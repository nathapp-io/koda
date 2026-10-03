import { afterEach, describe, expect, test } from 'bun:test';
import { ApprovalReceiver } from './approval-receiver';
import { signNax } from './nax-callback';

let receiver: ApprovalReceiver | null = null;
afterEach(() => { receiver?.stop(); receiver = null; });

const post = (port: number, body: string, sig: string | null, path = '/ask') =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-nax-signature': sig } : {}) }, body });

describe('ApprovalReceiver (spec §4.2)', () => {
  test('binds 127.0.0.1 on a free port and hands a verified body to onRequest', async () => {
    const seen: unknown[] = [];
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async (b) => { seen.push(b); return 200; } });
    expect(receiver.port).toBeGreaterThan(0);
    const body = JSON.stringify({ id: 'ask-1' });
    expect((await post(receiver.port, body, signNax('s', body))).status).toBe(200);
    expect(seen).toEqual([{ id: 'ask-1' }]);
  });
  test('401 on a bad or missing signature; onRequest not called', async () => {
    let calls = 0;
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => { calls += 1; return 200; } });
    expect((await post(receiver.port, '{}', signNax('other', '{}'))).status).toBe(401);
    expect((await post(receiver.port, '{}', null)).status).toBe(401);
    expect(calls).toBe(0);
  });
  test('413 over 64 KiB', async () => {
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => 200 });
    const body = JSON.stringify({ pad: 'x'.repeat(70_000) });
    expect((await post(receiver.port, body, signNax('s', body))).status).toBe(413);
  });
  test('404 for another path or method; 400 for invalid JSON', async () => {
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => 200 });
    expect((await post(receiver.port, '{}', signNax('s', '{}'), '/other')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${receiver.port}/ask`)).status).toBe(404);
    expect((await post(receiver.port, 'not json', signNax('s', 'not json'))).status).toBe(400);
  });
  test('starting on a taken port throws', () => {
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => 200 });
    const takenPort = receiver.port;
    expect(() => ApprovalReceiver.start({ port: takenPort, secret: 's', onRequest: async () => 200 })).toThrow();
  });
});
