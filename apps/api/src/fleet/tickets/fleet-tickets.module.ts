import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EventsModule } from '../../events/events.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { VcsModule } from '../../vcs/vcs.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';
import { FleetPrStateRefresher } from './fleet-pr-state.refresher';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { FleetTicketsService } from './fleet-tickets.service';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import { TicketFleetJobsController } from './ticket-fleet-jobs.controller';

/** Fleet C9 (spec docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md). */
@Module({
  imports: [PrismaModule, TicketsModule, EventsModule, ProjectAccessModule, VcsModule, GitBrokerModule],
  controllers: [TicketFleetJobsController],
  providers: [PrismaFleetTicketsRepository, FleetTicketsService, FleetTicketEventRecorder, FleetJobTicketEffects, FleetPrStateRefresher],
  exports: [PrismaFleetTicketsRepository, FleetTicketsService, FleetJobTicketEffects, FleetPrStateRefresher],
})
export class FleetTicketsModule {}
