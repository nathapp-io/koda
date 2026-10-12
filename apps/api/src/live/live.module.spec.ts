import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { LiveController } from './live.controller';
import { LiveModule } from './live.module';
import { LiveStreamRegistry } from './live-stream-registry';
import { MeLiveController } from './me-live.controller';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';
import { ThreadEventBus } from './thread-event-bus';
import { ThreadEventsController, ThreadEventsGuard } from './thread-events.controller';
import { UserEventBus } from './user-event-bus';

describe('LiveModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, LiveModule] }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves the bus and the subscriber', () => {
    expect(moduleRef.get(ProjectEventBus)).toBeInstanceOf(ProjectEventBus);
    expect(moduleRef.get(TicketLiveSubscriber)).toBeInstanceOf(TicketLiveSubscriber);
  });

  it('resolves the controller and the stream registry', () => {
    expect(moduleRef.get(LiveController)).toBeInstanceOf(LiveController);
    expect(moduleRef.get(LiveStreamRegistry)).toBeInstanceOf(LiveStreamRegistry);
  });

  it('registers the live handler on ticket_event at init', async () => {
    await moduleRef.init();
    const handlers = moduleRef.get(FanOutPublisher).getHandlers('ticket_event');
    expect(handlers.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves the user bus and the /me/events controller (S4a §4)', () => {
    expect(moduleRef.get(UserEventBus)).toBeInstanceOf(UserEventBus);
    expect(moduleRef.get(MeLiveController)).toBeInstanceOf(MeLiveController);
  });

  it('resolves the thread event bus, SSE controller and authorization guard (US-006)', () => {
    expect(moduleRef.get(ThreadEventBus)).toBeInstanceOf(ThreadEventBus);
    expect(moduleRef.get(ThreadEventsController)).toBeInstanceOf(ThreadEventsController);
    expect(moduleRef.get(ThreadEventsGuard)).toBeInstanceOf(ThreadEventsGuard);
  });
});
