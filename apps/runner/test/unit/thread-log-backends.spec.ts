import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeNaxCli } from '../helpers/fake-nax-cli';
import { fakeLogServer } from '../helpers/fake-log-server';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';
import { createMemoryLogger } from '../../src/logger';
import { NaxCapabilityProbe } from '../../src/capabilities/nax-probe';
import { LogShipper } from '../../src/logs/log-shipper';
import type { LogShipperTuning } from '../../src/logs/log-shipper';
import { ServerClient } from '../../src/sync/http';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const shippers: LogShipper[] = [];
afterEach(async () => { await Promise.all(shippers.splice(0).map((shipper) => shipper.close())); });

function shipper() {
  const server = fakeLogServer();
  const instance = new LogShipper({
    transport: server.transport,
    log: createMemoryLogger(),
    nowMs: Date.now,
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    random: () => 0,
    tuning: { chunkBytes: 64, maxInFlight: 2, putTimeoutMs: 30_000, backoffMaxMs: 30_000 } satisfies LogShipperTuning,
  });
  shippers.push(instance);
  return { server, shipper: instance };
}

function threadJob(threadPath: string) {
  return { jobId: 'j1', leaseEpoch: 1, threadPath, lifecycle: (_level: 'info' | 'warn' | 'error', _message: string) => undefined };
}

function registerThread(logs: LogShipper, threadPath: string): unknown {
  try {
    logs.register(threadJob(threadPath));
    return undefined;
  } catch (error) {
    return error;
  }
}

async function probe(home: string, nax: FakeNaxCli) {
  const empty = join(home, 'empty-probe');
  const prober = new NaxCapabilityProbe({
    nax,
    naxHome: home,
    now: () => new Date('2026-10-01T00:00:00.000Z'),
    toolWorks: async () => true,
    makeEmptyDir: async () => {
      await mkdir(empty, { recursive: true });
      return { dir: empty, remove: async () => undefined };
    },
  });
  return prober.probe();
}

async function modelHome(name: string, withConfig = true): Promise<string> {
  const home = await tmp.make(name);
  if (withConfig) await writeFile(join(home, 'config.json'), JSON.stringify({ models: { native: { balanced: 'minimax/MiniMax-M3' } } }));
  return home;
}

describe('US-002 thread log shipping', () => {
  test('AC-1: ships the thread JSONL file into the thread stream', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-register'), 'thread.jsonl');
    const contents = '{"a":1}\n';
    await writeFile(threadPath, contents);
    expect(registerThread(logs, threadPath)).toBeUndefined();
    await waitFor(() => server.stored('j1:1:thread') === contents);
    expect(server.stored('j1:1:thread')).toBe(contents);
  });

  test('AC-1: does not create an empty thread stream when the path is missing', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-missing'), 'missing.jsonl');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.calls).toHaveLength(0);
  });

  test('AC-2: registration sends no stdout, stderr, or run PUTs', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-only'), 'thread.jsonl');
    await writeFile(threadPath, '{"a":1}\n');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    await waitFor(() => server.calls.length > 0);
    expect(server.calls.map((call) => call.stream)).toEqual(['thread']);
  });

  test('AC-2: registering an empty thread creates no ordinary log streams', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-empty'), 'thread.jsonl');
    await writeFile(threadPath, '');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.calls.some((call) => ['stdout', 'stderr', 'run'].includes(call.stream))).toBe(false);
  });

  test('AC-3: drain includes bytes appended after registration and resolves drained', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-append'), 'thread.jsonl');
    await writeFile(threadPath, '{"a":1}\n');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    await waitFor(() => server.stored('j1:1:thread') === '{"a":1}\n');
    await appendFile(threadPath, '{"b":2}\n');
    expect(await logs.drain('j1', 1, 5_000)).toBe('drained');
    expect(server.stored('j1:1:thread')).toBe('{"a":1}\n{"b":2}\n');
  });

  test('AC-3: draining an empty thread stream completes without inventing contents', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-empty-drain'), 'thread.jsonl');
    await writeFile(threadPath, '');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    expect(await logs.drain('j1', 1, 5_000)).toBe('drained');
    expect(server.stored('j1:1:thread')).toBe('');
  });

  test('AC-4: the final PUT for a drained thread stream has final true', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-final'), 'thread.jsonl');
    await writeFile(threadPath, '{"a":1}\n');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    expect(await logs.drain('j1', 1, 5_000)).toBe('drained');
    expect(server.calls.filter((call) => call.stream === 'thread').at(-1)?.final).toBe(true);
  });

  test('AC-4: an empty registered thread still receives a final PUT at drain', async () => {
    const { server, shipper: logs } = shipper();
    const threadPath = join(await tmp.make('thread-final-empty'), 'thread.jsonl');
    await writeFile(threadPath, '');
    expect(registerThread(logs, threadPath)).toBeUndefined();
    expect(await logs.drain('j1', 1, 5_000)).toBe('drained');
    expect(server.calls.at(-1)).toMatchObject({ stream: 'thread', final: true });
  });

  test('AC-10: nax stdout continues to ship and drain as stdout', async () => {
    const { server, shipper: logs } = shipper();
    const dir = await tmp.make('nax-stdout');
    const stdoutPath = join(dir, 'stdout');
    await writeFile(stdoutPath, 'hello');
    logs.register({
      jobId: 'j1', leaseEpoch: 1,
      sources: { outDir: join(dir, 'out'), feature: 'f', stdoutPath, stderrPath: join(dir, 'stderr'), runLog: false },
      lifecycle: () => undefined,
    });
    expect(await logs.drain('j1', 1, 5_000)).toBe('drained');
    expect(server.stored('j1:1:stdout')).toBe('hello');
  });
});

describe('US-002 thread backends and stream transport', () => {
  test('AC-5: putLog addresses the thread stream route', async () => {
    let requestedPath: string | undefined;
    const client = new ServerClient({
      serverUrl: 'https://koda.example.test',
      apiKey: 'test-key',
      fetchFn: async (url) => {
        requestedPath = new URL(url).pathname;
        return new Response(JSON.stringify({ ret: 0, data: { outcome: 'appended', size: 1 } }), { status: 200 });
      },
    });
    await client.putLog({ jobId: 'j1', stream: 'thread', leaseEpoch: 1, offset: 0, bytes: Buffer.from('x'), final: false });
    expect(requestedPath?.endsWith('/fleet/runner/jobs/j1/logs/thread')).toBe(true);
  });

  test('AC-5: thread URL is scoped to its job and not an ordinary stream', async () => {
    let requestedPath: string | undefined;
    const client = new ServerClient({
      serverUrl: 'https://koda.example.test', apiKey: 'test-key',
      fetchFn: async (url) => {
        requestedPath = new URL(url).pathname;
        return new Response(JSON.stringify({ ret: 0, data: { outcome: 'complete', size: 0 } }), { status: 200 });
      },
    });
    await client.putLog({ jobId: 'other', stream: 'thread', leaseEpoch: 1, offset: 0, bytes: new Uint8Array(), final: true });
    expect(requestedPath?.endsWith('/fleet/runner/jobs/other/logs/thread')).toBe(true);
  });

  test('AC-6: advertises configured native models only when their provider credential is available', async () => {
    const home = await modelHome('native-available');
    const nax = new FakeNaxCli({ auth: [{ providerId: 'minimax', stored: { kind: 'api-key', expired: false }, ambient: false, available: true }] });
    const { capabilities } = await probe(home, nax);
    expect(capabilities.threadBackends).toEqual({ native: ['minimax/MiniMax-M3'], acp: [] });
  });

  test('AC-7: excludes configured native models when provider credentials are unavailable', async () => {
    const home = await modelHome('native-unavailable');
    const nax = new FakeNaxCli({ auth: [] });
    const { capabilities } = await probe(home, nax);
    expect(capabilities.threadBackends).toEqual({ native: [], acp: [] });
  });

  test('AC-8: requests auth for a configured native provider when there are no profiles', async () => {
    const home = await modelHome('native-auth-args');
    const nax = new FakeNaxCli({ auth: [{ providerId: 'minimax', stored: { kind: 'api-key', expired: false }, ambient: false, available: true }] });
    await probe(home, nax);
    expect(nax.calls.find((call) => call.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json', 'minimax']);
  });

  test('AC-8: requests no provider IDs when neither profiles nor native models exist', async () => {
    const home = await tmp.make('no-model-auth-args');
    const nax = new FakeNaxCli();
    await probe(home, nax);
    expect(nax.calls.find((call) => call.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json']);
  });

  test('AC-9: reports empty thread backends when config.json is absent', async () => {
    const home = await modelHome('native-config-absent', false);
    const { capabilities } = await probe(home, new FakeNaxCli());
    expect(capabilities.threadBackends).toEqual({ native: [], acp: [] });
  });

  test('AC-9: an absent config does not trigger a native provider auth request', async () => {
    const home = await modelHome('native-config-absent-auth', false);
    const nax = new FakeNaxCli();
    await probe(home, nax);
    expect(nax.calls.find((call) => call.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json']);
  });
});
