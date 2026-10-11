import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { cloneUrlFor } from '../git-broker/clone-url';
import { BudgetGate } from '../budgets/budget-gate';
import { budgetReason } from '../budgets/budget-rules';
import { buildAssignPayload, gitIdentityFor } from './assign-payload';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import { EMPTY_LOAD, evaluateRunners, firstMisfit, jobScopePause, MisfitReason, orderCandidates, PlacementJob, QUEUED_SCAN_LIMIT, toLoads, toPlacementJob } from './placement-rules';
import { isThreadKind } from '../common/thread-jobs';
import { RunnerNotifier } from './runner-notifier';
import {
  FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository, PlacementRunnerRow,
} from './domain/fleet-job.domain';

export interface PlacementOutcome {
  assigned: boolean;
  runnerId: string | null;
  leaseEpoch: number | null;
  misfits: Array<{ runnerId: string; name: string; reason: MisfitReason }>;
}

/**
 * Spec §4 + §6.1. placeJob runs at dispatch and requeue; fillRunner when a runner syncs
 * with free slots. Runner rows are locked in id order before counting load; fillRunner
 * takes job rows with SKIP LOCKED, so the two never wait on each other in a cycle.
 */
@Injectable()
export class PlacementService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    private readonly budgets: BudgetGate,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>,
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
    return firstMisfit(job, { ...runner, budgetPaused }, loads.get(runner.id) ?? EMPTY_LOAD, now, this.fleetConfig.runnerOfflineSec);
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
      const placementJob = toPlacementJob(job, repo, isThreadKind(job.command) && threadAssign ? { backend: threadAssign.backend, enabled: this.fleetConfig.threadsEnabled } : undefined);
      const evaluated = evaluateRunners(placementJob, runners, loads, (id) => pauses.runnerPaused(id), now, this.fleetConfig.runnerOfflineSec);
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
      let count = 0;
      for (const id of slots > 0 ? await this.repo.findQueuedIds(QUEUED_SCAN_LIMIT) : []) {
        if (slots <= 0) break;
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED || isThreadKind(job.command)) continue;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) continue;
        // S1b §2.3: the same pre-assign check as placeJob.
        const paused = jobScopePause(job, (keys) => pauses.match(keys));
        if (paused) {
          events.push(await this.cancelForPause(job, paused.id, now));
          continue;
        }
        const repo = await this.repo.findRepo(job.repoId);
        if (!repo || firstMisfit(toPlacementJob(job, repo), runner, load, now, this.fleetConfig.runnerOfflineSec) !== null) continue;
        const done = await this.assign(job, repo, runner, now);
        if (!done) continue;
        events.push(done.live);
        count += 1;
        slots -= 1;
        load = { ...load, active: load.active + 1, repoIds: new Set([...load.repoIds, job.repoId]) };
      }
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
      const load = toLoads(await this.repo.findActiveLoads([runner.id])).get(runner.id) ?? EMPTY_LOAD;
      let slots = (runner.threadCapacity ?? 0) - (load.threads ?? 0);
      const events: LiveFleetJobEvent[] = [];
      let count = 0;
      for (const id of slots > 0 ? await this.repo.findQueuedIds(QUEUED_SCAN_LIMIT) : []) {
        if (slots <= 0) break;
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED || !isThreadKind(job.command)) continue;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) continue;
        const paused = jobScopePause(job, (keys) => pauses.match(keys));
        if (paused) { events.push(await this.cancelForPause(job, paused.id, now)); continue; }
        const [repo, thread] = await Promise.all([this.repo.findRepo(job.repoId), this.repo.findThreadAssign(job.id)]);
        // A THREAD job without its turn (or repo) is a broken row, not a reason to fail the whole
        // sync: skip it the way fillRunner skips a missing repo (one failing job in a sync is
        // logged and skipped, never allowed to fail the request).
        if (!repo || !thread) continue;
        const placementJob = toPlacementJob(job, repo, { backend: thread.backend, enabled: this.fleetConfig.threadsEnabled });
        const currentLoad = { ...load, threads: (runner.threadCapacity ?? 0) - slots };
        if (firstMisfit(placementJob, candidate, currentLoad, now, this.fleetConfig.runnerOfflineSec) !== null) continue;
        const done = await this.assign(job, repo, runner, now);
        if (!done) continue;
        events.push(done.live);
        count += 1;
        slots -= 1;
      }
      return { live: events, assigned: count };
    });
    this.live.publish(live);
    if (assigned > 0) this.notifier.notify(runnerId);
  }

  /** S1b §2.3: cancel a QUEUED job in a paused scope. The transition's activity row names the policy (plan D170). */
  private async cancelForPause(job: FleetJobRecord, policyId: string, now: Date): Promise<LiveFleetJobEvent> {
    const reason = budgetReason(policyId);
    const r = await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'server', now, actor: SYSTEM_ACTOR, reason, extra: { cancelReason: reason } });
    return r.live;
  }

  private async assign(job: FleetJobRecord, repo: FleetRepoRef, runner: PlacementRunnerRow, now: Date): Promise<{ leaseEpoch: number; live: LiveFleetJobEvent } | null> {
    const thread = isThreadKind(job.command) ? await this.repo.findThreadAssign(job.id) : undefined;
    // The caller guarantees a thread job has its turn; a broken row is a no-op, never a 500.
    if (isThreadKind(job.command) && !thread) return null;
    const leaseEpoch = await this.repo.casAssign(job.id, runner.id, runner.bootId, now);
    if (leaseEpoch === null) return null; // another placement won (spec §6.1)
    const after = await this.repo.findById(job.id);
    if (!after) return null;
    const payload = buildAssignPayload(after, repo, cloneUrlFor(repo, this.vcsConfig), gitIdentityFor(repo.provider, this.fleetConfig), thread ?? undefined);
    if (thread) await this.repo.pinThreadRunner(thread.threadId, runner.id);
    await this.repo.createCommand({ runnerId: runner.id, jobId: job.id, type: FleetCommandType.ASSIGN, leaseEpoch, payload });
    const live = await this.transitions.record({ before: job, after, by: 'server', now, actor: SYSTEM_ACTOR, reason: `assigned to ${runner.name}` });
    return { leaseEpoch, live };
  }
}
