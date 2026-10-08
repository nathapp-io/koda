import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { LiveController } from './live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { MeLiveController } from './me-live.controller';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';
import { UserEventBus } from './user-event-bus';

@Module({
  imports: [OutboxModule, AuthModule, ProjectAccessModule],
  controllers: [LiveController, MeLiveController],
  providers: [ProjectEventBus, UserEventBus, TicketLiveSubscriber, LiveStreamRegistry],
  exports: [ProjectEventBus, UserEventBus],
})
export class LiveModule {}
