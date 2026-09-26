import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { LiveController } from './live.controller';
import { LiveModule } from './live.module';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';

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
});
