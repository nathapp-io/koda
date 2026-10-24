import type { Mock } from 'vitest';
import { FanOutPublisher, OutboxFanOutError, OUTBOX_LAST_ERROR_MAX_LENGTH } from './fan-out-publisher';
import { outboxRecord } from '../../test/helpers/outbox-record';
import { currentContext, runWithActionContext, type ActionContext } from '../action-context/action-context';

describe('FanOutPublisher', () => {
  let recordLastError: Mock;
  let publisher: FanOutPublisher;

  beforeEach(() => {
    recordLastError = vi.fn().mockResolvedValue(undefined);
    publisher = new FanOutPublisher({ recordLastError });
  });

  it('calls every handler for the record type with the payload, in registration order', async () => {
    const first = vi.fn();
    const second = vi.fn();
    publisher.register('ticket_event', first);
    publisher.register('ticket_event', second);

    await publisher.publish(outboxRecord('ticket_event', { id: 'e1' }));

    expect(first).toHaveBeenCalledWith({ id: 'e1' });
    expect(second).toHaveBeenCalledWith({ id: 'e1' });
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
    expect(recordLastError).not.toHaveBeenCalled();
  });

  it('AC-1: invokes every handler inside a SYSTEM/outbox context', async () => {
    const observed: (ActionContext | undefined)[] = [];
    const first = () => observed.push(currentContext());
    const second = () => observed.push(currentContext());
    publisher.register('ticket_event', first);
    publisher.register('ticket_event', second);

    await publisher.publish(outboxRecord('ticket_event', { id: 'e1' }));

    expect(observed).toHaveLength(2);
    for (const context of observed) {
      expect(context?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
      // A fan-out run is a direct action before P3: no approval is claimed for it.
      expect(context?.approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none' });
      // Each handler gets its own run, and nothing is left behind afterwards.
      expect(currentContext()).toBeUndefined();
    }
  });

  it('AC-2: invokes a handler with origin system, inside the enclosing correlation id', async () => {
    let observed: ActionContext | undefined;
    publisher.register('ticket_event', () => {
      observed = currentContext();
    });

    await runWithActionContext(
      { actor: { type: 'USER', id: 'u1' }, origin: 'rest', correlationId: 'c-1' },
      () => publisher.publish(outboxRecord('ticket_event', {})),
    );

    expect(observed?.origin).toBe('system');
    expect(observed?.correlationId).toBe('c-1');
  });

  it('ignores handlers registered for other types', async () => {
    const other = vi.fn();
    publisher.register('agent_event', other);

    await publisher.publish(outboxRecord('ticket_event', {}));

    expect(other).not.toHaveBeenCalled();
  });

  it('resolves when no handler is registered for the type', async () => {
    await expect(publisher.publish(outboxRecord('unknown_type', {}))).resolves.toBeUndefined();
  });

  it('AC-9 / AC-11: runs the remaining handlers after one fails, then rejects with one aggregate error', async () => {
    let failingContext: ActionContext | undefined;
    const failing = vi.fn(() => {
      failingContext = currentContext();
      throw new Error('boom');
    });
    const after = vi.fn();
    publisher.register('ticket_event', failing);
    publisher.register('ticket_event', after);

    const result = publisher.publish(outboxRecord('ticket_event', {}, { id: 'row-1' }));

    await expect(result).rejects.toBeInstanceOf(OutboxFanOutError);
    await expect(result).rejects.toThrow('1 fan-out handler(s) failed for ticket_event: boom');
    // AC-9: the failure happens inside SYSTEM/outbox, and the remaining handler still runs.
    expect(failingContext?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('AC-10: records lastError for the failed record before rejecting', async () => {
    let failingContext: ActionContext | undefined;
    publisher.register('ticket_event', () => {
      failingContext = currentContext();
      throw new Error('handler exploded');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}, { id: 'row-2' }))).rejects.toThrow();

    // AC-10: unchanged aggregation, thrown from inside SYSTEM/outbox.
    expect(failingContext?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
    expect(recordLastError).toHaveBeenCalledWith('row-2', '1 fan-out handler(s) failed for ticket_event: handler exploded');
  });

  it('truncates lastError to OUTBOX_LAST_ERROR_MAX_LENGTH characters', async () => {
    publisher.register('ticket_event', () => {
      throw new Error('x'.repeat(10_000));
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}))).rejects.toThrow();

    const [, message] = recordLastError.mock.calls[0] as [string, string];
    expect(message.length).toBe(OUTBOX_LAST_ERROR_MAX_LENGTH);
  });

  it('AC-5: awaits recordLastError in SYSTEM/outbox context', async () => {
    let observed: ActionContext | undefined;
    recordLastError.mockImplementation(() => ({
      then(resolve: (value: undefined) => unknown) {
        observed = currentContext();
        return Promise.resolve(resolve(undefined));
      },
    }));
    publisher.register('ticket_event', () => {
      throw new Error('boom');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}))).rejects.toThrow('boom');
    expect(observed?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
  });

  // US-003 suggested criterion (not an acceptance criterion of its own, and AC-9 already labels the
  // aggregate-failure case above): a failing recordLastError must not mask the handler failure.
  it('still rejects with the handler failure when writing lastError fails', async () => {
    recordLastError.mockRejectedValue(new Error('db down'));
    publisher.register('ticket_event', () => {
      throw new Error('handler failed');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}))).rejects.toMatchObject({
      name: 'OutboxFanOutError',
      failures: ['handler failed'],
    });
  });

  it('M4: a concurrent failing publish does not affect a succeeding one', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    publisher.register('slow_ok', async () => {
      await gate;
    });
    publisher.register('fails', () => {
      throw new Error('nope');
    });

    const ok = publisher.publish(outboxRecord('slow_ok', {}, { id: 'ok' }));
    const bad = publisher.publish(outboxRecord('fails', {}, { id: 'bad' }));
    await expect(bad).rejects.toThrow('nope');
    release();

    await expect(ok).resolves.toBeUndefined();
    expect(recordLastError).toHaveBeenCalledTimes(1);
    expect(recordLastError).toHaveBeenCalledWith('bad', expect.any(String));
  });

  it('registers a given handler only once per type and unregisters it', async () => {
    const handler = vi.fn();
    publisher.register('ticket_event', handler);
    publisher.register('ticket_event', handler);
    expect(publisher.getHandlers('ticket_event')).toHaveLength(1);

    publisher.unregister('ticket_event', handler);

    expect(publisher.getHandlers('ticket_event')).toHaveLength(0);
  });
});
