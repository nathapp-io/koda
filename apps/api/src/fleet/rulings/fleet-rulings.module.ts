import { Module } from '@nestjs/common';
import { FLEET_PR_RULING_REPOSITORY } from './fleet-pr-ruling.domain';
import { PrismaFleetPrRulingRepository } from './prisma-fleet-pr-ruling.repository';
import { FleetPrRulingsService } from './fleet-pr-rulings.service';

@Module({
  providers: [PrismaFleetPrRulingRepository, { provide: FLEET_PR_RULING_REPOSITORY, useExisting: PrismaFleetPrRulingRepository }, FleetPrRulingsService],
  exports: [FleetPrRulingsService],
})
export class FleetRulingsModule {}
