import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { NetworkError, ServerClient, ServerError, type FetchFn } from './http';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ ret: 0, data }), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchFn: FetchFn, over: Record<string, unknown> = {}) => new ServerClient({ serverUrl: 'https://koda.example.com/koda', apiKey: 'kr_secret', fetchFn, ...over });

describe('ServerClient', () => {
  test('calls /api/fleet/runner/sync under the server path with the bearer key and unwraps data', async () => {
    let seen = null as { url: string; init: RequestInit | undefined } | null;
    const reply = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
    const c = client(async (url, init) => { seen = { url, init }; return ok(reply); });
    const res = await c.sync({ protocolVersion: 1, bootId: 'b', daemonVersion: 'd', freeSlots: 0, jobs: [], commandAcks: [], tokenRequests: [] });
    expect(res).toEqual(reply);
    expect(seen?.url).toBe('https://koda.example.com/koda/api/fleet/runner/sync');
    expect(seen?.init?.method).toBe('POST');
    expect((seen?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer kr_secret');
    expect((seen?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
  test('me reads the identity; enroll sends no Authorization header', async () => {
    const headers: Array<Record<string, string>> = [];
    const c = client(async (url, init) => {
      headers.push(init?.headers as Record<string, string>);
      return url.endsWith('/me') ? ok({ id: 'r', name: 'n', labels: [], capacity: 2, enabled: true }) : ok({ runnerId: 'r', apiKey: 'kr_new' }, 201);
    }, { apiKey: undefined });
    await expect(c.enroll({} as never)).resolves.toEqual({ runnerId: 'r', apiKey: 'kr_new' });
    expect(headers[0]['authorization']).toBeUndefined();
    await expect(new ServerClient({ serverUrl: 'https://x', fetchFn: async () => ok({ id: 'r', name: 'n', labels: [], capacity: 2, enabled: true }), apiKey: 'k' }).me()).resolves.toMatchObject({ capacity: 2 });
  });
  test('a non-2xx answer is a ServerError carrying status, server message and body', async () => {
    const c = client(async () => new Response(JSON.stringify({ ret: 1, message: 'Unsupported protocol version' }), { status: 426 }));
    const error = await c.me().catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 426, message: 'Unsupported protocol version', body: { ret: 1 } });
  });
  test('a 2xx body that is not an envelope is a ServerError', async () => {
    await expect(client(async () => new Response('<html>', { status: 200 })).me()).rejects.toBeInstanceOf(ServerError);
    await expect(client(async () => new Response(JSON.stringify({ ret: 5, message: 'x' }), { status: 200 })).me()).rejects.toBeInstanceOf(ServerError);
  });
  test('a fetch failure is a NetworkError; an abort passes through untouched', async () => {
    await expect(client(async () => { throw new TypeError('fetch failed'); }).me()).rejects.toBeInstanceOf(NetworkError);
    const controller = new AbortController();
    const hang: FetchFn = (_url, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init?.signal?.reason ?? new DOMException('aborted', 'AbortError')));
    });
    const pending = client(hang).me(controller.signal).catch((e) => e);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(NetworkError);
  });
  test('the sync timeout fires as a TimeoutError, not a NetworkError', async () => {
    const hang: FetchFn = (_url, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init?.signal?.reason));
    });
    const error = await client(hang, { syncTimeoutMs: 30 }).sync({} as never).catch((e) => e);
    expect(error.name).toBe('TimeoutError');
  });
  test('a missing api key is refused before any request', async () => {
    let called = false;
    const c = new ServerClient({ serverUrl: 'https://x', fetchFn: async () => { called = true; return ok({}); } });
    await expect(c.me()).rejects.toThrow(/api key/i);
    // sync() must reject, never throw synchronously: the sync loop awaits it inside try/catch.
    let thrown: unknown = null;
    let pending: Promise<unknown> = Promise.resolve();
    try {
      pending = c.sync({} as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    await expect(pending).rejects.toThrow(/api key/i);
    expect(called).toBe(false);
  });
});

describe('uploadBundle', () => {
  test('PUTs the file with Content-Length, gzip type, sha header and the epoch, and returns the status', async () => {
    const file = join(await tmp.make('up'), 'bundle.tar.gz');
    await writeFile(file, Buffer.alloc(4096, 1));
    let seen = null as { method: string; url: string; headers: Headers; bytes: number } | null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { method: req.method, url: req.url, headers: req.headers, bytes: (await req.arrayBuffer()).byteLength };
        return new Response('', { status: 201 });
      },
    });
    try {
      const c = new ServerClient({ serverUrl: `http://127.0.0.1:${server.port}`, apiKey: 'kr_x' });
      expect(await c.uploadBundle({ jobId: 'j1', leaseEpoch: 3, filePath: file, sha256: 'a'.repeat(64) })).toEqual({ status: 201 });
      expect(seen?.method).toBe('PUT');
      expect(new URL(seen?.url ?? '').pathname).toBe('/api/fleet/runner/jobs/j1/bundle');
      expect(new URL(seen?.url ?? '').searchParams.get('leaseEpoch')).toBe('3');
      expect(seen?.headers.get('content-length')).toBe('4096');
      expect(seen?.headers.get('content-type')).toBe('application/gzip');
      expect(seen?.headers.get('x-content-sha256')).toBe('a'.repeat(64));
      expect(seen?.headers.get('authorization')).toBe('Bearer kr_x');
      expect(seen?.bytes).toBe(4096);
    } finally {
      server.stop(true);
    }
  });
  test('returns a non-2xx status instead of throwing, and a network failure throws NetworkError', async () => {
    const file = join(await tmp.make('up'), 'b.tgz');
    await writeFile(file, 'x');
    const c = client(async () => new Response('', { status: 413 }));
    expect(await c.uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).toEqual({ status: 413 });
    await expect(client(async () => { throw new TypeError('down'); }).uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).rejects.toBeInstanceOf(NetworkError);
  });
  test('returns the error message of a non-2xx JSON body, and asks for English (D60)', async () => {
    const file = join(await tmp.make('up'), 'b.tgz');
    await writeFile(file, 'x');
    let language = null as string | null;
    const c = client(async (_url, init) => {
      language = new Headers(init?.headers).get('accept-language');
      return new Response(JSON.stringify({ ret: 409, message: 'The job is ASSIGNED; this action is not allowed' }), { status: 409 });
    });
    expect(await c.uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).toEqual({ status: 409, message: 'The job is ASSIGNED; this action is not allowed' });
    expect(language).toBe('en');
    expect(await client(async () => new Response('not json', { status: 502 })).uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).toEqual({ status: 502 });
  });
});

describe('putLog (S2a §2.4, plan D322)', () => {
  test('PUTs the bytes with octet-stream type, their sha256, the bearer key, en, and the epoch/offset/final query', async () => {
    let seen = null as { method: string; url: URL; headers: Headers; body: Buffer } | null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { method: req.method, url: new URL(req.url), headers: req.headers, body: Buffer.from(await req.arrayBuffer()) };
        return new Response(JSON.stringify({ ret: 0, data: { outcome: 'appended', size: 11 } }), { status: 200 });
      },
    });
    try {
      const c = new ServerClient({ serverUrl: `http://127.0.0.1:${server.port}`, apiKey: 'kr_x' });
      const answer = await c.putLog({ jobId: 'j 1', stream: 'stdout', leaseEpoch: 2, offset: 5, bytes: Buffer.from('hello\n'), final: true });
      expect(answer).toEqual({ status: 200, outcome: 'appended', size: 11 });
      expect(seen?.method).toBe('PUT');
      expect(seen?.url.pathname).toBe('/api/fleet/runner/jobs/j%201/logs/stdout');
      expect(Object.fromEntries(seen?.url.searchParams ?? [])).toEqual({ leaseEpoch: '2', offset: '5', final: '1' });
      expect(seen?.headers.get('content-type')).toBe('application/octet-stream');
      expect(seen?.headers.get('authorization')).toBe('Bearer kr_x');
      expect(seen?.headers.get('accept-language')).toBe('en');
      expect(seen?.headers.get('x-content-sha256')).toBe(new Bun.CryptoHasher('sha256').update('hello\n').digest('hex'));
      expect(seen?.body.toString()).toBe('hello\n');
    } finally {
      server.stop(true);
    }
  });
  test('a non-final PUT has no final param; an empty final body is sent as zero bytes', async () => {
    const urls: string[] = [];
    const lengths: number[] = [];
    const c = client(async (url, init) => {
      urls.push(url);
      lengths.push((init?.body as Uint8Array).byteLength);
      return ok({ outcome: 'complete', size: 0 });
    });
    await c.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 0, bytes: Buffer.from('x'), final: false });
    await c.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 1, bytes: new Uint8Array(0), final: true });
    expect(new URL(urls[0]).searchParams.has('final')).toBe(false);
    expect(new URL(urls[1]).searchParams.get('final')).toBe('1');
    expect(lengths).toEqual([1, 0]);
  });
  test('carries retryAfterMs; a non-2xx is just its status; a malformed 2xx body has no outcome', async () => {
    const answers = [
      ok({ outcome: 'rate_limited', size: -1, retryAfterMs: 250 }),
      new Response(JSON.stringify({ ret: 1, message: 'Job not found' }), { status: 409 }),
      new Response('not json', { status: 200 }),
      ok({ outcome: 'weird', size: 3 }),
      ok({ outcome: 'appended' }),
    ];
    const c = client(async () => answers.shift() as Response);
    const put = () => c.putLog({ jobId: 'j1', stream: 'stderr', leaseEpoch: 1, offset: 0, bytes: Buffer.from('a'), final: false });
    expect(await put()).toEqual({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 250 });
    expect(await put()).toEqual({ status: 409 });
    expect(await put()).toEqual({ status: 200 });
    expect(await put()).toEqual({ status: 200 });
    expect(await put()).toEqual({ status: 200 });
  });
  test('a network failure throws NetworkError; an abort rejects with the abort reason', async () => {
    const down = client(async () => { throw new TypeError('connect ECONNREFUSED'); });
    await expect(down.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 0, bytes: Buffer.from('a'), final: false })).rejects.toBeInstanceOf(NetworkError);
    const hanging = client((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = hanging.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 0, bytes: Buffer.from('a'), final: false, signal: controller.signal });
    controller.abort(new Error('shipper timeout'));
    await expect(pending).rejects.toThrow('shipper timeout');
  });
});
