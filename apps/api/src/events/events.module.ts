import { Module } from '@nestjs/common';
import { TicketEventService } from './ticket-event.service';
import { AgentEventService } from './agent-event.service';
import { DecisionEventService } from './decision-event.service';

@Module({
  providers: [TicketEventService, AgentEventService, DecisionEventService],
  exports: [TicketEventService, AgentEventService, DecisionEventService],
})
export class EventsModule {}