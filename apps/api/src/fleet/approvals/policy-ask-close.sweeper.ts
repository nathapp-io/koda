import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BUDGET_REPOSITORY, type BudgetPolicyRecord, type IBudgetRepository } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { ApprovalCloser, systemActor, type ApprovalActor } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
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
 * The queue is durable and self-describing: a link with an intent whose request is still pending is work, and it
 * carries the reason that action chose, so a leftover of a delete still closes `policy_deleted` after the policy row
 * is gone (a leftover of a rollover closes `window_reset`, not whatever the current state would derive). Scheduling
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
    @Inject(BUDGET_REPOSITORY) private readonly budgets: Pick<IBudgetRepository, 'findById'>,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
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
          // The policy row is gone after a delete: the close still happens, attributed to the system and the intent.
          const policy = await this.budgets.findById(ask.budgetPolicyId ?? '');
          const actor: ApprovalActor = policy === null ? deletedPolicyActor : systemActor(policy as BudgetPolicyRecord);
          const closed = await this.closer.closePolicyAsk(ask.requestId, {
            // A manual resume is the one resolution the fleet reports as `approved`; every other reason cancels.
            status: ask.pendingResolvedBy === 'manual_resume' ? 'approved' : 'cancelled',
            resolvedBy: ask.pendingResolvedBy, actor,
          }, now);
          if (closed.approval !== null) {
            // The audit and every cancellation write commit or roll back together, per close.
            await this.audit.record({
              key: 'system.approval.expire', resourceType: 'fleet-approval', resourceId: ask.requestId,
              projectId: ask.projectId, summary: `policy close continued: ${ask.pendingResolvedBy}`,
            });
          }
          return closed;
        });
        if (change.approval !== null) {
          result.closed += 1;
          if (change.live.length > 0) this.live.publish(change.live); // only after the audited close commits
        }
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Ask ${ask.requestId}: policy ask close failed: ${reason(error)}`);
      }
    }
    return result;
  }
}

/** The policy of a continued close has been deleted: there is no editor left to attribute it to. */
const deletedPolicyActor: ApprovalActor = { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: null };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
