import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { CommandAckProcessor } from './command-ack.processor';
import { FenceService } from './fence.service';
import { FleetSweeper } from './fleet-sweeper';
import { JobReportProcessor } from './job-report.processor';
import { RunnerSyncController } from './runner-sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [PrismaModule, FleetActivityModule, FleetJobsModule, GitBrokerModule],
  controllers: [RunnerSyncController],
  providers: [FenceService, JobReportProcessor, CommandAckProcessor, SyncService, FleetSweeper],
  exports: [FenceService, FleetSweeper],
})
export class SyncModule {}
