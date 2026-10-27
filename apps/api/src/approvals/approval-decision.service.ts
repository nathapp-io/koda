import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, runWithActionContext, type ActionApproval } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PermissionService } from '../permissions/permission.service';
import { decideEligibility } from './approval-eligibility';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalCancelForbiddenError, ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalRequestEvents } from './approval-request-events';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

@Injectable()
export class ApprovalDecisionService {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly requests: PrismaApprovalRequestRepository,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
    private readonly execution: ApprovalExecutionService,
    private readonly events: ApprovalRequestEvents,
  ) {}

  async decide(requestId: string, decision: 'approve' | 'reject', comment: string | null, now = new Date()): Promise<ApprovalRequestRecord> {
    const decided = await this.record(requestId, decision, comment, now);
    // The decision is committed before the command runs, in its own transaction, so a failing
    // command leaves the approval on record and settles the request as failed.
    return decision === 'approve' ? this.execution.execute(requestId) : decided;
  }

  async cancel(requestId: string, now = new Date()): Promise<ApprovalRequestRecord> {
    return this.txManager.run(async () => {
      const request = await this.requests.lockById(requestId);
      if (!request) throw new ApprovalRequestNotFoundError(requestId);
      if (request.status !== 'pending') throw new ApprovalRequestNotPendingError(request.status);

      const actor = currentContext()?.actor;
      const requester = request.actor.type === 'SYSTEM' && request.actor.id === 'assistant'
        ? request.onBehalfOf : request.actor;
      if (!actor || (actor.type !== 'USER' && actor.type !== 'AGENT') ||
          actor.type !== requester?.type || actor.id !== requester.id) {
        throw new ApprovalCancelForbiddenError(requestId);
      }
      const cancelled = await this.requests.transition(requestId, 'pending', { status: 'cancelled', settledAt: now });
      // A lost CAS under the row lock must roll back, never emit phantom bookkeeping.
      if (!cancelled) throw new ApprovalRequestNotPendingError(request.status);
      await this.events.record(cancelled);
      await this.audit.record({
        key: 'approval.request.cancel', resourceType: 'approval-request', resourceId: requestId,
        projectId: request.projectId, summary: `cancelled ${request.permissionKey}`,
      });
      return cancelled;
    });
  }

  private record(requestId: string, decision: 'approve' | 'reject', comment: string | null, now: Date): Promise<ApprovalRequestRecord> {
    return this.txManager.run(async () => {
      const request = await this.requests.lockById(requestId);
      if (!request) throw new ApprovalRequestNotFoundError(requestId);
      if (request.status !== 'pending') throw new ApprovalRequestNotPendingError(request.status);
      if (request.expiresAt.getTime() <= now.getTime()) throw new ApprovalRequestExpiredError(requestId);

      const context = currentContext();
      if (!context) throw new Error('approval decision needs an action context');
      const decider = context.actor;
      const keys = decider.type === 'USER' || decider.type === 'AGENT'
        ? await this.permissions.effectiveKeys({ type: decider.type, id: decider.id }, request.projectId ? { projectId: request.projectId } : 'global')
        : new Set<string>();
      const eligibility = decideEligibility(request, decider, keys);
      if (eligibility.ok === false) throw new ApprovalDecideForbiddenError(eligibility.reason);
      // Keep the persistence boundary principal-only even if eligibility is replaced by a test seam.
      if (decider.type !== 'USER' && decider.type !== 'AGENT') throw new ApprovalDecideForbiddenError('not-a-principal');

      await this.requests.createDecision({ requestId, deciderType: decider.type, deciderId: decider.id, decision, comment, decidedAt: now });
      const approved = decision === 'approve';
      const attribution = approved ? { satisfiedBy: eligibility.satisfiedBy, approverType: decider.type, approverId: decider.id } : {};
      const updated = await this.requests.transition(requestId, 'pending', {
        status: approved ? 'approved' : 'rejected', decidedAt: now, ...attribution,
      });
      // A lost CAS under our row lock indicates a broken transaction boundary: roll back all writes.
      if (!updated) throw new ApprovalRequestNotPendingError(request.status);
      await this.events.record(updated);
      const approval: ActionApproval = {
        requiredMode: request.requiredMode, satisfiedBy: approved ? eligibility.satisfiedBy : 'none',
        ...(approved ? { approverType: decider.type, approverId: decider.id } : {}), requestId,
      };
      await runWithActionContext({ ...context, approval }, () => this.audit.record({
        key: 'approval.decide', resourceType: 'approval-request', resourceId: requestId,
        projectId: request.projectId, summary: `${approved ? 'approved' : 'rejected'} ${request.permissionKey}`,
      }));
      return updated;
    });
  }
}
