import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, runWithActionContext, type ActionApproval } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PermissionService } from '../permissions/permission.service';
import { decideEligibility } from './approval-eligibility';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

@Injectable()
export class ApprovalDecisionService {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly requests: PrismaApprovalRequestRepository,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
  ) {}

  decide(requestId: string, decision: 'approve' | 'reject', comment: string | null, now = new Date()): Promise<ApprovalRequestRecord> {
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
      const approval: ActionApproval = {
        requiredMode: request.requiredMode, satisfiedBy: approved ? eligibility.satisfiedBy : 'none',
        ...(approved ? { approverType: decider.type, approverId: decider.id } : {}), requestId,
      };
      await runWithActionContext({ ...context, approval }, () => this.audit.record({
        key: 'approval.decide', resourceType: 'approval-request', resourceId: requestId,
        projectId: request.projectId, summary: `${approved ? 'approved' : 'rejected'} ${request.permissionKey}`,
      }));
      // US-011 adds execution after this transaction commits; decisions never run commands here.
      return updated;
    });
  }
}
