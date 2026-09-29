import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityController } from './fleet-activity.controller';
import { FleetActivityService } from './fleet-activity.service';
import { PrismaFleetActivityRepository } from './prisma-fleet-activity.repository';
import { FLEET_ACTIVITY_REPOSITORY } from './domain/fleet-activity.domain';

@Module({
  imports: [PrismaModule],
  controllers: [FleetActivityController],
  providers: [
    PrismaFleetActivityRepository,
    { provide: FLEET_ACTIVITY_REPOSITORY, useExisting: PrismaFleetActivityRepository },
    FleetActivityService,
  ],
  exports: [FleetActivityService],
})
export class FleetActivityModule {}
