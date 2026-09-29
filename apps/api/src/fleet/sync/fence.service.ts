import { Inject, Injectable, Logger } from '@nestjs/common';
import { FleetCommandType } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';

/** Spec §6.2: only the job's current (runnerId, leaseEpoch) may write; anyone else gets ABANDON. */
@Injectable()
export class FenceService {
  private readonly logger = new Logger(FenceService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'findPendingCommand' | 'createCommand'>,
    private readonly activity: FleetActivityService,
  ) {}

  holds(job: Pick<FleetJobRecord, 'runnerId' | 'leaseEpoch'>, runnerId: string, leaseEpoch: number): boolean {
    return job.runnerId === runnerId && job.leaseEpoch === leaseEpoch;
  }

  /** Inside txManager.run. Queues ABANDON unless one is already pending for (runner, job, epoch). */
  async abandon(runnerId: string, job: FleetJobRecord, leaseEpoch: number): Promise<boolean> {
    if (await this.repo.findPendingCommand({ jobId: job.id, type: FleetCommandType.ABANDON, runnerId, leaseEpoch })) return false;
    // Only reached when the caller does not hold the lease, so the reason is always a stale lease.
    // (`job_terminal` stays in the protocol union for a later "job ended under you" signal.)
    const reason = 'stale_lease';
    await this.repo.createCommand({ runnerId, jobId: job.id, type: FleetCommandType.ABANDON, leaseEpoch, payload: { reason } });
    await this.activity.record({
      actorType: 'SYSTEM', actorId: 'system', action: 'job.abandon_queued', entityType: 'job', entityId: job.id, jobId: job.id,
      projectId: job.projectId, responsibleUserId: job.requestedById, payload: { runnerId, leaseEpoch, reason },
    });
    this.logger.warn(`Fenced runner ${runnerId} on job ${job.id}: holds epoch ${leaseEpoch}, current ${job.leaseEpoch}`);
    return true;
  }
}
