import { AppException, ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { ApprovalCancelForbiddenError, ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';

export function rethrowApprovalError(error: unknown): never {
  if (error instanceof ApprovalRequestNotFoundError) throw new NotFoundAppException({}, 'approvals.requestNotFound');
  if (error instanceof ApprovalRequestNotPendingError) throw new ConflictAppException({ status: error.status }, 'approvals.notPending');
  if (error instanceof ApprovalRequestExpiredError) throw new ConflictAppException({}, 'approvals.expired');
  if (error instanceof ApprovalDecideForbiddenError) throw new AppException(403, { reason: error.reason }, 'approvals.decideForbidden', 403);
  if (error instanceof ApprovalCancelForbiddenError) throw new ForbiddenAppException({}, 'approvals.cancelForbidden');
  throw error;
}
