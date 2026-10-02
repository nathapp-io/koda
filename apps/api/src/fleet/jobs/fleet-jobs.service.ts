import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { addUsd } from '../budgets/money';
import { BudgetGate } from '../budgets/budget-gate';
import { budgetReason, jobGateKeys } from '../budgets/budget-rules';
import { normalizeDispatch } from './dispatch-input';
import { FleetDispatchException } from './fleet-dispatch.exception';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { canTransition, isTerminal } from './job-state';
import { JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import { RunnerNotifier } from './runner-notifier';
import { PERMANENT_MISFITS } from './placement-rules';
import { PlacementService, toPlacementJob } from './placement.service';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, FleetJobFilters, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { FleetJobEventDto } from './dto/fleet-job-event.dto';

/** What a budget stop did to its jobs (plan D157). Publish `live` and notify `wake` after the transaction commits. */
export interface BudgetCancelResult {
  /** Ended on the server: QUEUED, or ASSIGNED whose ASSIGN was never acked. */
  cancelled: string[];
  /** cancelRequestedAt + one CANCEL; the runner reports CANCELLED and keeps the budget reason (plan D156). */
  requested: string[];
  live: LiveFleetJobEvent[];
  wake: string[];
}

@Injectable()
export class FleetJobsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly placement: PlacementService,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
    private readonly transitions: JobTransitionsService,
    private readonly notifier: RunnerNotifier,
    private readonly budgets: BudgetGate,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Spec §5.1: validate, insert QUEUED (409 on an active duplicate), record, place. */
  async dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto, opts: { scheduleId?: string } = {}): Promise<DispatchResultDto> {
    const repo = await this.repo.findRepo(dto.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const input = normalizeDispatch(dto, repo.defaultBranch);

    if (input.pinnedRunnerId) {
      const verdict = await this.placement.evaluatePinned(input.pinnedRunnerId, toPlacementJob(input, repo));
      if (verdict === 'not_found') throw new NotFoundAppException({}, 'fleet.runners');
      if (verdict !== null && PERMANENT_MISFITS.has(verdict)) throw new FleetDispatchException(verdict);
    }

    // S1b §2.3: no new job in a paused scope, the pinned runner's included.
    await this.budgets.assertNotPaused(jobGateKeys({ projectId, repoId: repo.id, pinnedRunnerId: input.pinnedRunnerId }), new Date());

    let job: FleetJobRecord;
    try {
      job = await this.txManager.run(async () => {
        const created = await this.repo.createJob({
          ...input, projectId, requestedById: actorId, ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
        });
        await this.repo.appendEvent(created.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({
          actorType: 'USER', actorId, action: 'job.dispatched', entityType: 'job', entityId: created.id, jobId: created.id,
          projectId, responsibleUserId: actorId,
          payload: { repoId: repo.id, feature: created.feature, command: created.command, ref: created.ref, ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}) },
        });
        return created;
      });
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      // The failed insert aborted that transaction; look the winner up outside it.
      const activeJobId = await this.repo.findActiveJobId(repo.id, input.feature);
      throw new ConflictAppException({ activeJobId: activeJobId ?? 'unknown' }, 'fleet.jobs');
    }

    this.live.publish([this.live.event(job)]);
    const outcome = await this.placement.placeJob(job.id);
    const fresh = (await this.repo.findById(job.id)) ?? job;
    return Object.assign(new DispatchResultDto(), {
      job: FleetJobDto.from(fresh),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }

  async list(filters: FleetJobFilters, page: IPageOption): Promise<IPageResult<FleetJobDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetJobDto.summary);
  }

  /**
   * Spec §5.3 cancel. QUEUED: server-side. ASSIGNED with the ASSIGN never acked: server-side,
   * the assign withdrawn and the epoch bumped (plan D4). Otherwise: cancelRequestedAt + one
   * CANCEL; the runner reports CANCELLED. Repeating a pending cancel is a no-op.
   */
  async cancel(actorId: string, projectId: string, jobId: string, canOperate: boolean): Promise<FleetJobDto> {
    const now = new Date();
    const actor = { type: 'USER' as const, id: actorId };
    const { job, live, wake } = await this.txManager.run(async () => {
      const current = await this.repo.lockById(jobId);
      if (!current || current.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
      if (!canOperate && current.requestedById !== actorId) throw new ForbiddenAppException({}, 'projects');
      if (isTerminal(current.state)) throw new ConflictAppException({ state: current.state }, 'fleet.jobState');

      if (current.state === FleetJobState.QUEUED) {
        const r = await this.transitions.apply({ job: current, to: 'CANCELLED', by: 'server', now, actor, reason: 'cancelled before assignment' });
        return { ...r, wake: null };
      }
      if (current.state === FleetJobState.ASSIGNED) {
        const unacked = await this.repo.findPendingCommand({ jobId, type: FleetCommandType.ASSIGN, leaseEpoch: current.leaseEpoch });
        if (unacked) {
          const r = await this.transitions.apply({ job: current, to: 'CANCELLED', by: 'server', now, actor, reason: 'cancelled before the runner took it' });
          return { ...r, wake: null };
        }
      }
      if (current.cancelRequestedAt) return { job: current, live: null, wake: null };
      // Reachable only in ASSIGNED (assign acked) / RUNNING / UPLOADING, all of which have a
      // runner assigned by casAssign. Fail fast if a future state change breaks that
      // invariant (DB FK on FleetCommand.runnerId would surface as a less obvious 500).
      if (!current.runnerId) throw new Error(`cancel path reached without runnerId for job ${jobId} (state ${current.state})`);
      const updated = await this.repo.update(jobId, { cancelRequestedAt: now });
      await this.repo.createCommand({ runnerId: current.runnerId, jobId, type: FleetCommandType.CANCEL, leaseEpoch: current.leaseEpoch, payload: {} });
      await this.repo.appendEvent(jobId, { leaseEpoch: current.leaseEpoch, runnerSeq: null, type: 'lifecycle', payload: { level: 'info', message: 'cancel requested' } });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'job.cancel_requested', entityType: 'job', entityId: jobId, jobId,
        projectId, responsibleUserId: current.requestedById, payload: { state: current.state },
      });
      return { job: updated, live: this.live.event(updated), wake: current.runnerId };
    });
    if (live) this.live.publish([live]);
    if (wake) this.notifier.notify(wake);
    return FleetJobDto.from(job);
  }

  /**
   * S1b §2.2 hard stop: the scope's QUEUED jobs, and (runningJobs = cancel) its ASSIGNED and RUNNING jobs.
   * A system action: the activity actor is SYSTEM, the responsible user the policy's last editor.
   * Call inside txManager.run (the evaluator holds the policy lock); jobs are re-checked under their own row lock.
   */
  async cancelForBudget(jobIds: readonly string[], policy: { id: string; responsibleUserId: string }, now = new Date()): Promise<BudgetCancelResult> {
    const reason = budgetReason(policy.id);
    const result: BudgetCancelResult = { cancelled: [], requested: [], live: [], wake: [] };
    for (const id of jobIds) {
      const job = await this.repo.lockById(id);
      if (!job || job.cancelRequestedAt) continue;
      const unacked = job.state === FleetJobState.ASSIGNED &&
        (await this.repo.findPendingCommand({ jobId: id, type: FleetCommandType.ASSIGN, leaseEpoch: job.leaseEpoch })) !== null;
      if (job.state === FleetJobState.QUEUED || unacked) {
        const r = await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'server', now, actor: SYSTEM_ACTOR, reason, extra: { cancelReason: reason } });
        result.cancelled.push(id);
        result.live.push(r.live);
        continue;
      }
      if ((job.state !== FleetJobState.ASSIGNED && job.state !== FleetJobState.RUNNING) || !job.runnerId) continue;
      const updated = await this.repo.update(id, { cancelRequestedAt: now, cancelReason: reason });
      await this.repo.createCommand({ runnerId: job.runnerId, jobId: id, type: FleetCommandType.CANCEL, leaseEpoch: job.leaseEpoch, payload: {} });
      await this.repo.appendEvent(id, { leaseEpoch: job.leaseEpoch, runnerSeq: null, type: 'lifecycle', payload: { level: 'info', message: `cancel requested (${reason})` } });
      await this.activity.record({
        actorType: 'SYSTEM', actorId: SYSTEM_ACTOR.id, action: 'job.cancel_requested', entityType: 'job', entityId: id, jobId: id,
        projectId: job.projectId, responsibleUserId: policy.responsibleUserId, payload: { state: job.state, reason },
      });
      result.requested.push(id);
      result.live.push(this.live.event(updated));
      result.wake.push(job.runnerId);
    }
    return result;
  }

  /** Spec §5.3 requeue: CRASHED | FAILED | CANCELLED -> QUEUED, run fields cleared, epoch + 1, then placement. */
  async requeue(actorId: string, projectId: string, jobId: string): Promise<DispatchResultDto> {
    const now = new Date();
    let queued: FleetJobRecord;
    let feature = '';
    let repoId = '';
    let liveEvent: LiveFleetJobEvent;
    try {
      const r = await this.txManager.run(async () => {
        const current = await this.repo.lockById(jobId);
        if (!current || current.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
        feature = current.feature;
        repoId = current.repoId;
        if (!canTransition(current.state, FleetJobState.QUEUED, 'server')) throw new ConflictAppException({ state: current.state }, 'fleet.jobState');
        await this.budgets.assertNotPaused(jobGateKeys(current), now);
        // Plan D4: a requeue is a fresh lease (the transition carries `bumpEpoch: true`).
        // Withdraw pending non-ABANDON commands from the prior epoch so a late runner
        // can no longer ack them, and so the next sync sees no orphan ASSIGN/CANCEL.
        // ABANDON rows are deliberately preserved (they are server-issued).
        await this.repo.withdrawPendingCommands(jobId, now);
        return this.transitions.apply({
          job: current, to: 'QUEUED', by: 'server', now, actor: { type: 'USER', id: actorId }, reason: 'requeued',
          extra: {
            runnerId: null, runnerBootId: null, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
            naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
            // S1b §2.1: requeue keeps spend; the attempt's cost moves into costCarriedUsd.
            costSpentUsd: '0', costCarriedUsd: addUsd(current.costCarriedUsd, current.costSpentUsd), cancelReason: null,
            lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null,
            resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,
            ackedRunnerSeq: 0, bumpEpoch: true,
          },
        });
      });
      queued = r.job;
      liveEvent = r.live;
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      const activeJobId = await this.repo.findActiveJobId(repoId, feature);
      throw new ConflictAppException({ activeJobId: activeJobId ?? 'unknown' }, 'fleet.jobs');
    }
    this.live.publish([liveEvent]);
    const outcome = await this.placement.placeJob(queued.id);
    const fresh = (await this.repo.findById(queued.id)) ?? queued;
    return Object.assign(new DispatchResultDto(), {
      job: FleetJobDto.from(fresh),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }

  async get(projectId: string, id: string): Promise<FleetJobDto> {
    return FleetJobDto.from(await this.findInProject(projectId, id));
  }

  async events(projectId: string, id: string, page: IPageOption): Promise<IPageResult<FleetJobEventDto>> {
    await this.findInProject(projectId, id);
    return remapPage(await this.repo.findEventPage(id, page), FleetJobEventDto.from);
  }

  protected async findInProject(projectId: string, id: string): Promise<FleetJobRecord> {
    const job = await this.repo.findById(id);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    return job;
  }
}
