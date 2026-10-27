import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalRepository } from './prisma-approval.repository';

/** Plan D226: approval storage and the close port, importable by budgets (and jobs in 2a) without a cycle. */
@Module({
  imports: [PrismaModule, LiveModule, FleetActivityModule, WebhookModule],
  providers: [PrismaApprovalRepository, { provide: APPROVAL_REPOSITORY, useExisting: PrismaApprovalRepository }, ApprovalLivePublisher, ApprovalCloser],
  exports: [APPROVAL_REPOSITORY, PrismaApprovalRepository, ApprovalLivePublisher, ApprovalCloser],
})
export class ApprovalStoreModule {}
