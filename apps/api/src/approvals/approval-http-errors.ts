import { AppException, ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { DeferredDecisionRefusedError, ApprovalPolicyConflictError, ApprovalPolicyNotFoundError, ApprovalPolicySelfApplicationError, InvalidApprovalPolicyError, ApprovalCancelForbiddenError, ApprovalDecideForbiddenError, ApprovalDecisionParamsInvalidError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';

export function rethrowApprovalError(error: unknown): never {
  if (error instanceof DeferredDecisionRefusedError) {
    if (error.reason === 'not-pending') throw new ConflictAppException({ status: error.status }, 'approvals.notPending');
    throw new ConflictAppException({}, 'approvals.expired');
  }
  if (error instanceof ApprovalRequestNotFoundError) throw new NotFoundAppException({}, 'approvals.requestNotFound');
  if (error instanceof ApprovalRequestNotPendingError) throw new ConflictAppException({ status: error.status }, 'approvals.notPending');
  if (error instanceof ApprovalRequestExpiredError) throw new ConflictAppException({}, 'approvals.expired');
  if (error instanceof ApprovalDecideForbiddenError) throw new AppException(403, { reason: error.reason }, 'approvals.decideForbidden', 403);
  if (error instanceof ApprovalCancelForbiddenError) throw new ForbiddenAppException({}, 'approvals.cancelForbidden');
  if (error instanceof ApprovalDecisionParamsInvalidError) throw new ValidationAppException({ reason: error.reason }, 'approvals.invalidDecisionParams');
  if (error instanceof InvalidApprovalPolicyError) throw new ValidationAppException({ violation: error.violation }, 'approvals.invalidPolicy');
  if (error instanceof ApprovalPolicyConflictError) throw new ConflictAppException({}, 'approvals.policyConflict');
  if (error instanceof ApprovalPolicyNotFoundError) throw new NotFoundAppException({}, 'approvals.policyNotFound');
  if (error instanceof ApprovalPolicySelfApplicationError) throw new ForbiddenAppException({}, 'approvals.policySelfApplication');
  throw error;
}
