import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { cloneUrlFor } from '../git-broker/clone-url';
import { buildAssignPayload, gitIdentityFor } from './assign-payload';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import { EMPTY_LOAD, firstMisfit, MisfitReason, orderCandidates, PlacementJob, RunnerLoad } from './placement-rules';
import { RunnerNotifier } from './runner-notifier';
import {
  ActiveJobRef, FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository, PlacementRunnerRow,
} from './domain/fleet-job.domain';

export interface PlacementOutcome {
  assigned: boolean;
  runnerId: string | null;
  leaseEpoch: number | null;
  misfits: Array<{ runnerId: string; name: string; reason: MisfitReason }>;
}

/** Oldest-first scan window per fill. 50 unplaceable old jobs can hide newer ones from a runner; fine at S1 scale (home fleet). */
const QUEUED_SCAN_LIMIT = 50;

const toLoads = (refs: readonly ActiveJobRef[]): ReadonlyMap<string, RunnerLoad> =>
  refs.reduce((acc, { runnerId, repoId }) => {
    const prev = acc.get(runnerId) ?? EMPTY_LOAD;
    return new Map([...acc, [runnerId, { active: prev.active + 1, repoIds: new Set([...prev.repoIds, repoId]) }]]);
  }, new Map<string, RunnerLoad>());

export const toPlacementJob = (job: Pick<FleetJobRecord, 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId'>, repo: Pick<FleetRepoRef, 'provider'>): PlacementJob => ({
  repoId: job.repoId, provider: repo.provider, profiles: job.profiles, selectorLabels: job.selectorLabels, pinnedRunnerId: job.pinnedRunnerId,
});

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
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>,
  ) {}

  /** Dispatch-time check of a pin (spec §4): null = fits now, a reason = does not, 'not_found' = no such runner. */
  async evaluatePinned(pinnedRunnerId: string, job: PlacementJob, now = new Date()): Promise<MisfitReason | null | 'not_found'> {
    const [runner] = await this.repo.findPlacementRunners([pinnedRunnerId]);
    if (!runner) return 'not_found';
    const loads = toLoads(await this.repo.findActiveLoads([runner.id]));
    return firstMisfit(job, runner, loads.get(runner.id) ?? EMPTY_LOAD, now, this.fleetConfig.runnerOfflineSec);
  }

  async placeJob(jobId: string, now = new Date()): Promise<PlacementOutcome> {
    const { outcome, live } = await this.txManager.run(async () => {
      const job = await this.repo.lockById(jobId);
      if (!job || job.state !== FleetJobState.QUEUED) {
        return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits: [] } as PlacementOutcome, live: [] as LiveFleetJobEvent[] };
      }
      const repo = await this.repo.findRepo(job.repoId);
      if (!repo) throw new Error(`fleet repo ${job.repoId} missing for job ${job.id}`);
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
      const placementJob = toPlacementJob(job, repo);
      const evaluated = runners.map((runner) => {
        const load = loads.get(runner.id) ?? EMPTY_LOAD;
        return { runner, load, reason: firstMisfit(placementJob, runner, load, now, this.fleetConfig.runnerOfflineSec) };
      });
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

  /** Assigns up to min(freeSlots, capacity - active) QUEUED jobs to one runner; returns how many. */
  async fillRunner(runnerId: string, freeSlots: number, now = new Date()): Promise<number> {
    if (freeSlots <= 0) return 0;
    const live = await this.txManager.run(async () => {
      const locked = await this.repo.lockRunners([runnerId]);
      const [runner] = await this.repo.findPlacementRunners(locked);
      if (!runner || !runner.enabled) return [] as LiveFleetJobEvent[];
      let load = toLoads(await this.repo.findActiveLoads([runner.id])).get(runner.id) ?? EMPTY_LOAD;
      let slots = Math.min(freeSlots, runner.capacity - load.active);
      const events: LiveFleetJobEvent[] = [];
      for (const id of slots > 0 ? await this.repo.findQueuedIds(QUEUED_SCAN_LIMIT) : []) {
        if (slots <= 0) break;
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED) continue;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) continue;
        const repo = await this.repo.findRepo(job.repoId);
        if (!repo || firstMisfit(toPlacementJob(job, repo), runner, load, now, this.fleetConfig.runnerOfflineSec) !== null) continue;
        const assigned = await this.assign(job, repo, runner, now);
        if (!assigned) continue;
        events.push(assigned.live);
        slots -= 1;
        load = { active: load.active + 1, repoIds: new Set([...load.repoIds, job.repoId]) };
      }
      return events;
    });
    this.live.publish(live);
    if (live.length > 0) this.notifier.notify(runnerId);
    return live.length;
  }

  private async assign(job: FleetJobRecord, repo: FleetRepoRef, runner: PlacementRunnerRow, now: Date): Promise<{ leaseEpoch: number; live: LiveFleetJobEvent } | null> {
    const leaseEpoch = await this.repo.casAssign(job.id, runner.id, runner.bootId, now);
    if (leaseEpoch === null) return null; // another placement won (spec §6.1)
    const after = await this.repo.findById(job.id);
    if (!after) return null;
    const payload = buildAssignPayload(after, repo, cloneUrlFor(repo, this.vcsConfig), gitIdentityFor(repo.provider, this.fleetConfig));
    await this.repo.createCommand({ runnerId: runner.id, jobId: job.id, type: FleetCommandType.ASSIGN, leaseEpoch, payload });
    const live = await this.transitions.record({ before: job, after, by: 'server', now, actor: SYSTEM_ACTOR, reason: `assigned to ${runner.name}` });
    return { leaseEpoch, live };
  }
}
