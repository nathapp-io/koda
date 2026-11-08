import { FLOW_STOP_DETAIL_MAX } from './flow-steps';
import { parsePrdEdits, type FlowPrdEdit } from './flow-prd-edits';

export type FlowFindingClass = 'answered' | 'minor' | 'ambiguous';

export interface FlowFinding {
  id?: string;
  class: FlowFindingClass;
  summary: string;
  fix?: string;
  question?: string;
  answer?: string;
}

/**
 * `notes` counts the `answered`/`minor` findings dropped for carrying no fix (#415): a reviewer's
 * "already settled, no change" note has nothing to apply, so it must not sink the verdict. It is
 * present only when at least one note was dropped. A failure names the first check that failed.
 */
export type FlowVerdict =
  | { ok: true; findings: FlowFinding[]; prdEdits: FlowPrdEdit[]; notes?: number }
  | { ok: false; reason: string };

const unreadable = (reason: string): FlowVerdict => ({ ok: false, reason });

export function parseFlowVerdict(output: string | null | undefined): FlowVerdict {
  if (typeof output !== 'string') return unreadable('no agent output');

  const marker = '{"findings"';
  const start = output.lastIndexOf(marker);
  if (start < 0) return unreadable('no verdict line');

  let candidate = output.slice(start).trim();
  candidate = candidate.replace(/\s*```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return unreadable('verdict is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || !('findings' in parsed)) return unreadable('verdict has no findings');
  const { findings } = parsed as { findings: unknown };
  if (!Array.isArray(findings)) return unreadable('findings is not a list');

  const result: FlowFinding[] = [];
  let notes = 0;
  for (const [index, finding] of findings.entries()) {
    const position = index + 1;
    if (typeof finding !== 'object' || finding === null || !('summary' in finding) || typeof finding.summary !== 'string') {
      return unreadable(`finding ${position} is not an object with a summary`);
    }
    const classification = 'class' in finding ? finding.class : undefined;
    if (classification !== 'answered' && classification !== 'minor' && classification !== 'ambiguous') {
      return unreadable(`finding ${position} has no valid class`);
    }
    const fix = 'fix' in finding && typeof finding.fix === 'string' ? finding.fix : undefined;
    const question = 'question' in finding && typeof finding.question === 'string' ? finding.question : undefined;
    if (classification === 'ambiguous') {
      if (question === undefined || question.trim().length === 0) return unreadable(`finding ${position} has no question`);
    } else if (fix === undefined || fix.trim().length === 0) {
      notes += 1;
      continue;
    }
    const id = 'id' in finding && typeof finding.id === 'string' ? finding.id : undefined;
    result.push({ ...(id === undefined ? {} : { id }), class: classification, summary: finding.summary, ...(fix === undefined ? {} : { fix }), ...(question === undefined ? {} : { question }) });
  }

  const prdEdits = 'prdEdits' in parsed ? parsePrdEdits(parsed.prdEdits) : [];
  if (prdEdits === null) return unreadable('prdEdits is invalid');
  return { ok: true, findings: result, prdEdits, ...(notes > 0 ? { notes } : {}) };
}

export function formatFindings(findings: readonly FlowFinding[]): string {
  const noun = findings.length === 1 ? 'finding' : 'findings';
  const entries = findings.map((finding, index) =>
    `${index + 1}. ${finding.id === undefined ? '' : `[${finding.id}] `}(${finding.class}) ${finding.summary}`,
  );
  const detail = `${findings.length} ${noun}: ${entries.join(' ')}`;
  if (detail.length <= FLOW_STOP_DETAIL_MAX) return detail;
  return `${detail.slice(0, FLOW_STOP_DETAIL_MAX - 1)}…`;
}
