import type { StatusView } from './status-view';

export type VerdictState = 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CANCELLED';

export interface Verdict {
  readonly state: VerdictState;
  readonly reason: string | null;
}

const COMPLETING_RESULTS: ReadonlySet<string> = new Set(['opened', 'promoted', 'already-ready', 'nothing-to-finish']);

/** S1 spec §5.2 step 6 (slice 3 design §2 step 7): first matching row wins; the exit code is never consulted. */
export function runVerdict(input: { cancelRequested: boolean; status: StatusView | null }): Verdict {
  if (input.cancelRequested) return { state: 'CANCELLED', reason: null };
  const { status } = input;
  if (!status) return { state: 'FAILED', reason: 'no status.json' };
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
