import type { MessageEvent } from '@nestjs/common';
import { createLiveStream, LiveStreamOptions } from './live-stream';
import type { LiveEvent } from './live-event';

const liveEvent: LiveEvent = {
  id: 'evt-1', type: 'ticket', action: 'transitioned', projectId: 'p1', ticketId: 't1', actorId: 'u1', at: '2026-09-26T00:00:00.000Z',
};

function setup(overrides: Partial<LiveStreamOptions> = {}) {
  let listener: ((event: LiveEvent) => void) | null = null;
  const unsubscribe = jest.fn();
  const options: LiveStreamOptions = {
    projectId: 'p1',
    heartbeatMs: 1000,
    expiresAtMs: null,
    now: () => 0,
    subscribe: jest.fn((_projectId, l) => {
      listener = l;
      return unsubscribe;
    }),
    stillAllowed: jest.fn().mockResolvedValue(true),
    onClose: jest.fn(),
    ...overrides,
  };
  const messages: MessageEvent[] = [];
  let completed = false;
  const subscription = createLiveStream(options).subscribe({
    next: (m) => messages.push(m),
    complete: () => {
      completed = true;
    },
  });
  return {
    options,
    messages,
    unsubscribe,
    subscription,
    emit: (event: LiveEvent) => listener?.(event),
    isCompleted: () => completed,
  };
}

describe('createLiveStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends ready first, then subscribes to the project', () => {
    const s = setup();
    expect(s.messages[0]).toEqual({ type: 'ready', data: {} });
    expect(s.options.subscribe).toHaveBeenCalledWith('p1', expect.any(Function));
    s.subscription.unsubscribe();
  });

  it('forwards bus events as named ticket events carrying the event id', () => {
    const s = setup();
    s.emit(liveEvent);
    expect(s.messages[1]).toEqual({ type: 'ticket', id: 'evt-1', data: liveEvent });
    s.subscription.unsubscribe();
  });

  it('pings on each heartbeat while access holds', async () => {
    const s = setup();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.messages.filter((m) => m.type === 'ping')).toHaveLength(2);
    expect(s.options.stillAllowed).toHaveBeenCalledTimes(2);
    s.subscription.unsubscribe();
  });

  it('completes on the first heartbeat that loses access, and pings no more', async () => {
    const stillAllowed = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const s = setup({ stillAllowed });
    await jest.advanceTimersByTimeAsync(2000);
    expect(s.isCompleted()).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(s.messages.filter((m) => m.type === 'ping')).toHaveLength(1);
  });

  it('treats a failing access check as lost access', async () => {
    const s = setup({ stillAllowed: jest.fn().mockRejectedValue(new Error('db down')) });
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.isCompleted()).toBe(true);
  });

  it('completes at token expiry', async () => {
    const s = setup({ expiresAtMs: 1500, now: () => 0, heartbeatMs: 60_000 });
    await jest.advanceTimersByTimeAsync(1499);
    expect(s.isCompleted()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(s.isCompleted()).toBe(true);
  });

  it('does not fire at once for a far-future expiry (timer overflow guard)', async () => {
    const s = setup({ expiresAtMs: 60 * 24 * 60 * 60 * 1000, now: () => 0, heartbeatMs: 60_000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.isCompleted()).toBe(false);
    s.subscription.unsubscribe();
  });

  it('does not hammer checks when the heartbeat delay overflows the timer range', async () => {
    const s = setup({ heartbeatMs: 60 * 24 * 60 * 60 * 1000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.messages.filter((m) => m.type === 'ping')).toHaveLength(0);
    expect(s.options.stillAllowed).not.toHaveBeenCalled();
    s.subscription.unsubscribe();
  });

  it('completes right after ready when the token is already expired', async () => {
    const s = setup({ expiresAtMs: 10, now: () => 20 });
    await jest.advanceTimersByTimeAsync(0);
    expect(s.messages[0].type).toBe('ready');
    expect(s.isCompleted()).toBe(true);
  });

  it('tears down exactly once on client close: bus unsubscribed, timers cleared, onClose called', async () => {
    const s = setup();
    s.subscription.unsubscribe();
    s.subscription.unsubscribe();
    await jest.advanceTimersByTimeAsync(5000);
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.options.onClose).toHaveBeenCalledTimes(1);
    expect(s.options.stillAllowed).not.toHaveBeenCalled();
  });

  it('tears down exactly once when the server closes the stream', async () => {
    const s = setup({ stillAllowed: jest.fn().mockResolvedValue(false) });
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.options.onClose).toHaveBeenCalledTimes(1);
  });

  it('skips a heartbeat while the previous access check is still running', async () => {
    let resolveCheck: (value: boolean) => void = () => undefined;
    const stillAllowed = jest.fn(() => new Promise<boolean>((resolve) => { resolveCheck = resolve; }));
    const s = setup({ stillAllowed });
    await jest.advanceTimersByTimeAsync(3000);
    expect(stillAllowed).toHaveBeenCalledTimes(1);
    resolveCheck(true);
    s.subscription.unsubscribe();
  });
});
