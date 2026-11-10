import { evaluateRunners, MisfitReason, PERMANENT_MISFITS, PlacementJob, PlacementRunner, RunnerLoad } from './placement-rules';

/**
 * US-002 (#425): the verdicts the dashboard and the thread detail share. Moved here (from `dashboard.types.ts`)
 * so the judgement lives next to the placement rules it reads, and the dashboard types re-export them.
 */
export const UNPLACEABLE_VERDICTS = ['never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed'] as const;
export type UnplaceableVerdict = (typeof UNPLACEABLE_VERDICTS)[number];

/** Why a queued job cannot be placed, and how loudly the dashboard says so. */
export interface UnplaceableJudgement {
  verdict: UnplaceableVerdict;
  severity: 'error' | 'warning';
  misfits: Array<{ runnerId: string; runnerName: string; reason: MisfitReason }>;
}

/**
 * Reasons a runner clears by itself (a busy slot, a held repo, a trust domain, a full thread capacity): the job
 * waits for them, so the dashboard reports a warning, not an error.
 */
const WAITING_REASONS: ReadonlySet<MisfitReason> = new Set<MisfitReason>(['capacity', 'busy_repo', 'trust_domain', 'thread_capacity']);

/**
 * The dashboard's classification, in today's order: every permanent misfit is `never` (error), every waiting
 * reason is `waiting_capacity` (warning), every budget pause is `runners_paused` (warning), and any other mix
 * is `no_fit` (warning).
 */
const classify = (reasons: readonly MisfitReason[]): { verdict: UnplaceableVerdict; severity: 'error' | 'warning' } => {
  if (reasons.every((r) => PERMANENT_MISFITS.has(r))) return { verdict: 'never', severity: 'error' };
  if (reasons.every((r) => WAITING_REASONS.has(r))) return { verdict: 'waiting_capacity', severity: 'warning' };
  if (reasons.every((r) => r === 'budget_paused')) return { verdict: 'runners_paused', severity: 'warning' };
  return { verdict: 'no_fit', severity: 'warning' };
};

/**
 * US-002 (#425): the one judgement a queued job's verdict comes from, wherever it is read (the dashboard dry-run
 * and the thread detail). It asks placement's own rules, so a dashboard verdict and a dispatch decision cannot drift.
 *
 * `null` means the job is delayed, not unplaceable: some runner in the pool can take it.
 */
export function judgeUnplaceable(input: {
  job: PlacementJob;
  /** The job's own scope (project, repo) is budget-paused: placement will cancel the job. */
  scopePaused: boolean;
  /** The candidate runners (a pinned job's pool is its one runner). */
  pool: readonly PlacementRunner[];
  loads: ReadonlyMap<string, RunnerLoad>;
  runnerPaused: (runnerId: string) => boolean;
  now: Date;
  offlineSec: number;
}): UnplaceableJudgement | null {
  if (input.scopePaused) return { verdict: 'budget_paused', severity: 'warning', misfits: [] };
  if (input.pool.length === 0) return { verdict: 'no_runners', severity: 'error', misfits: [] };
  const verdicts = evaluateRunners(input.job, input.pool, input.loads, input.runnerPaused, input.now, input.offlineSec);
  const misfits = verdicts
    .flatMap((v) => (v.reason === null ? [] : [{ runnerId: v.runner.id, runnerName: v.runner.name, reason: v.reason }]))
    .sort((a, b) => a.runnerName.localeCompare(b.runnerName) || a.runnerId.localeCompare(b.runnerId));
  // A runner that fits the job means the job is delayed, not unplaceable.
  if (misfits.length < verdicts.length) return null;
  const { verdict, severity } = classify(misfits.map((m) => m.reason));
  return { verdict, severity, misfits };
}
