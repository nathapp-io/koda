import { Module } from '@nestjs/common';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalPolicyResolver } from './approval-policy.resolver';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

@Module({
  exports: [ApprovalPolicyService],
  providers: [
    ApprovalPolicyService,
    ApprovalPolicyResolver,
    PrismaApprovalPolicyRepository,
    { provide: APPROVAL_POLICY_REPOSITORY, useExisting: PrismaApprovalPolicyRepository },
    PrismaApprovalRequestRepository,
    { provide: APPROVAL_REQUEST_REPOSITORY, useExisting: PrismaApprovalRequestRepository },
  ],
})
export class ApprovalEngineModule {}
