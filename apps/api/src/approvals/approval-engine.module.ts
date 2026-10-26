import { Module } from '@nestjs/common';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalGate } from './approval-gate.service';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalPolicyResolver } from './approval-policy.resolver';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

/**
 * P3 approval core. The command registry is one instance per application: an owning module registers
 * its commands in `onModuleInit` and callers resolve the same instance through this module's exports,
 * so `ApprovalGate` (US-008) and the registering module share one map.
 */
@Module({
  exports: [ApprovalPolicyService, ApprovalCommandRegistry, ApprovalGate, ApprovalDecisionService],
  providers: [
    ApprovalDecisionService,
    ApprovalGate,
    ApprovalPolicyService,
    ApprovalPolicyResolver,
    ApprovalCommandRegistry,
    PrismaApprovalPolicyRepository,
    { provide: APPROVAL_POLICY_REPOSITORY, useExisting: PrismaApprovalPolicyRepository },
    PrismaApprovalRequestRepository,
    { provide: APPROVAL_REQUEST_REPOSITORY, useExisting: PrismaApprovalRequestRepository },
  ],
})
export class ApprovalEngineModule {}
