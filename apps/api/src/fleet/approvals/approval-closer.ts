import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { runAsSystem } from '../../action-context/action-context';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { ApprovalAskService } from '../../approvals/approval-ask.service';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import type { ApprovalOption } from '../common/protocol';
import { responsibleUserOf } from '../common/responsible-user';
import { SYSTEM_ACTOR } from '../common/system-actor';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { approvalActivityPayload, approvalWebhookPayload } from './approval-payloads';
import { checkBashDecision } from './bash-decision';
import {
  APPROVAL_REPOSITORY, ApprovalDecision, ApprovalResolvedBy, FleetApprovalRecord, IApprovalRepository,
} from './domain/approval.domain';
import { MAX_PENDING_ASKS_PER_JOB, type PersistedPolicyClose } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/** US-002: `responsibleUserId` is null when the job the approval belongs to was requested by an agent. */
export interface ApprovalActor { type: 'USER' | 'SYSTEM' | 'RUNNER'; id: string; responsibleUserId: string | null }
/**
 * Permissions P3 US-006: `answer` is the ask the engine resolved to `none`, which the fleet must answer itself —
 * the caller writes the `APPROVAL_ANSWER` command, since the closer holds no job repository.
 */
export interface ApprovalChange {
  approval: FleetApprovalRecord | null;
  live: LiveFleetApprovalEvent[];
  answer?: { naxAskId: string; choice: ApprovalOption };
}
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
/** The close as the continuation needs it: what to write, for whom, and with which outcome. */
const persistedClose = (close: PolicyClose): PersistedPolicyClose => ({
  resolvedBy: close.resolvedBy,
  status: close.status,
  actor: { type: close.actor.type, id: close.actor.id, responsibleUserId: close.actor.responsibleUserId },
  ...(close.outcome === undefined ? {} : { outcome: close.outcome }),
});

/** A system action answers to the policy's last editor; there is no human in the loop. */
export const systemActor = (policy: BudgetPolicyRecord): ApprovalActor =>
  ({ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: policy.updatedById });

/** Plan D260: a runner-raised ask answers to the job's requester (US-002: null for an agent requester). */
export const runnerActor = (runnerId: string, job: Pick<FleetJobRecord, 'requestedById' | 'requestedByType'>): ApprovalActor =>
  ({ type: 'RUNNER', id: runnerId, responsibleUserId: responsibleUserOf(job) });
/** Plan D260: job-end and timeout closes answer to the job's requester (US-002: null for an agent requester). */
export const jobSystemActor = (job: Pick<FleetJobRecord, 'requestedById' | 'requestedByType'>): ApprovalActor =>
  ({ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: responsibleUserOf(job) });

export type BashJob = Pick<FleetJobRecord, 'id' | 'projectId' | 'leaseEpoch' | 'state' | 'bashMode' | 'approvalTimeoutSec' | 'requestedById' | 'requestedByType'>;
export interface BashAsk { naxAskId: string; deadlineAt: Date; payload: Record<string, unknown> }

/** Why nax cannot wait for this ask, or null when it can (US-006). */
const notOpenedReason = (job: BashJob, ask: BashAsk, now: Date): string | null => {
  if (job.state !== 'RUNNING') return 'job not running';
  if (job.bashMode === 'raw') return 'raw mode';
  if (ask.deadlineAt.getTime() <= now.getTime()) return 'past deadline';
  return null;
};

/**
 * US-006 (F1 round 3): how many asks one `closeForJob` call settles. The call runs inside the job transition's
 * interactive transaction, so its work has to fit Prisma's 5 s budget: one page of asks is ~600 statements, well
 * inside it, while an unbounded sweep over thousands would roll the transition back. The rest of a job's asks are
 * drained by `ApprovalJobEndSweeper` in its own transactions.
 */
export const MAX_ASKS_CLOSED_PER_CALL = 100;

/** Plan D262: spec §2.5 activity actions for a closed approval. */
const closedAction = (a: Pick<FleetApprovalRecord, 'status'>): string =>
  a.status === 'expired' ? 'approval.expired' : a.status === 'cancelled' ? 'approval.cancelled' : 'approval.decided';

/**
 * S1.5 §2.1: the narrow port budgets and jobs use to open and close approvals inside their own transactions. Budget
 * callers hold the BudgetPolicy lock, bash callers the FleetJob lock (lock order, spec §1.4).
 *
 * Permissions P3 (US-006, US-007): both halves are asks on the approval engine — `ApprovalAskService` decides whether
 * one is needed at all — linked back to the job or budget policy by `FleetApprovalAskStore`. Only `expire` still uses
 * the legacy `IApprovalRepository`, which US-012 removes.
 */
@Injectable()
export class ApprovalCloser {
  private readonly logger = new Logger(ApprovalCloser.name);

  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: IApprovalRepository,
    private readonly store: FleetApprovalAskStore,
    private readonly askService: ApprovalAskService,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly livePublisher: ApprovalLivePublisher,
    private readonly outbox: OutboxService,
    private readonly audit: AuditRecorder,
  ) {}

  async openBudget(policy: BudgetPolicyRecord, at: { windowStart: Date; spentUsd: string }, now: Date): Promise<ApprovalChange> {
    const system = systemActor(policy);
    const stray = await this.closeForPolicy(policy.id, { status: 'cancelled', resolvedBy: 'superseded', actor: system }, now);
    // Permissions P3 US-007: the ask is the engine's, so it expires with the policy timeout (24 h without one) and a
    // decider works the policy through the registered `fleet.budget.override` command.
    const outcome = await this.askService.open({
      key: 'fleet.budget.override',
      projectId: policy.projectId,
      component: 'budget',
      onBehalfOf: null,
      origin: 'system',
      input: {
        policyId: policy.id, scopeType: policy.scopeType, scopeId: policy.scopeId, windowKind: policy.windowKind,
        windowStart: at.windowStart.toISOString(), spentUsd: at.spentUsd, amountUsd: policy.amountUsd,
        // The re-queue candidates are the jobs cancelled for the policy from here on.
        requestedAt: now.toISOString(),
      },
      deadline: null,
    }, now);
    // `fleet.budget.override`'s floor is `self`, so a policy can never resolve this ask to `none`: a hard stop that
    // asked nobody would pause every job with nothing to resume it.
    if (outcome.status === 'not-needed') throw new Error('budget override resolved to none');

    const requestId = outcome.request.id;
    await this.store.insert({ requestId, kind: 'budget', projectId: policy.projectId, budgetPolicyId: policy.id });
    const view = await this.store.findApproval(requestId);
    if (view === null) throw new Error(`fleet budget ask ${requestId} has no ask link`);
    await this.record(view, system, 'approval.requested');
    await this.dispatch(view, 'fleet.approval.requested');
    await this.enqueueRequested(view);
    return { approval: view, live: [...stray.live, ...this.livePublisher.event(view)] };
  }

  /**
   * Permissions P3 US-007: every pending ask of a policy closes on the engine. The engine status is always
   * `cancelled` — a manual resume reports `approved` through the link's `manual_resume` resolution — and a request
   * another transaction holds is skipped, so the policy transaction completes without it. Callers read
   * `approval?.id` for the incident's `approvalId`, which is null exactly when no ask could be closed.
   *
   * The read is paged and bounded per call (fix round 1): one skipped (held) ask must not leave a newer pending ask
   * of the same policy behind — reachable when an earlier close skipped a held request and a later hard stop opened
   * another — and this runs inside the caller's transaction, so it settles at most `limit` asks, like the job-end
   * close.
   *
   * Fix round 2: the intent is stamped on every pending ask of the policy *before* the first close
   * (`store.markPendingPolicyAsks`), so whatever this call leaves behind — a held request, an ask past the bound — is
   * drained later by `PolicyAskCloseSweeper` with the resolution this action chose, even after the policy row is gone.
   */
  async closeForPolicy(policyId: string, close: PolicyClose, now: Date, limit = MAX_ASKS_CLOSED_PER_CALL): Promise<ApprovalChange> {
    const live: LiveFleetApprovalEvent[] = [];
    let first: FleetApprovalRecord | null = null;
    // The whole close, not just its reason: a leftover must keep the actor (attribution) and the outcome (a resume's
    // amount, its re-queues and the resumer) that this action chose.
    const intended = await this.store.markPendingPolicyAsks(policyId, persistedClose(close));
    if (intended === 0) return { approval: null, live };

    let after: string | undefined;
    let processed = 0;
    while (processed < limit) {
      const take = Math.min(MAX_PENDING_ASKS_PER_JOB, limit - processed);
      const links = await this.store.findPendingForPolicyPage(policyId, after, take);
      if (links.length === 0) return { approval: first, live };
      for (const link of links) {
        const closed = await this.closePolicyAsk(link.requestId, close, now);
        if (closed.approval === null) continue;
        first ??= closed.approval;
        live.push(...closed.live);
      }
      processed += links.length;
      const next = links.at(-1);
      if (links.length < take || next === undefined) return { approval: first, live };
      after = next.requestId;
    }
    this.logger.warn(`Policy ${policyId}: close stopped at ${limit} asks; the continuation sweeper drains the rest`);
    return { approval: first, live };
  }

  /**
   * One policy ask, in the caller's transaction. Answers `{ approval: null, live: [] }` when the engine skipped it
   * (the request is held); the intent stamped by `closeForPolicy` keeps it in the sweeper's queue.
   */
  async closePolicyAsk(requestId: string, close: PolicyClose, now: Date): Promise<ApprovalChange> {
    const closed = await this.askService.close(requestId, { status: 'cancelled', reason: close.resolvedBy }, now);
    if (closed === null) return { approval: null, live: [] };

    await this.store.setResolvedBy(requestId, close.resolvedBy);
    if (close.outcome !== undefined) {
      await this.store.setOutcome(requestId, {
        ...close.outcome,
        // The engine records the decider on the request; a manual resume's decider is the resumer in the outcome.
        ...(close.status === 'approved' ? { resumedById: close.actor.id } : {}),
      });
    }
    const view = await this.store.findApproval(requestId);
    if (view === null) throw new Error(`Fleet ask ${requestId} closed ${close.resolvedBy} but has no view`);
    return { approval: view, live: await this.recordResolved(view, close.actor) };
  }

  async recordResolved(approval: FleetApprovalRecord, actor: ApprovalActor): Promise<LiveFleetApprovalEvent[]> {
    await this.record(approval, actor, closedAction(approval));
    await this.dispatch(approval, 'fleet.approval.resolved');
    return this.livePublisher.event(approval);
  }

  /**
   * Spec §2.2 / P3 US-006: one approval per relayed ask, opened on the engine. A re-reported ask is the same ask; a job
   * that cannot wait for it (not RUNNING, raw mode, past deadline) opens nothing and says so in the audit trail; a
   * policy that needs no approval is answered here, and the caller writes the command.
   */
  async openBash(job: BashJob, ask: BashAsk, runnerId: string, now: Date): Promise<ApprovalChange> {
    const existing = await this.store.findByAsk(job.id, job.leaseEpoch, ask.naxAskId);
    if (existing) return { approval: await this.store.findApproval(existing.ask.requestId), live: [] };

    const reason = notOpenedReason(job, ask, now);
    if (reason !== null) {
      await this.audit.record({ key: 'runner.sync', resourceType: 'fleet-job', resourceId: job.id, projectId: job.projectId, summary: `bash ask not opened: ${reason}` });
      return { approval: null, live: [] };
    }

    // Plan D263 / P3: the engine's own timeout never outlasts nax's deadline. A policy with a shorter `timeoutSec`
    // still expires the ask earlier: the engine takes the earlier of the two.
    const deadline = new Date(Math.min(ask.deadlineAt.getTime(), now.getTime() + job.approvalTimeoutSec * 1000));
    const outcome = await this.askService.open({
      key: 'fleet.job.shell.escalate',
      projectId: job.projectId,
      component: 'runner',
      onBehalfOf: { type: job.requestedByType ?? 'USER', id: job.requestedById },
      origin: 'runner',
      input: { jobId: job.id, leaseEpoch: job.leaseEpoch, naxAskId: ask.naxAskId, payload: ask.payload },
      deadline,
    }, now);

    if (outcome.status === 'not-needed') {
      const choice: ApprovalOption = checkBashDecision(ask.payload, 'allow').ok ? 'allow' : 'deny';
      await this.audit.record({ key: 'runner.sync', resourceType: 'fleet-job', resourceId: job.id, projectId: job.projectId, summary: `bash ask answered ${choice}: no approval needed` });
      return { approval: null, live: [], answer: { naxAskId: ask.naxAskId, choice } };
    }

    const requestId = outcome.request.id;
    await this.store.insert({
      requestId, kind: 'bash', projectId: job.projectId, jobId: job.id, leaseEpoch: job.leaseEpoch, naxAskId: ask.naxAskId,
    });
    const view = await this.store.findApproval(requestId);
    if (view === null) throw new Error(`fleet bash ask ${requestId} has no ask link`);
    await this.record(view, runnerActor(runnerId, job), 'approval.requested');
    await this.audit.record({ key: 'runner.sync', resourceType: 'fleet-approval', resourceId: view.id, projectId: view.projectId, summary: 'bash ask opened, pending' });
    await this.dispatch(view, 'fleet.approval.requested');
    await this.enqueueRequested(view);
    return { approval: view, live: this.livePublisher.event(view) };
  }

  /**
   * Spec §1.4: the job left RUNNING, so nax has exited or is exiting; every pending ask of it is moot. A request held
   * by an in-flight decide or execute is skipped — the close must not block the job transition (US-006 AC-14).
   *
   * The read is paged (US-006 F1) and bounded per call (F1 round 3): this runs inside the job transition's
   * interactive transaction, so it settles at most `limit` asks (one page by default, ~600 statements, well inside
   * Prisma's 5 s budget) and logs the backlog it leaves. `ApprovalJobEndSweeper` continues the job in its own
   * transactions until nothing is pending, so a job with thousands of asks neither times the transition out nor
   * leaves an ask with no `job_ended` cancellation. The cursor is the last `requestId` of the page, so a skipped
   * (held) request is stepped over rather than met again.
   */
  async closeForJob(
    job: Pick<FleetJobRecord, 'id' | 'requestedById' | 'requestedByType'>,
    now: Date,
    limit = MAX_ASKS_CLOSED_PER_CALL,
  ): Promise<LiveFleetApprovalEvent[]> {
    const live: LiveFleetApprovalEvent[] = [];
    let after: string | undefined;
    let processed = 0;
    while (processed < limit) {
      const take = Math.min(MAX_PENDING_ASKS_PER_JOB, limit - processed);
      const links = await this.store.findPendingForJobPage(job.id, after, take);
      if (links.length === 0) return live;
      for (const link of links) live.push(...(await this.closeJobAsk(job, link.requestId, now)).live);
      processed += links.length;
      const next = links.at(-1);
      if (links.length < take || next === undefined) return live;
      after = next.requestId;
    }
    this.logger.warn(`Job ${job.id}: job-end close stopped at ${limit} asks; the rest is drained by the job-end sweeper`);
    return live;
  }

  /** One job-end cancellation, in the caller's transaction; also used by the durable fair continuation. */
  async closeJobAsk(
    job: Pick<FleetJobRecord, 'id' | 'requestedById' | 'requestedByType'>,
    requestId: string,
    now: Date,
  ): Promise<ApprovalChange> {
    const closed = await this.askService.close(requestId, { status: 'cancelled', reason: 'job_ended' }, now);
    if (closed === null) return { approval: null, live: [] };
    await this.store.setResolvedBy(requestId, 'job_ended');
    const view = await this.store.findApproval(requestId);
    if (view === null) throw new Error(`Fleet ask ${requestId} closed job_ended but has no view`);
    return { approval: view, live: await this.recordResolved(view, jobSystemActor(job)) };
  }

  /** Spec §2.4: nax has already denied by its own timeout. The caller re-checked `pending` under the lock. */
  async expire(approval: FleetApprovalRecord, job: Pick<FleetJobRecord, 'requestedById' | 'requestedByType'>, now: Date): Promise<ApprovalChange> {
    const expired = await this.repo.resolve(approval.id, { status: 'expired', resolvedBy: 'timeout', decidedAt: now });
    await runAsSystem('approval', () => this.audit.record({ key: 'system.approval.expire', resourceType: 'fleet-approval', resourceId: expired.id, projectId: expired.projectId, summary: 'expired' }));
    return { approval: expired, live: await this.recordResolved(expired, jobSystemActor(job)) };
  }

  private record(approval: FleetApprovalRecord, actor: ApprovalActor, action: string, extra: Record<string, unknown> = {}): Promise<void> {
    return this.activity.record({
      actorType: actor.type, actorId: actor.id, action, entityType: 'approval', entityId: approval.id, jobId: approval.jobId,
      projectId: approval.projectId, responsibleUserId: actor.responsibleUserId, payload: approvalActivityPayload(approval, extra),
    });
  }

  private async dispatch(approval: FleetApprovalRecord, event: string): Promise<void> {
    if (!approval.projectId) return;
    const slug = await this.store.findProjectSlug(approval.projectId);
    if (slug) await this.webhooks.dispatch(approval.projectId, event, approvalWebhookPayload(approval, slug));
  }

  /**
   * Enqueue every fresh project ask in the caller's transaction. Project live listeners may not
   * have permission to decide this approval; notification consumers own recipient eligibility.
   */
  private async enqueueRequested(approval: FleetApprovalRecord): Promise<void> {
    if (!approval.projectId) return;
    const slug = await this.store.findProjectSlug(approval.projectId);
    if (!slug) return;
    await this.outbox.record({
      type: 'fleet_approval_requested',
      payload: approvalWebhookPayload(approval, slug),
      metadata: { projectId: approval.projectId, eventId: approval.id },
    });
  }
}
