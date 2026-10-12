import { ThreadEventBus, ThreadLiveEvent } from './thread-event-bus';

describe('ThreadEventBus (US-006)', () => {
  it('US-006 AC1: delivers each event only to subscribers of its thread', () => {
    const bus = new ThreadEventBus();
    const received: ThreadLiveEvent[] = [];
    bus.subscribe('a', (event) => received.push(event));

    bus.publish({ id: 'event-a', threadId: 'a', at: '2026-10-01T00:00:00.000Z', type: 'thread' });
    bus.publish({ id: 'event-b', threadId: 'b', at: '2026-10-01T00:00:00.000Z', type: 'thread' });

    expect(received).toEqual([
      { id: 'event-a', threadId: 'a', at: '2026-10-01T00:00:00.000Z', type: 'thread' },
    ]);
  });
});
