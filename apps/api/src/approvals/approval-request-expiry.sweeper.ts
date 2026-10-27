import { SystemWriter } from '../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { FLEET_CFG, type IFleetConfig } from '../config/fleet.config';
import { ApprovalExecutionService } from './approval-execution.service';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalRequestNotPendingError } from './domain/approval.errors';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { ApprovalRequestEvents } from './approval-request-events';

/** At most this many requests settle in one tick; a longer backlog waits for the next one. */
export const MAX_PER_TICK = 100;
export const STALE_APPROVED_AFTER_MS = 300_000;

export interface ApprovalRequestExpiryResult {
  /** Settled `expired` because nobody decided in time. */
  expired: number;
  /** Moved to `approved` by `onTimeout: 'approve'`, whatever its execution then ended as. */
  approved: number;
  /** Requests whose settlement — or whose timeout execution — threw; the sweep carried on. */
  failed: number;
}

/**
 * P3 approval core US-012: settles the approval requests nobody decided before their `expiresAt`.
 *
 * `onTimeout: 'reject'` (the default) expires the request; `onTimeout: 'approve'` moves it to
 * `approved` — as if a principal had approved it — and then runs the frozen command through
 * `ApprovalExecutionService` after the settling transaction commits. Each request owns its
 * transaction and row lock, so one failure costs only that request. Bash asks on ended jobs are
 * excluded before the batch limit and rechecked under lock: the fleet's durable continuation owns
 * their `cancelled`/`job_ended` settlement, regardless of deadline or timeout policy.
 *
 * The interval reuses the fleet approval sweep window (`fleetConfig.approvalSweepMs`, gated by
 * `fleetConfig.sweepEnabled`), and only this class settles these requests as a system writer: it
 * writes no `ApprovalDecision` row and publishes no live event.
 */
@Injectable()
@SystemWriter('system.approval.expire')
export class ApprovalRequestExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalRequestExpirySweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly requests: PrismaApprovalRequestRepository,
    private readonly audit: AuditRecorder,
    private readonly execution: ApprovalExecutionService,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled' | 'approvalSweepMs'>,
    private readonly events: ApprovalRequestEvents,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(async () => {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error(`Approval request expiry sweep failed: ${reason(error)}`);
      }
      try {
        await this.retryStale();
      } catch (error) {
        this.logger.error(`Approval request stale retry failed: ${reason(error)}`);
      }
    }, this.fleetConfig.approvalSweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The background entry, so the whole sweep runs inside this writer's `system.approval.expire`
   * component: an audit entry it records names SYSTEM/approval.
   */
  tick(now = new Date()): Promise<ApprovalRequestExpiryResult> {
    return runAsSystemWriter(this, () => this.settleDue(now));
  }

  retryStale(now = new Date()): Promise<{ retried: number; failed: number }> {
    return runAsSystemWriter(this, async () => {
      const result = { retried: 0, failed: 0 };
      const stale = await this.requests.findStaleApproved(
        new Date(now.getTime() - STALE_APPROVED_AFTER_MS), MAX_PER_TICK,
      );
      for (const request of stale) {
        try {
          await this.execution.execute(request.id, now);
          result.retried += 1;
        } catch (error) {
          if (error instanceof ApprovalRequestNotPendingError) continue;
          result.failed += 1;
          this.logger.warn(`Approval request ${request.id} stale retry failed: ${reason(error)}`);
        }
      }
      return result;
    });
  }

  private async settleDue(now: Date): Promise<ApprovalRequestExpiryResult> {
    const result: ApprovalRequestExpiryResult = { expired: 0, approved: 0, failed: 0 };
    for (const due of await this.requests.findDue(now, MAX_PER_TICK)) {
      let settled: ApprovalRequestRecord | null;
      try {
        settled = await this.txManager.run(() => this.settleOne(due, now));
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Approval request ${due.id} not settled: ${reason(error)}`);
        continue;
      }
      if (settled === null) continue;
      if (settled.status === 'expired') {
        result.expired += 1;
        continue;
      }

      // Counted as approved before its execution, which ends on its own: a command that throws or
      // fails its pre-checks still leaves the request approved by the timeout.
      result.approved += 1;
      try {
        await this.execution.execute(settled.id);
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Approval request ${settled.id} not executed: ${reason(error)}`);
      }
    }
    return result;
  }

  /**
   * Settles one due request inside the caller's transaction. The lock plus the re-check make a decide
   * or a concurrent tick that won the race harmless — null means "nothing to do", never a failure.
   */
  private async settleOne(due: ApprovalRequestRecord, now: Date): Promise<ApprovalRequestRecord | null> {
    const locked = await this.requests.lockById(due.id);
    if (!locked || locked.status !== 'pending' || locked.expiresAt.getTime() > now.getTime()) return null;
    // An ended job's cancellation backlog belongs to the fleet continuation, not timeout policy.
    if (!await this.requests.canSettleTimeout(locked.id)) return null;

    const approved = locked.onTimeout === 'approve';
    const settled = await this.requests.transition(locked.id, 'pending', approved
      // No approver at all: the timeout released it, so nothing but the clock satisfies the mode.
      ? { status: 'approved', decidedAt: now, satisfiedBy: 'none' }
      : { status: 'expired', settledAt: now });
    // The row is locked by this transaction, so a lost transition means a broken boundary: throw so the
    // transaction rolls back, instead of recording an entry for a settlement that did not happen.
    if (!settled) throw new ApprovalRequestNotPendingError(locked.status);
    await this.events.record(settled);

    await this.audit.record({
      key: 'system.approval.expire',
      resourceType: 'approval-request',
      resourceId: locked.id,
      projectId: locked.projectId,
      summary: `${approved ? 'approved on timeout' : 'expired'} ${locked.permissionKey}`,
    });
    return settled;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
