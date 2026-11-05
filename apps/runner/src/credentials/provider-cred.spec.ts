// apps/runner/src/credentials/provider-cred.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  PROVIDER_CRED_SOCKET_ENV, PROVIDER_CRED_TIMEOUT_MS, parseProviderReply, parseProviderRequest, requestProviderKey, runProviderCred,
  type ProviderCredIo, type ProviderCredReply,
} from './provider-cred';
import { makeTempDirs } from '../../test/helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const API_KEY: ProviderCredReply = { ok: true, key: 'k1', expiresAt: 1, account: 'koda:global:fleet' };
const ASK = { version: 1, providerId: 'openrouter' };

/** The helper's whole outside world: stdin, stdout, stderr, the environment and the one socket call. */
function io(
  body: unknown,
  reply: ProviderCredReply | (() => Promise<ProviderCredReply>),
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: Array<{ path: string; providerId: string }> = [];
  const seam: ProviderCredIo & { out: string[]; err: string[]; asked: Array<{ path: string; providerId: string }> } = {
    out, err, asked,
    readStdin: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    write: (text) => { out.push(text); },
    warn: (line) => { err.push(line); },
    env,
    request: async (path, providerId) => {
      asked.push({ path, providerId });
      return typeof reply === 'function' ? await reply() : reply;
    },
  };
  return seam;
}

describe('runProviderCred (US-009)', () => {
  test('AC-1: get writes the api-key reply for the provider in the nax request and exits 0', async () => {
    const x = io(ASK, API_KEY, { [PROVIDER_CRED_SOCKET_ENV]: '/run/jobs/j1/provider-keys.sock' });
    expect(await runProviderCred(['get'], x)).toBe(0);
    expect(x.out.join('')).toBe('{"version":1,"kind":"api-key","key":"k1","expiresAt":1,"account":"koda:global:fleet"}\n');
    expect(x.asked).toEqual([{ path: '/run/jobs/j1/provider-keys.sock', providerId: 'openrouter' }]);
    expect(x.err).toEqual([]);
  });

  test('AC-2: --socket wins over the inherited KODA_PROVIDER_CRED_SOCKET', async () => {
    const x = io(ASK, API_KEY, { [PROVIDER_CRED_SOCKET_ENV]: '/run/jobs/other/provider-keys.sock' });
    expect(await runProviderCred(['--socket', '/run/jobs/this/provider-keys.sock', 'get'], x)).toBe(0);
    expect(x.asked).toEqual([{ path: '/run/jobs/this/provider-keys.sock', providerId: 'openrouter' }]);
  });

  test('AC-3: with neither --socket nor the environment the helper declines and exits 0', async () => {
    const x = io(ASK, API_KEY);
    expect(await runProviderCred(['get'], x)).toBe(0);
    expect(x.out.join('')).toBe('{"version":1,"decline":true}\n');
    expect(x.asked).toEqual([]);
    expect(x.err).toEqual([]);
  });

  test('AC-4: a `none` answer declines, so nax falls back to the machine credentials file', async () => {
    const x = io(ASK, { ok: false, reason: 'none' }, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
    expect(await runProviderCred(['get'], x)).toBe(0);
    expect(x.out.join('')).toBe('{"version":1,"decline":true}\n');
    expect(x.err).toEqual([]);
  });

  for (const reason of ['revoked', 'error', 'bad request'] as const) {
    test(`AC-5: a ${reason} answer exits 1 with one non-secret stderr line and no stdout`, async () => {
      const x = io(ASK, { ok: false, reason }, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
      expect(await runProviderCred(['get'], x)).toBe(1);
      expect(x.out).toEqual([]);
      expect(x.err).toHaveLength(1);
      expect(x.err[0]).not.toContain('\n');
      expect(x.err[0]).not.toContain('sk-');
      expect(x.err[0]?.length ?? 0).toBeGreaterThan(0);
    });
  }

  test('AC-6: a socket error exits 1 with one non-secret stderr line and never a decline', async () => {
    const x = io(ASK, () => Promise.reject(new Error('connect ECONNREFUSED /s/p.sock')), { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
    expect(await runProviderCred(['get'], x)).toBe(1);
    expect(x.out).toEqual([]);   // no decline: a job that lost its socket must fail loudly, not switch to a local key
    expect(x.err).toHaveLength(1);
    expect(x.err[0]).not.toContain('ECONNREFUSED');
  });

  test('AC-6: a path nothing listens on exits 1, writes no stdout and no decline', async () => {
    const path = join(await tmp.make('pc'), 'nothing.sock');
    const out: string[] = [];
    const err: string[] = [];
    const x: ProviderCredIo = {
      readStdin: async () => JSON.stringify(ASK),
      write: (text) => { out.push(text); },
      warn: (line) => { err.push(line); },
      env: { [PROVIDER_CRED_SOCKET_ENV]: path },
      request: (sock, providerId) => requestProviderKey(sock, providerId),
    };
    expect(await runProviderCred(['get'], x)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
  });

  test('a request that is not one of nax\'s is refused, never sent to the socket', async () => {
    for (const body of ['', 'not json', JSON.stringify({ version: 2, providerId: 'openrouter' }), JSON.stringify({ version: 1, providerId: 'Bad Id' })]) {
      const x = io(body, API_KEY, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
      expect(await runProviderCred(['get'], x)).toBe(1);
      expect(x.out).toEqual([]);
      expect(x.err).toHaveLength(1);
      expect(x.asked).toEqual([]);
    }
  });

  test('an unknown action fails rather than declining', async () => {
    const x = io(ASK, API_KEY, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
    expect(await runProviderCred([], x)).toBe(1);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual([]);
  });

  test('a --socket without its path fails rather than declining', async () => {
    const x = io(ASK, API_KEY, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
    expect(await runProviderCred(['--socket'], x)).toBe(1);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual([]);
    expect(x.err).toHaveLength(1);
  });

  test('a key or account beyond nax\'s schema limits is refused, not written', async () => {
    for (const reply of [{ ...API_KEY, key: 'k'.repeat(8193) }, { ...API_KEY, account: 'a'.repeat(201) }, { ...API_KEY, expiresAt: Number.NaN }] as ProviderCredReply[]) {
      const x = io(ASK, reply, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
      expect(await runProviderCred(['get'], x)).toBe(1);
      expect(x.out).toEqual([]);
      expect(x.err).toHaveLength(1);
    }
  });

  test('the reply never carries the key anywhere but the key field', async () => {
    const x = io(ASK, { ...API_KEY, key: 'sk-or-secret' }, { [PROVIDER_CRED_SOCKET_ENV]: '/s/p.sock' });
    await runProviderCred(['get'], x);
    expect(x.err).toEqual([]);
    expect(JSON.parse(x.out.join(''))).toEqual({ version: 1, kind: 'api-key', key: 'sk-or-secret', expiresAt: 1, account: 'koda:global:fleet' });
  });
});

describe('koda-runner provider-cred through the real binary (US-009)', () => {
  const MAIN = join(import.meta.dir, '..', 'main.ts');
  async function cli(argv: string[], stdin: string, env: Record<string, string> = {}) {
    const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
      stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, KODA_PROVIDER_CRED_SOCKET: '', ...env },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test('dispatchInternal recognizes provider-cred before commander, and with no socket it declines', async () => {
    const out = await cli(['provider-cred', 'get'], '{"version":1,"providerId":"openrouter"}');
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('{"version":1,"decline":true}\n');
    expect(out.stderr).toBe('');
  });

  test('a socket nothing listens on exits 1 through the real binary and prints no decline', async () => {
    const path = join(await tmp.make('pc-cli'), 'gone.sock');
    const out = await cli(['provider-cred', 'get'], '{"version":1,"providerId":"openrouter"}', { KODA_PROVIDER_CRED_SOCKET: path });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
  });
});

describe('parseProviderRequest', () => {
  test('reads nax\'s version 1 request', () => {
    expect(parseProviderRequest('{"version":1,"providerId":"openrouter"}')).toEqual({ ok: true, providerId: 'openrouter' });
    expect(parseProviderRequest('{"version":1,"providerId":"openrouter"}\n')).toEqual({ ok: true, providerId: 'openrouter' });
  });
  test('refuses anything else', () => {
    for (const text of ['', '{}', '{"version":1}', '{"version":1,"providerId":""}', '{"version":1,"providerId":"Bad Id"}', '{"version":"1","providerId":"openrouter"}', 'nope']) {
      expect(parseProviderRequest(text).ok).toBe(false);
    }
  });
});

describe('requestProviderKey', () => {
  test('a missing socket is `unavailable`, never a throw', async () => {
    expect(await requestProviderKey(join(await tmp.make('pc'), 'gone.sock'), 'openrouter')).toEqual({ ok: false, reason: 'unavailable' });
  });
  test('the helper timeout is under nax\'s 60 s helper timeout', () => {
    expect(PROVIDER_CRED_TIMEOUT_MS).toBeLessThan(60_000);
  });
});

describe('parseProviderReply', () => {
  test('reads the two reply shapes', () => {
    expect(parseProviderReply('{"ok":true,"key":"k1","expiresAt":2,"account":"a"}\n')).toEqual({ ok: true, key: 'k1', expiresAt: 2, account: 'a' });
    expect(parseProviderReply('{"ok":false,"reason":"none"}')).toEqual({ ok: false, reason: 'none' });
    expect(parseProviderReply('{"ok":false,"reason":"revoked"}')).toEqual({ ok: false, reason: 'revoked' });
  });
  test('refuses anything that is not exactly one of those shapes', () => {
    for (const text of ['not json', '{"ok":true,"key":"k1"}', '{"ok":true,"key":"k1","expiresAt":"2","account":"a"}', '{"ok":false,"reason":"whatever"}', '{"ok":true,"key":1,"expiresAt":2,"account":"a"}']) {
      expect(parseProviderReply(text)).toEqual({ ok: false, reason: 'bad reply' });
    }
  });
});
