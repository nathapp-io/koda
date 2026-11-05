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
import { waitFor } from '../helpers/wait';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const uid = process.getuid?.() ?? 0;
const empty: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
const grant = (providerId = 'openrouter', key = 'sk-or-1'): ProviderKeyGrant => ({
  jobId: 'j1', providerId, key, account: 'koda:global:fleet', fingerprint: '0123456789ab',
  expiresAt: new Date(T0 + 600_000).toISOString(),
});

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
  const release = (response: SyncResponse): void => { resolveSync?.(response); };
  return { loop: new SyncLoop(deps), journal, calls, release };
}

describe('US-008 SyncLoop provider keys', () => {
  test('AC-14: the loop sends the queued provider requests and applies the grants it gets back', async () => {
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    cache.want('j1', 4, 'openrouter');
    const h = harness(cache);
    try {
      const pending = h.loop.syncOnce();
      expect(h.calls[0]?.providerRequests).toEqual([{ jobId: 'j1', leaseEpoch: 4, providerId: 'openrouter' }]);
      h.release({ ...empty, providerKeys: [grant()] });
      expect(await pending).toEqual({ kind: 'ok' });
      expect(cache.state('j1', 4, 'openrouter', T0)).toMatchObject({ kind: 'grant', grant: { key: 'sk-or-1' } });
      expect(cache.requests()).toEqual([]);
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
      expect(await pending).toEqual({ kind: 'ok' });   // not 'woken': the request was allowed to finish
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
      expect(h.calls[0]?.providerRequests).toEqual([]);
      h.loop.wake();
      expect(await pending).toEqual({ kind: 'woken' });
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
      expect(await pending).toEqual({ kind: 'ok' });
      expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'denied', reason: 'none' });
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
      const path = await broker.serveProviderKeys(row);
      const answer = askProvider(path, 'provider openrouter\n');
      await waitFor(() => cache.requests().length > 0, { message: 'the socket request never queued a ProviderKeyRequest' });
      const pending = h.loop.syncOnce();
      expect(h.calls[0]?.providerRequests).toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      h.release({ ...empty, providerKeys: [grant()] });
      expect(await pending).toEqual({ kind: 'ok' });
      expect(JSON.parse(await answer)).toMatchObject({ ok: true, key: 'sk-or-1', account: 'koda:global:fleet' });
    } finally {
      h.loop.stop();
      h.journal.close();
      await broker.closeAll();
    }
  });
});

function askProvider(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let out = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => { out += chunk; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}
