import { AGENT_RESULT_LIMITS, type AgentDeniedAsk, type AgentJobResult } from '../common/agent-jobs';

const COST_RE = /^\d{1,8}(\.\d{1,4})?$/;
type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAsk(raw: unknown): AgentDeniedAsk | null {
  if (!isObject(raw)) return null;
  if (raw.kind === 'question') {
    return typeof raw.text === 'string' && raw.text.length <= AGENT_RESULT_LIMITS.maxAskChars
      ? { kind: 'question', text: raw.text }
      : null;
  }
  if (raw.kind === 'approval') {
    return typeof raw.tool === 'string' && raw.tool.length <= AGENT_RESULT_LIMITS.maxToolChars &&
      typeof raw.summary === 'string' && raw.summary.length <= AGENT_RESULT_LIMITS.maxAskChars
      ? { kind: 'approval', tool: raw.tool, summary: raw.summary }
      : null;
  }
  return null;
}

/** Validate the entire untrusted snapshot result as one bounded field. */
export function parseAgentResult(raw: unknown): AgentJobResult | null {
  if (!isObject(raw)) return null;
  const { status, model, output, truncated, deniedAsks, deniedAsksTruncated, costUsd } = raw;
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'timeout') return null;
  if (model !== undefined && (typeof model !== 'string' || model.length > AGENT_RESULT_LIMITS.maxModelChars)) return null;
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > AGENT_RESULT_LIMITS.maxOutputBytes) return null;
  if (typeof truncated !== 'boolean' || typeof deniedAsksTruncated !== 'boolean') return null;
  if (!Array.isArray(deniedAsks) || deniedAsks.length > AGENT_RESULT_LIMITS.maxDeniedAsks) return null;
  const asks = deniedAsks.map(parseAsk);
  if (asks.some((ask) => ask === null)) return null;
  if (costUsd !== undefined && (typeof costUsd !== 'string' || !COST_RE.test(costUsd))) return null;

  const result: AgentJobResult = {
    status,
    ...(model !== undefined ? { model: model as string } : {}),
    output,
    truncated,
    deniedAsks: asks as AgentDeniedAsk[],
    deniedAsksTruncated,
    ...(costUsd !== undefined ? { costUsd: costUsd as string } : {}),
  };
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= AGENT_RESULT_LIMITS.budgetBytes ? result : null;
}
