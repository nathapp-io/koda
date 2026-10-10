import { FleetLogLivePublisher, LogTouch } from './fleet-log-live.publisher';

describe('FleetLogLivePublisher', () => {
  const bus = { publish: vi.fn() };
  const touch = (size: number, over: Partial<LogTouch> = {}): LogTouch => ({ projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size, complete: false, ...over });
  let pub: FleetLogLivePublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    pub = new FleetLogLivePublisher(bus as never);
  });
  afterEach(() => {
    pub.onModuleDestroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const sizes = () => bus.publish.mock.calls.map(([e]) => e.size);

  it('publishes the first touch at once, then at most one per second with the latest size (trailing edge)', () => {
    pub.touch(touch(10), false);
    pub.touch(touch(20), false);
    pub.touch(touch(30), false);
    expect(sizes()).toEqual([10]);
    vi.advanceTimersByTime(1000);
    expect(sizes()).toEqual([10, 30]);
    vi.advanceTimersByTime(1000);
    expect(sizes()).toEqual([10, 30]); // nothing pending: no repeat
    expect(pub.pendingKeys).toBe(0);
  });

  it('an immediate touch publishes now and cancels the pending trailing one', () => {
    pub.touch(touch(10), false);
    pub.touch(touch(20), false);
    pub.touch(touch(25, { complete: true }), true);
    vi.advanceTimersByTime(5000);
    expect(sizes()).toEqual([10, 25]);
    expect(bus.publish.mock.calls[1][0]).toMatchObject({ type: 'fleet_log', complete: true });
  });

  it('keys by job, epoch and stream; every event has a fresh id', () => {
    pub.touch(touch(1), false);
    pub.touch(touch(1, { stream: 'stdout' }), false);
    pub.touch(touch(1, { leaseEpoch: 2 }), false);
    expect(bus.publish).toHaveBeenCalledTimes(3);
    const ids = bus.publish.mock.calls.map(([e]) => e.id);
    expect(new Set(ids).size).toBe(3);
    expect(bus.publish.mock.calls[0][0]).toEqual({ id: ids[0], type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size: 1, complete: false, at: expect.any(String) });
  });
});
