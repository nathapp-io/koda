// apps/runner/test/unit/provider-cred-socket.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderKeyGrant, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { isNaxSandboxed } from '../helpers/test-environment';
import { CredentialBroker } from '../../src/credentials/broker';
import { ProviderKeyCache } from '../../src/credentials/provider-key-cache';
import { PROVIDER_CRED_SOCKET_ENV, requestProviderKey, runProviderCred, type ProviderCredIo, type ProviderCredReply } from '../../src/credentials/provider-cred';
import { TokenCache } from '../../src/credentials/token-cache';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import { SyncLoop, type SyncLoopDeps } from '../../src/sync/sync-loop';
import { assignFor } from '../helpers/assign';
import { within } from '../helpers/deadline';
import { waitFor } from '../helpers/wait';

const uid = process.getuid?.() ?? 0;
const ASK = JSON.stringify({ version: 1, providerId: 'openrouter' });
const EMPTY: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
const grant = (key = 'k1'): ProviderKeyGrant => ({
  jobId: 'j1', providerId: 'openrouter', key, account: 'koda:global:fleet', fingerprint: '0123456789ab',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
const dirs: string[] = [];
const journals: Journal[] = [];
afterAll(async () => {
  for (const journal of journals.splice(0)) journal.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A real broker over a real cache and a scripted sync client: no network, no database, no socket unless asked. */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'pc-sock-'));
  dirs.push(dir);
  const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
  const broker = new CredentialBroker({
    tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
    providerKeys: cache, socketDir: join(dir, 's'), runnerId: 'r1', selfCommand: ['/k/koda-runner'],
    nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms),
    timing: { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 10, providerKeyWaitMs: 2_000 }, uid,
  });
  const journal = Journal.open(':memory:');
  journals.push(journal);
  const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'git@github.com:o/n.git' };
  const row: JobRow = journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(dir, '.jobs', 'j1') }).row;
  return { dir, cache, broker, row, journal };
}

/** A helper invocation whose one socket call is the broker's own lookup: the wire is the only thing left out. */
function helper(request: (path: string, providerId: string) => Promise<ProviderCredReply>, socket = '/koda/provider-keys.sock') {
  const out: string[] = [];
  const err: string[] = [];
  const io: ProviderCredIo & { out: string[]; err: string[] } = {
    out, err,
    readStdin: async () => ASK,
    write: (text) => { out.push(text); },
    warn: (line) => { err.push(line); },
    env: { [PROVIDER_CRED_SOCKET_ENV]: socket },
    request,
  };
  return io;
}

/** The real SyncLoop over the real cache, with the server answer the test scripts. */
function syncLoop(cache: ProviderKeyCache, journal: Journal, response: SyncResponse, calls: SyncRequest[]) {
  const deps: SyncLoopDeps = {
    client: { sync: async (request: SyncRequest) => { calls.push(request); return response; } },
    journal, bootId: 'boot', daemonVersion: 'test', freeSlots: () => 1,
    capabilityReport: () => null, onCapabilitiesSent: () => undefined,
    handleCommands: async () => [], abandonUnknown: async () => undefined,
    tokenRequests: () => [], onTokens: () => undefined, onStop: () => undefined,
    log: createMemoryLogger(), sleep: async () => undefined, random: () => 0.5, nowMs: () => Date.now(), minGapMs: 0,
    providerRequests: () => cache.requests(),
    onProviderKeys: (requested, grants, errors) => cache.apply(requested, grants, errors),
  };
  return new SyncLoop(deps);
}

// The framing the helper shares with the socket, without the wire: these run in a nax sandbox too.
describe('runProviderCred over the broker lookup (US-009)', () => {
  test('AC-13: a granted key is written as nax\'s api-key reply', async () => {
    const w = await world();
    try {
      const io = helper((_path, providerId) => w.broker.providerKeyReply(w.row, providerId));
      const answer = runProviderCred(['get'], io);
      await waitFor(() => w.cache.requests().length > 0, { message: 'the helper never queued a provider request' });
      const granted = grant();
      w.cache.apply(w.cache.requests(), [granted], []);
      expect(await within(answer, 'the helper\'s api-key reply')).toBe(0);
      expect(JSON.parse(io.out.join(''))).toEqual({ version: 1, kind: 'api-key', key: 'k1', expiresAt: Date.parse(granted.expiresAt), account: 'koda:global:fleet' });
      expect(io.err).toEqual([]);
    } finally {
      await w.broker.closeAll();
    }
  });

  test('AC-14: a vault_off answer for a provider with no lease declines through the broker', async () => {
    const w = await world();
    const calls: SyncRequest[] = [];
    const loop = syncLoop(w.cache, w.journal, { ...EMPTY, providerKeyErrors: [{ jobId: 'j1', providerId: 'openrouter', reason: 'vault_off' }] }, calls);
    try {
      const io = helper((_path, providerId) => w.broker.providerKeyReply(w.row, providerId));
      const answer = runProviderCred(['get'], io);
      await waitFor(() => w.cache.requests().length > 0, { message: 'the helper never queued a provider request' });
      expect(await within(loop.syncOnce(), 'the sync that answered vault_off')).toEqual({ kind: 'ok' });
      expect(calls[0]?.providerRequests).toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      expect(await within(answer, 'the helper\'s decline')).toBe(0);
      expect(io.out.join('')).toBe('{"version":1,"decline":true}\n');
      expect(io.err).toEqual([]);
    } finally {
      loop.stop();
      await w.broker.closeAll();
    }
  });
});

// The nax sandbox withholds real Unix socket binding (and its $TMPDIR would push the socket path over 100 bytes).
describe.skipIf(isNaxSandboxed())('runProviderCred over a real provider-key socket (US-009)', () => {
  test('AC-13: the helper asks the job\'s socket and writes the key the broker granted', async () => {
    const w = await world();
    try {
      const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
      const io = helper((sock, providerId) => requestProviderKey(sock, providerId), path);
      const answer = runProviderCred(['get'], io);
      await waitFor(() => w.cache.requests().length > 0, { message: `the helper never queued a request on ${path}` });
      w.cache.apply(w.cache.requests(), [grant()], []);
      expect(await within(answer, 'the helper\'s answer over the socket')).toBe(0);
      const reply = JSON.parse(io.out.join('')) as Record<string, unknown>;
      expect(reply, `the helper wrote ${JSON.stringify(io.out.join(''))}`).toMatchObject({ version: 1, kind: 'api-key', key: 'k1', account: 'koda:global:fleet' });
      expect(io.err).toEqual([]);
    } finally {
      await w.broker.closeAll();
    }
  });

  test('AC-14: vault_off for a provider with no lease reaches the helper as a decline over the socket', async () => {
    const w = await world();
    const calls: SyncRequest[] = [];
    const loop = syncLoop(w.cache, w.journal, { ...EMPTY, providerKeyErrors: [{ jobId: 'j1', providerId: 'openrouter', reason: 'vault_off' }] }, calls);
    try {
      const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
      const io = helper((sock, providerId) => requestProviderKey(sock, providerId), path);
      const answer = runProviderCred(['get'], io);
      await waitFor(() => w.cache.requests().length > 0, { message: `the helper never queued a request on ${path}` });
      expect(await within(loop.syncOnce(), 'the sync that answered vault_off')).toEqual({ kind: 'ok' });
      expect(await within(answer, 'the helper\'s decline over the socket')).toBe(0);
      expect(io.out.join(''), `the helper wrote ${JSON.stringify(io.out.join(''))}`).toBe('{"version":1,"decline":true}\n');
    } finally {
      loop.stop();
      await w.broker.closeAll();
    }
  });
});
