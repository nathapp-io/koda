// apps/runner/src/credentials/provider-key-cache.spec.ts
import { describe, expect, test } from 'bun:test';
import type { ProviderKeyError, ProviderKeyGrant, ProviderKeyRequest } from '@nathapp/fleet-protocol';
import { MAX_PROVIDER_KEY_REQUESTS, ProviderKeyCache } from './provider-key-cache';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const timing = { refreshMarginMs: 60_000 };
const ask = (providerId = 'openrouter', jobId = 'j1', leaseEpoch = 1): ProviderKeyRequest => ({ jobId, leaseEpoch, providerId });
const grant = (over: Partial<ProviderKeyGrant> = {}): ProviderKeyGrant => ({
  jobId: 'j1', providerId: 'openrouter', key: 'sk-or-1', account: 'koda:global:fleet', fingerprint: '0123456789ab',
  expiresAt: iso(T0 + 600_000), ...over,
});
const denial = (over: Partial<ProviderKeyError> = {}): ProviderKeyError => ({ jobId: 'j1', providerId: 'openrouter', reason: 'none', ...over });
/** The queued requests as an assertion message: a failure names what the cache would send. */
const queued = (cache: ProviderKeyCache): string => `queued provider requests: ${JSON.stringify(cache.requests())}`;

describe('ProviderKeyCache requests (US-008)', () => {
  test('AC-6: a wanted provider is requested once for its job and epoch', () => {
    const cache = new ProviderKeyCache(timing);
    expect(cache.requests(), 'a fresh cache must ask for nothing').toEqual([]);
    cache.want('j1', 3, 'openrouter');
    expect(cache.requests(), `after one want: ${queued(cache)}`).toEqual([ask('openrouter', 'j1', 3)]);
    cache.want('j1', 3, 'openrouter');
    expect(cache.requests(), `a repeated want must not duplicate the request: ${queued(cache)}`).toEqual([ask('openrouter', 'j1', 3)]);
  });

  test('a request is sent once per (job, provider): the highest epoch', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 4, 'openrouter');
    cache.want('j2', 2, 'zai');
    expect(cache.requests(), 'one request per job and provider, at the highest epoch that wants it')
      .toEqual([ask('openrouter', 'j1', 4), ask('zai', 'j2', 2)]);
  });

  test(`at most ${MAX_PROVIDER_KEY_REQUESTS} requests (the server's limit)`, () => {
    const cache = new ProviderKeyCache(timing);
    for (let i = 0; i < 70; i += 1) cache.want(`j${i}`, 1, 'openrouter');
    expect(cache.requests(), `70 wanted jobs must be cut to ${MAX_PROVIDER_KEY_REQUESTS} requests`).toHaveLength(MAX_PROVIDER_KEY_REQUESTS);
  });

  test('want notifies once per new key; the unsubscribe stops it', () => {
    const cache = new ProviderKeyCache(timing);
    let calls = 0;
    const off = cache.onNeed(() => { calls += 1; });
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 1, 'zai');
    expect(calls, 'two new wants notify twice, the repeated one does not').toBe(2);
    off();
    cache.want('j1', 2, 'openrouter');
    expect(calls, 'a listener removed with the unsubscribe must not run').toBe(2);
  });
});

describe('ProviderKeyCache apply (US-008)', () => {
  test('AC-7: a grant becomes a cached grant in epoch milliseconds for its originating request epoch', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 2, 'openrouter');
    const requested = cache.requests();
    cache.apply(requested, [grant()], []);
    expect(cache.state('j1', 2, 'openrouter', T0), 'the wire ISO expiry must become epoch milliseconds, with its account').toEqual({
      kind: 'grant', grant: { key: 'sk-or-1', expiresAtMs: T0 + 600_000, account: 'koda:global:fleet' },
    });
    expect(cache.requests(), 'an answered request must not be asked for again').toEqual([]);
  });

  test('a grant lands on the epoch that asked, not on another epoch of the same job', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 5, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 5, 'openrouter', T0), 'the requesting epoch must hold the grant').toMatchObject({ kind: 'grant' });
    expect(cache.state('j1', 6, 'openrouter', T0), 'another epoch of the same job must stay pending').toEqual({ kind: 'pending' });
  });

  test('a grant for a provider that was not requested, or was dropped meanwhile, is ignored', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply([], [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a grant for a request that was never sent must be ignored').toEqual({ kind: 'pending' });
    cache.drop('j1', 1);
    cache.apply([ask()], [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a grant for a dropped job epoch must be ignored').toEqual({ kind: 'pending' });
  });

  test('a grant whose expiresAt cannot be read is not invented, and stays asked for', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant({ expiresAt: 'not a time' })], []);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a grant with an unreadable expiry must not be served').toEqual({ kind: 'pending' });
    expect(cache.requests(), 'and it must stay queued for a real answer').toEqual([ask()]);
  });
});

describe('ProviderKeyCache serving window (US-008)', () => {
  test('AC-8: a grant with more than 60 s left is served and not asked for again', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0 + 600_000 - 60_001), '60 001 ms of lease left is still servable')
      .toMatchObject({ kind: 'grant' });
    expect(cache.requests(), 'a servable grant must queue nothing').toEqual([]);
  });

  test('AC-9: a grant within 60 s of its expiry is not served, so the provider is asked for again', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0 + 600_000 - 60_000), 'exactly 60 s left is inside the margin, so it is pending')
      .toEqual({ kind: 'pending' });
    cache.want('j1', 1, 'openrouter');
    expect(cache.requests(), 'the pending request must go out again').toEqual([ask()]);
  });

  test('an expired grant is never served', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0 + 600_000), 'a grant at its expiry is pending, not served').toEqual({ kind: 'pending' });
  });

  test('AC-10: a none for a provider never served to the job is a none', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a provider this job never had must decline').toEqual({ kind: 'denied', reason: 'none' });
  });

  test('AC-11: a none for a provider the job was served before is a revocation', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    const late = T0 + 600_000 - 30_000;   // inside the refresh margin, so the socket asks for a new key
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', late), 'a provider served before must revoke, never decline').toEqual({ kind: 'denied', reason: 'revoked' });
  });

  test('a live grant outranks a denial: a still-valid key keeps serving', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    cache.apply([ask()], [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a denial must not displace a key that still has its lease').toMatchObject({ kind: 'grant' });
  });

  test('a disabled vault or an inactive job is a decline too, and a revocation after a grant', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial({ reason: 'vault_off' })]);
    expect(cache.state('j1', 1, 'openrouter', T0), 'an initially disabled vault declines').toEqual({ kind: 'denied', reason: 'none' });

    const served = new ProviderKeyCache(timing);
    served.want('j1', 1, 'openrouter');
    served.apply(served.requests(), [grant()], []);
    served.want('j1', 1, 'openrouter');
    served.apply(served.requests(), [], [denial({ reason: 'job_not_active' })]);
    expect(served.state('j1', 1, 'openrouter', T0 + 600_000), 'an inactive job after a grant is a revocation').toEqual({ kind: 'denied', reason: 'revoked' });
  });

  test('an answered denial is not asked for again until the socket asks once more', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.requests(), 'an answered denial must not be re-asked on its own').toEqual([]);
    cache.want('j1', 1, 'openrouter');
    expect(cache.requests(), 'a new socket request asks once more').toEqual([ask()]);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a new want clears the denial and waits').toEqual({ kind: 'pending' });
  });

  test('a grant after a denial clears the denial', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial({ reason: 'vault_off' })]);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0), 'a later grant must serve, whatever the earlier denial').toMatchObject({ kind: 'grant', grant: { key: 'sk-or-1' } });
  });
});

describe('ProviderKeyCache drop (US-008 release)', () => {
  test('AC-13: drop forgets the grant, the served set and any queued request of that job epoch', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    cache.drop('j1', 1);
    expect(cache.state('j1', 1, 'openrouter', T0), 'the released epoch must hold nothing').toEqual({ kind: 'pending' });
    expect(cache.requests(), 'nothing of the released epoch may stay queued').toEqual([]);
    // the served set is gone with it: the next `none` is a decline, not a revocation
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', T0), 'the served set went with the drop, so this is a decline')
      .toEqual({ kind: 'denied', reason: 'none' });
  });

  test('drop leaves another epoch of the same job untouched', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 2, 'openrouter');
    cache.apply([ask('openrouter', 'j1', 1)], [grant()], []);   // the sync that carried epoch 1's request
    cache.apply([ask('openrouter', 'j1', 2)], [grant()], []);   // the one that carried epoch 2's
    cache.drop('j1', 1);
    expect(cache.state('j1', 1, 'openrouter', T0), 'the released epoch is gone').toEqual({ kind: 'pending' });
    expect(cache.state('j1', 2, 'openrouter', T0), 'the other epoch keeps its grant').toMatchObject({ kind: 'grant' });
  });
});
