import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/** How many jobs one tick drains, and how many bounded closes it runs for each of them. */
export const MAX_JOBS_PER_TICK = 10;
export const MAX_ROUNDS_PER_JOB = 5;

export interface ApprovalJobEndResult {
  /** Jobs the tick closed at least one ask for. */
  jobs: number;
  /** Asks settled `cancelled`/`job_ended` in this tick. */
  closed: number;
  /** Jobs whose close threw; the tick carried on with the next one. */
  failed: number;
}

/**
 * US-006 (F1 round 3): finishes the job-end close a job transition started.
 *
 * `ApprovalCloser.closeForJob` runs inside the job transition's interactive transaction, so it settles only
 * `MAX_ASKS_CLOSED_PER_CALL` asks — a runner can relay far more than one transaction can settle inside Prisma's
 * timeout, and an ask left pending would never get its `job_ended` cancellation. This processor is that
 * continuation: each tick finds the jobs that still have a pending ask but are no longer RUNNING and keeps calling
 * the bounded close, each call in its own transaction, until the job is empty or the per-tick round bound is hit.
 *
 * It is durable because it is a query, not an in-memory queue: a tick that crashes, or a job whose close left a
 * backlog, is picked up again on the next interval. The interval reuses the fleet approval sweep window, and the
 * close runs as the same `system.approval.expire` component the fleet's expiry sweeper writes under.
 */
@Injectable()
@SystemWriter('system.approval.expire')
export class ApprovalJobEndSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalJobEndSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: FleetApprovalAskStore,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled' | 'approvalSweepMs'>,
    private readonly audit: AuditRecorder,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Job-end ask sweep failed: ${reason(error)}`));
    }, this.fleetConfig.approvalSweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The background entry, so the sweep runs inside this writer's `system.approval.expire` component. */
  tick(now = new Date()): Promise<ApprovalJobEndResult> {
    return runAsSystemWriter(this, () => this.drain(now));
  }

  private async drain(now: Date): Promise<ApprovalJobEndResult> {
    const result: ApprovalJobEndResult = { jobs: 0, closed: 0, failed: 0 };
    for (const jobId of await this.store.findEndedJobPendingAsks(MAX_JOBS_PER_TICK)) {
      const job = await this.jobs.findById(jobId);
      // A job row that is gone has no requester left to attribute the close to; its asks still expire.
      if (job === null) continue;
      try {
        result.closed += await this.closeJob(job, now);
        result.jobs += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Job ${jobId}: job-end ask close failed: ${reason(error)}`);
      }
    }
    return result;
  }

  /** Repeated bounded closes, each in its own transaction, until the job has no pending ask or the round bound. */
  private async closeJob(job: FleetJobRecord, now: Date): Promise<number> {
    let closed = 0;
    for (let round = 0; round < MAX_ROUNDS_PER_JOB; round += 1) {
      const live = await this.txManager.run(() => this.closer.closeForJob(job, now));
      this.live.publish(live);
      closed += live.length;
      // Nothing settled: either the job is empty, or every ask left is held by an in-flight decide.
      if (live.length === 0) break;
      if ((await this.store.findPendingForJobPage(job.id, undefined, 1)).length === 0) break;
    }
    // One entry per drained job: the close writes rows, and a system writer must account for them.
    if (closed > 0) {
      await this.txManager.run(() => this.audit.record({
        key: 'system.approval.expire', resourceType: 'fleet-job', resourceId: job.id, projectId: job.projectId,
        summary: `job-ended close: ${closed} ask${closed === 1 ? '' : 's'}`,
      }));
    }
    return closed;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
