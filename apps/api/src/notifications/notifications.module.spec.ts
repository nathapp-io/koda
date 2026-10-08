import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { NotificationWriter } from './notification-writer';
import { NotificationsModule } from './notifications.module';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';

describe('NotificationsModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, NotificationsModule] }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves the writer and the ticket producer', () => {
    expect(moduleRef.get(NotificationWriter)).toBeInstanceOf(NotificationWriter);
    expect(moduleRef.get(TicketNotificationSubscriber)).toBeInstanceOf(TicketNotificationSubscriber);
  });

  it('registers the ticket producer on ticket_event at init', async () => {
    await moduleRef.init();
    const subscriber = moduleRef.get(TicketNotificationSubscriber);
    expect(moduleRef.get(FanOutPublisher).getHandlers('ticket_event')).toContain(subscriber.handle);
  });
});
