import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { FleetTestHooksController } from './fleet-test-hooks.controller';
import { ProjectFleetSchedulesController } from './project-fleet-schedules.controller';
import { ScheduleStoreModule } from './schedule-store.module';
import { ScheduleTicker } from './schedule-ticker';
import { SchedulesService } from './schedules.service';

/** S1b §3 C4 schedules (plan D192): ticker, management service and the project routes. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, ScheduleStoreModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetSchedulesController, FleetTestHooksController],
  providers: [SchedulesService, ScheduleTicker],
  exports: [ScheduleTicker],
})
export class SchedulesModule {}
