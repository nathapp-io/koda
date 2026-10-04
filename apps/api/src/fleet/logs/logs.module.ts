import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { FLEET_JOB_LOG_REPOSITORY } from './domain/fleet-job-log.domain';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LocalDiskLogStore } from './local-disk-log.store';
import { LOG_STORE } from './log-store';
import { LogUploadController } from './log-upload.controller';
import { LogUploadService } from './log-upload.service';
import { PrismaFleetJobLogRepository } from './prisma-fleet-job-log.repository';

/** Fleet S2a (spec docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md). */
@Module({
  imports: [PrismaModule, LiveModule, FleetJobsModule, SyncModule],
  controllers: [LogUploadController],
  providers: [
    LocalDiskLogStore, { provide: LOG_STORE, useExisting: LocalDiskLogStore },
    PrismaFleetJobLogRepository, { provide: FLEET_JOB_LOG_REPOSITORY, useExisting: PrismaFleetJobLogRepository },
    FleetLogLivePublisher, LogUploadService,
  ],
  exports: [LOG_STORE, FLEET_JOB_LOG_REPOSITORY, FleetLogLivePublisher],
})
export class LogsModule {}
