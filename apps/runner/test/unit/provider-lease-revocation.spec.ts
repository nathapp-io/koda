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
 * A real broker over a real cache, on a clock the test moves and with a poll tick that never fires: every lookup then
 * waits on the answer to its own request, which is exactly the ownership US-008 D-1 asks for (a suspended lookup is
 * one whose own answer has not arrived yet — never one whose answer was replaced).
 */
function world() {
  const clock = { now: T0 };
  const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
  const broker = new CredentialBroker({
    tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
    providerKeys: cache, socketDir: join(tmpdir(), 'pk-revocation'), runnerId: 'r1', selfCommand: ['/k/koda-runner'],
    nowMs: () => clock.now,
    sleep: () => new Promise<void>(() => undefined),   // the tick never wakes a lookup: only its own answer does
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
  const deny = (reason: ProviderKeyError['reason'] = 'none'): ProviderKeyError => ({ jobId: 'j1', providerId: 'openrouter', reason });
  const queued = (): string => JSON.stringify(cache.requests());
  return { clock, cache, broker, row, grant, deny, queued };
}

describe('a provider-key lookup owns its own answer (US-008 D-1 as wired by US-009)', () => {
  test('a later lookup\'s grant never becomes a waiting lookup\'s decline', async () => {
    const w = world();
    try {
      const first = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [], [w.deny()]);
      // A later lookup revalidates and is granted a key, all before either lookup is observed.
      const second = w.broker.providerKeyReply(w.row, 'openrouter');
      expect(w.cache.requests(), `the later lookup must queue its own request (${w.queued()})`)
        .toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
      w.cache.apply(w.cache.requests(), [w.grant({ key: 'sk-or-2' })], []);
      expect(await within(first, 'the first lookup\'s decline'), 'the first lookup must read the answer to its own request')
        .toEqual({ ok: false, reason: 'none' });
      expect(await within(second, 'the later lookup\'s grant'), 'the later lookup must be handed the recovered key')
        .toMatchObject({ ok: true, key: 'sk-or-2' });
    } finally {
      await w.broker.closeAll();
    }
  });

  test('a later lookup\'s grant never becomes a waiting lookup\'s revocation', async () => {
    const w = world();
    try {
      const served = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [w.grant()], []);
      expect(await within(served, 'the first grant')).toMatchObject({ ok: true, key: 'sk-or-1' });
      w.clock.now = T0 + 600_000 - 30_000;   // inside the refresh margin: the next lookup asks again
      const first = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [], [w.deny()]);
      const second = w.broker.providerKeyReply(w.row, 'openrouter');
      w.cache.apply(w.cache.requests(), [w.grant({ key: 'sk-or-2', expiresAt: iso(w.clock.now + 600_000) })], []);
      expect(await within(first, 'the renewal\'s revocation'), 'the renewal must read the answer to its own request')
        .toEqual({ ok: false, reason: 'revoked' });
      expect(await within(second, 'the later lookup\'s grant'), 'the later lookup must be handed the renewed key')
        .toMatchObject({ ok: true, key: 'sk-or-2' });
    } finally {
      await w.broker.closeAll();
    }
  });
});
