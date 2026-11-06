// apps/runner/test/unit/provider-key-sync.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderKeyGrant, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { isNaxSandboxed } from '../helpers/test-environment';
import { CredentialBroker } from '../../src/credentials/broker';
import { ProviderKeyCache } from '../../src/credentials/provider-key-cache';
import { TokenCache } from '../../src/credentials/token-cache';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import { SyncLoop, type SyncLoopDeps } from '../../src/sync/sync-loop';
import { assignFor } from '../helpers/assign';
import { within } from '../helpers/deadline';
import { waitFor } from '../helpers/wait';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const uid = process.getuid?.() ?? 0;
const empty: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
const grant = (providerId = 'openrouter', key = 'sk-or-1'): ProviderKeyGrant => ({
  jobId: 'j1', providerId, key, account: 'koda:global:fleet', fingerprint: '0123456789ab',
  expiresAt: new Date(T0 + 600_000).toISOString(),
});
const liveExpiry = (): string => new Date(Date.now() + 600_000).toISOString();
/**
 * A grant on the **real** clock: the tests that hold a socket or a broker with `nowMs: () => Date.now()` need an
 * expiry the cache will still serve. `grant()` above is pinned to `T0` for the tests that drive a fake clock, and its
 * expiry is in the past for a real-clock consumer — which is a request that waits forever, not a served key.
 */
const liveGrant = (providerId = 'openrouter', key = 'sk-or-1'): ProviderKeyGrant =>
  ({ ...grant(providerId, key), expiresAt: liveExpiry() });

/**
 * Every assertion below is written `expect(value, message)` with the message built here first: a failure then names
 * the sync body, the reply or the socket answer it saw, not just a diff. `captured()` is the same for a value that
 * has to be awaited or decoded (JSON, an empty answer) before it can be asserted.
 */
const captured = (label: string, value: unknown): string => {
  const seen = value === null || value === undefined ? String(value) : JSON.stringify(value);
  return `${label}: ${seen ?? String(value)}`;
};

/** The JSON the socket answered, `null` when it answered nothing or something that is not JSON, plus the raw text. */
function decode(rawAnswer: string): { reply: unknown; raw: string } {
  try {
    return { reply: JSON.parse(rawAnswer), raw: rawAnswer };
  } catch {
    return { reply: null, raw: rawAnswer };
  }
}

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A real SyncLoop over a real cache, with a scripted client: no network, no database. */
function harness(cache: ProviderKeyCache) {
  const calls: SyncRequest[] = [];
  let resolveSync: ((response: SyncResponse) => void) | null = null;
  const journal = Journal.open(':memory:');
  const deps: SyncLoopDeps = {
    client: {
      sync: async (request: SyncRequest, signal?: AbortSignal) => {
        calls.push(structuredClone(request));
        return new Promise<SyncResponse>((resolve, reject) => {
          resolveSync = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      },
    },
    journal, bootId: 'boot', daemonVersion: 'test', freeSlots: () => 1,
    capabilityReport: () => null, onCapabilitiesSent: () => undefined,
    handleCommands: async () => [], abandonUnknown: async () => undefined,
    tokenRequests: () => [], onTokens: () => undefined, onStop: () => undefined,
    log: createMemoryLogger(), sleep: async () => undefined, random: () => 0.5, nowMs: () => T0, minGapMs: 0,
    providerRequests: () => cache.requests(),
    onProviderKeys: (requested, grants, errors) => cache.apply(requested, grants, errors),
  };
  /** Answer the in-flight sync. Throws rather than hanging when the loop never reached `client.sync`. */
  const release = (response: SyncResponse): void => {
    if (!resolveSync) throw new Error('release() before the loop called client.sync: no request was in flight');
    resolveSync(response);
  };
  const body = (index = 0): string => captured('the sync body the loop sent', calls[index] ?? null);
  return { loop: new SyncLoop(deps), journal, calls, release, body };
}

describe('US-008 SyncLoop provider keys', () => {
  test('AC-14: the loop sends the queued provider requests and applies the grants it gets back', async () => {
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    cache.want('j1', 4, 'openrouter');
    const h = harness(cache);
    try {
      const pending = h.loop.syncOnce();
      const body = h.body();
      expect(h.calls[0]?.providerRequests, `the sync body must carry the queued provider request; ${body}`)
        .toEqual([{ jobId: 'j1', leaseEpoch: 4, providerId: 'openrouter' }]);
      h.release({ ...empty, providerKeys: [grant()] });
      const outcome = await within(pending, 'the sync that carried a provider request');
      expect(outcome, `a provider request must be delivered, not retried or aborted; ${body}`).toEqual({ kind: 'ok' });
      const state = cache.state('j1', 4, 'openrouter', T0);
      expect(state, `the grant must land on the epoch its request carried; ${captured('state', state)}`)
        .toMatchObject({ kind: 'grant', grant: { key: 'sk-or-1' } });
      const queued = cache.requests();
      expect(queued, `an answered request must not be asked for again; ${captured('queued', queued)}`).toEqual([]);
    } finally {
      h.loop.stop();
      h.journal.close();
    }
  });

  test('AC-14: the loop is not idle while provider requests are queued, so a write does not abort the poll', async () => {
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    cache.want('j1', 1, 'openrouter');
    const h = harness(cache);
    try {
      const pending = h.loop.syncOnce();
      h.loop.wake();
      h.release(empty);
      const outcome = await within(pending, 'the poll that carried a provider request');
      expect(outcome, `a write must not abort a poll that carries a provider request; ${h.body()}`).toEqual({ kind: 'ok' });
    } finally {
      h.loop.stop();
      h.journal.close();
    }
  });

  test('with nothing queued the poll is still idle, and a write does abort it', async () => {
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    const h = harness(cache);
    try {
      const pending = h.loop.syncOnce();
      const carried = h.calls[0]?.providerRequests;
      expect(carried, `nothing is queued, so the body carries no provider requests; ${h.body()}`).toEqual([]);
      h.loop.wake();
      const outcome = await within(pending, 'the idle poll');
      expect(outcome, `an idle poll is aborted by a write; ${h.body()}`).toEqual({ kind: 'woken' });
    } finally {
      h.loop.stop();
      h.journal.close();
    }
  });

  test('a providerKeyErrors answer becomes a denial the waiting job can read', async () => {
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    cache.want('j1', 1, 'openrouter');
    const h = harness(cache);
    try {
      const pending = h.loop.syncOnce();
      h.release({ ...empty, providerKeyErrors: [{ jobId: 'j1', providerId: 'openrouter', reason: 'vault_off' }] });
      const outcome = await within(pending, 'the sync that answered providerKeyErrors');
      expect(outcome, `an answer carrying providerKeyErrors is still a successful sync; ${h.body()}`).toEqual({ kind: 'ok' });
      const state = cache.state('j1', 1, 'openrouter', T0);
      expect(state, `vault_off before any grant is a decline, never a revocation; ${captured('state', state)}`)
        .toEqual({ kind: 'denied', reason: 'none' });
    } finally {
      h.loop.stop();
      h.journal.close();
    }
  });
  test('a providerKeyErrors answer reaches the waiting job as its decline message', async () => {
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    // The reply waits on this clock; sleep advances it, so a reply that never hears back costs no real time.
    const clock = { now: T0 };
    const broker = new CredentialBroker({
      tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
      providerKeys: cache, socketDir: join(tmpdir(), 'pk-sync'), runnerId: 'r1', selfCommand: ['/k/koda-runner'],
      nowMs: () => clock.now, sleep: async (ms: number) => { await Promise.resolve(); clock.now += ms; }, timing: { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 250 }, uid,
    });
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'git@github.com:o/n.git' };
    const row: JobRow = Journal.open(':memory:').insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(tmpdir(), 'pk-sync-jobs', 'j1') }).row;
    const h = harness(cache);
    try {
      const waiting = broker.providerKeyReply(row, 'openrouter');
      const pending = h.loop.syncOnce();
      h.release({ ...empty, providerKeyErrors: [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }] });
      await within(pending, 'the sync that answered the decline');
      const reply = await within(waiting, 'the reply the waiting job reads');
      expect(reply, `the job must be told why no key came; ${captured('reply', reply)}`).toEqual({ ok: false, reason: 'none' });
    } finally {
      h.loop.stop();
      h.journal.close();
    }
  });
  test('AC-14: a grant the sync answers reaches a real-clock waiting job', async () => {
    // The socket half of this file only runs on a host. This is the same flow on the real clock without a socket, so
    // a grant the cache will never serve fails here with a message instead of hanging the socket test into the bare
    // timeout that captures no assertion message.
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    const broker = new CredentialBroker({
      tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
      providerKeys: cache, socketDir: join(tmpdir(), 'pk-sync'), runnerId: 'r1', selfCommand: ['/k/koda-runner'],
      nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms), timing: { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 10 }, uid,
    });
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'git@github.com:o/n.git' };
    const row: JobRow = Journal.open(':memory:').insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(tmpdir(), 'pk-sync-jobs', 'j1') }).row;
    const h = harness(cache);
    try {
      const waiting = broker.providerKeyReply(row, 'openrouter');
      const pending = h.loop.syncOnce();
      h.release({ ...empty, providerKeys: [liveGrant()] });
      await within(pending, 'the sync that answered the grant');
      const state = cache.state('j1', 1, 'openrouter', Date.now());
      expect(state, `a grant the cache can serve must be a grant right after the sync; ${captured('state', state)}`)
        .toMatchObject({ kind: 'grant' });
      const reply = await within(waiting, 'the reply a real-clock job waits for');
      expect(reply, `the job must be handed the key the sync granted; ${captured('reply', reply)}`).toMatchObject({ ok: true, key: 'sk-or-1' });
    } finally {
      h.loop.stop();
      h.journal.close();
    }
  });
});

// The nax sandbox withholds real Unix socket binding, so the end-to-end half of AC-14 runs on a host.
describe.skipIf(isNaxSandboxed())('US-008 SyncLoop to a real provider-key socket', () => {
  test('AC-14: a waiting socket request resolves ok once the stubbed sync answers providerKeys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pks-'));
    dirs.push(dir);
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    const broker = new CredentialBroker({
      tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
      providerKeys: cache, socketDir: join(dir, 's'), runnerId: 'r1', selfCommand: ['/k/koda-runner'],
      nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms), timing: { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 10 }, uid,
    });
    const journal = Journal.open(':memory:');
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'git@github.com:o/n.git' };
    const row: JobRow = journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(dir, '.jobs', 'j1') }).row;
    const h = harness(cache);
    try {
      const path = await within(broker.serveProviderKeys(row), 'the provider-key socket listen');
      const answer = askProvider(path, 'provider openrouter\n');
      await waitFor(() => cache.requests().length > 0, { timeoutMs: 2_000, message: `the socket request at ${path} never queued a ProviderKeyRequest` });
      const pending = h.loop.syncOnce();
      const carried = h.calls[0]?.providerRequests;
      expect(carried, `the socket's request must be the one the sync carries; ${h.body()}`)
        .toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      h.release({ ...empty, providerKeys: [liveGrant()] });
      const outcome = await within(pending, 'the sync that answered the socket request');
      expect(outcome, `the sync that answered the key must still succeed; ${h.body()}`).toEqual({ kind: 'ok' });
      const raw = await within(answer, 'the provider-key socket answer');
      const decoded = decode(raw);
      expect(decoded.reply, `the provider-key socket answered ${JSON.stringify(decoded.raw)}; an empty answer means it closed with no line`)
        .toMatchObject({ ok: true, key: 'sk-or-1', account: 'koda:global:fleet' });
    } finally {
      h.loop.stop();
      h.journal.close();
      await broker.closeAll();
    }
  });
});

function askProvider(path: string, line: string): Promise<string> {
  const answer = new Promise<string>((resolve, reject) => {
    const socket = createConnection(path);
    let out = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => { out += chunk; });
    socket.on('end', () => resolve(out));
    socket.on('error', (error: Error) => reject(new Error(`the provider-key socket at ${path} failed: ${error.message}`)));
  });
  return within(answer, `the answer from the provider-key socket at ${path}`);
}
