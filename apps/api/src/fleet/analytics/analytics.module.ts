import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { AnalyticsRouteCommands } from './analytics-route.commands';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { AnalyticsService } from './analytics.service';
import { ANALYTICS_REPOSITORY } from './domain/analytics.domain';
import { PrismaAnalyticsRepository } from './prisma-analytics.repository';
import { ProjectFleetAnalyticsController } from './project-fleet-analytics.controller';
import { FleetAnalyticsController } from './fleet-analytics.controller';

/** Fleet S2b (d) §4 read side (D376); spec docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md. */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, ProjectAccessModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetAnalyticsController, FleetAnalyticsController],
  providers: [
    AnalyticsRouteCommands,
    PrismaAnalyticsRepository, { provide: ANALYTICS_REPOSITORY, useExisting: PrismaAnalyticsRepository },
    AnalyticsService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
