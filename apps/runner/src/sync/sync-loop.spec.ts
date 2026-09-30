import { beforeEach, describe, expect, test } from 'bun:test';
import type { AssignPayload, CommandAck, FleetCommandOut, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { ServerError, NetworkError } from './http';
import { SyncLoop, PENDING_ACK_TTL_MS, type CapabilityReport, type StopReason, type SyncLoopDeps } from './sync-loop';

const empty: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
const assign = (jobId: string): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'https://x/a/b.git' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '1', bashMode: 'raw', gitIdentity: { name: 'n', email: 'e' },
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
    abandonUnknown: async (ids) => { abandoned.push([...ids]); },
    onStop: (r) => { stops.push(r); }, log: createMemoryLogger(),
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, nowMs: () => now, minGapMs: 250,
    tokenRequests: () => tokenAsks,
    onTokens: (requested, tokens, errors) => { delivered.push({ requested: [...requested], tokens: [...tokens], errors: [...errors] }); },
    ...over,
  });
}
const add = (jobId: string, epoch = 1) => journal.insertJob({ assign: assign(jobId), leaseEpoch: epoch, repoKey: 'a/b', jobDir: `/w/${jobId}` });
const log = (jobId: string, n: number, epoch = 1) => { for (let i = 0; i < n; i += 1) journal.appendEvent(jobId, epoch, 'log', { stream: 'run', text: `l${i}` }); };
const ok = (over: Partial<SyncResponse> = {}): Step => async () => ({ ...empty, ...over });
const assignCmd: FleetCommandOut = { commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assign('j1') };

beforeEach(() => {
  journal = Journal.open(':memory:');
  calls = []; script = []; sleeps = []; stops = []; capsNow = null; sentHashes = []; handled = []; commandAcks = []; abandoned = []; now = 0;
  tokenAsks = []; delivered = [];
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
    expect(calls[0]).toMatchObject({ protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 3, jobs: [] });
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
      script.push(server);
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
      script.push(server);
      await loop.syncOnce();
    }
    expect(calls.some((c) => c.jobs.some((job) => job.events.some((e) => e.type === 'lifecycle')))).toBe(true);
    expect(journal.jobsWithPending()).toEqual([]);
  });
  test('a 400 on a request carrying capabilities retries without them, logs, and does not resend that hash (D25)', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    script.push(async () => { throw new ServerError(400, 'capabilities', null); }, ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] }), ok());
    const loop = makeLoop();
    expect((await loop.syncOnce()).kind).toBe('again');
    expect(calls[0].capabilities).toBeDefined();
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[1].capabilities).toBeUndefined();
    expect(journal.pendingEvents('j1', 1, 5)).toEqual([]);      // the event was not blamed
    await loop.syncOnce();
    expect(calls[2].capabilities).toBeUndefined();
    expect(sentHashes).toEqual([]);
    capsNow = caps('h2');
    script.push(ok());
    await loop.syncOnce();
    expect(calls[3].capabilities?.nax.version).toBe('h2');
    expect(sentHashes).toEqual(['h2']);
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
