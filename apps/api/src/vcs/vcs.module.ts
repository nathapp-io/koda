import { VcsManualSync } from './vcs-manual-sync.service';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { VcsRouteCommands } from './vcs-route.commands';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { VcsController } from './vcs.controller';
import { VcsWebhookController } from './vcs-webhook.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsWebhookService } from './vcs-webhook.service';
import { VcsPollingService } from './vcs-polling.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import { PrismaVcsRepository } from './prisma-vcs.repository';
import { VcsProjectDeletionListener } from './vcs-project-deletion.listener';
import { ProjectsModule } from '../projects/projects.module';
import { RagModule } from '../rag/rag.module';
import { VCS_REPOSITORY } from './domain/vcs.repository';
import { OutboxModule } from '../outbox/outbox.module';
import { WebhookSecurityModule } from '../webhook-security/webhook-security.module';

@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, ScheduleModule.forRoot(), RagModule, OutboxModule, ProjectsModule, WebhookSecurityModule],
  controllers: [VcsController, VcsWebhookController],
  providers: [
    VcsRouteCommands,
    VcsManualSync,
    PrismaVcsRepository,
    { provide: VCS_REPOSITORY, useExisting: PrismaVcsRepository },
    VcsConnectionService,
    VcsSyncService,
    VcsWebhookService,
    VcsPollingService,
    VcsPrSyncService,
    VcsLinkExtractorService,
    // Review P2 remainder (US-002): a soft-deleted project's VCS polling stops.
    VcsProjectDeletionListener,
  ],
  exports: [VCS_REPOSITORY, VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService, VcsPrSyncService, VcsLinkExtractorService],
})
export class VcsModule {}
