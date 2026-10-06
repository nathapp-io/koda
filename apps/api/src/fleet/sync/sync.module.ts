import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalStoreModule } from '../approvals/approval-store.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { FleetTicketsModule } from '../tickets/fleet-tickets.module';
import { CommandAckProcessor } from './command-ack.processor';
import { FenceService } from './fence.service';
import { FleetSweeper } from './fleet-sweeper';
import { JobReportProcessor } from './job-report.processor';
import { PrAttributionService } from './pr-attribution.service';
import { RunnerSyncController } from './runner-sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [PrismaModule, ApprovalStoreModule, FleetActivityModule, BudgetsModule, FleetJobsModule, GitBrokerModule, FleetTicketsModule],
  controllers: [RunnerSyncController],
  providers: [FenceService, JobReportProcessor, CommandAckProcessor, PrAttributionService, SyncService, FleetSweeper],
  exports: [FenceService, FleetSweeper],
})
export class SyncModule {}
