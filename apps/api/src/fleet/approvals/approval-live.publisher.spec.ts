import { ApprovalLivePublisher } from './approval-live.publisher';
import type { ProjectEventBus } from '../../live/project-event-bus';
import type { LiveFleetApprovalEvent } from '../../live/live-event';

/**
 * S1.5 §2.5 guard: only project-scoped approvals reach the bus, and the frame is content-free.
 * The closer spec stubs the publisher out, so these are the only committed coverage of it.
 */
describe('ApprovalLivePublisher', () => {
  const make = () => {
    const bus = { publish: vi.fn() };
    return { bus, publisher: new ApprovalLivePublisher(bus as unknown as ProjectEventBus) };
  };

  it('builds no event for an approval with no project', () => {
    expect(make().publisher.event({ id: 'a1', projectId: null, status: 'pending' })).toEqual([]);
  });

  it('builds one content-free fleet_approval frame for a project approval', () => {
    const events = make().publisher.event({ id: 'a1', projectId: 'p1', status: 'approved' });
    expect(events).toHaveLength(1);
    const [event] = events as [LiveFleetApprovalEvent];
    expect(event.id).toEqual(expect.any(String));
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.type).toBe('fleet_approval');
    expect(event.projectId).toBe('p1');
    expect(event.approvalId).toBe('a1');
    expect(event.status).toBe('approved');
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    // Content-free: no payload, command or money reaches the frame.
    expect(Object.keys(event).sort()).toEqual(['approvalId', 'at', 'id', 'projectId', 'status', 'type']);
  });

  it('gives each event its own id', () => {
    const { publisher } = make();
    const [first, second] = [
      publisher.event({ id: 'a1', projectId: 'p1', status: 'pending' })[0],
      publisher.event({ id: 'a1', projectId: 'p1', status: 'pending' })[0],
    ];
    expect(first.id).not.toBe(second.id);
  });

  it('forwards every event to the bus exactly once', () => {
    const { bus, publisher } = make();
    const events = [
      { id: 'e1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'cancelled', at: '2026-10-02T10:00:00.000Z' },
      { id: 'e2', type: 'fleet_approval', projectId: 'p1', approvalId: 'a2', status: 'pending', at: '2026-10-02T10:00:00.000Z' },
    ] as LiveFleetApprovalEvent[];
    publisher.publish(events);
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(bus.publish).toHaveBeenNthCalledWith(1, events[0]);
    expect(bus.publish).toHaveBeenNthCalledWith(2, events[1]);
  });

  it('publishes nothing for an empty batch', () => {
    const { bus, publisher } = make();
    publisher.publish([]);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  describe('US-009 fix round 2: retryable publication for an outbox-backed producer', () => {
    const frame = (id: string): LiveFleetApprovalEvent =>
      ({ id, type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'approved', at: '2026-10-02T10:00:00.000Z' });
    const makeRetryable = () => {
      const bus = { publish: vi.fn(), publishRetryable: vi.fn(), acknowledgeRetryable: vi.fn() };
      return { bus, publisher: new ApprovalLivePublisher(bus as unknown as ProjectEventBus) };
    };

    it('sends a retryable batch through the bus publication that reports a failed listener', () => {
      const { bus, publisher } = makeRetryable();
      const events = [frame('e1'), frame('e2')];

      publisher.publish(events, { retryable: true });

      expect(bus.publish).not.toHaveBeenCalled();
      expect(bus.publishRetryable).toHaveBeenCalledTimes(2);
      expect(bus.publishRetryable).toHaveBeenNthCalledWith(1, events[0]);
      expect(bus.publishRetryable).toHaveBeenNthCalledWith(2, events[1]);
    });

    it('lets a failed listener throw, so the caller can retry the publication', () => {
      const { bus, publisher } = makeRetryable();
      bus.publishRetryable.mockImplementation(() => { throw new Error('socket unavailable'); });

      expect(() => publisher.publish([frame('e1')], { retryable: true })).toThrow('socket unavailable');
    });

    it('releases the delivered ids only when the caller acknowledges them', () => {
      const { bus, publisher } = makeRetryable();
      const events = [frame('e1')];

      publisher.publish(events, { retryable: true });
      expect(bus.acknowledgeRetryable).not.toHaveBeenCalled();

      publisher.acknowledge(events);
      expect(bus.acknowledgeRetryable).toHaveBeenCalledWith(events[0]);
    });

    it('keeps the plain publication non-throwing for the fleet-side producers', () => {
      const { bus, publisher } = makeRetryable();
      // A caller outside the relay has already committed: a listener failure must not surface as a request failure.
      bus.publishRetryable.mockImplementation(() => { throw new Error('socket unavailable'); });

      expect(() => publisher.publish([frame('e1')])).not.toThrow();
      expect(bus.acknowledgeRetryable).not.toHaveBeenCalled();
    });
  });
});
