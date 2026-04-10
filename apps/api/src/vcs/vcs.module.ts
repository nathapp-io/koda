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
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [ScheduleModule.forRoot(), ProjectsModule],
  controllers: [VcsController, VcsWebhookController],
  providers: [
    VcsConnectionService,
    VcsSyncService,
    VcsWebhookService,
    VcsPollingService,
    VcsPrSyncService,
    VcsLinkExtractorService,
  ],
  exports: [VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService, VcsPrSyncService, VcsLinkExtractorService],
})
export class VcsModule {}
