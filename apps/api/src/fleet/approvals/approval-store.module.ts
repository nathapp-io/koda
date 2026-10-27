import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { FLEET_APPROVAL_ASK_REPOSITORY } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';
import { PrismaApprovalRepository } from './prisma-approval.repository';
import { PrismaFleetApprovalAskRepository } from './prisma-fleet-approval-ask.repository';

/** Plan D226: approval storage and the close port, importable by budgets (and jobs in 2a) without a cycle. */
@Module({
  imports: [PrismaModule, LiveModule, FleetActivityModule, WebhookModule],
  providers: [
    PrismaApprovalRepository, { provide: APPROVAL_REPOSITORY, useExisting: PrismaApprovalRepository },
    PrismaFleetApprovalAskRepository, { provide: FLEET_APPROVAL_ASK_REPOSITORY, useExisting: PrismaFleetApprovalAskRepository },
    ApprovalLivePublisher, ApprovalCloser, FleetApprovalAskStore,
  ],
  // Repositories stay module-private: the ask link table is published as the store service only.
  exports: [APPROVAL_REPOSITORY, PrismaApprovalRepository, ApprovalLivePublisher, ApprovalCloser, FleetApprovalAskStore],
})
export class ApprovalStoreModule {}
