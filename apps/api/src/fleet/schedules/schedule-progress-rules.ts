import type { AutoDisableReason } from './domain/schedule.domain';

export type ProgressVerdict =
  | { kind: 'ignore' }
  | { kind: 'disable'; reason: Extract<AutoDisableReason, 'completed' | 'finish_failed'> }
  | { kind: 'progress'; passed: number }
  | { kind: 'no_progress' };

/** A count the runner reported: a non-negative integer, or null. Anything else is treated as absent. */
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** nax's `status.progress` is cumulative over the PRD (S1b spec, "Why a RUN schedule works"). */
export function readProgress(progress: unknown): { passed: number | null; total: number | null } {
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return { passed: null, total: null };
  const p = progress as Record<string, unknown>;
  return { passed: count(p['passed']), total: count(p['total']) };
}

/**
 * S1b §3.3 rules 1-6, in order, for a scheduled job that reached a terminal state. Pure: the caller applies the
 * verdict to the schedule row.
 */
export function judgeEndedJob(job: { state: string; progress: unknown }, lastPassedCount: number): ProgressVerdict {
  if (job.state === 'COMPLETED') return { kind: 'disable', reason: 'completed' };
  if (job.state === 'CANCELLED') return { kind: 'ignore' };
  const { passed, total } = readProgress(job.progress);
  if (passed === null) return { kind: 'no_progress' };
  if (total !== null && total > 0 && passed === total) return { kind: 'disable', reason: 'finish_failed' };
  return passed > lastPassedCount ? { kind: 'progress', passed } : { kind: 'no_progress' };
}
