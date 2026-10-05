import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { AnalyticsService } from './analytics.service';
import { ANALYTICS_REPOSITORY } from './domain/analytics.domain';
import { PrismaAnalyticsRepository } from './prisma-analytics.repository';
import { ProjectFleetAnalyticsController } from './project-fleet-analytics.controller';

/** Fleet S2b (d) §4 read side (D376); spec docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetAnalyticsController],
  providers: [
    PrismaAnalyticsRepository, { provide: ANALYTICS_REPOSITORY, useExisting: PrismaAnalyticsRepository },
    AnalyticsService,
  ],
})
export class AnalyticsModule {}
