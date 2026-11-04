import { Module } from '@nestjs/common';
import { FleetTicketsModule } from '../tickets/fleet-tickets.module';
import { FLEET_PR_RULING_REPOSITORY } from './fleet-pr-ruling.domain';
import { PrismaFleetPrRulingRepository } from './prisma-fleet-pr-ruling.repository';
import { FleetPrRulingsService } from './fleet-pr-rulings.service';

import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetRulingsController } from './fleet-rulings.controller';
import { FleetRulingRouteCommands } from './fleet-ruling-route.commands';

@Module({
  imports: [FleetTicketsModule, ApprovalEngineModule, AuthRepositoryModule, ProjectAccessModule],
  controllers: [FleetRulingsController],
  providers: [FleetRulingRouteCommands, PrismaFleetPrRulingRepository, { provide: FLEET_PR_RULING_REPOSITORY, useExisting: PrismaFleetPrRulingRepository }, FleetPrRulingsService],
  exports: [FleetPrRulingsService],
})
export class FleetRulingsModule {}
