import { Module } from '@nestjs/common';
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
import { ThreadJobEffects } from '../threads/thread-job-effects';

/** Fleet jobs (spec §4-§6). Tasks 11-12 add dispatch and the controller. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, LiveModule, BudgetStoreModule, ApprovalStoreModule, ScheduleStoreModule, FleetTicketsModule, ConfigEditStoreModule],
  controllers: [FleetJobsController],
  providers: [
    PrismaFleetJobRepository,
    { provide: FLEET_JOB_REPOSITORY, useExisting: PrismaFleetJobRepository },
    FleetJobLivePublisher,
    FleetJobOutcomeRecorder,
    JobTransitionsService,
    RunnerNotifier,
    PlacementService,
    FleetJobsService,
    ThreadJobEffects,
  ],
  exports: [FLEET_JOB_REPOSITORY, FleetJobLivePublisher, FleetJobOutcomeRecorder, JobTransitionsService, RunnerNotifier, PlacementService, FleetJobsService, ThreadJobEffects],
})
export class FleetJobsModule {}
