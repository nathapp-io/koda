// apps/runner/test/unit/provider-lease-revocation.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderKeyError, ProviderKeyGrant } from '@nathapp/fleet-protocol';
import { CredentialBroker } from '../../src/credentials/broker';
import { ProviderKeyCache } from '../../src/credentials/provider-key-cache';
import { TokenCache } from '../../src/credentials/token-cache';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { assignFor } from '../helpers/assign';
import { within } from '../helpers/deadline';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const uid = process.getuid?.() ?? 0;
const journals: Journal[] = [];
afterAll(() => { for (const journal of journals.splice(0)) journal.close(); });

/**
 * Two lookups racing over one cache, with time and the poll under the test's control (US-008 D-1, the completion
 * ownership a socket-free regression can be exact about): `sleep` parks each lookup until the test resumes it, so
 * "A is suspended" is a fact, not a race.
 */
function world() {
  const clock = { now: T0 };
  const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
  const sleepers: Array<() => void> = [];
  const broker = new CredentialBroker({
    tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
    providerKeys: cache, socketDir: join(tmpdir(), 'pk-revocation'), runnerId: 'r1', selfCommand: ['/k/koda-runner'],
    nowMs: () => clock.now,
    sleep: () => new Promise<void>((resolve) => { sleepers.push(resolve); }),
    timing: { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 250 }, uid,
  });
  const journal = Journal.open(':memory:');
  journals.push(journal);
  const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'git@github.com:o/n.git' };
  const row: JobRow = journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', repo }), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(tmpdir(), 'pk-revocation-jobs', 'j1') }).row;
  const grant = (over: Partial<ProviderKeyGrant> = {}): ProviderKeyGrant => ({
    jobId: 'j1', providerId: 'openrouter', key: 'sk-or-1', account: 'koda:global:fleet', fingerprint: '0123456789ab',
    expiresAt: iso(clock.now + 600_000), ...over,
  });
  /** How many lookups are suspended in a poll right now. */
  const parked = (): number => sleepers.length;
  /** Resume the given number of suspended lookups (the oldest first) and let their polls continue. */
  const resume = (count = 1): void => { for (const wake of sleepers.splice(0, count)) wake(); };
  const queued = (): string => JSON.stringify(cache.requests());
  return { clock, cache, broker, row, grant, parked, resume, queued };
}

describe('provider-key lookups keep their own answer (US-008 D-1)', () => {
  test('a second lookup\'s revalidation never erases a waiting lookup\'s none', async () => {
    const w = world();
    let second = 'pending';
    try {
      const first = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.parked(), 'the first lookup must be suspended in its poll').toBe(1);
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' } satisfies ProviderKeyError]);
      // A second lookup starts before the first resumes: it asks again, and the sync for its request is stalled.
      const secondLookup = w.broker.providerKeyReply(w.row, 'openrouter');
      void secondLookup.then((reply) => { second = JSON.stringify(reply); }, () => { second = 'rejected'; });
      expect(w.parked(), 'both lookups must be suspended in their own poll').toBe(2);
      w.resume();
      expect(await within(first, 'the first lookup\'s decline'), 'the first lookup must read the answer to its own request')
        .toEqual({ ok: false, reason: 'none' });
      expect(w.cache.requests(), `the second lookup must keep its own request queued (${w.queued()})`)
        .toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      await Promise.resolve();
      expect(second, 'the second lookup must stay pending until its own request is answered').toBe('pending');
      // Its own answer arrives: the wait it kept is the one that recovers the key.
      w.cache.apply(w.cache.requests(), [w.grant({ key: 'sk-or-2' })], []);
      w.resume();
      expect(await within(secondLookup, 'the second lookup\'s own grant'), 'the second lookup must be served its own answer')
        .toMatchObject({ ok: true, key: 'sk-or-2' });
    } finally {
      await w.broker.closeAll();
      w.resume(10);
    }
  });

  test('a second lookup\'s revalidation never erases a waiting lookup\'s revocation', async () => {
    const w = world();
    let second = 'pending';
    try {
      // The job is served a key first, so a denial is a revocation, not a decline.
      const served = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [w.grant()], []);
      w.resume();
      expect(await within(served, 'the first grant')).toMatchObject({ ok: true, key: 'sk-or-1' });
      w.clock.now = T0 + 600_000 - 30_000;   // inside the refresh margin: the next lookup asks again
      const first = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.parked(), 'the renewal must be suspended in its poll').toBe(1);
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
      const secondLookup = w.broker.providerKeyReply(w.row, 'openrouter');
      void secondLookup.then((reply) => { second = JSON.stringify(reply); }, () => { second = 'rejected'; });
      expect(w.parked(), 'both lookups must be suspended in their own poll').toBe(2);
      w.resume();
      expect(await within(first, 'the renewal\'s revocation'), 'the renewal must read the answer to its own request')
        .toEqual({ ok: false, reason: 'revoked' });
      expect(w.cache.requests(), `the later lookup must keep its own request queued (${w.queued()})`)
        .toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      await Promise.resolve();
      expect(second, 'the later lookup must stay pending, not inherit the revocation').toBe('pending');
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
      w.resume();
      expect(await within(secondLookup, 'the later lookup\'s own answer'), 'the later lookup must read its own revocation')
        .toEqual({ ok: false, reason: 'revoked' });
    } finally {
      await w.broker.closeAll();
      w.resume(10);
    }
  });

  test('a grant answered to a later lookup never replaces a suspended lookup\'s none', async () => {
    const w = world();
    try {
      const first = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.parked(), 'the first lookup must be suspended in its poll').toBe(1);
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
      const secondLookup = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.parked(), 'both lookups must be suspended in their own poll').toBe(2);
      // The server recovers the provider for the later lookup while the first is still suspended: its own grant must
      // not become the first lookup's answer.
      w.cache.apply(w.cache.requests(), [w.grant({ key: 'sk-or-2' })], []);
      w.resume();
      expect(await within(first, 'the first lookup\'s completed decline'), 'the first lookup must read its own answer')
        .toEqual({ ok: false, reason: 'none' });
      w.resume();
      expect(await within(secondLookup, 'the later lookup\'s grant'), 'the later lookup must be handed the recovered key')
        .toMatchObject({ ok: true, key: 'sk-or-2' });
    } finally {
      await w.broker.closeAll();
      w.resume(10);
    }
  });

  test('a grant answered to a later lookup never replaces a suspended lookup\'s revocation', async () => {
    const w = world();
    try {
      const served = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [w.grant()], []);
      w.resume();
      expect(await within(served, 'the first grant')).toMatchObject({ ok: true, key: 'sk-or-1' });
      w.clock.now = T0 + 600_000 - 30_000;   // inside the refresh margin: the renewal asks again
      const first = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.parked(), 'the renewal must be suspended in its poll').toBe(1);
      w.cache.apply(w.cache.requests(), [], [{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
      const secondLookup = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.parked(), 'both lookups must be suspended in their own poll').toBe(2);
      w.cache.apply(w.cache.requests(), [w.grant({ key: 'sk-or-2', expiresAt: iso(w.clock.now + 600_000) })], []);
      w.resume();
      expect(await within(first, 'the renewal\'s completed revocation'), 'the renewal must read its own answer')
        .toEqual({ ok: false, reason: 'revoked' });
      w.resume();
      expect(await within(secondLookup, 'the later lookup\'s grant'), 'the later lookup must be handed the renewed key')
        .toMatchObject({ ok: true, key: 'sk-or-2' });
    } finally {
      await w.broker.closeAll();
      w.resume(10);
    }
  });
});
