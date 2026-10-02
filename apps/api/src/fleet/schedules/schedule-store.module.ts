import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { SCHEDULE_REPOSITORY } from './domain/schedule.domain';
import { PrismaScheduleRepository } from './prisma-schedule.repository';
import { ScheduleProgressService } from './schedule-progress.service';

/** Plan D192: schedule storage and progress counting, importable by the jobs module without a cycle. */
@Module({
  imports: [PrismaModule, FleetActivityModule, WebhookModule],
  providers: [PrismaScheduleRepository, { provide: SCHEDULE_REPOSITORY, useExisting: PrismaScheduleRepository }, ScheduleProgressService],
  exports: [SCHEDULE_REPOSITORY, PrismaScheduleRepository, ScheduleProgressService],
})
export class ScheduleStoreModule {}
