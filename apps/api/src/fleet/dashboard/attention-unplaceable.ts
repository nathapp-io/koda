import { jobGateKeys } from '../budgets/budget-rules';
import {
  evaluateRunners, MisfitReason, PERMANENT_MISFITS, PlacementRunner, RunnerLoad, toPlacementJob,
} from '../jobs/placement-rules';
import { jobItem } from './attention-jobs';
import {
  AttentionItem, AttentionReason, AttentionThresholds, DASHBOARD_LIMITS, DashboardJobRow, DashboardRunnerRow, secondsSince, Severity,
  UnplaceableVerdict,
} from './dashboard.types';

/** The parts of PauseSnapshot the dry-run needs. */
export interface DryRunPauses {
  runnerPaused(runnerId: string): boolean;
  match(keys: readonly string[]): unknown;
}

export interface DryRunInput {
  /** The globally oldest QUEUED jobs: the window fillRunner scans (D407). */
  queued: readonly DashboardJobRow[];
  runners: readonly DashboardRunnerRow[];
  /** Runner-held loads across all projects. */
  loads: ReadonlyMap<string, RunnerLoad>;
  pauses: DryRunPauses;
}

export interface ScopedItem {
  projectId: string;
  item: AttentionItem;
}

export interface DryRunResult {
  items: ScopedItem[];
  /** Runners whose runner-fixable misfit (credential, interaction) holds back an unplaced job (spec §2.4 escalation). */
  fixableBlockedRunnerIds: ReadonlySet<string>;
}

/** Misfits the runner itself can clear (a credential, the service environment): they raise its runner_unhealthy to error. */
const RUNNER_FIXABLE_REASONS: ReadonlySet<MisfitReason> = new Set<MisfitReason>(['provider_missing', 'provider_unavailable', 'interaction']);
const WAITING_REASONS: ReadonlySet<MisfitReason> = new Set<MisfitReason>(['capacity', 'busy_repo']);

/** Runners with unreadable capabilities are never candidates (spec §1.4). */
const toCandidate = (r: DashboardRunnerRow): PlacementRunner | null =>
  r.capabilities === null
    ? null
    : { id: r.id, name: r.name, enabled: r.enabled, lastSeenAt: r.lastSeenAt, labels: r.labels, capacity: r.capacity, capabilities: r.capabilities };

function classify(reasons: readonly MisfitReason[]): { verdict: UnplaceableVerdict; severity: Severity } {
  if (reasons.every((r) => PERMANENT_MISFITS.has(r))) return { verdict: 'never', severity: 'error' };
  if (reasons.every((r) => WAITING_REASONS.has(r))) return { verdict: 'waiting_capacity', severity: 'warning' };
  if (reasons.every((r) => r === 'budget_paused')) return { verdict: 'runners_paused', severity: 'warning' };
  return { verdict: 'no_fit', severity: 'warning' };
}

/**
 * Spec §2.3. Evaluated in the global context; the caller filters `items` to its scope. Same inputs as
 * PlacementService.placeJob, but no locks and no assignment.
 */
export function jobUnplaceableItems(input: DryRunInput, now: Date, t: AttentionThresholds): DryRunResult {
  const candidates = input.runners.map(toCandidate).filter((r): r is PlacementRunner => r !== null);
  const blocked = new Set<string>();
  const items = input.queued.flatMap((job): ScopedItem[] => {
    if (job.projectDeleted || secondsSince(now, job.queuedAt) <= t.jobQueuedWarnSec) return [];
    const emit = (verdict: UnplaceableVerdict, severity: Severity, reasons: AttentionReason[], reasonsTotal: number): ScopedItem[] => [{
      projectId: job.projectId,
      item: jobItem('job_unplaceable', job, severity, job.queuedAt, { verdict, reasons: reasons.slice(0, DASHBOARD_LIMITS.reasonsShown), reasonsTotal }),
    }];
    if (input.pauses.match(jobGateKeys(job))) return emit('budget_paused', 'warning', [], 0);
    const pool = job.pinnedRunnerId ? candidates.filter((r) => r.id === job.pinnedRunnerId) : candidates;
    if (pool.length === 0) return emit('no_runners', 'error', [], 0);
    const verdicts = evaluateRunners(toPlacementJob(job, job), pool, input.loads, (id) => input.pauses.runnerPaused(id), now, t.runnerOfflineSec);
    const misfits = verdicts
      .flatMap((v) => (v.reason === null ? [] : [{ runnerId: v.runner.id, runnerName: v.runner.name, reason: v.reason }]))
      .sort((a, b) => a.runnerName.localeCompare(b.runnerName) || a.runnerId.localeCompare(b.runnerId));
    const reasons = misfits.map(({ runnerName, reason }) => ({ runnerName, reason }));
    if (misfits.length < verdicts.length) return emit('fits_not_placed', 'warning', reasons, reasons.length);
    misfits.filter((m) => RUNNER_FIXABLE_REASONS.has(m.reason)).forEach((m) => blocked.add(m.runnerId));
    const { verdict, severity } = classify(misfits.map((m) => m.reason));
    return emit(verdict, severity, reasons, reasons.length);
  });
  return { items, fixableBlockedRunnerIds: blocked };
}
