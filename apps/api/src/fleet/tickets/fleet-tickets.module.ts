import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EventsModule } from '../../events/events.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { FleetTicketsService } from './fleet-tickets.service';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

/** Fleet C9 (spec docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md). */
@Module({
  imports: [PrismaModule, TicketsModule, EventsModule],
  providers: [PrismaFleetTicketsRepository, FleetTicketsService, FleetTicketEventRecorder, FleetJobTicketEffects],
  exports: [PrismaFleetTicketsRepository, FleetTicketsService, FleetJobTicketEffects],
})
export class FleetTicketsModule {}
