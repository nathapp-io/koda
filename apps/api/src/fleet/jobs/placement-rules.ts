import type { ProfileNeeds, RunnerCapabilities, BashMode } from '../common/protocol';
import { isRunnerOnline } from '../common/runner-online';
import { isConfigKind } from '../common/config-jobs';
import { jobGateKeys } from '../budgets/budget-rules';
import { isThreadKind } from '../common/thread-jobs';
import type { ThreadBackend } from '../common/thread-jobs';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

/** The first placement rule a runner fails (spec §4), reported per runner at dispatch. */
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'interaction' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity'
  | 'config_jobs' | 'thread_capacity' | 'thread_backend' | 'threads_disabled';

// budget_paused is not permanent either: it clears on resume or month rollover (S1b §2.3).
// provider_unavailable is not permanent: a later probe may fix it, so the job queues and a
// pinned dispatch answers 201 (spec §4).
// interaction is not permanent either: the runner's env is fixed and a re-probe clears it (#207).
/** A pinned job whose runner fails one of these can never run there: 422 at dispatch (spec §4). */
export const PERMANENT_MISFITS: ReadonlySet<MisfitReason> = new Set<MisfitReason>([
  'disabled', 'executor', 'protocol', 'provider_missing', 'sandbox', 'tools', 'approvals_relay', 'config_jobs',
]);

export interface PlacementJob {
  command: string;
  repoId: string;
  provider: 'github' | 'gitlab';
  profiles: readonly string[];
  selectorLabels: readonly string[];
  pinnedRunnerId: string | null;
  bashMode: BashMode;
  thread?: { backend: ThreadBackend; enabled: boolean };
}

export interface PlacementRunner {
  id: string;
  name: string;
  enabled: boolean;
  lastSeenAt: Date;
  labels: readonly string[];
  capacity: number;
  capabilities: RunnerCapabilities;
  /** S1b §2.3, plan D159: the runner's own budget scope is effectively paused. Set by PlacementService; absent = no. */
  budgetPaused?: boolean;
  protocolVersion?: number;
  threadCapacity?: number;
}

/** The runner's active jobs (ASSIGNED, RUNNING, UPLOADING). */
export interface RunnerLoad {
  active: number;
  repoIds: ReadonlySet<string>;
  threads?: number;
}

export const EMPTY_LOAD: RunnerLoad = Object.freeze({ active: 0, repoIds: new Set<string>() });

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** S3 §4.4: the placement rules for one profile the runner reports (also used by the credential board). */
export function profileMisfit(needs: ProfileNeeds, caps: RunnerCapabilities): MisfitReason | null {
  if (!caps.nax.protocols.includes(needs.protocol)) return 'protocol';
  for (const provider of needs.providers) {
    const credential = caps.credentials.find((c) => c.providerId === provider);
    if (!credential) return 'provider_missing';
    // nax's own verdict (slice 3 design §1.1): available deliberately ignores access-token expiry.
    if (!credential.available) return 'provider_unavailable';
  }
  if (needs.sandbox && !caps.sandbox.available) return 'sandbox';
  // #207: nax could not start this profile's interaction plugin in the runner's environment.
  if (needs.interaction?.ok === false) return 'interaction';
  return null;
}

function toolsMisfit(job: PlacementJob, caps: RunnerCapabilities): MisfitReason | null {
  const forgeTool = job.provider === 'github' ? caps.tools.gh : caps.tools.glab;
  return !caps.tools.git || !forgeTool ? 'tools' : null;
}

function capabilityMisfit(job: PlacementJob, caps: RunnerCapabilities): MisfitReason | null {
  // Fleet S3 D470: a config job runs no agent, so only the S3 capability and the forge tools matter.
  if (isConfigKind(job.command)) return caps.configJobs === true ? toolsMisfit(job, caps) : 'config_jobs';
  // Plan D270: a gated/escalate job on a runner without the relay would have every ask denied (A7), so never place it.
  if (job.bashMode !== 'raw' && caps.approvals?.relay !== true) return 'approvals_relay';
  for (const name of job.profiles) {
    // A name the runner does not report is repo-provided and unknowable before clone (spec §2.1).
    if (!own(caps.profiles, name)) continue;
    const misfit = profileMisfit(caps.profiles[name], caps);
    if (misfit) return misfit;
  }
  // #207: a job with no profiles runs on the machine's base config. A job naming profiles is judged on them only:
  // each reported profile's result already includes the base config it overlays.
  if (job.profiles.length === 0 && caps.interaction?.ok === false) return 'interaction';
  return toolsMisfit(job, caps);
}

/** Spec §4 steps 1-3, in order. Pinned jobs ignore selector labels (the pin is the candidate set). */
export function firstMisfit(job: PlacementJob, runner: PlacementRunner, load: RunnerLoad, now: Date, offlineSec: number): MisfitReason | null {
  if (!runner.enabled) return 'disabled';
  if (!isRunnerOnline(runner.lastSeenAt, now, offlineSec)) return 'offline';
  // Fleet S3 D470: config jobs spend nothing, so a runner's budget pause does not hold them.
  if (runner.budgetPaused && !isConfigKind(job.command)) return 'budget_paused';
  if (job.pinnedRunnerId === null && !job.selectorLabels.every((label) => runner.labels.includes(label))) return 'labels';
  if (!runner.capabilities.executors.includes('host')) return 'executor';
  if (isThreadKind(job.command)) {
    if (!job.thread?.enabled) return 'threads_disabled';
    if ((runner.protocolVersion ?? 0) < 4) return 'protocol';
    const backends = runner.capabilities.threadBackends;
    const backend = job.thread.backend;
    if (backend.kind === 'native') {
      const models = backends?.native;
      if (!models?.length || (backend.model !== undefined && !models.includes(backend.model))) return 'thread_backend';
    } else if (!backends?.acp.includes(backend.agent)) return 'thread_backend';
    if ((load.threads ?? 0) >= (runner.threadCapacity ?? 0)) return 'thread_capacity';
    return null;
  }
  const capability = capabilityMisfit(job, runner.capabilities);
  if (capability) return capability;
  if (load.repoIds.has(job.repoId)) return 'busy_repo';
  if (load.active >= runner.capacity) return 'capacity';
  return null;
}

/** Spec §4 step 4: fewest active jobs, then oldest lastSeenAt; id breaks ties deterministically. */
export function orderCandidates<T extends { runner: PlacementRunner; load: RunnerLoad }>(fits: readonly T[]): T[] {
  return [...fits].sort(
    (a, b) =>
      a.load.active - b.load.active ||
      a.runner.lastSeenAt.getTime() - b.runner.lastSeenAt.getTime() ||
      a.runner.id.localeCompare(b.runner.id),
  );
}

/** Oldest-first scan window per fill (moved from placement.service.ts, D413). The dashboard dry-run reads the same window (S2b (c) §2.3). */
export const QUEUED_SCAN_LIMIT = 50;

/** Runner-held job refs -> per-runner load (moved from placement.service.ts, D413). */
export const toLoads = (refs: readonly { runnerId: string; repoId: string; command?: string }[]): ReadonlyMap<string, RunnerLoad> =>
  refs.reduce((acc, { runnerId, repoId, command }) => {
    const prev = acc.get(runnerId) ?? EMPTY_LOAD;
    const isThread = isThreadKind(command ?? '');
    return new Map([...acc, [runnerId, {
      active: prev.active + (isThread ? 0 : 1),
      repoIds: isThread ? new Set(prev.repoIds) : new Set([...prev.repoIds, repoId]),
      ...((prev.threads ?? 0) + (isThread ? 1 : 0) > 0 ? { threads: (prev.threads ?? 0) + (isThread ? 1 : 0) } : {}),
    }]]);
  }, new Map<string, RunnerLoad>());

export const toPlacementJob = (
  job: Pick<FleetJobRecord, 'command' | 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId' | 'bashMode'>,
  repo: Pick<FleetRepoRef, 'provider'>,
  thread?: { backend: ThreadBackend; enabled: boolean },
): PlacementJob => ({
  command: job.command, repoId: job.repoId, provider: repo.provider, profiles: job.profiles, selectorLabels: job.selectorLabels, pinnedRunnerId: job.pinnedRunnerId, bashMode: job.bashMode,
  ...(thread ? { thread } : {}),
});

/** S1b §2.3 pre-assign pause check; config jobs spend nothing, so a pause never holds or cancels them (fleet S3 D470). */
export function jobScopePause<T>(
  job: { command: string; projectId: string; repoId: string; pinnedRunnerId: string | null },
  match: (keys: readonly string[]) => T | null,
): T | null {
  return isConfigKind(job.command) ? null : match(jobGateKeys(job));
}

export interface RunnerVerdict<R extends PlacementRunner = PlacementRunner> {
  runner: R;
  load: RunnerLoad;
  reason: MisfitReason | null;
}

/**
 * Spec §4 steps 1-3 for every candidate, with the runner's own budget pause applied. Shared by
 * PlacementService.placeJob and the dashboard dry-run (S2b (c) §2.3) so the two cannot drift.
 */
export function evaluateRunners<R extends PlacementRunner>(
  job: PlacementJob,
  runners: readonly R[],
  loads: ReadonlyMap<string, RunnerLoad>,
  runnerPaused: (runnerId: string) => boolean,
  now: Date,
  offlineSec: number,
): Array<RunnerVerdict<R>> {
  return runners.map((row) => {
    const runner = { ...row, budgetPaused: runnerPaused(row.id) };
    const load = loads.get(row.id) ?? EMPTY_LOAD;
    return { runner, load, reason: firstMisfit(job, runner, load, now, offlineSec) };
  });
}
