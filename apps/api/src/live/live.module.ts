import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { LiveController } from './live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';

@Module({
  imports: [OutboxModule, AuthModule, ProjectAccessModule],
  controllers: [LiveController],
  providers: [ProjectEventBus, TicketLiveSubscriber, LiveStreamRegistry],
  exports: [ProjectEventBus],
})
export class LiveModule {}
