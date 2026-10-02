import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ApprovalCloser, systemActor } from '../approvals/approval-closer';
import { ApprovalLivePublisher } from '../approvals/approval-live.publisher';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { BudgetEvaluator } from './budget-evaluator';
import { budgetActivityPayload } from './budget-payloads';
import { isStaleMonthlyPause, windowStart } from './budget-rules';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from './domain/budget.domain';

const SWEEP_INTERVAL_MS = 60_000;

export interface BudgetSweepResult {
  deleted: number;
  reset: number;
  evaluated: number;
  failed: number;
}

/**
 * S1b §2.2 sweep, on the FleetSweeper pattern: every 60 s it deletes policies whose scope row is gone,
 * clears monthly pauses from an earlier window (B8), and evaluates every policy (the B7 backstop).
 */
@Injectable()
export class BudgetSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BudgetSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly repo: IBudgetRepository,
    private readonly evaluator: BudgetEvaluator,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled'>,
    private readonly approvals: ApprovalCloser,
    private readonly approvalLive: ApprovalLivePublisher,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Budget sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One failing policy is logged and skipped; the rest still run. */
  async tick(now = new Date()): Promise<BudgetSweepResult> {
    const result: BudgetSweepResult = { deleted: 0, reset: 0, evaluated: 0, failed: 0 };
    for (const policy of await this.repo.findAll()) {
      try {
        if (!(await this.repo.scopeExists(policy))) {
          if (await this.deleteOrphan(policy.id)) result.deleted += 1;
          continue;
        }
        if (isStaleMonthlyPause(policy, now) && (await this.resetWindow(policy.id, now))) result.reset += 1;
        await this.evaluator.evaluate(policy.id, now);
        result.evaluated += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(`Budget sweep: policy ${policy.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /** S1b §2.1: a policy whose scope row is gone is deleted with its incidents; S1.5 closes its pending approval. */
  private async deleteOrphan(id: string): Promise<boolean> {
    const { deleted, live } = await this.txManager.run(async () => {
      const none: LiveFleetApprovalEvent[] = [];
      const policy = await this.repo.lockById(id);
      if (!policy || (await this.repo.scopeExists(policy))) return { deleted: false, live: none };
      const closed = await this.approvals.closeForPolicy(id, { status: 'cancelled', resolvedBy: 'policy_deleted', actor: systemActor(policy) }, new Date());
      await this.repo.delete(id);
      await this.record('budget.deleted', policy, { reason: 'scope_gone' });
      return { deleted: true, live: closed.live };
    });
    this.approvalLive.publish(live);
    return deleted;
  }

  /** B8: clear a monthly pause from an earlier window and record the rollover; S1.5 closes its pending approval. */
  private async resetWindow(id: string, now: Date): Promise<boolean> {
    const { reset, live } = await this.txManager.run(async () => {
      const none: LiveFleetApprovalEvent[] = [];
      const policy = await this.repo.lockById(id);
      if (!policy || !isStaleMonthlyPause(policy, now)) return { reset: false, live: none };
      const start = windowStart(policy.windowKind, now);
      const spent = await this.repo.windowSpend(policy, start);
      const closed = await this.approvals.closeForPolicy(id, { status: 'cancelled', resolvedBy: 'window_reset', actor: systemActor(policy) }, now);
      await this.repo.update(id, { pausedAt: null, pausedWindowStart: null });
      await this.repo.insertIncident({ policyId: id, kind: 'window_reset', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null, approvalId: closed.approval?.id ?? null });
      await this.record('budget.window_reset', policy, { spentUsd: spent, windowStart: start.toISOString() });
      return { reset: true, live: closed.live };
    });
    this.approvalLive.publish(live);
    return reset;
  }

  private record(action: string, policy: BudgetPolicyRecord, extra: Record<string, unknown>): Promise<void> {
    return this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR.id, action, entityType: 'budget', entityId: policy.id,
      projectId: policy.projectId, responsibleUserId: policy.updatedById, payload: budgetActivityPayload(policy, extra),
    });
  }
}
