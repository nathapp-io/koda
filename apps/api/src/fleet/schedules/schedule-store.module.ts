import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { SCHEDULE_REPOSITORY } from './domain/schedule.domain';
import { PrismaScheduleRepository } from './prisma-schedule.repository';

/** Plan D192: schedule storage, importable by the jobs module without a cycle (Task 5 adds ScheduleProgressService). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaScheduleRepository, { provide: SCHEDULE_REPOSITORY, useExisting: PrismaScheduleRepository }],
  exports: [SCHEDULE_REPOSITORY, PrismaScheduleRepository],
})
export class ScheduleStoreModule {}
