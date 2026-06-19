import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { PrismaTicketsRepository } from './prisma-tickets.repository';
import { TICKET_REPOSITORY } from './domain/ticket.domain';
import { RagModule } from '../rag/rag.module';
import { WebhookModule } from '../webhook/webhook.module';
import { VcsModule } from '../vcs/vcs.module';
import { TicketLinksModule } from '../ticket-links/ticket-links.module';
import { EventsModule } from '../events/events.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [RagModule, WebhookModule, VcsModule, TicketLinksModule, EventsModule, OutboxModule],
  controllers: [TicketsController],
  providers: [
    PrismaTicketsRepository,
    { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
    TicketsService,
    TicketTransitionsService,
  ],
  exports: [TicketsService, TicketTransitionsService],
})
export class TicketsModule {}
