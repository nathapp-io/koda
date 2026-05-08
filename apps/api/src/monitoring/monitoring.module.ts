import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { SloDashboardService } from './slo-dashboard.service';
import { SloDashboardController } from './slo-dashboard.controller';

@Module({
  imports: [PrismaModule],
  controllers: [SloDashboardController],
  providers: [SloDashboardService],
  exports: [SloDashboardService],
})
export class MonitoringModule {}
