import { describe, expect, test } from 'bun:test';
import { serveRequest, type RequestSocket } from './cred-server';

type Reply = { ok: boolean; reason?: string; token?: string };

const REPLIES = {
  badRequest: { ok: false, reason: 'bad request' } as Reply,
  error: { ok: false, reason: 'error' } as Reply,
};

/** The `provider-key-server.spec.ts` stand-in: the line protocol is what these tests are about, the socket is transport. */
class FakeSocket implements RequestSocket {
  private data: ((chunk: string) => void) | null = null;
  readonly written: string[] = [];
  setEncoding(): void {}
  on(event: 'error' | 'data', listener: (chunk: string) => void): this {
    if (event === 'data') this.data = listener;
    return this;
  }
  end(reply: string): this {
    this.written.push(reply);
    return this;
  }
  send(chunk: string): void {
    this.data?.(chunk);
  }
}

/** A reply the test resolves by hand, so "while a reply is pending" is a state the test holds. */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const settle = (): Promise<void> => Bun.sleep(1);

describe('serveRequest takes one request line per connection (US-006)', () => {
  test('AC-9: a repeated chunk while the reply is pending calls request exactly once', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    const reply = pending<Reply>();
    serveRequest(socket, (line) => { calls.push(line); return reply.promise; }, REPLIES);
    socket.send('get\n');
    socket.send('get\n');
    await settle();
    expect(calls, `request was called ${calls.length} time(s): ${JSON.stringify(calls)}`).toEqual(['get']);
  });

  test('AC-10: ten more chunks reaching a newline dispatch nothing, and the one reply is a JSON line', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    const reply = pending<Reply>();
    serveRequest(socket, (line) => { calls.push(line); return reply.promise; }, REPLIES);
    socket.send('get\n');
    for (let index = 0; index < 10; index += 1) socket.send(`${'x'.repeat(1023)}\n`);
    await settle();
    expect(calls, `request was called ${calls.length} time(s): ${JSON.stringify(calls)}`).toEqual(['get']);
    expect(socket.written, `a reply was written while the first was pending: ${JSON.stringify(socket.written)}`).toEqual([]);
    reply.resolve({ ok: true, token: 'ghs_t' });
    await settle();
    expect(socket.written).toEqual(['{"ok":true,"token":"ghs_t"}\n']);
  });

  test('AC-11: a single `get` chunk reaches request once as `get`, and later chunks change nothing', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    serveRequest(socket, (line) => { calls.push(line); return Promise.resolve({ ok: true } as Reply); }, REPLIES);
    socket.send('get\n');
    await settle();
    expect(calls).toEqual(['get']);
    expect(socket.written).toEqual(['{"ok":true}\n']);
    socket.send('get\n');
    socket.send('provider openrouter\n');
    await settle();
    expect(calls, `request was called ${calls.length} time(s): ${JSON.stringify(calls)}`).toEqual(['get']);
    expect(socket.written).toHaveLength(1);
  });

  test('AC-12: 65 bytes without a newline answers badRequest and never calls request', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    serveRequest(socket, (line) => { calls.push(line); return Promise.resolve({ ok: true } as Reply); }, REPLIES);
    socket.send('x'.repeat(65));
    await settle();
    expect(socket.written).toEqual(['{"ok":false,"reason":"bad request"}\n']);
    expect(calls, `request was called ${calls.length} time(s) for a request that is not ours`).toEqual([]);
  });
});
