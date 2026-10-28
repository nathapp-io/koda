import { TicketLinkRouteCommands } from './ticket-link-route.commands';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../projects/project-access.module';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
import { PrismaTicketLinkRepository } from './prisma-ticket-link.repository';
import { TICKET_LINK_REPOSITORY } from './domain/ticket-link.domain';

/**
 * US-006: the controller no longer injects `ProjectsService`, so the module imports
 * `ProjectAccessModule` — the dependency `ProjectMembershipGuard` actually needs — instead of the
 * whole `ProjectsModule`. `PermissionService` comes from the global `PermissionsModule`.
 */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, ProjectAccessModule],
  controllers: [TicketLinksController],
  providers: [
    TicketLinkRouteCommands,
    PrismaTicketLinkRepository,
    { provide: TICKET_LINK_REPOSITORY, useExisting: PrismaTicketLinkRepository },
    TicketLinksService,
  ],
  exports: [TicketLinksService],
})
export class TicketLinksModule {}
