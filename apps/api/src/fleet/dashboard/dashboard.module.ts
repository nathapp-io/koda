import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module';
import { CredentialBoardService } from './credential-board.service';
import { FleetDashboardService } from './dashboard.service';
import { DASHBOARD_REPOSITORY } from './domain/dashboard.domain';
import { FleetCredentialBoardController } from './fleet-credential-board.controller';
import { FleetDashboardController } from './fleet-dashboard.controller';
import { PrismaDashboardRepository } from './prisma-dashboard.repository';
import { ProjectFleetDashboardController } from './project-fleet-dashboard.controller';

/**
 * Fleet S2b (c) dashboard (spec docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md).
 * `ProviderCredentialsModule` is imported for the credential board's `kodaKeys` (C10 US-007): the
 * board reads the vault's public service, never its repository.
 */
@Module({
  imports: [PrismaModule, ProjectAccessModule, BudgetStoreModule, ProviderCredentialsModule],
  controllers: [ProjectFleetDashboardController, FleetDashboardController, FleetCredentialBoardController],
  providers: [
    PrismaDashboardRepository, { provide: DASHBOARD_REPOSITORY, useExisting: PrismaDashboardRepository }, FleetDashboardService,
    CredentialBoardService,
  ],
})
export class DashboardModule {}
