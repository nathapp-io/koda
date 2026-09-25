import { FanOutPublisher, OutboxFanOutError, OUTBOX_LAST_ERROR_MAX_LENGTH } from './fan-out-publisher';
import { outboxRecord } from '../../test/helpers/outbox-record';

describe('FanOutPublisher', () => {
  let recordLastError: jest.Mock;
  let publisher: FanOutPublisher;

  beforeEach(() => {
    recordLastError = jest.fn().mockResolvedValue(undefined);
    publisher = new FanOutPublisher({ recordLastError });
  });

  it('calls every handler for the record type with the payload, in registration order', async () => {
    const first = jest.fn();
    const second = jest.fn();
    publisher.register('ticket_event', first);
    publisher.register('ticket_event', second);

    await publisher.publish(outboxRecord('ticket_event', { id: 'e1' }));

    expect(first).toHaveBeenCalledWith({ id: 'e1' });
    expect(second).toHaveBeenCalledWith({ id: 'e1' });
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
    expect(recordLastError).not.toHaveBeenCalled();
  });

  it('ignores handlers registered for other types', async () => {
    const other = jest.fn();
    publisher.register('agent_event', other);

    await publisher.publish(outboxRecord('ticket_event', {}));

    expect(other).not.toHaveBeenCalled();
  });

  it('resolves when no handler is registered for the type', async () => {
    await expect(publisher.publish(outboxRecord('unknown_type', {}))).resolves.toBeUndefined();
  });

  it('runs the remaining handlers after one fails, then rejects with one aggregate error', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('boom'));
    const after = jest.fn();
    publisher.register('ticket_event', failing);
    publisher.register('ticket_event', after);

    const result = publisher.publish(outboxRecord('ticket_event', {}, { id: 'row-1' }));

    await expect(result).rejects.toBeInstanceOf(OutboxFanOutError);
    await expect(result).rejects.toThrow('1 fan-out handler(s) failed for ticket_event: boom');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('records lastError for the failed record before rejecting', async () => {
    publisher.register('ticket_event', () => {
      throw new Error('handler exploded');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}, { id: 'row-2' }))).rejects.toThrow();

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

  it('still rejects with the handler failure when writing lastError fails', async () => {
    recordLastError.mockRejectedValue(new Error('db down'));
    publisher.register('ticket_event', () => {
      throw new Error('handler failed');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}))).rejects.toThrow('handler failed');
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
    const handler = jest.fn();
    publisher.register('ticket_event', handler);
    publisher.register('ticket_event', handler);
    expect(publisher.getHandlers('ticket_event')).toHaveLength(1);

    publisher.unregister('ticket_event', handler);

    expect(publisher.getHandlers('ticket_event')).toHaveLength(0);
  });
});
