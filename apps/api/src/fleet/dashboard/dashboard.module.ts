import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { DASHBOARD_REPOSITORY } from './domain/dashboard.domain';
import { PrismaDashboardRepository } from './prisma-dashboard.repository';

/** Fleet S2b (c) dashboard (spec docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaDashboardRepository, { provide: DASHBOARD_REPOSITORY, useExisting: PrismaDashboardRepository }],
})
export class DashboardModule {}
