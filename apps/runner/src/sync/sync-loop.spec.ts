import { beforeEach, describe, expect, test } from 'bun:test';
import { FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import type { AssignPayload, CommandAck, FleetCommandOut, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { systemNow, systemSleep } from '../time';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { NO_LOG_SHIPPING } from '../../test/helpers/fake-log-shipping';
import { waitFor } from '../../test/helpers/wait';
import { CommandHandler } from '../supervisor/command-handler';
import { RepoMutex } from '../supervisor/repo-mutex';
import { Supervisor } from '../supervisor/supervisor';
import { ServerError, NetworkError } from './http';
import { SyncLoop, PENDING_ACK_TTL_MS, type CapabilityReport, type StopReason, type SyncLoopDeps } from './sync-loop';

const empty: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
const assign = (jobId: string): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'https://x/a/b.git' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '1', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: { name: 'n', email: 'e' },
});
const caps = (v: string): CapabilityReport => ({
  hash: v,
  capabilities: { nax: { version: v, protocols: ['native'] }, sandbox: { available: true, probedAt: 't' }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'] },
});

type Step = (req: SyncRequest, signal?: AbortSignal) => Promise<SyncResponse>;
let journal: Journal;
let calls: SyncRequest[];
let script: Step[];
let sleeps: number[];
let stops: StopReason[];
let capsNow: CapabilityReport | null;
let sentHashes: string[];
let handled: FleetCommandOut[][];
let commandAcks: CommandAck[];
let abandoned: string[][];
let now: number;
let tokenAsks: Array<{ jobId: string; leaseEpoch: number }>;
let delivered: Array<{ requested: unknown; tokens: unknown; errors: unknown }>;
let archived: string[][];

function makeLoop(over: Partial<SyncLoopDeps> = {}): SyncLoop {
  return new SyncLoop({
    client: { sync: async (req, signal) => {
      calls.push(structuredClone(req));
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      return step(req, signal);
    } },
    journal, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: () => 1,
    capabilityReport: () => capsNow, onCapabilitiesSent: (h) => { sentHashes.push(h); },
    handleCommands: async (cmds) => { handled.push([...cmds]); return commandAcks; },
    abandonUnknown: (ids) => { abandoned.push([...ids]); },
    onStop: (r) => { stops.push(r); }, log: createMemoryLogger(),
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, nowMs: () => now, minGapMs: 250,
    tokenRequests: () => tokenAsks,
    onTokens: (requested, tokens, errors) => { delivered.push({ requested: [...requested], tokens: [...tokens], errors: [...errors] }); },
    onArchivedThreads: (ids) => { archived.push([...ids]); },
    ...over,
  });
}
const add = (jobId: string, epoch = 1) => journal.insertJob({ assign: assign(jobId), leaseEpoch: epoch, repoKey: 'a/b', jobDir: `/w/${jobId}` });
const log = (jobId: string, n: number, epoch = 1) => { for (let i = 0; i < n; i += 1) journal.appendEvent(jobId, epoch, 'log', { stream: 'run', text: `l${i}` }); };
const ok = (over: Partial<SyncResponse> = {}): Step => async () => ({ ...empty, ...over });
const assignCmd: FleetCommandOut = { commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assign('j1') };
const assignCmd2: FleetCommandOut = { commandId: 'c2', type: 'ASSIGN', jobId: 'j2', leaseEpoch: 1, payload: assign('j2') };

beforeEach(() => {
  journal = Journal.open(':memory:');
  calls = []; script = []; sleeps = []; stops = []; capsNow = null; sentHashes = []; handled = []; commandAcks = []; abandoned = []; now = 0;
  tokenAsks = []; delivered = []; archived = [];
});

describe('acks and the cursor', () => {
  test('advances the cursor of the epoch that was reported', async () => {
    add('j1', 2);
    log('j1', 3, 2);
    script.push(ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 2 }] }));
    expect(await makeLoop().syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[0].jobs).toMatchObject([{ jobId: 'j1', leaseEpoch: 2 }]);
    expect(journal.pendingEvents('j1', 2, 10).map((e) => e.seq)).toEqual([3]);
  });
  test('an ack for a job that was not in the request is ignored', async () => {
    add('j1');
    log('j1', 1);
    script.push(ok({ jobAcks: [{ jobId: 'other', ackedSeq: 9 }] }));
    await makeLoop().syncOnce();
    expect(journal.pendingEvents('j1', 1, 10)).toHaveLength(1);
  });
  test('sends free slots and identity on every request', async () => {
    script.push(ok());
    await makeLoop({ freeSlots: () => 3 }).syncOnce();
    expect(calls[0]).toMatchObject({ protocolVersion: FLEET_PROTOCOL_VERSION, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 3, jobs: [] });
  });
});

describe('abort on write', () => {
  test('a journal write aborts an idle poll; the next sync carries the new event', async () => {
    add('j1');
    const idle: Step = (_req, signal) => new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(signal.reason)));
    script.push(idle, ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] }));
    const loop = makeLoop();
    const first = loop.syncOnce();
    log('j1', 1);
    loop.wake();
    expect(await first).toEqual({ kind: 'woken' });
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[1].jobs[0].events).toHaveLength(1);
  });
  test('a wake during a request that carries data does not abort it; the next sync starts with no min-gap sleep (D57)', async () => {
    add('j1');
    log('j1', 1);
    let aborted = false;
    let release: (response: SyncResponse) => void = () => undefined;
    const busy: Step = (_req, signal) => new Promise((res) => {
      release = res;
      signal?.addEventListener('abort', () => { aborted = true; });
    });
    script.push(busy, async () => { throw new ServerError(426, 'stop', null); });
    const loop = makeLoop();
    const done = loop.run();            // the first request is already in flight and carries event 1
    log('j1', 1);                       // the journal write calls wake() through the onWrite listener
    loop.wake();
    expect(aborted).toBe(false);
    expect(calls).toHaveLength(1);
    release({ ...empty, jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] });
    await done;
    expect(calls).toHaveLength(2);
    expect(calls[1].jobs[0].events.map((e) => e.seq)).toEqual([2]); // the write made during the request goes out at once
    expect(sleeps).toEqual([]);                                     // without the minGap sleep
    expect(stops[0].kind).toBe('protocol');
  });
  test('a request that carries only command acks is not idle either: a wake does not abort it (D57)', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    let aborted = false;
    let release: (response: SyncResponse) => void = () => undefined;
    const busy: Step = (_req, signal) => new Promise((res) => {
      release = res;
      signal?.addEventListener('abort', () => { aborted = true; });
    });
    script.push(ok({ commands: [assignCmd] }), busy);
    const loop = makeLoop();
    await loop.syncOnce();                  // handles the command, queues its ack
    commandAcks = [];
    const second = loop.syncOnce();         // carries the ack and nothing else
    expect(calls[1].commandAcks).toHaveLength(1);
    loop.wake();
    expect(aborted).toBe(false);
    release(empty);
    expect(await second).toEqual({ kind: 'ok' });
  });
  test('the journal listener is wired: appending an event wakes the loop', async () => {
    add('j1');
    const seen: Array<() => void> = [];
    const fake = { ...journal, onWrite: (l: () => void) => { seen.push(l); return () => undefined; } } as unknown as SyncLoopDeps['journal'];
    makeLoop({ journal: fake });
    expect(seen).toHaveLength(1);
  });
});

describe('failures', () => {
  test('5xx and network errors back off with full jitter and a success resets the attempt', async () => {
    script.push(async () => { throw new ServerError(503, 'down', null); }, async () => { throw new NetworkError('reset'); }, ok(), async () => { throw new ServerError(500, 'x', null); });
    const loop = makeLoop();
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 1000 });
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
  });
  test('a client timeout is retried like a network error', async () => {
    script.push(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    expect((await makeLoop().syncOnce()).kind).toBe('retry');
  });
  test('426 stops the loop and names the message; 401 stops it as an auth failure; neither retries', async () => {
    script.push(async () => { throw new ServerError(426, 'Unsupported protocol version 2; supported: 1', null); });
    const loop = makeLoop();
    await loop.run();
    expect(stops).toEqual([{ kind: 'protocol', message: 'Unsupported protocol version 2; supported: 1' }]);
    expect(calls).toHaveLength(1);

    script.push(async () => { throw new ServerError(401, 'runner key rejected', null); });
    await makeLoop().run();
    expect(stops[1].kind).toBe('auth');
    expect(calls).toHaveLength(2);
  });
  test('run() leaves at least minGap between syncs and sleeps the backoff after a failure', async () => {
    script.push(ok(), async () => { throw new ServerError(500, 'x', null); }, async () => { throw new ServerError(426, 'old', null); });
    now = 100;
    await makeLoop().run();
    expect(sleeps).toEqual([250, 500]);
  });
});

describe('stop during sleep (US-003)', () => {
  test('AC-1, AC-2, AC-3: retry sleep receives a live abort signal and stop ends run', async () => {
    script.push(async () => { throw new ServerError(500, 'x', null); });
    let entered = (): void => undefined;
    const sleeping = new Promise<void>((resolve) => { entered = resolve; });
    let sleepSignal: AbortSignal | undefined;
    let abortedAtCall: boolean | undefined;
    const loop = makeLoop({ sleep: (_ms, signal) => {
      sleepSignal = signal;
      abortedAtCall = signal?.aborted;
      entered();
      return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    } });
    const running = loop.run();
    await sleeping;
    expect(sleepSignal).toBeInstanceOf(AbortSignal);
    expect(abortedAtCall).toBe(false);
    loop.stop();
    expect(sleepSignal?.aborted).toBe(true);
    await running;
    expect(calls).toHaveLength(1);
  });

  test('AC-4, AC-5, AC-8, AC-9: stopping the 250 ms min-gap resolves the running loop after one sync', async () => {
    script.push(ok());
    let entered = (): void => undefined;
    const sleeping = new Promise<void>((resolve) => { entered = resolve; });
    let sleepMs: number | undefined;
    let sleepSignal: AbortSignal | undefined;
    const loop = makeLoop({ sleep: (ms, signal) => {
      sleepMs = ms;
      sleepSignal = signal;
      entered();
      return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    } });
    const running = loop.run();
    await sleeping;
    expect(sleepMs).toBe(250);
    loop.stop();
    expect(sleepSignal?.aborted).toBe(true);
    await running;
    expect(calls).toHaveLength(1);
  });

  test('AC-6, AC-7: stopping during the real retry sleep resolves promptly without another sync', async () => {
    script.push(async () => { throw new ServerError(500, 'x', null); });
    let entered = (): void => undefined;
    const sleeping = new Promise<void>((resolve) => { entered = resolve; });
    const loop = makeLoop({ sleep: (ms, signal) => {
      entered();
      return systemSleep(60_000, signal);
    } });
    const running = loop.run();
    await sleeping;
    loop.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([running, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('run did not stop')), 1_000); })]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    expect(calls).toHaveLength(1);
  });
});

describe('bad batches', () => {
  test('halves until the poisoned event is alone, replaces it, and everything else arrives in order (D24)', async () => {
    add('j1');
    for (let i = 1; i <= 8; i += 1) journal.appendEvent('j1', 1, 'snapshot', i === 5 ? { poison: true } as never : { costSpentUsd: String(i) });
    const received: number[] = [];
    const server: Step = async (req) => {
      const events = req.jobs.flatMap((j) => j.events);
      if (events.some((e) => (e.payload as { poison?: boolean }).poison)) throw new ServerError(400, 'bad event', null);
      received.push(...events.map((e) => e.seq));
      return { ...empty, jobAcks: [{ jobId: 'j1', ackedSeq: Math.max(...events.map((e) => e.seq)) }] };
    };
    const loop = makeLoop();
    for (let i = 0; i < 60 && journal.jobsWithPending().length > 0; i += 1) {
      script.push(server, server);
      await loop.syncOnce();
    }
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(journal.jobsWithPending()).toEqual([]);
    const all = journal.pendingEvents('j1', 1, 20);
    expect(all).toEqual([]); // all acked; the replaced one was delivered as a lifecycle error
    expect(calls.some((c) => c.jobs.some((j) => j.events.some((e) => e.seq === 5 && e.type === 'lifecycle')))).toBe(true);
  });
  test('with nothing to blame, a bad batch halves down to {1,1} and then backs off instead of dropping anything', async () => {
    const loop = makeLoop();
    const reject: Step = async () => { throw new ServerError(413, 'too large', null); };
    // No pending events, so the request has no job. 64/500 reaches 1/1 after eight halvings (500 needs nine steps to 1).
    for (let i = 0; i < 8; i += 1) {
      script.push(reject);
      expect((await loop.syncOnce()).kind).toBe('again');
    }
    script.push(reject);
    expect((await loop.syncOnce()).kind).toBe('retry');
    expect(script).toEqual([]);
  });
  test('at {1,1} a 400 on a request with command acks retries once without them before an event is blamed (D58)', async () => {
    add('j1');
    log('j1', 1);
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok', detail: 'bad-detail' }];
    script.push(ok({ commands: [assignCmd] }));
    const loop = makeLoop();
    await loop.syncOnce();                  // queues the ack; event 1 stays unacked
    commandAcks = [];
    // the server rejects any request whose acks carry a detail
    const server: Step = async (req) => {
      if (req.commandAcks.some((a) => a.detail !== undefined)) throw new ServerError(400, 'ack detail', null);
      const events = req.jobs.flatMap((job) => job.events);
      return { ...empty, jobAcks: events.length > 0 ? [{ jobId: 'j1', ackedSeq: Math.max(...events.map((e) => e.seq)) }] : [] };
    };
    for (let i = 0; i < 30; i += 1) {
      script.push(server);
      await loop.syncOnce();
    }
    expect(journal.jobsWithPending()).toEqual([]);
    const sent = calls.flatMap((c) => c.jobs.flatMap((job) => job.events));
    expect(sent.every((e) => e.type === 'log')).toBe(true);                       // the event was never replaced
    expect(calls.slice(1).some((c) => c.jobs.length > 0 && c.commandAcks.length === 0)).toBe(true); // the acks-free retry (calls[0] is the seed sync)
    expect(calls.some((c) => c.commandAcks.length === 1 && c.commandAcks[0].detail === undefined)).toBe(true); // acks resent without detail
    expect(calls[calls.length - 1].commandAcks).toEqual([]);                      // and delivered
  });
  test('a 400 at {1,1} that persists without acks still blames the event (D24 stays the last resort)', async () => {
    add('j1');
    journal.appendEvent('j1', 1, 'snapshot', { poison: true } as never);
    const server: Step = async (req) => {
      if (req.jobs.flatMap((job) => job.events).some((e) => (e.payload as { poison?: boolean }).poison)) throw new ServerError(400, 'bad event', null);
      return { ...empty, jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] };
    };
    const loop = makeLoop();
    for (let i = 0; i < 20 && journal.jobsWithPending().length > 0; i += 1) {
      script.push(server, server);
      await loop.syncOnce();
    }
    expect(calls.some((c) => c.jobs.some((job) => job.events.some((e) => e.type === 'lifecycle')))).toBe(true);
    expect(journal.jobsWithPending()).toEqual([]);
  });
  test('a 400 on a request carrying capabilities retries them on their own first (D25, US-003)', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    // The batch is refused; the report alone is accepted, so the event is not blamed.
    script.push(async () => { throw new ServerError(400, 'bad batch', null); }, ok(), ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] }), ok());
    const loop = makeLoop();
    expect((await loop.syncOnce()).kind).toBe('again');
    expect(calls[0].capabilities).toBeDefined();
    expect(calls[1].capabilities).toBeDefined();
    expect(calls[1].jobs).toEqual([]);
    expect(sentHashes).toEqual(['h1']);
    // The next ordinary batch carries no capabilities and the event is delivered.
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[2].capabilities).toBeUndefined();
    expect(journal.pendingEvents('j1', 1, 5)).toEqual([]);      // the event was not blamed
    await loop.syncOnce();
    expect(calls[3].capabilities).toBeUndefined();
    expect(sentHashes).toEqual(['h1']);
  });
});

/**
 * US-003: a 400 on a batch that carried capabilities does not prove the capabilities are bad. They are tried on
 * their own first; the hash is suppressed only when that isolated request is refused and the same envelope without
 * capabilities succeeds.
 */
describe('capability isolation (US-003)', () => {
  /** The API refuses an event whose payload is over 16 KiB (apps/api/src/fleet/sync/sync-request.parser.ts). */
  const tooLarge = (payload: unknown): boolean => Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16_384;

  test('AC-1: a valid report survives an oversized event: it is isolated, accepted and marked sent once', async () => {
    add('j1');
    journal.appendEvent('j1', 1, 'snapshot', { phase: 'x'.repeat(17_000) } as never);
    capsNow = caps('h1');
    const server: Step = async (req) => {
      const events = req.jobs.flatMap((job) => job.events);
      if (events.some((e) => tooLarge(e.payload))) throw new ServerError(400, 'event payload too large', null);
      return { ...empty, jobAcks: events.length > 0 ? [{ jobId: 'j1', ackedSeq: Math.max(...events.map((e) => e.seq)) }] : [] };
    };
    const loop = makeLoop();
    script.push(server, server);
    expect(await loop.syncOnce()).toEqual({ kind: 'again' });
    // The report was tried on its own and accepted; the batch was refused for another reason.
    expect(calls[0].capabilities).toBeDefined();
    expect(calls[1].capabilities).toBeDefined();
    expect(calls[1].jobs).toEqual([]);
    expect(calls[1].commandAcks).toEqual([]);
    expect(sentHashes).toEqual(['h1']);
    // The bad event is recovered by the ordinary isolation and the corrected event is acknowledged.
    for (let i = 0; i < 60 && journal.jobsWithPending().length > 0; i += 1) {
      script.push(server, server);
      await loop.syncOnce();
    }
    expect(journal.jobsWithPending()).toEqual([]);
    expect(sentHashes).toEqual(['h1']);
    expect(calls.some((c) => c.jobs.some((job) => job.events.some((e) => e.type === 'lifecycle')))).toBe(true);
  });

  test('AC-2: an invalid report is suppressed only after a base-only control succeeds', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    const server: Step = async (req) => {
      if (req.capabilities?.nax.version === 'h1') throw new ServerError(400, 'capabilities invalid', null);
      const events = req.jobs.flatMap((job) => job.events);
      return { ...empty, jobAcks: events.length > 0 ? [{ jobId: 'j1', ackedSeq: Math.max(...events.map((e) => e.seq)) }] : [] };
    };
    const loop = makeLoop();
    script.push(server, server, server);
    expect(await loop.syncOnce()).toEqual({ kind: 'again' });
    // The report alone was refused; the base-only control confirmed it.
    expect(calls[1].capabilities).toBeDefined();
    expect(calls[1].jobs).toEqual([]);
    expect(calls[2].capabilities).toBeUndefined();
    expect(calls[2].jobs).toEqual([]);
    expect(sentHashes).toEqual([]);
    // The invalid hash stays suppressed and the unrelated event is delivered.
    script.push(server);
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[3].capabilities).toBeUndefined();
    expect(journal.pendingEvents('j1', 1, 5)).toEqual([]);
    // A changed hash is eligible again.
    capsNow = caps('h2');
    script.push(server);
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[4].capabilities?.nax.version).toBe('h2');
    expect(sentHashes).toEqual(['h2']);
  });

  test('AC-2: an already isolated request is its own evidence: exactly one base-only control is sent', async () => {
    capsNow = caps('h1');
    const server: Step = async (req) => {
      if (req.capabilities) throw new ServerError(400, 'capabilities invalid', null);
      return { ...empty };
    };
    const loop = makeLoop();
    script.push(server, server);
    expect(await loop.syncOnce()).toEqual({ kind: 'again' });
    expect(calls).toHaveLength(2);
    expect(calls[0].capabilities).toBeDefined();
    expect(calls[1].capabilities).toBeUndefined();
    expect(calls[1].jobs).toEqual([]);
    expect(sentHashes).toEqual([]);
  });

  test('AC-3: a network failure during the isolation keeps the hash eligible', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    script.push(async () => { throw new ServerError(400, 'mixed', null); }, async () => { throw new NetworkError('offline'); });
    const loop = makeLoop();
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
    expect(sentHashes).toEqual([]);
    // The hash was neither sent nor suppressed: a later request reports it again.
    script.push(ok());
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[2].capabilities?.nax.version).toBe('h1');
    expect(sentHashes).toEqual(['h1']);
  });

  test('AC-3: an ambiguous rejection keeps the hash eligible', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    script.push(
      async () => { throw new ServerError(400, 'mixed', null); },
      async () => { throw new ServerError(400, 'capabilities', null); },
      async () => { throw new ServerError(400, 'base', null); },
    );
    const loop = makeLoop();
    expect(await loop.syncOnce()).toEqual({ kind: 'again' });
    expect(sentHashes).toEqual([]);
    // The hash was not suppressed: a later request reports it again.
    script.push(ok());
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[3].capabilities?.nax.version).toBe('h1');
    expect(sentHashes).toEqual(['h1']);
  });

  test('AC-3: a 401 or a 426 during the isolation stops the loop', async () => {
    for (const [status, kind] of [[401, 'auth'], [426, 'protocol']] as const) {
      journal = Journal.open(':memory:'); calls = []; script = [];
      add('j1');
      log('j1', 1);
      capsNow = caps('h1');
      script.push(async () => { throw new ServerError(400, 'mixed', null); }, async () => { throw new ServerError(status, 'stop', null); });
      await makeLoop().run();
      expect(stops.at(-1)).toEqual({ kind, message: 'stop' });
      expect(calls).toHaveLength(2);
      // The refusal came from the isolated report, not from the batch.
      expect(calls[1].jobs).toEqual([]);
      expect(calls[1].capabilities).toBeDefined();
    }
  });

  test('AC-3: stop aborts an in-flight probe without a follow-up request or a committed answer', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    const loop = makeLoop();
    script.push(async () => { throw new ServerError(400, 'mixed', null); }, async (_req, signal) => {
      loop.stop();
      throw signal?.reason;
    });
    expect(await loop.syncOnce()).toEqual({ kind: 'woken' });
    expect(calls).toHaveLength(2);      // the refused batch and the probe; no control follows
    expect(calls[1].jobs).toEqual([]);
    expect(sentHashes).toEqual([]);     // the probe's answer was not committed
  });

  test('AC-5: a mixed 400 at the smallest scale: the control is handled once, the acks keep their detail, the scale is unchanged', async () => {
    add('j1');
    log('j1', 3);
    commandAcks = [{ commandId: 'c9', leaseEpoch: 1, result: 'ok', detail: 'the detail' }];
    const loop = makeLoop();
    Object.assign(loop, { scale: { jobs: 1, events: 1 } });
    // A command is handled first: its ack waits for a request that carries it.
    script.push(ok({ commands: [assignCmd] }));
    await loop.syncOnce();
    expect(calls[0].commandAcks).toEqual([]);
    Object.assign(loop, { scale: { jobs: 1, events: 1 } });   // the mixed batch runs at the smallest scale
    capsNow = caps('h1');
    // The mixed batch is refused; the report alone is refused too; the base-only control succeeds.
    script.push(
      async () => { throw new ServerError(400, 'mixed', null); },
      async () => { throw new ServerError(400, 'capabilities', null); },
      ok({ commands: [assignCmd2], archivedThreadIds: ['t1'] }),
    );
    expect(await loop.syncOnce()).toEqual({ kind: 'again' });
    expect(calls[1].commandAcks).toEqual([{ commandId: 'c9', leaseEpoch: 1, result: 'ok', detail: 'the detail' }]);
    expect(calls[2].commandAcks).toEqual([]);        // the probe carried no ack
    expect(calls[3].commandAcks).toEqual([]);        // the control carried no ack
    expect(calls[3].capabilities).toBeUndefined();
    // The command and the archive notice of the control are handled once.
    expect(handled).toEqual([[assignCmd], [assignCmd2]]);
    expect(archived).toEqual([['t1']]);
    // No capability is marked sent.
    expect(sentHashes).toEqual([]);
    // The next ordinary batch resumes at the prior scale and the unsent ack keeps its detail.
    script.push(ok());
    await loop.syncOnce();
    expect(calls[4].commandAcks).toEqual([{ commandId: 'c9', leaseEpoch: 1, result: 'ok', detail: 'the detail' }]);
    expect(calls[4].jobs[0].events).toHaveLength(1);
    expect(calls[4].capabilities).toBeUndefined();
  });
});

describe('bad-batch probes (US-002)', () => {
  const prepareSmallState = (): void => {
    add('j1');
    for (let seq = 1; seq <= 4; seq += 1) journal.appendEvent('j1', 1, 'log', { stream: 'run', text: String(seq) });
    journal.appendEvent('j1', 1, 'state', {});
    journal.ackThrough('j1', 1, 4);
  };

  test('AC-1..3: rejected event probe keeps the state event and retries', async () => {
    prepareSmallState();
    const tokenRequests = [{ jobId: 'j1', leaseEpoch: 1 }];
    const loop = makeLoop({ tokenRequests: () => tokenRequests });
    for (let i = 0; i < 8; i += 1) script.push(async () => { throw new ServerError(400, 'bad batch', null); });
    for (let i = 0; i < 8; i += 1) await loop.syncOnce();
    script.push(async () => { throw new ServerError(400, 'bad batch', null); }, async () => { throw new ServerError(400, 'still bad', null); });
    const replace = journal.replaceEvent.bind(journal);
    let replacements = 0;
    journal.replaceEvent = ((...args: Parameters<typeof journal.replaceEvent>) => { replacements += 1; return replace(...args); }) as typeof journal.replaceEvent;
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
    expect(calls.at(-1)?.jobs).toEqual([]);
    expect(calls.at(-1)?.tokenRequests).toEqual(calls.at(-2)?.tokenRequests);
    expect(calls.at(-1)?.bootId).toBe(calls.at(-2)?.bootId);
    expect(calls.at(-2)?.jobs[0].events[0]).toMatchObject({ seq: 5, type: 'state' });
    expect(replacements).toBe(0);
    expect(journal.pendingEvents('j1', 1, 10)).toMatchObject([{ seq: 5, type: 'state' }]);
  });

  test('AC-4..5: a successful probe applies then replaces and backs off with structured error log', async () => {
    prepareSmallState();
    const memoryLog = createMemoryLogger();
    const loop = makeLoop({ log: memoryLog });
    for (let i = 0; i < 8; i += 1) { script.push(async () => { throw new ServerError(400, 'bad', null); }); await loop.syncOnce(); }
    script.push(async () => { throw new ServerError(400, 'bad', null); }, ok());
    const replace = journal.replaceEvent.bind(journal);
    const replacementArgs: Parameters<typeof journal.replaceEvent>[] = [];
    journal.replaceEvent = ((...args: Parameters<typeof journal.replaceEvent>) => { replacementArgs.push(args); return replace(...args); }) as typeof journal.replaceEvent;
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
    expect(replacementArgs).toHaveLength(1);
    expect(replacementArgs[0].slice(0, 4)).toEqual(['j1', 1, 5, 'lifecycle']);
    expect(memoryLog.lines).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringContaining('event 5 (state) dropped'), fields: { jobId: 'j1', seq: 5, type: 'state' } }));
  });

  test('AC-6: probe response commands are handled', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {}); journal.ackThrough('j1', 1, 0);
    const loop = makeLoop();
    for (let i = 0; i < 8; i += 1) { script.push(async () => { throw new ServerError(400, 'bad', null); }); await loop.syncOnce(); }
    script.push(async () => { throw new ServerError(400, 'bad', null); }, ok({ commands: [assignCmd] }));
    await loop.syncOnce();
    expect(handled).toEqual([[assignCmd]]);
  });

  test('AC-7,14: probe auth and protocol failures stop without replacing', async () => {
    for (const [status, kind] of [[401, 'auth'], [426, 'protocol']] as const) {
      journal = Journal.open(':memory:'); calls = []; script = []; add('j1'); journal.appendEvent('j1', 1, 'state', {}); journal.ackThrough('j1', 1, 0);
      const loop = makeLoop();
      for (let i = 0; i < 8; i += 1) { script.push(async () => { throw new ServerError(400, 'bad', null); }); await loop.syncOnce(); }
      script.push(async () => { throw new ServerError(400, 'bad', null); }, async () => { throw new ServerError(status, 'stop', null); });
      expect(await loop.syncOnce()).toMatchObject({ kind: 'stop', reason: { kind } });
      expect(journal.pendingEvents('j1', 1, 5)).toMatchObject([{ type: 'state' }]);
    }
  });

  test('AC-8: a network probe error backs off without replacing', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {}); journal.ackThrough('j1', 1, 0);
    const loop = makeLoop();
    for (let i = 0; i < 8; i += 1) { script.push(async () => { throw new ServerError(400, 'bad', null); }); await loop.syncOnce(); }
    script.push(async () => { throw new ServerError(400, 'bad', null); }, async () => { throw new NetworkError('offline'); });
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
    expect(journal.pendingEvents('j1', 1, 5)).toMatchObject([{ type: 'state' }]);
  });

  test('AC-9..10: persistent 400 batches make two calls and back off increasingly', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {}); journal.ackThrough('j1', 1, 0);
    const loop = makeLoop();
    for (let i = 0; i < 8; i += 1) { script.push(async () => { throw new ServerError(400, 'bad', null); }); await loop.syncOnce(); }
    for (const delay of [500, 1000, 2000]) {
      const before = calls.length;
      script.push(async () => { throw new ServerError(400, 'bad', null); }, async () => { throw new ServerError(400, 'bad', null); });
      expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: delay });
      expect(calls.length - before).toBe(2);
    }
  });

  test('AC-11: stop aborts a pending probe and retains the event', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {}); journal.ackThrough('j1', 1, 0);
    const loop = makeLoop();
    Object.assign(loop, { scale: { jobs: 1, events: 1 } });
    script.push(async () => { throw new ServerError(400, 'bad', null); }, async (_req, signal) => {
      loop.stop();
      throw signal?.reason;
    });
    const pending = loop.syncOnce();
    expect(await pending).toEqual({ kind: 'woken' });
    expect(journal.pendingEvents('j1', 1, 5)).toMatchObject([{ type: 'state' }]);
  });

  test('F1: a rejecting probe command handler returns retry and keeps the event', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {});
    const loop = makeLoop({ handleCommands: async () => { throw new Error('handler failed'); } });
    Object.assign(loop, { scale: { jobs: 1, events: 1 } });
    script.push(async () => { throw new ServerError(400, 'bad', null); }, ok({ commands: [assignCmd] }));
    expect(await loop.syncOnce()).toMatchObject({ kind: 'retry' });
    expect(journal.pendingEvents('j1', 1, 5)).toMatchObject([{ type: 'state' }]);
  });

  test('F2: a probe that resolves after stop returns woken without replacing the event', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {});
    const loop = makeLoop();
    Object.assign(loop, { scale: { jobs: 1, events: 1 } });
    let startedProbe: () => void = () => undefined;
    let resolveProbe: (response: SyncResponse) => void = () => undefined;
    script.push(async () => { throw new ServerError(400, 'bad', null); }, (_req) => new Promise<SyncResponse>((resolve) => {
      resolveProbe = resolve;
      startedProbe();
    }));
    const probeStarted = new Promise<void>((resolve) => { startedProbe = resolve; });
    const pending = loop.syncOnce();
    await probeStarted;
    loop.stop();
    resolveProbe(empty);
    expect(await pending).toEqual({ kind: 'woken' });
    expect(journal.pendingEvents('j1', 1, 5)).toMatchObject([{ type: 'state' }]);
  });

  test('AC-12: a smallest-scale 413 also probes jobs: []', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {}); journal.ackThrough('j1', 1, 0);
    const loop = makeLoop();
    for (let i = 0; i < 8; i += 1) { script.push(async () => { throw new ServerError(400, 'bad', null); }); await loop.syncOnce(); }
    script.push(async () => { throw new ServerError(413, 'large', null); }, ok());
    await loop.syncOnce(); expect(calls.at(-1)?.jobs).toEqual([]);
  });

  test('AC-13: run sleeps with backoff before the third persistent bad-batch request', async () => {
    add('j1'); journal.appendEvent('j1', 1, 'state', {});
    let sleptBeforeThird = false;
    const loop = makeLoop({ sleep: async (ms) => { sleeps.push(ms); if (calls.length === 10 && ms > 0) sleptBeforeThird = true; } });
    script.push(...Array.from({ length: 8 }, () => async () => { throw new ServerError(400, 'bad', null); }));
    script.push(async () => { throw new ServerError(400, 'bad', null); }, async () => { throw new ServerError(400, 'probe', null); });
    script.push(async () => { throw new ServerError(426, 'stop', null); });
    await loop.run();
    expect(sleptBeforeThird).toBe(true);
    expect(calls).toHaveLength(11);
  });
});

describe('capabilities', () => {
  test('are sent when the report says so and confirmed only after a successful sync', async () => {
    capsNow = caps('h1');
    script.push(async () => { throw new ServerError(500, 'x', null); }, ok());
    const loop = makeLoop();
    await loop.syncOnce();
    expect(sentHashes).toEqual([]);
    await loop.syncOnce();
    expect(calls[1].capabilities?.nax.version).toBe('h1');
    expect(sentHashes).toEqual(['h1']);
  });
});

describe('commands', () => {
  test('are handled, and their acks ride the next sync and stop riding once it succeeds', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), ok(), ok());
    const loop = makeLoop();
    await loop.syncOnce();
    expect(handled).toEqual([[assignCmd]]);
    commandAcks = [];
    await loop.syncOnce();
    expect(calls[1].commandAcks).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    await loop.syncOnce();
    expect(calls[2].commandAcks).toEqual([]);
  });
  test('acks survive a failed sync and are resent', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), async () => { throw new ServerError(500, 'x', null); }, ok());
    const loop = makeLoop();
    await loop.syncOnce();
    commandAcks = [];
    await loop.syncOnce();
    await loop.syncOnce();
    expect(calls[1].commandAcks).toHaveLength(1);
    expect(calls[2].commandAcks).toHaveLength(1);
  });
  test('an ack detail longer than 200 characters is clamped as it is queued (D59)', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'rejected', detail: 'x'.repeat(600) }];
    script.push(ok({ commands: [assignCmd] }), ok());
    const loop = makeLoop();
    await loop.syncOnce();
    await loop.syncOnce();
    expect(calls[1].commandAcks[0].detail).toHaveLength(200);
  });
  test('unknownJobIds are handed to the abandon hook', async () => {
    script.push(ok({ unknownJobIds: ['ghost'] }));
    await makeLoop().syncOnce();
    expect(abandoned).toEqual([['ghost']]);
  });
  test('pending acks older than 1h are pruned (MEM-1)', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), ok(), ok());
    const loop = makeLoop();
    await loop.syncOnce();                       // queues c1 at nowMs=0
    commandAcks = [];
    now = PENDING_ACK_TTL_MS + 1;
    expect(loop.pruneStalePendingAcks(now)).toBe(1);
    await loop.syncOnce();                       // carries nothing
    expect(calls[1].commandAcks).toEqual([]);
  });
  test('MEM-1: a confirmed ack clears its timestamp, so prune never sees a ghost', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), ok());   // second sync carries c1 and the server confirms it
    const loop = makeLoop();
    await loop.syncOnce();                       // queues c1 at nowMs=0
    await loop.syncOnce();                       // sends c1; apply() drops both the ack and its timestamp
    commandAcks = [];
    now = PENDING_ACK_TTL_MS + 1;
    expect(loop.pruneStalePendingAcks(now)).toBe(0);
  });
  test('pruneStalePendingAcks is a no-op when no ack is stale', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), ok());
    const loop = makeLoop();
    await loop.syncOnce();
    commandAcks = [];
    now = PENDING_ACK_TTL_MS - 1;
    expect(loop.pruneStalePendingAcks(now)).toBe(0);
  });
  test('wake triggers the prune before deciding to abort', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), ok());
    const loop = makeLoop();
    await loop.syncOnce();
    commandAcks = [];
    now = PENDING_ACK_TTL_MS + 1;
    loop.wake();                                 // loop is not inflight, prune runs anyway
    await loop.syncOnce();
    expect(calls[1].commandAcks).toEqual([]);
  });
});

describe('git tokens (design §3.1, D81)', () => {
  test('the request carries the cache\'s token requests and the answer goes back with them', async () => {
    tokenAsks = [{ jobId: 'j1', leaseEpoch: 2 }];
    const token = { jobId: 'j1', token: 'ghs_x', expiresAt: '2026-10-01T01:00:00.000Z', username: 'x-access-token' as const };
    script.push(ok({ gitTokens: [token], gitTokenErrors: [{ jobId: 'j9', reason: 'job_not_active' }] }));
    await makeLoop().syncOnce();
    expect(calls[0].tokenRequests).toEqual([{ jobId: 'j1', leaseEpoch: 2 }]);
    expect(delivered).toEqual([{ requested: [{ jobId: 'j1', leaseEpoch: 2 }], tokens: [token], errors: [{ jobId: 'j9', reason: 'job_not_active' }] }]);
  });
  test('a failed sync delivers nothing, so the next one asks again', async () => {
    tokenAsks = [{ jobId: 'j1', leaseEpoch: 1 }];
    script.push(async () => { throw new NetworkError('down'); });
    await makeLoop().syncOnce();
    expect(delivered).toEqual([]);
  });
  test('a request that asks for tokens is not an idle poll: wake() does not abort it', async () => {
    tokenAsks = [{ jobId: 'j1', leaseEpoch: 1 }];
    let aborted = false;
    let release: () => void = () => undefined;
    script.push((_req, signal) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => { aborted = true; });
      release = () => resolve(empty);
    }));
    const loop = makeLoop();
    const pending = loop.syncOnce();
    await Promise.resolve();
    loop.wake();
    release();
    await pending;
    expect(aborted).toBe(false);
  });
});

/**
 * US-001: the real sync loop, command handler, supervisor, journal and FIFO repo mutex with a fake executor.
 * The script answers each request in turn; `tokenAsks` is what the fake executor asked a token for.
 */
function realLoop(over: { capabilities?: () => CapabilityReport | null; sleep?: (ms: number) => Promise<void> } = {}) {
  const journal = Journal.open(':memory:');
  const ex = new FakeExecutor();
  const log = createMemoryLogger();
  const mutex = new RepoMutex();
  const supervisor = new Supervisor({
    journal, executor: ex, mutex, log, now: systemNow, sleep: systemSleep,
    uploader: { upload: async () => ({ kind: 'ok' }) },
    tuning: { statusPollMs: 10, killGraceMs: 1_000, ackPollMs: 5, uploadAckWaitMs: 0, logDrainTimeoutMs: 1_000 },
    readoptHeartbeatMs: 120_000,
    logs: NO_LOG_SHIPPING,
  });
  // The ABANDON's ack is offered when its outcome is durable; the loop carries it on a later request.
  const deferred: { sink: (ack: CommandAck) => void } = { sink: () => undefined };
  const handler = new CommandHandler({
    journal, supervisor, workspaceRoot: '/w', log, now: systemNow,
    approvals: { answer: async () => ({ result: 'ok' }) },
    onDeferredAck: (ack) => { deferred.sink(ack); },
  });
  const requests: SyncRequest[] = [];
  const tokenAsks: Array<{ jobId: string; leaseEpoch: number }> = [];
  const loop = new SyncLoop({
    client: { sync: async (req) => {
      requests.push(structuredClone(req));
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      return step(req);
    } },
    journal, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: () => 4,
    capabilityReport: over.capabilities ?? (() => null), onCapabilitiesSent: (hash) => { sentHashes.push(hash); },
    handleCommands: (cmds) => handler.handle(cmds),
    abandonUnknown: (ids) => { for (const id of ids) supervisor.retireUnknown(id); },
    tokenRequests: () => tokenAsks,
    onTokens: () => undefined,
    onStop: () => undefined, log, sleep: over.sleep ?? (async () => undefined), random: () => 0.5, nowMs: () => Date.now(), minGapMs: 0,
  });
  deferred.sink = (ack) => { loop.queueAck(ack); };
  return { journal, ex, log, mutex, supervisor, handler, loop, requests, tokenAsks };
}

/** A work that must not wait for the repo lock a test holds; a regression that waits fails on the race. */
async function settlesWithin<T>(work: Promise<T>, ms = 500): Promise<{ done: true; value: T } | { done: false }> {
  const timeout = new Promise<{ done: false }>((resolve) => { setTimeout(() => resolve({ done: false }), ms); });
  return Promise.race([work.then((value) => ({ done: true as const, value })), timeout]);
}

describe('the poll stays free while a stale epoch retires (US-001)', () => {
  const assignJob = (commandId: string, jobId: string, leaseEpoch = 1): FleetCommandOut =>
    ({ commandId, type: 'ASSIGN', jobId, leaseEpoch, payload: assign(jobId) });
  const abandonJob = (commandId: string, jobId: string, leaseEpoch = 1): FleetCommandOut =>
    ({ commandId, type: 'ABANDON', jobId, leaseEpoch, payload: { reason: 'stale_lease' } });

  test('AC-1: the sync after the retirement asks for the token of the job that waits behind it', async () => {
    const f = realLoop();
    let releaseA = (): void => undefined;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let grantB = (): void => undefined;
    const tokenB = new Promise<void>((resolve) => { grantB = resolve; });
    const prepare = f.ex.prepare.bind(f.ex);
    f.ex.prepare = async (job, options) => {
      await prepare(job, options);                              // the fake records the call
      if (job.jobId === 'jA') { await gateA; return { ok: true, branch: 'feat/a' }; }
      f.tokenAsks.push({ jobId: job.jobId, leaseEpoch: job.leaseEpoch });
      await tokenB;
      return { ok: true, branch: 'feat/b' };
    };
    try {
      script.push(ok({ commands: [assignJob('cA', 'jA')] }));
      await f.loop.syncOnce();
      await waitFor(() => f.ex.calls.includes('prepare:jA'));                 // A holds the repo lock

      script.push(ok({ commands: [assignJob('cB', 'jB'), abandonJob('aA', 'jA')] }));
      // The retirement waits for A's cleanup; the poll must not wait with it.
      expect(await settlesWithin(f.loop.syncOnce())).toEqual({ done: true, value: { kind: 'ok' } });

      releaseA();                                                          // the halted A lets go of the repo lock
      await waitFor(() => f.tokenAsks.length > 0);                           // B now waits for its token
      script.push(ok());
      await f.loop.syncOnce();
      expect(f.requests.at(-1)?.tokenRequests).toEqual([{ jobId: 'jB', leaseEpoch: 1 }]);
      grantB();
      await waitFor(() => f.ex.calls.includes('spawn:jB'));                   // B resumes
    } finally {
      releaseA();
      grantB();
      f.supervisor.shutdown();
    }
  });

  test('AC-2: the abandonment is not acknowledged before its cleanup, and the next delivery carries the recorded ack', async () => {
    const f = realLoop();
    f.ex.dieAfterTicks(1);
    let releaseA = (): void => undefined;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let grantB = (): void => undefined;
    const tokenB = new Promise<void>((resolve) => { grantB = resolve; });
    const prepare = f.ex.prepare.bind(f.ex);
    f.ex.prepare = async (job, options) => {
      await prepare(job, options);                              // the fake records the call
      if (job.jobId === 'jA') { await gateA; return { ok: true, branch: 'feat/a' }; }
      await tokenB;                                            // B waits for its token, holding the repo lock
      return { ok: true, branch: 'feat/b' };
    };
    try {
      script.push(ok({ commands: [assignJob('cA', 'jA')] }));
      await f.loop.syncOnce();
      await waitFor(() => f.ex.calls.includes('prepare:jA'));

      script.push(ok({ commands: [assignJob('cB', 'jB'), abandonJob('aA', 'jA')] }));
      // The retirement waits for the repo lock; the poll must not wait with it.
      expect(await settlesWithin(f.loop.syncOnce())).toEqual({ done: true, value: { kind: 'ok' } });
      releaseA();
      await waitFor(() => f.ex.calls.includes('prepare:jB'));   // B took the repo lock; A's cleanup waits behind it
      // The cleanup has not run, so no request carries the abandonment's ack.
      expect(f.ex.calls).not.toContain('cleanup:jA');
      expect(f.requests.flatMap((r) => r.commandAcks).filter((a) => a.commandId === 'aA')).toEqual([]);

      grantB();
      await waitFor(() => f.ex.calls.includes('cleanup:jA'));   // B is done; A's cleanup ran
      await f.handler.idle();                                 // and its outcome is durable
      script.push(ok());
      await f.loop.syncOnce();
      expect(f.requests.at(-1)?.commandAcks).toContainEqual({ commandId: 'aA', leaseEpoch: 1, result: 'ok' });
    } finally {
      releaseA();
      grantB();
      f.supervisor.shutdown();
    }
  });

  test('AC-4: a job reported missing twice is swept once, and a lease that arrives later is preserved', async () => {
    const f = realLoop();
    let releaseX = (): void => undefined;
    const gateX = new Promise<void>((resolve) => { releaseX = resolve; });
    const prepare = f.ex.prepare.bind(f.ex);
    f.ex.prepare = async (job, options) => {
      await prepare(job, options);                              // the fake records the call
      if (job.leaseEpoch === 1) { await gateX; return { ok: true, branch: 'feat/x' }; }
      return { ok: true, branch: 'feat/x2' };
    };
    // An unrelated job with a pending event: the poll keeps delivering while the retirement waits.
    f.journal.insertJob({ assign: assignFor('RUN', { jobId: 'jY' }), leaseEpoch: 1, repoKey: 'a/other', jobDir: '/w/jY' });
    f.journal.appendEvent('jY', 1, 'log', { stream: 'run', text: 'hello' });
    try {
      script.push(ok({ commands: [assignJob('cX', 'jX')] }));
      await f.loop.syncOnce();
      await waitFor(() => f.ex.calls.includes('prepare:jX'));                 // jX holds the repo lock

      script.push(ok({ unknownJobIds: ['jX'] }));
      expect(await settlesWithin(f.loop.syncOnce())).toEqual({ done: true, value: { kind: 'ok' } });
      script.push(ok({ unknownJobIds: ['jX'] }));
      expect(await settlesWithin(f.loop.syncOnce())).toEqual({ done: true, value: { kind: 'ok' } });

      // A higher epoch arrives after both missing-job reports: it is not part of the sweep.
      script.push(ok({ commands: [assignJob('cX2', 'jX', 2)] }));
      expect(await settlesWithin(f.loop.syncOnce())).toEqual({ done: true, value: { kind: 'ok' } });

      script.push(ok());
      await f.loop.syncOnce();
      expect(f.requests.at(-1)?.jobs.map((j) => j.jobId)).toContain('jY');

      releaseX();
      await waitFor(() => f.journal.getJob('jX', 1) === null);
      // One cleanup pass for the captured epoch (the shared checkout is left to the live higher epoch, AC-8).
      expect(f.ex.calls.filter((c) => c === 'releaseCredentials:jX')).toHaveLength(1);
      expect(f.journal.getJob('jX', 2)).not.toBeNull();                      // the later lease is preserved
    } finally {
      releaseX();
      f.supervisor.shutdown();
    }
  });
});

describe('the isolated capability probe (US-003)', () => {
  const abandonJob = (commandId: string, jobId: string, leaseEpoch = 1): FleetCommandOut =>
    ({ commandId, type: 'ABANDON', jobId, leaseEpoch, payload: { reason: 'stale_lease' } });

  test('AC-4: an ABANDON in the probe answer is handled once and its ack waits for the cleanup', async () => {
    const f = realLoop({ capabilities: () => caps('h1'), sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, 5); }) });
    // A job the runner knows: its retirement runs a cleanup.
    f.journal.insertJob({ assign: assignFor('RUN', { jobId: 'jA' }), leaseEpoch: 1, repoKey: 'a/one', jobDir: '/w/jA' });
    // An unrelated job with a pending event: it stays pending until a request carries it successfully.
    f.journal.insertJob({ assign: assignFor('RUN', { jobId: 'jB' }), leaseEpoch: 1, repoKey: 'a/two', jobDir: '/w/jB' });
    f.journal.appendEvent('jB', 1, 'log', { stream: 'run', text: 'hello' });
    const keepGoing: Step = async () => { script.push(keepGoing); return { ...empty }; };
    // The mixed batch is refused; the isolated report carries the abandonment.
    script.push(async () => { throw new ServerError(400, 'mixed', null); }, ok({ commands: [abandonJob('aA', 'jA')] }), keepGoing);
    const running = f.loop.run();
    try {
      await waitFor(() => f.ex.calls.includes('cleanup:jA'));
      await waitFor(() => f.requests.some((r) => r.commandAcks.some((a) => a.commandId === 'aA')));
    } finally {
      f.loop.stop();
      await running;
      f.supervisor.shutdown();
    }
    // The command was handled once.
    expect(f.ex.calls.filter((c) => c === 'cleanup:jA')).toHaveLength(1);
    expect(f.journal.getCommand('aA')).toMatchObject({ result: 'ok' });
    // The probe carried no jobs and no acks, so nothing was confirmed by it.
    expect(f.requests[1].jobs).toEqual([]);
    expect(f.requests[1].commandAcks).toEqual([]);
    // The ack rides a later request, and it is not sent again once that request succeeded.
    const ackIndex = f.requests.findIndex((r) => r.commandAcks.some((a) => a.commandId === 'aA'));
    expect(ackIndex).toBeGreaterThan(1);
    expect(f.requests.at(-1)?.commandAcks.some((a) => a.commandId === 'aA')).toBe(false);
    // The unsent job event is retained.
    expect(f.journal.pendingEvents('jB', 1, 10)).toHaveLength(1);
  });
});
