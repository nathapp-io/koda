import { jobScopePause, MisfitReason, PlacementRunner, RunnerLoad, toPlacementJob, withVaultProviders } from '../jobs/placement-rules';
import { jobItem } from './attention-jobs';
import { isThreadKind } from '../common/thread-jobs';
import { judgeUnplaceable, UnplaceableVerdict } from '../jobs/unplaceable-verdict';
import {
  AttentionItem, AttentionReason, AttentionThresholds, DASHBOARD_LIMITS, DashboardJobRow, DashboardRunnerRow, secondsSince, Severity,
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
  /** US-002 (#425): the thread kill switch (FLEET_THREADS_ENABLED); a THREAD job is unplaceable while it is off. */
  threadsEnabled: boolean;
  /**
   * C10 (branch review B3): the providers the vault could hand one queued job, from that job's own scope.
   * Absent means the vault serves none, and a `providerVault` runner is then judged like any other — the
   * same rule placement applies, so the dry-run cannot call a job unplaceable that dispatch would place.
   */
  vaultProviders?: (job: DashboardJobRow) => ReadonlySet<string>;
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

/** Runners with unreadable capabilities are never candidates (spec §1.4). */
const toCandidate = (r: DashboardRunnerRow): PlacementRunner | null =>
  r.capabilities === null
    ? null
    : {
      id: r.id, name: r.name, enabled: r.enabled, lastSeenAt: r.lastSeenAt, labels: r.labels, capacity: r.capacity,
      capabilities: r.capabilities, protocolVersion: r.protocolVersion, threadCapacity: r.threadCapacity,
    };

/**
 * Spec §2.3. Evaluated in the global context; the caller filters `items` to its scope. Same inputs as
 * PlacementService.placeJob, but no locks and no assignment.
 */
export function jobUnplaceableItems(input: DryRunInput, now: Date, t: AttentionThresholds): DryRunResult {
  const candidates = input.runners.map(toCandidate).filter((r): r is PlacementRunner => r !== null);
  const blocked = new Set<string>();
  const items = input.queued.flatMap((job): ScopedItem[] => {
    if (job.projectDeleted || secondsSince(now, job.queuedAt) <= t.jobQueuedWarnSec) return [];
    // US-002 (#425): a THREAD job is judged like any other job, from its turn. A THREAD row with no turn is a
    // broken row placement skips too, so the dry-run skips it as well.
    const thread = isThreadKind(job.command) ? job.threadTurn : undefined;
    if (isThreadKind(job.command) && !thread) return [];
    const emit = (verdict: UnplaceableVerdict, severity: Severity, reasons: AttentionReason[], reasonsTotal: number): ScopedItem[] => [{
      projectId: job.projectId,
      item: jobItem('job_unplaceable', job, severity, job.queuedAt, { verdict, reasons: reasons.slice(0, DASHBOARD_LIMITS.reasonsShown), reasonsTotal }),
    }];
    const judged = toPlacementJob(job, job, thread ? { ...thread, enabled: input.threadsEnabled } : undefined);
    const placement = input.vaultProviders ? withVaultProviders(judged, input.vaultProviders(job)) : judged;
    const pool = job.pinnedRunnerId ? candidates.filter((r) => r.id === job.pinnedRunnerId) : candidates;
    // The one judgement every queued job's verdict comes from (US-002): the dashboard and the thread detail read
    // the same answer, so they cannot drift from placement.
    const judgement = judgeUnplaceable({
      job: placement,
      scopePaused: jobScopePause(job, (keys) => input.pauses.match(keys) ?? null) !== null,
      pool, loads: input.loads, runnerPaused: (id) => input.pauses.runnerPaused(id), now, offlineSec: t.runnerOfflineSec,
    });
    // A queued job with a compatible runner is delayed, not unplaceable.
    if (!judgement) return [];
    judgement.misfits.filter((m) => RUNNER_FIXABLE_REASONS.has(m.reason)).forEach((m) => blocked.add(m.runnerId));
    const reasons = judgement.misfits.map(({ runnerName, reason }) => ({ runnerName, reason }));
    return emit(judgement.verdict, judgement.severity, reasons, judgement.misfits.length);
  });
  return { items, fixableBlockedRunnerIds: blocked };
}
