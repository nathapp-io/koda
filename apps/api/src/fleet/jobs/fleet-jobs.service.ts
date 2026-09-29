import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { normalizeDispatch } from './dispatch-input';
import { FleetDispatchException } from './fleet-dispatch.exception';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
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
