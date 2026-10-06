import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EventsModule } from '../../events/events.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { FleetTicketsService } from './fleet-tickets.service';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import { TicketFleetJobsController } from './ticket-fleet-jobs.controller';

/** Fleet C9 (spec docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md). */
@Module({
  imports: [PrismaModule, TicketsModule, EventsModule, ProjectAccessModule],
  controllers: [TicketFleetJobsController],
  providers: [PrismaFleetTicketsRepository, FleetTicketsService, FleetTicketEventRecorder, FleetJobTicketEffects],
  exports: [PrismaFleetTicketsRepository, FleetTicketsService, FleetJobTicketEffects],
})
export class FleetTicketsModule {}
