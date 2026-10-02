import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalRepository } from './prisma-approval.repository';

/**
 * Plan D226: approval storage and the close port, importable by budgets (and jobs in 2a) without a cycle.
 * `ApprovalLivePublisher` and `ApprovalCloser` land with the live event in slice 1a Task 3.
 */
@Module({
  imports: [PrismaModule],
  providers: [PrismaApprovalRepository, { provide: APPROVAL_REPOSITORY, useExisting: PrismaApprovalRepository }],
  exports: [APPROVAL_REPOSITORY, PrismaApprovalRepository],
})
export class ApprovalStoreModule {}