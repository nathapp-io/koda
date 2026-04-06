import { Module } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { RagModule } from '../rag/rag.module';
import { WebhookModule } from '../webhook/webhook.module';
import { VcsModule } from '../vcs/vcs.module';
import { TicketLinksModule } from '../ticket-links/ticket-links.module';

@Module({
  imports: [RagModule, WebhookModule, VcsModule, TicketLinksModule],
  controllers: [TicketsController],
  providers: [
    TicketsService,
    TicketTransitionsService,
    { provide: 'PrismaService', useExisting: PrismaService<PrismaClient> },
  ],
  exports: [TicketsService, TicketTransitionsService],
})
export class TicketsModule {}
