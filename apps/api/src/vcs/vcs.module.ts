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
import { ProjectsService } from '../projects/projects.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [VcsController, VcsWebhookController],
  providers: [
    VcsConnectionService,
    VcsSyncService,
    VcsWebhookService,
    VcsPollingService,
    VcsPrSyncService,
    VcsLinkExtractorService,
    ProjectsService,
  ],
  exports: [VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService, VcsPrSyncService, VcsLinkExtractorService],
})
export class VcsModule {}
