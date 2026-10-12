import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { LiveController } from './live.controller';
import { ThreadEventBus } from './thread-event-bus';
import { LiveStreamRegistry } from './live-stream-registry';
import { MeLiveController } from './me-live.controller';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';
import { UserEventBus } from './user-event-bus';

@Module({
  imports: [OutboxModule, AuthModule, ProjectAccessModule],
  controllers: [LiveController, MeLiveController],
  providers: [ProjectEventBus, ThreadEventBus, UserEventBus, TicketLiveSubscriber, LiveStreamRegistry],
  exports: [ProjectEventBus, ThreadEventBus, UserEventBus, LiveStreamRegistry],
})
export class LiveModule {}
