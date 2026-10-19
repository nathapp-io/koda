import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../projects/project-access.module';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
import { PrismaTicketLinkRepository } from './prisma-ticket-link.repository';
import { TICKET_LINK_REPOSITORY } from './domain/ticket-link.domain';

/**
 * US-006: the controller no longer injects `ProjectsService`, so the module imports
 * `ProjectAccessModule` — the dependency `ProjectMembershipGuard` (and its
 * `KodaCaslAbilityFactory`) actually needs — instead of the whole `ProjectsModule`.
 * `PermissionService` comes from the global `PermissionsModule`.
 */
@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [TicketLinksController],
  providers: [
    PrismaTicketLinkRepository,
    { provide: TICKET_LINK_REPOSITORY, useExisting: PrismaTicketLinkRepository },
    TicketLinksService,
  ],
  exports: [TicketLinksService],
})
export class TicketLinksModule {}
