import { FleetRulingsModule } from '../rulings/fleet-rulings.module';
import { MemoryModule } from '../../memory/memory.module';
import { Module } from '@nestjs/common';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { FleetJobRouteCommands } from './fleet-job-route.commands';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { ApprovalStoreModule } from '../approvals/approval-store.module';
import { ScheduleStoreModule } from '../schedules/schedule-store.module';
import { FleetTicketsModule } from '../tickets/fleet-tickets.module';
import { ConfigEditStoreModule } from '../repo-config/config-edit-store.module';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetJobsService } from './fleet-jobs.service';
import { FleetJobOutcomeRecorder } from './job-outcome.recorder';
import { JobTransitionsService } from './job-transitions.service';
import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { FLEET_JOB_REPOSITORY } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';
import { RunnerNotifier } from './runner-notifier';
import { ProjectDeletionJobsListener } from './project-deletion-jobs.listener';
import { ThreadJobEffects } from '../threads/thread-job-effects';

/** Fleet jobs (spec §4-§6). Tasks 11-12 add dispatch and the controller. */
@Module({
  imports: [FleetRulingsModule, MemoryModule, ApprovalEngineModule, AuthRepositoryModule, PrismaModule, ProjectAccessModule, FleetActivityModule, LiveModule, BudgetStoreModule, ApprovalStoreModule, ScheduleStoreModule, FleetTicketsModule, ConfigEditStoreModule],
  controllers: [FleetJobsController],
  providers: [
    FleetJobRouteCommands,
    PrismaFleetJobRepository,
    { provide: FLEET_JOB_REPOSITORY, useExisting: PrismaFleetJobRepository },
    FleetJobLivePublisher,
    FleetJobOutcomeRecorder,
    JobTransitionsService,
    RunnerNotifier,
    PlacementService,
    FleetJobsService,
    // Review P2 US-001: quiesces a soft-deleted project's unstarted jobs on PROJECT_SOFT_DELETED.
    ProjectDeletionJobsListener,
    ThreadJobEffects,
  ],
  exports: [FLEET_JOB_REPOSITORY, FleetJobLivePublisher, FleetJobOutcomeRecorder, JobTransitionsService, RunnerNotifier, PlacementService, FleetJobsService, ThreadJobEffects],
})
export class FleetJobsModule {}
