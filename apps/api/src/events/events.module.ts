import { Module } from '@nestjs/common';
import { TicketEventService } from './ticket-event.service';
import { AgentEventService } from './agent-event.service';
import { DecisionEventService } from './decision-event.service';
import { ActorResolver } from './actor-resolver.service';

@Module({
  providers: [TicketEventService, AgentEventService, DecisionEventService, ActorResolver],
  exports: [TicketEventService, AgentEventService, DecisionEventService, ActorResolver],
})
export class EventsModule {}