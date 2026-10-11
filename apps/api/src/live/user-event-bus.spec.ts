import { Logger } from '@nestjs/common';
import { UserEventBus, UserLiveEvent } from './user-event-bus';

const event = (userId: string, id = 'n1'): UserLiveEvent => ({ type: 'notification', userId, id, at: '2026-10-09T00:00:00.000Z' });

describe('UserEventBus (S4a §4)', () => {
  it('delivers only to the addressed user', () => {
    const bus = new UserEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('u1', a);
    bus.subscribe('u2', b);
    bus.publish(event('u1'));
    expect(a).toHaveBeenCalledWith(event('u1'));
    expect(b).not.toHaveBeenCalled();
  });

  it('unsubscribes and counts listeners per user', () => {
    const bus = new UserEventBus();
    const off = bus.subscribe('u1', vi.fn());
    bus.subscribe('u1', vi.fn());
    expect(bus.listenerCount('u1')).toBe(2);
    off();
    expect(bus.listenerCount('u1')).toBe(1);
    expect(bus.listenerCount('nobody')).toBe(0);
  });

  it('never throws when a listener does, and still reaches the others', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bus = new UserEventBus();
    const ok = vi.fn();
    bus.subscribe('u1', () => { throw new Error('boom'); });
    bus.subscribe('u1', ok);
    expect(() => bus.publish(event('u1'))).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });
});
