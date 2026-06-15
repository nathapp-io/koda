import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { TicketEventService } from './ticket-event.service';
import { AgentEventService } from './agent-event.service';
import { DecisionEventService } from './decision-event.service';
import { PrismaEventsRepository } from './prisma-events.repository';
import { EVENTS_REPOSITORY } from './domain/events.domain';

@Module({
  imports: [PrismaModule],
  providers: [
    PrismaEventsRepository,
    { provide: EVENTS_REPOSITORY, useExisting: PrismaEventsRepository },
    TicketEventService,
    AgentEventService,
    DecisionEventService,
  ],
  exports: [TicketEventService, AgentEventService, DecisionEventService],
})
export class EventsModule {}
