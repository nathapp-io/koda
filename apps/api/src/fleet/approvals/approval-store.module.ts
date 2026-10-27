import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { LiveModule } from '../../live/live.module';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { FLEET_APPROVAL_ASK_REPOSITORY } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';
import { PrismaFleetApprovalAskRepository } from './prisma-fleet-approval-ask.repository';

/**
 * Plan D226: approval storage and the close port, importable by budgets (and jobs in 2a) without a cycle.
 * Permissions P3 (US-006, US-012): the closer opens and closes asks on the approval engine, so this module imports
 * `ApprovalEngineModule` for `ApprovalAskService`; the legacy `FleetApproval` repository and its token are gone.
 */
@Module({
  imports: [PrismaModule, ApprovalEngineModule, LiveModule, FleetActivityModule, WebhookModule],
  providers: [
    PrismaFleetApprovalAskRepository, { provide: FLEET_APPROVAL_ASK_REPOSITORY, useExisting: PrismaFleetApprovalAskRepository },
    ApprovalLivePublisher, ApprovalCloser, FleetApprovalAskStore,
  ],
  // Repositories stay module-private: the ask link table is published as the store service only.
  exports: [FleetApprovalAskStore, ApprovalLivePublisher, ApprovalCloser],
})
export class ApprovalStoreModule {}
