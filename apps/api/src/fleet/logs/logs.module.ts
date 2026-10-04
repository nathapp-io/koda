import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { ArtifactStoreModule } from '../artifacts/artifact-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { FLEET_JOB_LOG_REPOSITORY } from './domain/fleet-job-log.domain';
import { LOG_RETENTION_REPOSITORY } from './domain/log-retention.domain';
import { FleetJobLogsController } from './fleet-job-logs.controller';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { FleetLogRetentionProcessor } from './fleet-log-retention.processor';
import { LocalDiskLogStore } from './local-disk-log.store';
import { LOG_STORE } from './log-store';
import { LogFallbackService } from './log-fallback.service';
import { LogReadService } from './log-read.service';
import { LogUploadController } from './log-upload.controller';
import { LogUploadService } from './log-upload.service';
import { PrismaFleetJobLogRepository } from './prisma-fleet-job-log.repository';
import { PrismaLogRetentionRepository } from './prisma-log-retention.repository';

/** Fleet S2a (spec docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md). */
@Module({
  imports: [PrismaModule, LiveModule, ProjectAccessModule, ArtifactStoreModule, FleetJobsModule, SyncModule],
  controllers: [LogUploadController, FleetJobLogsController],
  providers: [
    LocalDiskLogStore, { provide: LOG_STORE, useExisting: LocalDiskLogStore },
    PrismaFleetJobLogRepository, { provide: FLEET_JOB_LOG_REPOSITORY, useExisting: PrismaFleetJobLogRepository },
    PrismaLogRetentionRepository, { provide: LOG_RETENTION_REPOSITORY, useExisting: PrismaLogRetentionRepository },
    FleetLogLivePublisher, LogUploadService, LogFallbackService, LogReadService, FleetLogRetentionProcessor,
  ],
  exports: [LOG_STORE, FLEET_JOB_LOG_REPOSITORY, FleetLogLivePublisher, LogFallbackService],
})
export class LogsModule {}
