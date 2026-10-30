import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ApprovalCloser } from './approval-closer';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/** One tick attempts at most this many asks; each close gets its own short transaction. */
export const MAX_POLICY_ASKS_PER_TICK = 100;

export interface PolicyAskCloseResult {
  /** Asks settled by this tick. */
  closed: number;
  /** Asks whose close threw; the tick carried on with the next one. */
  failed: number;
}

/**
 * Finishes a bounded policy close (permissions P3 US-007, fix round 2). `ApprovalCloser.closeForPolicy` runs inside the
 * caller's transaction — a delete, a resume, a rollover, a supersede — and must not hold it open for an unbounded
 * backlog, nor wait on a request an in-flight decide holds. So it stamps the resolution it intends on every pending ask
 * of the policy (`FleetApprovalAsk.pendingResolvedBy`) and settles what it can; this sweeper drains the rest.
 *
 * The queue is durable and self-describing: a link with a persisted close whose request is still pending is work, and
 * it carries the *whole* close that action chose — resolution, status, actor and outcome — so a leftover of a delete
 * still closes `policy_deleted` after the policy row is gone, and a leftover of a resume still records the raised
 * amount, its re-queues and the resumer (fix round 3). Scheduling
 * skip-locks requests and links and moves the batch to the tail before any close is attempted, so neither a held ask
 * nor a failing one can hide later work, even across restarts.
 */
@Injectable()
@SystemWriter('system.approval.expire')
export class PolicyAskCloseSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyAskCloseSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: FleetApprovalAskStore,
    private readonly closer: ApprovalCloser,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled' | 'approvalSweepMs'>,
    private readonly audit: AuditRecorder,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Policy ask close sweep failed: ${reason(error)}`));
    }, this.fleetConfig.approvalSweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = new Date()): Promise<PolicyAskCloseResult> {
    return runAsSystemWriter(this, () => this.drain(now));
  }

  private async drain(now: Date): Promise<PolicyAskCloseResult> {
    const result: PolicyAskCloseResult = { closed: 0, failed: 0 };
    const batch = await this.txManager.run(() => this.store.claimPendingPolicyAsks(MAX_POLICY_ASKS_PER_TICK));
    if (batch.length >= MAX_POLICY_ASKS_PER_TICK) {
      this.logger.warn(`Policy ask close sweep reached ${MAX_POLICY_ASKS_PER_TICK} attempts; the next tick continues the queue`);
    }

    for (const ask of batch) {
      try {
        const change = await this.txManager.run(async () => {
          // The close the action intended, replayed verbatim: the same resolution, status, actor and outcome. A policy
          // deleted after the action ran changes nothing here — the intent is on the link.
          const closed = await this.closer.closePolicyAsk(ask.requestId, ask.pendingClose, now);
          if (closed.approval !== null) {
            // The audit and every cancellation write commit or roll back together, per close.
            await this.audit.record({
              key: 'system.approval.expire', resourceType: 'fleet-approval', resourceId: ask.requestId,
              projectId: ask.projectId, summary: `policy close continued: ${ask.pendingClose.resolvedBy}`,
            });
          }
          return closed;
        });
        if (change.approval !== null) {
          result.closed += 1;
        }
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Ask ${ask.requestId}: policy ask close failed: ${reason(error)}`);
      }
    }
    return result;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
