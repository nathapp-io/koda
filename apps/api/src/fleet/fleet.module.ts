import { Module } from '@nestjs/common';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { ApprovalStoreModule } from './approvals/approval-store.module';
import { FleetActivityModule } from './activity/fleet-activity.module';
import { BudgetsModule } from './budgets/budgets.module';
import { FleetReposModule } from './repos/fleet-repos.module';
import { FleetJobsModule } from './jobs/fleet-jobs.module';
import { RunnersModule } from './runners/runners.module';
import { SchedulesModule } from './schedules/schedules.module';
import { SyncModule } from './sync/sync.module';

/** Fleet S1 (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md). */
@Module({
  imports: [FleetActivityModule, BudgetsModule, ApprovalStoreModule, SchedulesModule, FleetReposModule, FleetJobsModule, RunnersModule, SyncModule, ArtifactsModule],
})
export class FleetModule {}
