import { LogAppendHooks } from './log-append-hooks';

describe('LogAppendHooks', () => {
  let hooks: LogAppendHooks;

  beforeEach(() => {
    hooks = new LogAppendHooks();
  });

  it('US-001 AC8: run calls the hook registered for the stream once with the event object', async () => {
    const hook = vi.fn(async () => undefined);
    hooks.register('thread', hook);
    const event = { jobId: 'j1', leaseEpoch: 1, stream: 'thread' };
    await hooks.run(event);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(event);
  });

  it('US-001: awaits every hook of the stream in registration order', async () => {
    const order: string[] = [];
    hooks.register('thread', async () => { await new Promise((r) => setTimeout(r, 5)); order.push('first'); });
    hooks.register('thread', async () => { order.push('second'); });
    await hooks.run({ jobId: 'j1', leaseEpoch: 1, stream: 'thread' });
    expect(order).toEqual(['first', 'second']);
  });

  it('US-001: runs no hook for a stream nothing is registered for', async () => {
    const hook = vi.fn(async () => undefined);
    hooks.register('thread', hook);
    await expect(hooks.run({ jobId: 'j1', leaseEpoch: 1, stream: 'run' })).resolves.toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
  });

  it('US-001: run rejects with the hook error, so the caller decides how to log it', async () => {
    const after = vi.fn(async () => undefined);
    hooks.register('thread', async () => { throw new Error('boom'); });
    hooks.register('thread', after);
    await expect(hooks.run({ jobId: 'j1', leaseEpoch: 1, stream: 'thread' })).rejects.toThrow('boom');
    expect(after).not.toHaveBeenCalled();
  });
});
