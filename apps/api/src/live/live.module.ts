import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';

@Module({
  imports: [OutboxModule],
  providers: [ProjectEventBus, TicketLiveSubscriber],
  exports: [ProjectEventBus],
})
export class LiveModule {}
