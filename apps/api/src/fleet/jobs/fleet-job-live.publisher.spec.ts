import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import type { LiveFleetJobEvent } from '../../live/live-event';
import type { ThreadLiveEvent } from '../../live/thread-event-bus';

const FLEET: LiveFleetJobEvent = { id: 'f1', type: 'fleet_job', projectId: 'p1', jobId: 'j1', state: 'CRASHED', at: '2026-10-13T07:00:00.000Z' };
const THREAD_EVENTS: ThreadLiveEvent[] = [
  { id: 't1', threadId: 'T', at: '2026-10-13T07:00:00.000Z', type: 'message', messageId: 'm1' },
  { id: 't2', threadId: 'T', at: '2026-10-13T07:00:00.000Z', type: 'thread' },
];

describe('FleetJobLivePublisher (#264)', () => {
  it('publishes a fleet event on the project bus and no thread event when it carries none', () => {
    const bus = { publish: vi.fn() };
    const threads = { publish: vi.fn() };
    new FleetJobLivePublisher(bus as never, threads as never).publish([FLEET]);
    expect(bus.publish).toHaveBeenCalledWith(FLEET);
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('publishes each carried thread event on the thread bus after the fleet event, and keeps them off the project bus', () => {
    const bus = { publish: vi.fn() };
    const threads = { publish: vi.fn() };
    new FleetJobLivePublisher(bus as never, threads as never).publish([{ ...FLEET, threadEvents: THREAD_EVENTS }]);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish.mock.calls[0][0]).toEqual(FLEET);
    expect(bus.publish.mock.calls[0][0]).not.toHaveProperty('threadEvents');
    expect(threads.publish.mock.calls.map(([event]) => event)).toEqual(THREAD_EVENTS);
  });
});
