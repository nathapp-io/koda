import type { Mock } from 'vitest';
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
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('p1', a);
    bus.subscribe('p1', b);

    bus.publish(event('p1'));

    expect(a).toHaveBeenCalledWith(event('p1'));
    expect(b).toHaveBeenCalledWith(event('p1'));
  });

  it('never delivers an event to another project', () => {
    const bus = new ProjectEventBus();
    const other = vi.fn();
    bus.subscribe('p2', other);

    bus.publish(event('p1'));

    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and forgets empty projects', () => {
    const bus = new ProjectEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe('p1', listener);

    unsubscribe();
    bus.publish(event('p1'));

    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount('p1')).toBe(0);
  });

  it('unsubscribe is idempotent and leaves other listeners alone', () => {
    const bus = new ProjectEventBus();
    const keep = vi.fn();
    const unsubscribe = bus.subscribe('p1', vi.fn());
    bus.subscribe('p1', keep);

    unsubscribe();
    unsubscribe();
    bus.publish(event('p1'));

    expect(keep).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('p1')).toBe(1);
  });

  it('isolates a throwing listener: the others still run and publish does not throw', () => {
    // test-setup.ts already replaces Logger methods with jest spies; do not re-spy or restore them.
    (Logger.prototype.error as Mock).mockClear();
    const bus = new ProjectEventBus();
    const after = vi.fn();
    bus.subscribe('p1', () => {
      throw new Error('boom');
    });
    bus.subscribe('p1', after);

    expect(() => bus.publish(event('p1'))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('retryable delivery rejects failures but deduplicates successful consumers on redelivery', () => {
    const bus = new ProjectEventBus();
    const good = vi.fn();
    const bad = vi.fn().mockImplementationOnce(() => { throw new Error('socket failed'); });
    bus.subscribe('p1', good);
    bus.subscribe('p1', bad);
    expect(() => bus.publishRetryable(event('p1'))).toThrow('socket failed');
    expect(() => bus.publishRetryable(event('p1'))).not.toThrow();
    bus.publishRetryable(event('p1'));
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it.each(['publication', 'acknowledgement'])('retains an unacknowledged frame through >1024 intervening frames after %s failure', (failure) => {
    const bus = new ProjectEventBus();
    const good = vi.fn();
    const bad = vi.fn((frame: LiveEvent) => {
      if (failure === 'publication' && frame.id === 'held') throw new Error('socket failed');
    });
    bus.subscribe('p1', good);
    bus.subscribe('p1', bad);
    try { bus.publishRetryable(event('p1', 'held')); } catch (error) {
      expect(failure).toBe('publication');
      expect(error).toBeInstanceOf(AggregateError);
    }
    for (let i = 0; i < 1100; i++) bus.publishRetryable(event('p1', String(i)));
    good.mockClear();
    bad.mockImplementation(() => undefined);
    bus.publishRetryable(event('p1', 'held'));
    expect(good).not.toHaveBeenCalled();
  });

  it('releases deduplication state only after durable acknowledgement or unsubscribe', () => {
    const bus = new ProjectEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe('p1', listener);
    bus.publishRetryable(event('p1'));
    bus.acknowledgeRetryable(event('p1'));
    // The producer's durable marker now prevents retries; the bus no longer owns this id.
    bus.publishRetryable(event('p1'));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    bus.publishRetryable(event('p1'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('the same listener function subscribed twice gets two independent subscriptions', () => {
    const bus = new ProjectEventBus();
    const listener = vi.fn();
    const first = bus.subscribe('p1', listener);
    bus.subscribe('p1', listener);

    first();
    bus.publish(event('p1'));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
