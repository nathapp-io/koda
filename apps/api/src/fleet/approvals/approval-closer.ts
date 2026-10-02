import { Inject, Injectable } from '@nestjs/common';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../common/system-actor';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { approvalActivityPayload, approvalWebhookPayload } from './approval-payloads';
import {
  APPROVAL_REPOSITORY, ApprovalDecision, ApprovalResolvedBy, FleetApprovalRecord, IApprovalRepository,
} from './domain/approval.domain';

export interface ApprovalActor { type: 'USER' | 'SYSTEM'; id: string; responsibleUserId: string }
export interface ApprovalChange { approval: FleetApprovalRecord | null; live: LiveFleetApprovalEvent[] }
export interface PolicyClose {
  status: 'approved' | 'cancelled';
  resolvedBy: ApprovalResolvedBy;
  actor: ApprovalActor;
  decision?: ApprovalDecision;
  outcome?: Record<string, unknown>;
}

/**
 * The only two actor shapes. Budgets, jobs and approvals all act on the same approval rows, so they
 * must not each build their own literal: a third copy is how the two lists drift apart.
 */
export const userActor = (id: string): ApprovalActor => ({ type: 'USER', id, responsibleUserId: id });
/** A system action answers to the policy's last editor; there is no human in the loop. */
export const systemActor = (policy: BudgetPolicyRecord): ApprovalActor =>
  ({ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: policy.updatedById });

/**
 * S1.5 §2.1: the narrow port budgets (and, from 2a, jobs) use to open and close approvals inside their own
 * transactions. Callers hold the BudgetPolicy lock (lock order, spec §1.4) and publish `live` after commit.
 */
@Injectable()
export class ApprovalCloser {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: IApprovalRepository,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly livePublisher: ApprovalLivePublisher,
  ) {}

  async openBudget(policy: BudgetPolicyRecord, at: { windowStart: Date; spentUsd: string }, now: Date): Promise<ApprovalChange> {
    const system = systemActor(policy);
    const stray = await this.closeForPolicy(policy.id, { status: 'cancelled', resolvedBy: 'superseded', actor: system }, now);
    const approval = await this.repo.create({
      type: 'budget_override_required', projectId: policy.projectId, policyId: policy.id, requestedAt: now,
      payload: {
        scopeType: policy.scopeType, scopeId: policy.scopeId, windowKind: policy.windowKind,
        windowStart: at.windowStart.toISOString(), spentUsd: at.spentUsd, amountUsd: policy.amountUsd,
      },
    });
    await this.record(approval, system, 'approval.requested');
    await this.dispatch(approval, 'fleet.approval.requested');
    return { approval, live: [...stray.live, ...this.livePublisher.event(approval)] };
  }

  async closeForPolicy(policyId: string, close: PolicyClose, now: Date): Promise<ApprovalChange> {
    const pending = await this.repo.findPendingForPolicy(policyId);
    if (!pending || !(await this.repo.lockById(pending.id))) return { approval: null, live: [] };
    const decided = close.status === 'approved';
    const approval = await this.repo.resolve(pending.id, {
      status: close.status, resolvedBy: close.resolvedBy, decidedAt: now,
      decision: decided ? close.decision ?? null : null, decidedById: decided && close.actor.type === 'USER' ? close.actor.id : null,
      ...(close.outcome !== undefined ? { outcome: close.outcome } : {}),
    });
    return { approval, live: await this.recordResolved(approval, close.actor) };
  }

  async recordResolved(approval: FleetApprovalRecord, actor: ApprovalActor): Promise<LiveFleetApprovalEvent[]> {
    await this.record(approval, actor, approval.status === 'cancelled' || approval.status === 'expired' ? 'approval.cancelled' : 'approval.decided');
    await this.dispatch(approval, 'fleet.approval.resolved');
    return this.livePublisher.event(approval);
  }

  private record(approval: FleetApprovalRecord, actor: ApprovalActor, action: string): Promise<void> {
    return this.activity.record({
      actorType: actor.type, actorId: actor.id, action, entityType: 'approval', entityId: approval.id, jobId: approval.jobId,
      projectId: approval.projectId, responsibleUserId: actor.responsibleUserId, payload: approvalActivityPayload(approval),
    });
  }

  private async dispatch(approval: FleetApprovalRecord, event: string): Promise<void> {
    if (!approval.projectId) return;
    const slug = await this.repo.findProjectSlug(approval.projectId);
    if (slug) await this.webhooks.dispatch(approval.projectId, event, approvalWebhookPayload(approval, slug));
  }
}
