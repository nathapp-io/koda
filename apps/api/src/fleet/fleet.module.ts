import { Module } from '@nestjs/common';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { FleetActivityModule } from './activity/fleet-activity.module';
import { BudgetsModule } from './budgets/budgets.module';
import { FleetReposModule } from './repos/fleet-repos.module';
import { FleetJobsModule } from './jobs/fleet-jobs.module';
import { RunnersModule } from './runners/runners.module';
import { SchedulesModule } from './schedules/schedules.module';
import { FleetTicketsModule } from './tickets/fleet-tickets.module';
import { SyncModule } from './sync/sync.module';
import { LogsModule } from './logs/logs.module';
import { IngestModule } from './ingest/ingest.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DashboardModule } from './dashboard/dashboard.module';

/** Fleet S1 (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md). */
@Module({
  imports: [FleetActivityModule, BudgetsModule, ApprovalsModule, SchedulesModule, FleetReposModule, FleetJobsModule, FleetTicketsModule, RunnersModule, SyncModule, ArtifactsModule, LogsModule, IngestModule, AnalyticsModule, DashboardModule],
})
export class FleetModule {}
