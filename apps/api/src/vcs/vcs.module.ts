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
import { ProjectsService } from '../projects/projects.service';
import { RagModule } from '../rag/rag.module';
import { VCS_REPOSITORY } from './domain/vcs.repository';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [ScheduleModule.forRoot(), RagModule, OutboxModule],
  controllers: [VcsController, VcsWebhookController],
  providers: [
    PrismaVcsRepository,
    { provide: VCS_REPOSITORY, useExisting: PrismaVcsRepository },
    VcsConnectionService,
    VcsSyncService,
    VcsWebhookService,
    VcsPollingService,
    VcsPrSyncService,
    VcsLinkExtractorService,
    ProjectsService,
  ],
  exports: [VCS_REPOSITORY, VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService, VcsPrSyncService, VcsLinkExtractorService],
})
export class VcsModule {}
