// apps/runner/src/credentials/provider-key-broker.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderKeyGrant } from '@nathapp/fleet-protocol';
import { isNaxSandboxed } from '../../test/helpers/test-environment';
import { within } from '../../test/helpers/deadline';
import { CredentialBroker, type BrokerTiming } from './broker';
import { ProviderKeyCache } from './provider-key-cache';
import { SocketDirError } from './socket-dir';
import { TokenCache } from './token-cache';
import { Journal } from '../journal/journal';
import type { JobRow } from '../journal/types';
import { assignFor } from '../../test/helpers/assign';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const uid = process.getuid?.() ?? 0;
const SELF = ['/k/koda-runner'];
const FAST: BrokerTiming = { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 250 };

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/**
 * A job row, a provider cache and a broker on a clock the test moves. `sleep` yields a microtask first (so a test can
 * queue a grant while a request is in flight) and then jumps the clock by the poll interval, so 55 s costs no time.
 */
function world(sleep?: (ms: number) => Promise<void>) {
  const clock = { now: T0 };
  const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
  const broker = new CredentialBroker({
    tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
    providerKeys: cache, socketDir: join(tmpdir(), 'pk-broker'), runnerId: 'r1', selfCommand: SELF,
    nowMs: () => clock.now, sleep: sleep ?? (async (ms: number) => { await Promise.resolve(); clock.now += ms; }), timing: FAST, uid,
  });
  const journal = Journal.open(':memory:');
  const job = (cloneUrl = 'https://github.com/acme/app.git', leaseEpoch = 1): JobRow => {
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl };
    return journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch, repoKey: 'acme/app', jobDir: join(tmpdir(), 'pk-broker-jobs', 'j1') }).row;
  };
  const grant = (over: Partial<ProviderKeyGrant> = {}): ProviderKeyGrant => ({
    jobId: 'j1', providerId: 'openrouter', key: 'sk-or-1', account: 'koda:global:fleet', fingerprint: '0123456789ab',
    expiresAt: iso(clock.now + 600_000), ...over,
  });
  return { clock, cache, broker, journal, job, grant };
}

describe('CredentialBroker provider keys (US-008)', () => {
  /** What the cache has queued, for an assertion message: a failure has to name the request, not just a diff. */
  const queued = (cache: ProviderKeyCache): string => `queued provider requests: ${JSON.stringify(cache.requests())}`;

  test('AC-6: a request queues a ProviderKeyRequest for the job, its epoch and the provider', () => {
    const w = world();
    const row = w.job(undefined, 3);
    const pending = w.broker.providerKeyReply(row, 'openrouter');
    expect(w.cache.requests(), queued(w.cache)).toEqual([{ jobId: 'j1', leaseEpoch: 3, providerId: 'openrouter' }]);
    w.cache.apply(w.cache.requests(), [w.grant({ jobId: 'j1' })], []);
    return expect(pending, 'a queued request must resolve once its grant arrives').resolves.toMatchObject({ ok: true });
  });

  test('AC-7: the request resolves with the key, the account and expiresAt in epoch milliseconds once the grant lands', async () => {
    const w = world();
    const pending = w.broker.providerKeyReply(w.job(), 'openrouter');
    w.cache.apply(w.cache.requests(), [w.grant()], []);
    expect(await pending, `the reply after ${queued(w.cache)} must be the granted key in epoch milliseconds`)
      .toEqual({ ok: true, key: 'sk-or-1', expiresAt: T0 + 600_000, account: 'koda:global:fleet' });
  });

  test('AC-8: a second request inside the lease asks for nothing and answers from the cache', async () => {
    const w = world();
    const row = w.job();
    const first = w.broker.providerKeyReply(row, 'openrouter');
    w.cache.apply(w.cache.requests(), [w.grant()], []);
    expect(await first, 'the first request must be answered by its grant').toMatchObject({ ok: true, key: 'sk-or-1' });
    w.clock.now = T0 + 300_000;   // still more than 60 s before expiresAt
    expect(await w.broker.providerKeyReply(row, 'openrouter'), 'a live grant must answer without a new request')
      .toMatchObject({ ok: true, key: 'sk-or-1' });
    expect(w.cache.requests(), 'a cached grant must queue nothing').toEqual([]);
  });

  test('AC-9: a request inside 60 s of expiresAt queues a new one and does not serve the stale key', async () => {
    const w = world();
    const row = w.job();
    const first = w.broker.providerKeyReply(row, 'openrouter');
    w.cache.apply(w.cache.requests(), [w.grant()], []);
    expect(await first, 'the first request must be answered by its grant').toMatchObject({ ok: true, key: 'sk-or-1' });
    w.clock.now = T0 + 600_000 - 30_000;   // inside the refresh margin
    const second = w.broker.providerKeyReply(row, 'openrouter');
    expect(w.cache.requests(), 'a grant inside the 60 s margin must be asked for again').toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
    w.cache.apply(w.cache.requests(), [w.grant({ key: 'sk-or-2' })], []);
    expect(await second, 'the re-request must answer the new key, never the stale one').toMatchObject({ ok: true, key: 'sk-or-2' });
  });

  test('AC-10: a none for a provider never served to the job answers none', async () => {
    const w = world();
    const pending = w.broker.providerKeyReply(w.job(), 'openrouter');
    w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
    expect(await pending, 'a provider this job never had must decline, not revoke').toEqual({ ok: false, reason: 'none' });
  });

  test('AC-11: a none for a provider served before answers revoked, so no identity switch happens', async () => {
    const w = world();
    const row = w.job();
    const served = w.broker.providerKeyReply(row, 'openrouter');
    w.cache.apply(w.cache.requests(), [w.grant()], []);
    expect(await served, 'the job must be served a key before the revocation can be observed').toMatchObject({ ok: true });
    w.clock.now = T0 + 600_000 - 30_000;   // inside the margin: the next call asks the server again
    const again = w.broker.providerKeyReply(row, 'openrouter');
    w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
    expect(await again, `a provider served before must revoke, not decline (${queued(w.cache)})`).toEqual({ ok: false, reason: 'revoked' });
  });

  test('AC-12: a request with no answer inside 55 s answers error and invents no key', async () => {
    const w = world();
    const started = w.clock.now;
    const pending = w.broker.providerKeyReply(w.job(), 'openrouter');
    expect(await pending, 'a request with no answer must answer error, never a key').toEqual({ ok: false, reason: 'error' });
    expect(w.clock.now - started, `the reply gave up after ${w.clock.now - started} ms of its 55 s budget`).toBe(55_000);
  });

  test('AC-13: release invalidates sleeping replies before dropping the epoch, including late sync grants', async () => {
    const sleepers: Array<() => void> = [];
    const w = world(() => new Promise<void>((resolve) => sleepers.push(resolve)));
    const old = w.job(undefined, 1);
    const current = w.job(undefined, 2);
    const oldReply = w.broker.providerKeyReply(old, 'openrouter');
    const oldRequests = w.cache.requests();
    // A different provider prevents requests()'s highest-epoch deduplication from hiding a resurrected old want.
    const currentReply = w.broker.providerKeyReply(current, 'zai');
    const currentRequests = w.cache.requests().filter((request) => request.leaseEpoch === 2);
    try {
      await w.broker.releaseProviderKeys(old);
      expect(w.cache.requests(), 'release must retain only the other epoch').toEqual(currentRequests);
      sleepers.splice(0).forEach((resume) => resume());
      await Promise.resolve();
      expect(w.cache.requests(), 'resuming the released waiter must not recreate its request').toEqual(currentRequests);
      w.cache.apply(oldRequests, [w.grant({ key: 'released-key' })], []);
      expect(w.cache.state('j1', 1, 'openrouter', w.clock.now), 'a late grant must not repopulate the released epoch').toEqual({ kind: 'pending' });
      expect(await within(oldReply, 'the cancelled epoch reply'), 'release must end the pending reply with error').toEqual({ ok: false, reason: 'error' });
      w.cache.apply(currentRequests, [w.grant({ providerId: 'zai', key: 'current-key' })], []);
      sleepers.splice(0).forEach((resume) => resume());
      expect(await within(currentReply, 'the other epoch reply'), 'the other epoch must still receive its grant').toMatchObject({ ok: true, key: 'current-key' });
      expect(w.cache.requests(), 'no request may survive the release and the other epoch grant').toEqual([]);
    } finally {
      await w.broker.closeAll();
      sleepers.splice(0).forEach((resume) => resume());
      await Promise.all([oldReply, currentReply]);
    }
  });

  test('AC-10: a timed-out request followed by a late unused grant, expiry and none still declines', async () => {
    const w = world();
    const row = w.job();
    const timedOut = w.broker.providerKeyReply(row, 'openrouter');
    const originalRequests = w.cache.requests();
    expect(await timedOut, 'no grant was delivered before the deadline').toEqual({ ok: false, reason: 'error' });
    const unused = w.grant();
    w.cache.apply(originalRequests, [unused], []);
    w.clock.now = Date.parse(unused.expiresAt);
    const renewal = w.broker.providerKeyReply(row, 'openrouter');
    w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
    expect(await renewal, 'sync receipt without broker delivery must not create served history').toEqual({ ok: false, reason: 'none' });
  });

  for (const reason of ['none', 'vault_off'] as const) {
    test(`AC-6: a later broker lookup revalidates ${reason} and can receive a newly available key`, async () => {
      const w = world();
      const row = w.job();
      const first = w.broker.providerKeyReply(row, 'openrouter');
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason }]);
      expect(await first, 'the initial lookup must decline').toEqual({ ok: false, reason: 'none' });
      const retry = w.broker.providerKeyReply(row, 'openrouter');
      expect(w.cache.requests(), 'the actual broker must queue the revalidation, without a direct cache.want').toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      w.cache.apply(w.cache.requests(), [w.grant()], []);
      expect(await retry, 'a newly configured credential must recover this job epoch').toMatchObject({ ok: true, key: 'sk-or-1' });
      w.clock.now += 600_000;
      const renewal = w.broker.providerKeyReply(row, 'openrouter');
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
      expect(await renewal, 'revalidation must preserve subsequent successful delivery history').toEqual({ ok: false, reason: 'revoked' });
      const deniedAgain = w.broker.providerKeyReply(row, 'openrouter');
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
      expect(await deniedAgain, 'revalidating a revocation must not clear served history').toEqual({ ok: false, reason: 'revoked' });
    });
  }

  test('providerKeyGranted is true on a grant and false on a denial', async () => {
    const w = world();
    const row = w.job();
    const granted = w.broker.providerKeyGranted(row, 'openrouter');
    w.cache.apply(w.cache.requests(), [w.grant()], []);
    expect(await granted, 'providerKeyGranted must be true once the grant is cached').toBe(true);
    w.cache.drop('j1', 1);
    const declined = w.broker.providerKeyGranted(row, 'zai');
    w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'zai', reason: 'none' }]);
    expect(await declined, 'providerKeyGranted must be false for a denied provider').toBe(false);
  });

  test('a broker with no provider cache answers error rather than inventing a key', async () => {
    const journal = Journal.open(':memory:');
    const broker = new CredentialBroker({
      tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
      socketDir: join(tmpdir(), 'pk-none'), runnerId: 'r1', selfCommand: SELF,
      nowMs: () => T0, sleep: async () => undefined, timing: FAST, uid,
    });
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' };
    const row = journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: join(tmpdir(), 'x') }).row;
    expect(await broker.providerKeyReply(row, 'openrouter'), 'a broker with no provider cache cannot grant anything').toEqual({ ok: false, reason: 'error' });
    expect(await broker.providerKeyGranted(row, 'openrouter'), 'a broker with no provider cache holds no key').toBe(false);
  });
  test('serveProviderKeys refuses an unsafe socket directory instead of serving keys from it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pku-'));
    dirs.push(dir);
    await chmod(dir, 0o755);
    const broker = new CredentialBroker({
      tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
      providerKeys: new ProviderKeyCache({ refreshMarginMs: 60_000 }), socketDir: dir, runnerId: 'r1', selfCommand: SELF,
      nowMs: () => T0, sleep: async () => undefined, timing: FAST, uid,
    });
    const journal = Journal.open(':memory:');
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' };
    const row = journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: join(dir, 'j') }).row;
    // D109: the same check the git sockets do, re-run before every listen (the sandbox's deep $TMPDIR trips the
    // length rule first, on a host the mode rule does — either way it is a SocketDirError, so nothing is served).
    await expect(broker.serveProviderKeys(row), `socketDir ${dir} is group-or-world accessible, so no key may be served from it`)
      .rejects.toThrow(SocketDirError);
  });
});

// The nax sandbox withholds real Unix socket binding (and its $TMPDIR would push the socket path over 100 bytes), so
// the socket lifecycle of these criteria runs on a host.
describe.skipIf(isNaxSandboxed())('CredentialBroker provider-key socket (US-008)', () => {
  /** A real-clock world: a socket the broker opens needs real time, and a real directory under $TMPDIR. */
  async function socketWorld() {
    const dir = await mkdtemp(join(tmpdir(), 'pkbr-'));
    dirs.push(dir);
    const socketDir = join(dir, 's');
    const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
    const broker = new CredentialBroker({
      tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
      providerKeys: cache, socketDir, runnerId: 'r1', selfCommand: SELF,
      nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms), timing: FAST, uid,
    });
    const journal = Journal.open(':memory:');
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'git@github.com:o/n.git' };
    const row = journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(dir, '.jobs', 'j1') }).row;
    const grant = (over: Partial<ProviderKeyGrant> = {}): ProviderKeyGrant => ({
      jobId: 'j1', providerId: 'openrouter', key: 'sk-or-1', account: 'koda:global:fleet', fingerprint: '0123456789ab',
      expiresAt: new Date(Date.now() + 600_000).toISOString(), ...over,
    });
    return { cache, broker, row, grant, socketDir };
  }

  test('AC-4: serveProviderKeys returns an existing socket path for an ssh clone URL', async () => {
    const w = await socketWorld();
    try {
      const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
      expect(path.startsWith(w.socketDir), `serveProviderKeys returned ${path}, outside ${w.socketDir}`).toBe(true);
      expect((await stat(path)).isSocket(), `${path} is not a socket`).toBe(true);
    } finally {
      await w.broker.closeAll();
    }
  });

  test('AC-5: two calls for one job and epoch return the same path and open one socket', async () => {
    const w = await socketWorld();
    try {
      const [first, second] = await within(
        Promise.all([w.broker.serveProviderKeys(w.row), w.broker.serveProviderKeys(w.row)]), 'two provider-key socket listens');
      expect(first, `two concurrent calls returned ${first} and ${second}`).toBe(second);
      const inode = (await stat(first)).ino;
      const third = await within(w.broker.serveProviderKeys(w.row), 'the third provider-key socket listen');
      expect(third, `a third call must return ${first}`).toBe(first);
      expect((await stat(first)).ino, 'a second listen would have replaced the socket file (new inode)').toBe(inode);
    } finally {
      await w.broker.closeAll();
    }
  });

  test('AC-13: releaseProviderKeys removes the socket and drops the cached grants', async () => {
    const w = await socketWorld();
    try {
      const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
      const pending = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [w.grant()], []);
      const reply = await within(pending, 'the reply for the granted key');
      expect(reply, 'the job must hold a grant before the release can be observed').toMatchObject({ ok: true, key: 'sk-or-1' });
      await within(w.broker.releaseProviderKeys(w.row), 'the provider-key release');
      await expect(stat(path), `${path} must be gone after releaseProviderKeys`).rejects.toThrow();
      expect(w.cache.state('j1', 1, 'openrouter', Date.now()), 'the release must drop the cached grant').toEqual({ kind: 'pending' });
      expect(w.cache.requests(), 'the release must leave nothing queued').toEqual([]);
    } finally {
      await w.broker.closeAll();
    }
  });

  test('the git release ignores the provider-key socket: it does not keep <jobDir>/bin alive, and the socket stays', async () => {
    const w = await socketWorld();
    try {
      const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
      await mkdir(join(w.row.jobDir, 'bin'), { recursive: true });
      await within(w.broker.release(w.row), 'the git release');
      await expect(stat(join(w.row.jobDir, 'bin')), 'a provider-key socket must not keep the git shims alive').rejects.toThrow();
      expect((await stat(path)).isSocket(), `the git release must leave ${path} serving`).toBe(true);
    } finally {
      await w.broker.closeAll();
    }
  });

  test('closeAll closes the provider-key socket too', async () => {
    const w = await socketWorld();
    const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
    await w.broker.closeAll();
    await expect(stat(path), `${path} must be gone after closeAll`).rejects.toThrow();
  });

  test('a socket request waits for the grant and answers it in epoch milliseconds', async () => {
    const w = await socketWorld();
    try {
      const path = await within(w.broker.serveProviderKeys(w.row), 'the provider-key socket listen');
      const answer = askProvider(path, 'provider openrouter\n');
      await Bun.sleep(20);
      w.cache.apply(w.cache.requests(), [w.grant()], []);
      const raw = await within(answer, 'the provider-key socket answer');
      let reply: unknown = null;
      try { reply = JSON.parse(raw); } catch { reply = null; }
      expect(reply, `the socket answered ${JSON.stringify(raw)} (empty means no line came back)`)
        .toMatchObject({ ok: true, key: 'sk-or-1', account: 'koda:global:fleet' });
    } finally {
      await w.broker.closeAll();
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
    socket.on('error', (error: Error) => reject(new Error(`${path} failed: ${error.message} (answered ${JSON.stringify(out)})`)));
  });
  return within(answer, `the answer from the provider-key socket at ${path}`);
}
