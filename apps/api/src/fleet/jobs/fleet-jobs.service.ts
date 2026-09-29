import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { normalizeDispatch } from './dispatch-input';
import { FleetDispatchException } from './fleet-dispatch.exception';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { canTransition, isTerminal } from './job-state';
import { JobTransitionsService } from './job-transitions.service';
import { RunnerNotifier } from './runner-notifier';
import { PERMANENT_MISFITS } from './placement-rules';
import { PlacementService, toPlacementJob } from './placement.service';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, FleetJobFilters, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { FleetJobEventDto } from './dto/fleet-job-event.dto';

@Injectable()
export class FleetJobsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly placement: PlacementService,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
    private readonly transitions: JobTransitionsService,
    private readonly notifier: RunnerNotifier,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Spec §5.1: validate, insert QUEUED (409 on an active duplicate), record, place. */
  async dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto): Promise<DispatchResultDto> {
    const repo = await this.repo.findRepo(dto.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const input = normalizeDispatch(dto, repo.defaultBranch);

    if (input.pinnedRunnerId) {
      const verdict = await this.placement.evaluatePinned(input.pinnedRunnerId, toPlacementJob(input, repo));
      if (verdict === 'not_found') throw new NotFoundAppException({}, 'fleet.runners');
      if (verdict !== null && PERMANENT_MISFITS.has(verdict)) throw new FleetDispatchException(verdict);
    }

    let job: FleetJobRecord;
    try {
      job = await this.txManager.run(async () => {
        const created = await this.repo.createJob({ ...input, projectId, requestedById: actorId });
        await this.repo.appendEvent(created.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({
          actorType: 'USER', actorId, action: 'job.dispatched', entityType: 'job', entityId: created.id, jobId: created.id,
          projectId, responsibleUserId: actorId, payload: { repoId: repo.id, feature: created.feature, command: created.command, ref: created.ref },
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
    return remapPage(await this.repo.findPage(filters, page), FleetJobDto.from);
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
      // runner assigned by casAssign, so runnerId is non-null here.
      const updated = await this.repo.update(jobId, { cancelRequestedAt: now });
      await this.repo.createCommand({ runnerId: current.runnerId as string, jobId, type: FleetCommandType.CANCEL, leaseEpoch: current.leaseEpoch, payload: {} });
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
        return this.transitions.apply({
          job: current, to: 'QUEUED', by: 'server', now, actor: { type: 'USER', id: actorId }, reason: 'requeued',
          extra: {
            runnerId: null, runnerBootId: null, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
            naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
            costSpentUsd: '0', lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null,
            resultBranch: null, resultSha: null, resultPrUrl: null, ackedRunnerSeq: 0, bumpEpoch: true,
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
