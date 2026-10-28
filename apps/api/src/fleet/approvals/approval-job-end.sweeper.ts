import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/** A tick schedules at most this many individual asks; each close gets its own short transaction. */
export const MAX_ASKS_PER_TICK = 100;

export interface ApprovalJobEndResult {
  /** Distinct jobs the tick closed at least one ask for. */
  jobs: number;
  /** Asks settled `cancelled`/`job_ended` in this tick. */
  closed: number;
  /** Asks whose close threw; the tick carried on with the next one. */
  failed: number;
}

/**
 * Finishes the bounded job-end close a transition started. The durable queue is over individual asks, ordered by
 * the link's last update. Scheduling skip-locks requests and links, then moves the selected batch to the tail in
 * an audited transaction BEFORE trying any close. Thus neither held asks nor repeatedly failing jobs can hide
 * later work, even across restarts. A crash between scheduling and closing leaves the ask pending for a later
 * rotation. No in-memory cursor, job quota, or success-count termination can starve the queue's tail.
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

  tick(now = new Date()): Promise<ApprovalJobEndResult> {
    return runAsSystemWriter(this, () => this.drain(now));
  }

  private async drain(now: Date): Promise<ApprovalJobEndResult> {
    const result: ApprovalJobEndResult = { jobs: 0, closed: 0, failed: 0 };
    const batch = await this.txManager.run(async () => {
      const asks = await this.store.claimEndedJobAsks(MAX_ASKS_PER_TICK);
      // Account for the durable scheduling writes, even if every subsequent close fails or skips a held ask.
      for (const ask of asks) {
        await this.audit.record({
          key: 'system.approval.expire', resourceType: 'fleet-approval', resourceId: ask.requestId,
          projectId: ask.projectId, summary: 'job-end close scheduled',
        });
      }
      return asks;
    });
    if (batch.length >= MAX_ASKS_PER_TICK) {
      this.logger.warn(`Job-end ask sweep reached ${MAX_ASKS_PER_TICK} attempts; the next tick continues the durable queue`);
    }
    const closedJobs = new Set<string>(); // bounded by MAX_ASKS_PER_TICK
    for (const ask of batch) {
      try {
        const change = await this.txManager.run(async () => {
          const job = await this.jobs.findById(ask.jobId);
          // Re-check after scheduling: a requeued job may be running again, or may have been deleted.
          if (job === null || job.state === 'RUNNING') return { approval: null, live: [] };
          const closed = await this.closer.closeJobAsk(job, ask.requestId, now);
          if (closed.approval !== null) {
            // F2: the audit and ALL cancellation writes commit or roll back together, per close.
            await this.audit.record({
              key: 'system.approval.expire', resourceType: 'fleet-job', resourceId: job.id,
              projectId: job.projectId, summary: 'job-ended close: 1 ask',
            });
          }
          return closed;
        });
        if (change.approval !== null) {
          result.closed += 1;
          closedJobs.add(ask.jobId);
          if (change.live.length > 0) this.live.publish(change.live); // only after the audited cancellation commits
        }
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Ask ${ask.requestId}: job-end ask close failed: ${reason(error)}`);
      }
    }
    result.jobs = closedJobs.size;
    return result;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
