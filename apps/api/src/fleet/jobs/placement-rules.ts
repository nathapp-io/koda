import type { ProfileNeeds, RunnerCapabilities, BashMode } from '../common/protocol';
import { isRunnerOnline } from '../common/runner-online';
import { isConfigKind } from '../common/config-jobs';
import { jobGateKeys } from '../budgets/budget-rules';
import { isThreadKind } from '../common/thread-jobs';
import type { ThreadAction, ThreadBackend, ThreadMode, ChatThreadKind } from '../common/thread-jobs';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

/** The first placement rule a runner fails (spec §4), reported per runner at dispatch. */
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'interaction' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity'
  | 'config_jobs' | 'bot_review' | 'bot_fix' | 'bot_rulings' | 'trust_domain' | 'thread_capacity' | 'thread_backend' | 'thread_modes' | 'threads_disabled' | 'thread_write' | 'project_threads' | 'workspace_threads';

// budget_paused is not permanent either: it clears on resume or month rollover (S1b §2.3).
// provider_unavailable is not permanent: a later probe may fix it, so the job queues and a
// pinned dispatch answers 201 (spec §4).
// interaction is not permanent either: the runner's env is fixed and a re-probe clears it (#207).
// project_threads is not permanent either (S5b-R9): the runner's daemon may start hosting them (US-005).
/** A pinned job whose runner fails one of these can never run there: 422 at dispatch (spec §4). */
export const PERMANENT_MISFITS: ReadonlySet<MisfitReason> = new Set<MisfitReason>([
  'disabled', 'executor', 'protocol', 'provider_missing', 'sandbox', 'tools', 'approvals_relay', 'config_jobs',
]);

/** The thread facts placement judges: the turn's backend and action, whether thread jobs are on, and the thread kind. */
export interface PlacementThread {
  mode?: ThreadMode;
  backend: ThreadBackend;
  enabled: boolean;
  action?: ThreadAction;
  /** The normalized thread kind (1a-R1); absent means REPO (a thread row that names none). */
  kind?: ChatThreadKind;
}

export interface PlacementJob {
  command: string;
  repoId: string;
  projectId: string;
  provider: 'github' | 'gitlab';
  profiles: readonly string[];
  selectorLabels: readonly string[];
  pinnedRunnerId: string | null;
  bashMode: BashMode;
  thread?: PlacementThread;
  /** Only explicit FIX jobs with a non-empty ruling snapshot need this capability. */
  needsBotRulings?: true;
}

export interface PlacementRunner {
  id: string;
  name: string;
  enabled: boolean;
  lastSeenAt: Date;
  /** Set for runners created by enrollment; legacy/test rows may have no observed boot. */
  bootedAt?: Date | null;
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
  projectIds: ReadonlySet<string>;
  rawProjectIds: ReadonlySet<string>;
  threads?: number;
}

/** A runner with no held jobs. `threads` is always present so readers never need a `?? 0`. */
export const EMPTY_LOAD: RunnerLoad = Object.freeze({ active: 0, repoIds: new Set<string>(), projectIds: new Set<string>(), rawProjectIds: new Set<string>(), threads: 0 });

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * S3 §4.4: the placement rules for one profile the runner reports (also used by the credential board).
 *
 * C10: `providerVault` means the runner's nax config carries koda's exec helper, so the job's provider-key socket can
 * hand it a key koda holds. A provider the machine has no local `nax auth` credential for is therefore NOT a misfit —
 * a runner with no machine-local login is exactly what the vault is for, and refusing it here made vault-only fleet
 * jobs unplaceable. The widening is one-way: a locally available credential still satisfies the need, and a runner
 * without the helper keeps today's refusal (`provider_missing` is permanent to a pinned dispatch, so it must stay a
 * statement about the machine, not about koda's inventory).
 */
export function profileMisfit(needs: ProfileNeeds, caps: RunnerCapabilities): MisfitReason | null {
  if (!caps.nax.protocols.includes(needs.protocol)) return 'protocol';
  const vault = caps.providerVault === true;
  for (const provider of needs.providers) {
    const credential = caps.credentials.find((c) => c.providerId === provider);
    if (!credential) {
      if (vault) continue;
      return 'provider_missing';
    }
    // nax's own verdict (slice 3 design §1.1): available deliberately ignores access-token expiry.
    if (!credential.available && !vault) return 'provider_unavailable';
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
  if ((job.command === 'REVIEW' || job.command === 'FIX') && caps.botReview !== true) return 'bot_review';
  if (job.command === 'FIX' && caps.botFix !== true) return 'bot_fix';
  // Recoverable: a runner upgrade can add ruling support. Never refuse the pre-snapshot pin check.
  if (job.needsBotRulings && caps.botRulings !== true) return 'bot_rulings';
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

function hasTrustDomainMisfit(job: PlacementJob, load: RunnerLoad): boolean {
  const isRawAgent = job.bashMode === 'raw' && !isConfigKind(job.command) && job.command !== 'CONFIG';
  return [...(load.projectIds ?? [])].some((projectId) => projectId !== job.projectId && isRawAgent)
    || [...(load.rawProjectIds ?? [])].some((projectId) => projectId !== job.projectId);
}

/** Spec §4 steps 1-3, in order. Pinned jobs ignore selector labels (the pin is the candidate set). */
export function firstMisfit(job: PlacementJob, runner: PlacementRunner, load: RunnerLoad, now: Date, offlineSec: number): MisfitReason | null {
  if (!runner.enabled) return 'disabled';
  if (!isRunnerOnline(runner.lastSeenAt, now, offlineSec)) return 'offline';
  // Fleet S3 D470: config jobs spend nothing, so a runner's budget pause does not hold them.
  if (runner.budgetPaused && !isConfigKind(job.command)) return 'budget_paused';
  if (job.pinnedRunnerId === null && !job.selectorLabels.every((label) => runner.labels.includes(label))) return 'labels';
  if (!runner.capabilities.executors?.includes('host')) return 'executor';
  if (isThreadKind(job.command)) {
    if (!job.thread?.enabled) return 'threads_disabled';
    if ((runner.protocolVersion ?? 0) < 4) return 'protocol';
    // S5b-R9: a PROJECT thread runs with no checkout, which only a runner advertising projectThreads can host.
    // Recoverable (a daemon upgrade clears it), so an unfit runner leaves the job QUEUED, never cancels it.
    if (job.thread.kind === 'PROJECT' && runner.capabilities.projectThreads !== true) return 'project_threads';
    // Recoverable: a daemon upgrade can enable workspace hosting.
    if (job.thread.kind === 'WORKSPACE' && runner.capabilities.workspaceThreads !== true) return 'workspace_threads';
    // Fleet S5a §4: Publish and Discard run in the worktree, not on an agent, so they need threadWrite and no backend.
    const action = job.thread.action ?? 'SESSION';
    if (action === 'SESSION') {
      if ((job.thread.mode === 'ask' || job.thread.mode === 'full') && runner.capabilities.threadModes !== true) return 'thread_modes';
      const backends = runner.capabilities.threadBackends;
      const backend = job.thread.backend;
      if (backend.kind === 'native') {
        const models = backends?.native;
        if (!models?.length || (backend.model !== undefined && !models.includes(backend.model))) return 'thread_backend';
      } else if (!backends?.acp.includes(backend.agent)) return 'thread_backend';
    } else if (runner.capabilities.threadWrite !== true) {
      return 'thread_write';
    }
    if (hasTrustDomainMisfit(job, load)) return 'trust_domain';
    if ((load.threads ?? 0) >= (runner.threadCapacity ?? 0)) return 'thread_capacity';
    return null;
  }
  const capability = capabilityMisfit(job, runner.capabilities);
  if (capability) return capability;
  if (hasTrustDomainMisfit(job, load)) return 'trust_domain';
  if (load.repoIds.has(job.repoId)) return 'busy_repo';
  if (load.active >= runner.capacity) return 'capacity';
  return null;
}

/**
 * Spec §4 step 4 ordering: fewest active jobs, then a runner that has reported a boot, then the
 * oldest `lastSeenAt`, then id. Protocol, thread capacity and the other rules are not sort terms —
 * they are hard misfits in `firstMisfit`, so an unfit runner never reaches this sort.
 */
export function orderCandidates<T extends { runner: PlacementRunner; load: RunnerLoad }>(fits: readonly T[]): T[] {
  return [...fits].sort(
    (a, b) =>
      a.load.active - b.load.active ||
      Number(b.runner.bootedAt !== null && b.runner.bootedAt !== undefined) - Number(a.runner.bootedAt !== null && a.runner.bootedAt !== undefined) ||
      a.runner.lastSeenAt.getTime() - b.runner.lastSeenAt.getTime() ||
      a.runner.id.localeCompare(b.runner.id),
  );
}

/** Oldest-first scan window per fill (moved from placement.service.ts, D413). The dashboard dry-run reads the same window (S2b (c) §2.3). */
export const QUEUED_SCAN_LIMIT = 50;

/**
 * US-004: how many pages one fill may read before it gives up. A page holds `QUEUED_SCAN_LIMIT` candidates, so a scan
 * that needs more than 500 rows means the queue is starving this runner; the fill logs a warn and leaves the rest for
 * the next sync instead of holding the placement transaction open.
 */
export const MAX_QUEUED_SCAN_PAGES = 10;

/** Runner-held job refs -> per-runner load (moved from placement.service.ts, D413). */
export function addJobToLoad(load: RunnerLoad, ref: { runnerId: string; repoId: string; command?: string; projectId: string; bashMode: string }): RunnerLoad {
  const isThread = isThreadKind(ref.command ?? '');
  const isRawAgent = ref.bashMode === 'raw' && !isConfigKind(ref.command ?? '') && ref.command !== 'CONFIG';
  return {
    active: load.active + (isThread ? 0 : 1),
    repoIds: isThread ? new Set(load.repoIds) : new Set([...load.repoIds, ref.repoId]),
    projectIds: new Set([...load.projectIds, ref.projectId]),
    rawProjectIds: isRawAgent ? new Set([...load.rawProjectIds, ref.projectId]) : new Set(load.rawProjectIds),
    threads: (load.threads ?? 0) + (isThread ? 1 : 0),
  };
}

export const toLoads = (refs: readonly { runnerId: string; repoId: string; command?: string; projectId: string; bashMode: string }[]): ReadonlyMap<string, RunnerLoad> =>
  refs.reduce((acc, ref) => {
    acc.set(ref.runnerId, addJobToLoad(acc.get(ref.runnerId) ?? EMPTY_LOAD, ref));
    return acc;
  }, new Map<string, RunnerLoad>());

export const toPlacementJob = (
  job: Pick<FleetJobRecord, 'command' | 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId' | 'bashMode' | 'prRulings'>,
  repo: Pick<FleetRepoRef, 'provider' | 'projectId'>,
  thread?: PlacementThread,
): PlacementJob => ({
  command: job.command, repoId: job.repoId, projectId: repo.projectId, provider: repo.provider, profiles: job.profiles, selectorLabels: job.selectorLabels, pinnedRunnerId: job.pinnedRunnerId, bashMode: job.bashMode,
  ...(thread ? { thread } : {}),
  ...(job.command === 'FIX' && job.prRulings && 'rulings' in job.prRulings && job.prRulings.rulings.length > 0 ? { needsBotRulings: true as const } : {}),
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
