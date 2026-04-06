import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { VcsController } from './vcs.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsWebhookService } from './vcs-webhook.service';
import { VcsPollingService } from './vcs-polling.service';
import { ProjectsService } from '../projects/projects.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [VcsController],
  providers: [
    VcsConnectionService,
    VcsSyncService,
    VcsWebhookService,
    VcsPollingService,
    ProjectsService,
  ],
  exports: [VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService],
})
export class VcsModule {}
