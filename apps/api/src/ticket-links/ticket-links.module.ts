import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
import { PrismaTicketLinkRepository } from './prisma-ticket-link.repository';
import { TICKET_LINK_REPOSITORY } from './domain/ticket-link.domain';

@Module({
  imports: [PrismaModule],
  controllers: [TicketLinksController],
  providers: [
    PrismaTicketLinkRepository,
    { provide: TICKET_LINK_REPOSITORY, useExisting: PrismaTicketLinkRepository },
    TicketLinksService,
  ],
})
export class TicketLinksModule {}
