import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { JobTransitionsService } from './job-transitions.service';
import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { FLEET_JOB_REPOSITORY } from './domain/fleet-job.domain';

/** Fleet jobs (spec §4-§6). Tasks 10-12 add placement, the notifier, dispatch and the controller. */
@Module({
  imports: [PrismaModule, FleetActivityModule, LiveModule],
  providers: [
    PrismaFleetJobRepository,
    { provide: FLEET_JOB_REPOSITORY, useExisting: PrismaFleetJobRepository },
    FleetJobLivePublisher,
    JobTransitionsService,
  ],
  exports: [FLEET_JOB_REPOSITORY, FleetJobLivePublisher, JobTransitionsService],
})
export class FleetJobsModule {}
