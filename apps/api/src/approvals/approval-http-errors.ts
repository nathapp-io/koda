import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ApprovalRequestNotFoundError } from './domain/approval.errors';

export function rethrowApprovalError(error: unknown): never {
  if (error instanceof ApprovalRequestNotFoundError) throw new NotFoundAppException({}, 'approvals.requestNotFound');
  throw error;
}
