import { Logger } from '@nestjs/common';
import { ProjectEventBus } from './project-event-bus';
import type { LiveEvent } from './live-event';

const event = (projectId: string, id = 'evt-1'): LiveEvent => ({
  id,
  type: 'ticket',
  action: 'created',
  projectId,
  ticketId: 't1',
  actorId: 'u1',
  at: '2026-09-26T00:00:00.000Z',
});

describe('ProjectEventBus', () => {
  it('delivers an event to every listener of its project', () => {
    const bus = new ProjectEventBus();
    const a = jest.fn();
    const b = jest.fn();
    bus.subscribe('p1', a);
    bus.subscribe('p1', b);

    bus.publish(event('p1'));

    expect(a).toHaveBeenCalledWith(event('p1'));
    expect(b).toHaveBeenCalledWith(event('p1'));
  });

  it('never delivers an event to another project', () => {
    const bus = new ProjectEventBus();
    const other = jest.fn();
    bus.subscribe('p2', other);

    bus.publish(event('p1'));

    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and forgets empty projects', () => {
    const bus = new ProjectEventBus();
    const listener = jest.fn();
    const unsubscribe = bus.subscribe('p1', listener);

    unsubscribe();
    bus.publish(event('p1'));

    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount('p1')).toBe(0);
  });

  it('unsubscribe is idempotent and leaves other listeners alone', () => {
    const bus = new ProjectEventBus();
    const keep = jest.fn();
    const unsubscribe = bus.subscribe('p1', jest.fn());
    bus.subscribe('p1', keep);

    unsubscribe();
    unsubscribe();
    bus.publish(event('p1'));

    expect(keep).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('p1')).toBe(1);
  });

  it('isolates a throwing listener: the others still run and publish does not throw', () => {
    // test-setup.ts already replaces Logger methods with jest spies; do not re-spy or restore them.
    (Logger.prototype.error as jest.Mock).mockClear();
    const bus = new ProjectEventBus();
    const after = jest.fn();
    bus.subscribe('p1', () => {
      throw new Error('boom');
    });
    bus.subscribe('p1', after);

    expect(() => bus.publish(event('p1'))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('the same listener function subscribed twice gets two independent subscriptions', () => {
    const bus = new ProjectEventBus();
    const listener = jest.fn();
    const first = bus.subscribe('p1', listener);
    bus.subscribe('p1', listener);

    first();
    bus.publish(event('p1'));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
