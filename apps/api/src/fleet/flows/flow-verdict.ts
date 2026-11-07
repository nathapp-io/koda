import { FLOW_STOP_DETAIL_MAX } from './flow-steps';

export interface FlowFinding {
  id?: string;
  summary: string;
}

export type FlowVerdict = { ok: true; findings: FlowFinding[] } | { ok: false };

export function parseFlowVerdict(output: string | null | undefined): FlowVerdict {
  if (typeof output !== 'string') return { ok: false };

  const marker = '{"findings"';
  const start = output.lastIndexOf(marker);
  if (start < 0) return { ok: false };

  let candidate = output.slice(start).trim();
  candidate = candidate.replace(/\s*```(?:[a-zA-Z0-9_-]+)?\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false };
  }

  if (typeof parsed !== 'object' || parsed === null || !('findings' in parsed)) return { ok: false };
  const { findings } = parsed as { findings: unknown };
  if (!Array.isArray(findings)) return { ok: false };

  const result: FlowFinding[] = [];
  for (const finding of findings) {
    if (typeof finding !== 'object' || finding === null || !('summary' in finding) || typeof finding.summary !== 'string') {
      return { ok: false };
    }
    const id = 'id' in finding && typeof finding.id === 'string' ? finding.id : undefined;
    result.push(id === undefined ? { summary: finding.summary } : { id, summary: finding.summary });
  }

  return { ok: true, findings: result };
}

export function formatFindings(findings: readonly FlowFinding[]): string {
  const noun = findings.length === 1 ? 'finding' : 'findings';
  const entries = findings.map((finding, index) =>
    `${index + 1}. ${finding.id === undefined ? '' : `[${finding.id}] `}${finding.summary}`,
  );
  const detail = `${findings.length} ${noun}: ${entries.join(' ')}`;
  if (detail.length <= FLOW_STOP_DETAIL_MAX) return detail;
  return `${detail.slice(0, FLOW_STOP_DETAIL_MAX - 1)}…`;
}
