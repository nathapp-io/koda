import type { StatusView } from './status-view';

export type VerdictState = 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CANCELLED';

export interface Verdict {
  readonly state: VerdictState;
  readonly reason: string | null;
}

const COMPLETING_RESULTS: ReadonlySet<string> = new Set(['opened', 'promoted', 'already-ready', 'nothing-to-finish']);

/** D4: the server keeps at most 500 characters of a runner state reason; clip whole, prefix included. */
const WORKFLOW_REASON_MAX = 500;

function clipReason(text: string): string {
  if (text.length <= WORKFLOW_REASON_MAX) return text;
  const last = text.charCodeAt(WORKFLOW_REASON_MAX - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? WORKFLOW_REASON_MAX - 1 : WORKFLOW_REASON_MAX);
}

/** S1 spec §5.2 step 6 (slice 3 design §2 step 7): first matching row wins; the exit code is never consulted. */
export function runVerdict(input: { cancelRequested: boolean; status: StatusView | null; workflowReasons?: readonly string[] }): Verdict {
  if (input.cancelRequested) return { state: 'CANCELLED', reason: null };
  const { status } = input;
  if (!status) return { state: 'FAILED', reason: 'no status.json' };
  if (status.workflow) {
    const outcome = status.workflow.outcome;
    if (outcome === 'ready') return { state: 'COMPLETED', reason: null };
    if (outcome === 'draft') {
      const reasons = input.workflowReasons ?? [];
      if (reasons.length === 0) return { state: 'ESCALATED', reason: 'workflow draft' };
      return { state: 'ESCALATED', reason: clipReason(`workflow draft: ${reasons.join('; ')}`) };
    }
    if (outcome === 'local-only') {
      const reasons = input.workflowReasons ?? [];
      if (reasons.length === 0) return { state: 'FAILED', reason: 'workflow local-only' };
      return { state: 'FAILED', reason: clipReason(`workflow local-only: ${reasons.join('; ')}`) };
    }
    return { state: 'FAILED', reason: clipReason(`workflow ended at step ${status.workflow.step}`) };
  }
  const finish = status.postRun?.finish;
  if (finish?.result === 'escalated') return { state: 'ESCALATED', reason: finish.escalationReason ?? 'escalated' };
  if (status.run.status === 'completed') {
    if (!finish || finish.status === 'skipped' || (finish.result !== undefined && COMPLETING_RESULTS.has(finish.result))) {
      return { state: 'COMPLETED', reason: null };
    }
    return { state: 'FAILED', reason: `finish ${finish.status ?? 'unknown'}` };
  }
  return { state: 'FAILED', reason: `run status: ${status.run.status}` };
}
