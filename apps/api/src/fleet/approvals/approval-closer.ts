import { Inject, Injectable } from '@nestjs/common';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../common/system-actor';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { approvalActivityPayload, approvalWebhookPayload } from './approval-payloads';
import {
  APPROVAL_REPOSITORY, ApprovalDecision, ApprovalResolvedBy, FleetApprovalRecord, IApprovalRepository,
} from './domain/approval.domain';

export interface ApprovalActor { type: 'USER' | 'SYSTEM' | 'RUNNER'; id: string; responsibleUserId: string }
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

/** Plan D260: a runner-raised ask answers to the job's requester. */
export const runnerActor = (runnerId: string, job: Pick<FleetJobRecord, 'requestedById'>): ApprovalActor =>
  ({ type: 'RUNNER', id: runnerId, responsibleUserId: job.requestedById });
/** Plan D260: job-end and timeout closes answer to the job's requester. */
export const jobSystemActor = (job: Pick<FleetJobRecord, 'requestedById'>): ApprovalActor =>
  ({ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: job.requestedById });

export type BashJob = Pick<FleetJobRecord, 'id' | 'projectId' | 'leaseEpoch' | 'state' | 'bashMode' | 'approvalTimeoutSec' | 'requestedById'>;
export interface BashAsk { naxAskId: string; deadlineAt: Date; payload: Record<string, unknown> }

/** Plan D262: spec §2.5 activity actions for a closed approval. */
const closedAction = (a: Pick<FleetApprovalRecord, 'status'>): string =>
  a.status === 'expired' ? 'approval.expired' : a.status === 'cancelled' ? 'approval.cancelled' : 'approval.decided';

/**
 * S1.5 §2.1: the narrow port budgets and jobs use to open and close approvals inside their own transactions. Budget
 * callers hold the BudgetPolicy lock, bash callers the FleetJob lock (lock order, spec §1.4).
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
    await this.record(approval, actor, closedAction(approval));
    await this.dispatch(approval, 'fleet.approval.resolved');
    return this.livePublisher.event(approval);
  }

  /**
   * Spec §2.2: one approval per relayed ask. Born closed when the job is no longer RUNNING (or is raw) or the deadline
   * has passed; a born-closed ask gets its activity row and live event but no webhook (plan D261).
   */
  async openBash(job: BashJob, ask: BashAsk, runnerId: string, now: Date): Promise<ApprovalChange> {
    const existing = await this.repo.findByAsk(job.id, job.leaseEpoch, ask.naxAskId);
    if (existing) return { approval: existing, live: [] };
    const expiresAt = new Date(Math.min(ask.deadlineAt.getTime(), now.getTime() + job.approvalTimeoutSec * 1000));
    const created = await this.repo.create({
      type: 'nax_bash_escalate', projectId: job.projectId, policyId: null, jobId: job.id, leaseEpoch: job.leaseEpoch,
      naxAskId: ask.naxAskId, payload: ask.payload, requestedAt: now, expiresAt,
    });
    const actor = runnerActor(runnerId, job);
    const born = job.state !== 'RUNNING' || job.bashMode === 'raw'
      ? { status: 'cancelled' as const, resolvedBy: 'job_ended' as const }
      : expiresAt.getTime() <= now.getTime() ? { status: 'expired' as const, resolvedBy: 'timeout' as const } : null;
    if (!born) {
      await this.record(created, actor, 'approval.requested');
      await this.dispatch(created, 'fleet.approval.requested');
      return { approval: created, live: this.livePublisher.event(created) };
    }
    const closed = await this.repo.resolve(created.id, { ...born, decidedAt: now });
    await this.record(closed, actor, closedAction(closed));
    return { approval: closed, live: this.livePublisher.event(closed) };
  }

  /** Spec §1.4: the job left RUNNING, so nax has exited or is exiting; every pending ask of it is moot. */
  async closeForJob(job: Pick<FleetJobRecord, 'id' | 'requestedById'>, now: Date): Promise<LiveFleetApprovalEvent[]> {
    const live: LiveFleetApprovalEvent[] = [];
    for (const pending of await this.repo.findPendingForJob(job.id)) {
      const locked = await this.repo.lockById(pending.id);
      if (!locked || locked.status !== 'pending') continue;
      const closed = await this.repo.resolve(locked.id, { status: 'cancelled', resolvedBy: 'job_ended', decidedAt: now });
      live.push(...(await this.recordResolved(closed, jobSystemActor(job))));
    }
    return live;
  }

  /** Spec §2.4: nax has already denied by its own timeout. The caller re-checked `pending` under the lock. */
  async expire(approval: FleetApprovalRecord, job: Pick<FleetJobRecord, 'requestedById'>, now: Date): Promise<ApprovalChange> {
    const expired = await this.repo.resolve(approval.id, { status: 'expired', resolvedBy: 'timeout', decidedAt: now });
    return { approval: expired, live: await this.recordResolved(expired, jobSystemActor(job)) };
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
