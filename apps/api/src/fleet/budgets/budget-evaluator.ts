import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { LiveFleetApprovalEvent, LiveFleetJobEvent } from '../../live/live-event';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ApprovalCloser } from '../approvals/approval-closer';
import { ApprovalLivePublisher } from '../approvals/approval-live.publisher';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { budgetActivityPayload, budgetWebhookPayload } from './budget-payloads';
import { hardReached, isEffectivelyPaused, spendSince, warnReached, windowStart } from './budget-rules';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from './domain/budget.domain';

const DEBOUNCE_MS = 1_000;

export interface EvaluationResult {
  /** A warn incident was inserted by this evaluation. */
  warned: boolean;
  /** This evaluation paused the policy. */
  stopped: boolean;
}

const NOTHING = Object.freeze({
  result: { warned: false, stopped: false }, live: [] as LiveFleetJobEvent[], approvalLive: [] as LiveFleetApprovalEvent[], wake: [] as string[],
});

/**
 * S1b §2.2 (B7). Signalled by JobReportProcessor after a sync changed a job's cost, debounced per scope key;
 * the BudgetSweeper calls `evaluate` every 60 s as the backstop. In process: the API is single-instance.
 */
@Injectable()
export class BudgetEvaluator implements OnModuleDestroy {
  private readonly logger = new Logger(BudgetEvaluator.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly repo: IBudgetRepository,
    private readonly jobs: FleetJobsService,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly approvals: ApprovalCloser,
    private readonly approvalLive: ApprovalLivePublisher,
  ) {}

  /** Never throws; a failed evaluation is logged and the sweep retries it. */
  signal(scopeKeys: readonly string[]): void {
    for (const key of new Set(scopeKeys)) {
      if (this.pending.has(key)) continue;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.evaluateScope(key).catch((error: unknown) =>
          this.logger.error(`Budget evaluation for ${key} failed: ${error instanceof Error ? error.message : String(error)}`));
      }, DEBOUNCE_MS);
      timer.unref();
      this.pending.set(key, timer);
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  async evaluateScope(scopeKey: string, now = new Date()): Promise<void> {
    for (const policy of await this.repo.findByScopeKeys([scopeKey])) await this.evaluate(policy.id, now);
  }

  /** One policy under its row lock: a debounced signal and the sweep can run at once. */
  async evaluate(policyId: string, now = new Date()): Promise<EvaluationResult> {
    const { result, live, approvalLive, wake } = await this.txManager.run(async () => {
      const policy = await this.repo.lockById(policyId);
      // A policy whose scope row is gone is ignored; the sweep deletes it (S1b §2.1).
      if (!policy || !(await this.repo.scopeExists(policy))) return NOTHING;
      const start = windowStart(policy.windowKind, now);
      const spent = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
      const warned = warnReached(spent, policy.amountUsd, policy.warnPercent) ? await this.warn(policy, start, spent) : false;
      if (!policy.hardStop || isEffectivelyPaused(policy, now) || !hardReached(spent, policy.amountUsd)) {
        return { ...NOTHING, result: { warned, stopped: false } };
      }
      const stop = await this.hardStop(policy, start, spent, now);
      return { result: { warned, stopped: true }, ...stop };
    });
    this.live.publish(live);
    this.approvalLive.publish(approvalLive);
    for (const runnerId of new Set(wake)) this.notifier.notify(runnerId);
    return result;
  }

  private async warn(policy: BudgetPolicyRecord, start: Date, spent: string): Promise<boolean> {
    const inserted = await this.repo.insertIncident({ policyId: policy.id, kind: 'warn', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null });
    if (!inserted) return false;
    await this.record('budget.warn', policy, { spentUsd: spent });
    if (policy.projectId) await this.webhooks.dispatch(policy.projectId, 'fleet.budget.warn', budgetWebhookPayload(policy, spent, start));
    return true;
  }

  /** S1.5 plan D227: the approval is opened first so the incident carries its id. */
  private async hardStop(policy: BudgetPolicyRecord, start: Date, spent: string, now: Date)
    : Promise<{ live: LiveFleetJobEvent[]; approvalLive: LiveFleetApprovalEvent[]; wake: string[] }> {
    await this.repo.update(policy.id, { pausedAt: now, pausedWindowStart: start });
    const opened = await this.approvals.openBudget(policy, { windowStart: start, spentUsd: spent }, now);
    const approvalId = opened.approval?.id ?? null;
    const inserted = await this.repo.insertIncident({
      policyId: policy.id, kind: 'hard_stop', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null, approvalId,
    });
    const queued = await this.repo.findQueuedJobIds(policy);
    const held = policy.runningJobs === 'cancel' ? await this.repo.findHeldJobIds(policy) : [];
    const cancel = await this.jobs.cancelForBudget([...queued, ...held], { id: policy.id, responsibleUserId: policy.updatedById }, now);
    await this.record('budget.hard_stop', policy, { spentUsd: spent, cancelledJobIds: cancel.cancelled, cancelRequestedJobIds: cancel.requested, approvalId });
    if (inserted && policy.projectId) await this.webhooks.dispatch(policy.projectId, 'fleet.budget.hard_stop', budgetWebhookPayload(policy, spent, start));
    return { live: cancel.live, approvalLive: opened.live, wake: cancel.wake };
  }

  private record(action: string, policy: BudgetPolicyRecord, extra: Record<string, unknown>): Promise<void> {
    return this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR.id, action, entityType: 'budget', entityId: policy.id,
      projectId: policy.projectId, responsibleUserId: policy.updatedById, payload: budgetActivityPayload(policy, extra),
    });
  }
}
