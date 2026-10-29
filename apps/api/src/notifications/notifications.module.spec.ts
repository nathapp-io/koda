import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { NotificationWriter } from './notification-writer';
import { NotificationsModule } from './notifications.module';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';
import { TicketWatchRouteCommands } from './ticket-watch-route.commands';

describe('NotificationsModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, NotificationsModule] }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves the writer, ticket producer and watch route command', () => {
    expect(moduleRef.get(NotificationWriter)).toBeInstanceOf(NotificationWriter);
    expect(moduleRef.get(TicketNotificationSubscriber)).toBeInstanceOf(TicketNotificationSubscriber);
    expect(moduleRef.get(TicketWatchRouteCommands)).toBeInstanceOf(TicketWatchRouteCommands);
  });

  it('registers the ticket producer on ticket_event at init', async () => {
    await moduleRef.init();
    const subscriber = moduleRef.get(TicketNotificationSubscriber);
    expect(moduleRef.get(FanOutPublisher).getHandlers('ticket_event')).toContain(subscriber.handle);
  });
});
