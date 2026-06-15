import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { SloDashboardService } from './slo-dashboard.service';
import { SloDashboardController } from './slo-dashboard.controller';
import { PrismaMonitoringRepository } from './prisma-monitoring.repository';
import { MONITORING_REPOSITORY } from './domain/monitoring.domain';

@Module({
  imports: [PrismaModule],
  controllers: [SloDashboardController],
  providers: [
    PrismaMonitoringRepository,
    { provide: MONITORING_REPOSITORY, useExisting: PrismaMonitoringRepository },
    SloDashboardService,
  ],
  exports: [SloDashboardService],
})
export class MonitoringModule {}
