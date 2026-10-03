import { afterEach, describe, expect, test } from 'bun:test';
import { callbackUrlFor, postToNax, signNax, verifyNax } from './nax-callback';

describe('signing (nax webhook.ts:578-583)', () => {
  test('matches the captured nax signature', () => {
    const body = '{"requestId":"ask-1f2e3d4c","action":"choose","value":"allow","respondedBy":"koda:alice","respondedAt":1790000005000}';
    expect(signNax('test-secret', body)).toBe('90407e68331b948e945a8bc4a686f294d65a8d95aa105981a2bec0ba3df7e5cf');
  });
  test('verify accepts the right signature and refuses wrong, missing and odd-length ones', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const good = signNax('s', body);
    expect(verifyNax('s', body, good)).toBe(true);
    expect(verifyNax('s', body, good.replace(/.$/, good.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(verifyNax('s', body, null)).toBe(false);
    expect(verifyNax('s', body, 'abc')).toBe(false);
  });
});

describe('callbackUrlFor (plan D274)', () => {
  test.each([
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ask-1' }, 'http://127.0.0.1:43210/nax/interact/ask-1'],
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ask-2' }, null],
    [{ id: 'ask-1', callbackUrl: 'http://evil.example:43210/nax/interact/ask-1' }, null],
    [{ id: 'ask-1', callbackUrl: 'https://127.0.0.1:43210/nax/interact/ask-1' }, null],
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ask-1?x=1' }, null],
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:99999/nax/interact/ask-1' }, null],
    [{ id: 'ix-US_1.2-size-gate', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ix-US_1.2-size-gate' }, 'http://127.0.0.1:43210/nax/interact/ix-US_1.2-size-gate'],
    [{ id: 'a/b', callbackUrl: 'http://127.0.0.1:43210/nax/interact/a/b' }, null],
  ])('%p -> %p', (input, expected) => {
    expect(callbackUrlFor(input)).toBe(expected);
  });
});

describe('postToNax (spec §4.4)', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => { server?.stop(true); server = null; });

  test('POSTs the signed answer with a numeric respondedAt', async () => {
    const seen: Array<{ body: string; sig: string | null }> = [];
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (req) => { seen.push({ body: await req.text(), sig: req.headers.get('x-nax-signature') }); return new Response('OK'); } });
    const answer = { requestId: 'ask-1', action: 'choose' as const, value: 'allow', respondedBy: 'koda', respondedAt: 1790000005000 };
    expect(await postToNax(`http://127.0.0.1:${server.port}/nax/interact/ask-1`, 's', answer)).toEqual({ ok: true });
    const captured = seen[0];
    if (!captured) throw new Error('the test server did not receive the request');
    expect(JSON.parse(captured.body)).toEqual(answer);
    expect(captured.sig).toBe(signNax('s', captured.body));
  });
  test.each([[429], [401], [503]])('a %i is callback_failed:<status>', async (status) => {
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('no', { status }) });
    expect(await postToNax(`http://127.0.0.1:${server.port}/nax/interact/ask-1`, 's', { requestId: 'ask-1', action: 'choose', value: 'deny', respondedBy: 'koda', respondedAt: 1 }))
      .toEqual({ ok: false, detail: `callback_failed:${status}` });
  });
  test('an unreachable callback is callback_failed:error; a slow one callback_failed:timeout', async () => {
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
    const deadPort = gone.port;
    gone.stop(true);   // a port that was just free and is now closed
    expect(await postToNax(`http://127.0.0.1:${deadPort}/nax/interact/ask-1`, 's', { requestId: 'ask-1', action: 'skip', respondedBy: 'koda', respondedAt: 1 }))
      .toEqual({ ok: false, detail: 'callback_failed:error' });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    expect(await postToNax(`http://127.0.0.1:${server.port}/nax/interact/ask-1`, 's', { requestId: 'ask-1', action: 'skip', respondedBy: 'koda', respondedAt: 1 }, { timeoutMs: 50 }))
      .toEqual({ ok: false, detail: 'callback_failed:timeout' });
  });
});
