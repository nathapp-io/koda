import { Inject, Injectable, Logger } from '@nestjs/common';
import { bookkeeping } from '../../action-context/audit-coverage';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { runAsSystem } from '../../action-context/action-context';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { cloneUrlFor } from '../git-broker/clone-url';
import { BudgetGate } from '../budgets/budget-gate';
import { budgetReason } from '../budgets/budget-rules';
import { kodaToolDescriptorsFor } from '../assistant/koda-tool-descriptors';
import { buildAssignPayload, carriesRuleOverride, gitIdentityFor } from './assign-payload';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import { addJobToLoad, EMPTY_LOAD, evaluateRunners, firstMisfit, jobScopePause, MAX_QUEUED_SCAN_PAGES, MisfitReason, orderCandidates, PlacementJob, QUEUED_SCAN_LIMIT, toLoads, toPlacementJob, withVaultProviders } from './placement-rules';
import { judgeUnplaceable, type UnplaceableVerdict } from './unplaceable-verdict';
import { isThreadKind, type ThreadAssign } from '../common/thread-jobs';
import { withProjectRepos } from './project-repos-assign';
import type { RunnerCapabilities } from '../common/protocol';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import { providerScopeLookupKey, type ProviderLookupScope } from '../provider-credentials/provider-credential.domain';
import { RunnerNotifier } from './runner-notifier';
import {
  FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository, PlacementRunnerRow, QueuedCursor, QueuedScanFilter, ruleOverrideSummaryOf,
} from './domain/fleet-job.domain';

export interface PlacementOutcome {
  assigned: boolean;
  runnerId: string | null;
  leaseEpoch: number | null;
  misfits: Array<{ runnerId: string; name: string; reason: MisfitReason }>;
}

/** C10 (branch review B3): one placement pass's vault availability answers, keyed by job scope. */
type VaultMemo = Map<string, Promise<ReadonlySet<string>>>;

export interface QueuedVerdict {
  jobId: string;
  queuedAt: Date;
  verdict: Exclude<UnplaceableVerdict, 'fits_not_placed'>;
  reasons: Array<{ runnerName: string; reason: MisfitReason }>;
}

/** The answer for a scope the vault can serve nothing for; shared, never mutated. */
const NO_PROVIDERS: ReadonlySet<string> = new Set<string>();

/**
 * Spec §4 + §6.1. placeJob runs at dispatch and requeue; fillRunner when a runner syncs
 * with free slots. Runner rows are locked in id order before counting load; fillRunner
 * takes job rows with SKIP LOCKED, so the two never wait on each other in a cycle.
 */
@Injectable()
export class PlacementService {
  private readonly logger = new Logger(PlacementService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    private readonly budgets: BudgetGate,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>,
    private readonly audit: AuditRecorder,
    /**
     * C10 (branch review B3): the vault's public service, for the providers koda can serve a job. Placement
     * never reads the credential repository: it asks which providers resolve for the job's scope and nothing
     * about the keys themselves.
     */
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /**
   * Dispatch-time check of a pin (spec §4, plan D18): null = fits now, a reason = does not,
   * 'not_found' = no such runner. `selectorLabels` are deliberately ignored for a pinned job —
   * a pinned runner is named, so labels are not part of the match (see firstMisfit's
   * `job.pinnedRunnerId === null` guard). Task 3 (BUG-3) re-runs this same check inside the
   * placeJob tx so a runner-state change between verdict and lock surfaces the same verdict.
   */
  async evaluatePinned(pinnedRunnerId: string, job: PlacementJob, now = new Date()): Promise<MisfitReason | null | 'not_found'> {
    const [runner] = await this.repo.findPlacementRunners([pinnedRunnerId]);
    if (!runner) return 'not_found';
    const loads = toLoads(await this.repo.findActiveLoads([runner.id]));
    const budgetPaused = (await this.budgets.snapshot(now)).runnerPaused(runner.id);
    const judged = await this.judgedJob(job, [runner], new Map());
    return firstMisfit(judged, { ...runner, budgetPaused }, loads.get(runner.id) ?? EMPTY_LOAD, now, this.fleetConfig.runnerOfflineSec);
  }

  /**
   * Read-only explanation for a queued job that has waited beyond the configured warning window. This deliberately
   * uses no transaction or row lock: it is a best-effort snapshot, judged by the same placement rules as dispatch.
   */
  async queuedVerdict(jobId: string, now: Date, minQueuedSec: number): Promise<QueuedVerdict | null> {
    const job = await this.repo.findById(jobId);
    if (!job || job.state !== FleetJobState.QUEUED || now.getTime() - job.queuedAt.getTime() <= minQueuedSec * 1_000) return null;

    const repo = await this.repo.findRepo(job.repoId);
    if (!repo) return null;
    const pauses = await this.budgets.snapshot(now);
    const paused = jobScopePause(job, (keys) => pauses.match(keys)) !== null;
    const runners = await this.repo.findPlacementRunners(job.pinnedRunnerId ? [job.pinnedRunnerId] : undefined);
    const loads = toLoads(await this.repo.findActiveLoads(runners.map((runner) => runner.id)));
    const threadAssign = isThreadKind(job.command) ? await this.repo.findThreadAssign(job.id) : null;
    if (isThreadKind(job.command) && !threadAssign) return null;
    const placementJob = toPlacementJob(job, repo, threadAssign ? {
      backend: threadAssign.backend, enabled: this.fleetConfig.threadsEnabled, action: threadAssign.action,
      kind: threadAssign.kind, mode: threadAssign.mode,
    } : undefined);
    const judged = await this.judgedJob(placementJob, runners, new Map());
    const judgement = judgeUnplaceable({
      job: judged, scopePaused: paused, pool: runners, loads,
      runnerPaused: (runnerId) => pauses.runnerPaused(runnerId), now, offlineSec: this.fleetConfig.runnerOfflineSec,
    });
    if (!judgement) return null;
    return {
      jobId: job.id, queuedAt: job.queuedAt,
      verdict: judgement.verdict as Exclude<UnplaceableVerdict, 'fits_not_placed'>,
      reasons: judgement.misfits.map(({ runnerName, reason }) => ({ runnerName, reason })),
    };
  }

  /**
   * C10 (branch review B3): the job with the provider ids the vault could hand a candidate runner, so a
   * `providerVault` runner skips a local credential refusal only for a provider koda can actually serve for
   * this job's project and repo. Read once per job scope per pass (`memo`), and only when some candidate
   * reports the helper — a fleet without the vault, and every run whose runners cannot use it, pays no read.
   */
  private async judgedJob(job: PlacementJob, candidates: readonly { capabilities: RunnerCapabilities }[], memo: VaultMemo): Promise<PlacementJob> {
    if (!candidates.some((candidate) => candidate.capabilities.providerVault === true)) return job;
    return withVaultProviders(job, await this.vaultProviders({ projectId: job.projectId, repoId: job.repoId }, memo));
  }

  /** One availability question per scope per pass: a fill scans many jobs and most share a repo. */
  private vaultProviders(scope: ProviderLookupScope, memo: VaultMemo): Promise<ReadonlySet<string>> {
    const key = providerScopeLookupKey(scope);
    const pending = memo.get(key) ?? this.credentials.availableProviders([scope]).then((answers) => answers.get(key) ?? NO_PROVIDERS);
    memo.set(key, pending);
    return pending;
  }

  async placeJob(jobId: string, now = new Date()): Promise<PlacementOutcome> {
    const { outcome, live } = await this.txManager.run(async () => {
      const job = await this.repo.lockById(jobId);
      if (!job || job.state !== FleetJobState.QUEUED) {
        return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits: [] } as PlacementOutcome, live: [] as LiveFleetJobEvent[] };
      }
      const repo = await this.repo.findRepo(job.repoId);
      if (!repo) throw new Error(`fleet repo ${job.repoId} missing for job ${job.id}`);
      const pauses = await this.budgets.snapshot(now);
      // S1b §2.3 shared pre-assign check: a job whose scope paused after it was queued is cancelled, never assigned.
      const paused = jobScopePause(job, (keys) => pauses.match(keys));
      if (paused) {
        return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits: [] } as PlacementOutcome, live: [await this.cancelForPause(job, paused.id, now)] };
      }
      const ids = await this.repo.lockRunners(job.pinnedRunnerId ? [job.pinnedRunnerId] : undefined);
      // Review 2a BUG-3: a pinned runner's state can change between FleetJobsService.dispatch's
      // pre-tx evaluatePinned and the in-tx lock here. Re-evaluate; surface the same verdicts.
      if (job.pinnedRunnerId && ids.length === 0) {
        // The pinned runner was deleted between verdict and lock; the controller already
        // turned that into 404 at dispatch time, but a requeue or fillRunner can reach here.
        // Empty misfits is the documented accepted race for delete.
        return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits: [] } as PlacementOutcome, live: [] };
      }
      const runners = await this.repo.findPlacementRunners(ids);
      const loads = toLoads(await this.repo.findActiveLoads(ids));
      const threadAssign = isThreadKind(job.command) ? await this.repo.findThreadAssign(job.id) : null;
      const placementJob = toPlacementJob(job, repo, isThreadKind(job.command) && threadAssign ? { backend: threadAssign.backend, enabled: this.fleetConfig.threadsEnabled, action: threadAssign.action, kind: threadAssign.kind, mode: threadAssign.mode } : undefined);
      const evaluated = evaluateRunners(await this.judgedJob(placementJob, runners, new Map()), runners, loads, (id) => pauses.runnerPaused(id), now, this.fleetConfig.runnerOfflineSec);
      const misfits = evaluated
        .filter((e) => e.reason !== null)
        .map((e) => ({ runnerId: e.runner.id, name: e.runner.name, reason: e.reason as MisfitReason }));
      const [best] = orderCandidates(evaluated.filter((e) => e.reason === null));
      if (!best) return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits }, live: [] };
      const assigned = await this.assign(job, repo, best.runner, now);
      if (!assigned) return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits }, live: [] };
      return { outcome: { assigned: true, runnerId: best.runner.id, leaseEpoch: assigned.leaseEpoch, misfits }, live: [assigned.live] };
    });
    this.live.publish(live);
    if (outcome.runnerId) this.notifier.notify(outcome.runnerId);
    return outcome;
  }

  /** Assigns up to min(freeSlots, capacity - active) QUEUED jobs to one runner; returns how many were assigned. */
  async fillRunner(runnerId: string, freeSlots: number, now = new Date()): Promise<number> {
    if (freeSlots <= 0) return 0;
    const { live, assigned } = await this.txManager.run(async () => {
      const locked = await this.repo.lockRunners([runnerId]);
      const [row] = await this.repo.findPlacementRunners(locked);
      if (!row || !row.enabled) return { live: [] as LiveFleetJobEvent[], assigned: 0 };
      const pauses = await this.budgets.snapshot(now);
      const runner = { ...row, budgetPaused: pauses.runnerPaused(row.id) };
      let load = toLoads(await this.repo.findActiveLoads([runner.id])).get(runner.id) ?? EMPTY_LOAD;
      let slots = Math.min(freeSlots, runner.capacity - load.active);
      const events: LiveFleetJobEvent[] = [];
      const vault: VaultMemo = new Map();
      let count = 0;
      // US-004: SQL decides which jobs this runner can take, and the scan pages past a full page of per-job misfits.
      await this.scanQueuedCandidates({ runnerId: runner.id, threads: false }, () => slots <= 0, async (id) => {
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED || isThreadKind(job.command)) return;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) return;
        // S1b §2.3: the same pre-assign check as placeJob.
        const paused = jobScopePause(job, (keys) => pauses.match(keys));
        if (paused) {
          events.push(await this.cancelForPause(job, paused.id, now));
          return;
        }
        const repo = await this.repo.findRepo(job.repoId);
        if (!repo || firstMisfit(await this.judgedJob(toPlacementJob(job, repo), [runner], vault), runner, load, now, this.fleetConfig.runnerOfflineSec) !== null) return;
        const done = await this.assign(job, repo, runner, now);
        if (!done) return;
        events.push(done.live);
        count += 1;
        slots -= 1;
        // The next job in this same pass must see the load this assignment created: occupancy covers
        // capacity, the repository and the trust domain (US-004), not only the counter.
        load = addJobToLoad(load, { runnerId: runner.id, repoId: job.repoId, command: job.command, projectId: job.projectId, bashMode: job.bashMode });
      });
      return { live: events, assigned: count };
    });
    this.live.publish(live);
    if (assigned > 0) this.notifier.notify(runnerId);
    return assigned;
  }

  async fillRunnerThreads(runnerId: string, now = new Date()): Promise<void> {
    const { live, assigned } = await this.txManager.run(async () => {
      const locked = await this.repo.lockRunners([runnerId]);
      const [runner] = await this.repo.findPlacementRunners(locked);
      if (!runner || !runner.enabled) return { live: [] as LiveFleetJobEvent[], assigned: 0 };
      const pauses = await this.budgets.snapshot(now);
      const candidate = { ...runner, budgetPaused: pauses.runnerPaused(runner.id) };
      let load = toLoads(await this.repo.findActiveLoads([runner.id])).get(runner.id) ?? EMPTY_LOAD;
      let slots = (runner.threadCapacity ?? 0) - (load.threads ?? 0);
      const events: LiveFleetJobEvent[] = [];
      let count = 0;
      // US-004: the thread scan pages the same way, filtered to THREAD jobs this runner may host.
      await this.scanQueuedCandidates({ runnerId: runner.id, threads: true }, () => slots <= 0, async (id) => {
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED || !isThreadKind(job.command)) return;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) return;
        const paused = jobScopePause(job, (keys) => pauses.match(keys));
        if (paused) { events.push(await this.cancelForPause(job, paused.id, now)); return; }
        const [repo, thread] = await Promise.all([this.repo.findRepo(job.repoId), this.repo.findThreadAssign(job.id)]);
        // A THREAD job without its turn (or repo) is a broken row, not a reason to fail the whole
        // sync: skip it the way fillRunner skips a missing repo (one failing job in a sync is
        // logged and skipped, never allowed to fail the request).
        if (!repo || !thread) return;
        const placementJob = toPlacementJob(job, repo, { backend: thread.backend, enabled: this.fleetConfig.threadsEnabled, action: thread.action, kind: thread.kind, mode: thread.mode });
        if (firstMisfit(placementJob, candidate, load, now, this.fleetConfig.runnerOfflineSec) !== null) return;
        const done = await this.assign(job, repo, runner, now);
        if (!done) return;
        events.push(done.live);
        count += 1;
        slots -= 1;
        // Carry the assigned job into the load the next candidate is judged on, so a later turn of
        // another project's thread (or another slot) sees it (US-004).
        load = addJobToLoad(load, { runnerId: runner.id, repoId: job.repoId, command: job.command, projectId: job.projectId, bashMode: job.bashMode });
      });
      return { live: events, assigned: count };
    });
    this.live.publish(live);
    if (assigned > 0) this.notifier.notify(runnerId);
  }

  /**
   * US-004: reads the QUEUED candidates this runner can take in keyset pages, visiting each id in order. The scan
   * stops when `noSlotsLeft()` reports the fill is done, when a page comes back short (the queue is exhausted), or at
   * MAX_QUEUED_SCAN_PAGES. Only a per-job check can still drop a candidate (a lock SKIP LOCKED lost, a state change, a
   * misfit), so a full page of drops pages on instead of starving every newer job. Running out of pages with slots
   * still free means the queue is starving this runner: `.nax/rules/api-data.md` wants that surfaced at warn level.
   */
  private async scanQueuedCandidates(filter: QueuedScanFilter, noSlotsLeft: () => boolean, visit: (id: string) => Promise<void>): Promise<void> {
    let after: QueuedCursor | null = null;
    for (let page = 0; page < MAX_QUEUED_SCAN_PAGES; page += 1) {
      if (noSlotsLeft()) return;
      const rows = await this.repo.findQueuedPage(filter, QUEUED_SCAN_LIMIT, after);
      for (const row of rows) {
        after = row;
        await visit(row.id);
        if (noSlotsLeft()) return;
      }
      if (rows.length < QUEUED_SCAN_LIMIT) return;
    }
    if (!noSlotsLeft()) {
      this.logger.warn(`queued scan for runner ${filter.runnerId} stopped at ${MAX_QUEUED_SCAN_PAGES} pages of ${QUEUED_SCAN_LIMIT}: later candidates wait for the next sync`);
    }
  }

  /** S1b §2.3: cancel a QUEUED job in a paused scope. The transition's activity row names the policy (plan D170). */
  private async cancelForPause(job: FleetJobRecord, policyId: string, now: Date): Promise<LiveFleetJobEvent> {
    const reason = budgetReason(policyId);
    const r = await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'server', now, actor: SYSTEM_ACTOR, reason, extra: { cancelReason: reason } });
    await runAsSystem('budget', () => this.audit.record({
      key: 'system.budget.window-reset', resourceType: 'fleet-job', resourceId: job.id, projectId: job.projectId,
      summary: `QUEUED -> CANCELLED: budget ${policyId} paused`,
    }));
    return r.live;
  }

  private async assign(job: FleetJobRecord, repo: FleetRepoRef, runner: PlacementRunnerRow, now: Date): Promise<{ leaseEpoch: number; live: LiveFleetJobEvent } | null> {
    return bookkeeping('fleet.placement', async () => {
    const thread = isThreadKind(job.command) ? await this.repo.findThreadAssign(job.id) : undefined;
    // The caller guarantees a thread job has its turn; a broken row is a no-op, never a 500.
    if (isThreadKind(job.command) && !thread) return null;
    // US-008 (#370): the repo's rule override is read here, inside the placement transaction, so the job is
    // assigned the override the repo holds at this moment. A THREAD turn and a config job read nothing and
    // write nothing: they never carry an override (the designer's call, 2026-11-10).
    const withOverride = carriesRuleOverride(job.command);
    const ruleOverride = withOverride ? await this.repo.findRuleOverride(job.repoId) : null;
    const leaseEpoch = await this.repo.casAssign(job.id, runner.id, runner.bootId, now);
    if (leaseEpoch === null) return null; // another placement won (spec §6.1)
    // The summary is written before the job is read back, so the record the ASSIGN and the transition use
    // already carries it.
    if (withOverride) await this.repo.setRuleOverrideSummary(job.id, ruleOverrideSummaryOf(ruleOverride));
    const after = await this.repo.findById(job.id);
    if (!after) return null;
    const payload = buildAssignPayload(after, repo, cloneUrlFor(repo, this.vcsConfig), gitIdentityFor(repo.provider, this.fleetConfig), await this.attachProjectRepos(withKodaTools(thread, runner.capabilities), job, runner.capabilities), ruleOverride);
    if (thread) await this.repo.pinThreadRunner(thread.threadId, runner.id);
    await this.repo.createCommand({ runnerId: runner.id, jobId: job.id, type: FleetCommandType.ASSIGN, leaseEpoch, payload });
    const live = await this.transitions.record({ before: job, after, by: 'server', now, actor: SYSTEM_ACTOR, reason: `assigned to ${runner.name}` });
    return { leaseEpoch, live };
    });
  }

  /**
   * 1c-b-D7: only a PROJECT SESSION on a runner advertising `projectCode` reads the project's repositories; a runner
   * without the capability keeps the thread block as the repository read it — it must not even read the repository
   * list — and is told why on the session it starts (1c-b-D8). The read runs inside the placement transaction, so the
   * list the ASSIGN publishes is the list the token fence recomputes from the same rows (1c-b-D5).
   */
  private async attachProjectRepos(thread: ThreadAssign | undefined, job: FleetJobRecord, capabilities: RunnerCapabilities): Promise<ThreadAssign | undefined> {
    if (!thread || thread.kind !== 'PROJECT' || thread.action !== 'SESSION' || capabilities.projectCode !== true) return thread;
    return withProjectRepos(thread, await this.repo.findProjectRepos(job.projectId), this.vcsConfig);
  }
}

/**
 * 1b-D3 (S5b-R9): only a SESSION turn on a runner advertising `kodaTools` carries the descriptor catalog, so the
 * session can proxy koda reads. Publish and Discard run no agent, and a runner that does not advertise the
 * capability would refuse the ASSIGN (US-006), so both keep the thread block as the repository read it.
 * The catalog is per kind (1d2-D2): a WORKSPACE session gets `koda_my_projects` and the project argument, while a
 * REPO or PROJECT session gets the catalog as it is. The descriptors come from the plain `koda-tool-descriptors`
 * module: placement never imports the assistant module.
 */
function withKodaTools(thread: ThreadAssign | undefined, capabilities: RunnerCapabilities): ThreadAssign | undefined {
  if (!thread || thread.action !== 'SESSION' || capabilities.kodaTools !== true) return thread;
  return { ...thread, kodaTools: [...kodaToolDescriptorsFor(thread.kind ?? 'REPO')] };
}
