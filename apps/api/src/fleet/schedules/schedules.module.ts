import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ScheduleStoreModule } from './schedule-store.module';
import { ScheduleTicker } from './schedule-ticker';

/** S1b §3 C4 schedules (plan D192): the ticker; Task 8 adds the management routes. */
@Module({
  imports: [PrismaModule, ScheduleStoreModule, FleetJobsModule, FleetActivityModule],
  providers: [ScheduleTicker],
  exports: [ScheduleTicker],
})
export class SchedulesModule {}
