import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetJobsService } from './fleet-jobs.service';
import { JobTransitionsService } from './job-transitions.service';
import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { FLEET_JOB_REPOSITORY } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';
import { RunnerNotifier } from './runner-notifier';

/** Fleet jobs (spec §4-§6). Tasks 11-12 add dispatch and the controller. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, LiveModule, BudgetStoreModule],
  controllers: [FleetJobsController],
  providers: [
    PrismaFleetJobRepository,
    { provide: FLEET_JOB_REPOSITORY, useExisting: PrismaFleetJobRepository },
    FleetJobLivePublisher,
    JobTransitionsService,
    RunnerNotifier,
    PlacementService,
    FleetJobsService,
  ],
  exports: [FLEET_JOB_REPOSITORY, FleetJobLivePublisher, JobTransitionsService, RunnerNotifier, PlacementService, FleetJobsService],
})
export class FleetJobsModule {}
