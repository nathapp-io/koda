import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY, FleetApprovalRecord, IApprovalRepository } from './domain/approval.domain';

const MAX_PER_TICK = 100;

export interface ApprovalExpiryResult { expired: number; failed: number }

/** Spec §2.4: expires pending bash asks past `expiresAt` (nax has already denied them). Budget asks never expire. */
@Injectable()
export class ApprovalExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalExpirySweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: Pick<IApprovalRepository, 'findExpiredPending' | 'lockById'>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById'>,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled' | 'approvalSweepMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Approval expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.fleetConfig.approvalSweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<ApprovalExpiryResult> {
    const result: ApprovalExpiryResult = { expired: 0, failed: 0 };
    for (const due of await this.repo.findExpiredPending(now, MAX_PER_TICK)) {
      try {
        const live = await this.txManager.run(() => this.expireOne(due, now));
        if (live) {
          this.live.publish(live);
          result.expired += 1;
        }
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Approval ${due.id} not expired: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /** Lock order job -> approval (spec §1.4); re-checks under the lock, since a decide may have won. */
  private async expireOne(due: FleetApprovalRecord, now: Date): Promise<LiveFleetApprovalEvent[] | null> {
    const job = due.jobId ? await this.jobs.lockById(due.jobId) : null;
    const locked = await this.repo.lockById(due.id);
    if (!job || !locked || locked.status !== 'pending' || !locked.expiresAt || locked.expiresAt.getTime() > now.getTime()) return null;
    return (await this.closer.expire(locked, job, now)).live;
  }
}
