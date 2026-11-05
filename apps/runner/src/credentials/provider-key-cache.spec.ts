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

describe('ProviderKeyCache requests (US-008)', () => {
  test('AC-6: a wanted provider is requested once for its job and epoch', () => {
    const cache = new ProviderKeyCache(timing);
    expect(cache.requests()).toEqual([]);
    cache.want('j1', 3, 'openrouter');
    expect(cache.requests()).toEqual([ask('openrouter', 'j1', 3)]);
    cache.want('j1', 3, 'openrouter');
    expect(cache.requests()).toEqual([ask('openrouter', 'j1', 3)]);
  });

  test('a request is sent once per (job, provider): the highest epoch', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 4, 'openrouter');
    cache.want('j2', 2, 'zai');
    expect(cache.requests()).toEqual([ask('openrouter', 'j1', 4), ask('zai', 'j2', 2)]);
  });

  test(`at most ${MAX_PROVIDER_KEY_REQUESTS} requests (the server's limit)`, () => {
    const cache = new ProviderKeyCache(timing);
    for (let i = 0; i < 70; i += 1) cache.want(`j${i}`, 1, 'openrouter');
    expect(cache.requests()).toHaveLength(MAX_PROVIDER_KEY_REQUESTS);
  });

  test('want notifies once per new key; the unsubscribe stops it', () => {
    const cache = new ProviderKeyCache(timing);
    let calls = 0;
    const off = cache.onNeed(() => { calls += 1; });
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 1, 'zai');
    expect(calls).toBe(2);
    off();
    cache.want('j1', 2, 'openrouter');
    expect(calls).toBe(2);
  });
});

describe('ProviderKeyCache apply (US-008)', () => {
  test('AC-7: a grant becomes a cached grant in epoch milliseconds for its originating request epoch', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 2, 'openrouter');
    const requested = cache.requests();
    cache.apply(requested, [grant()], []);
    expect(cache.state('j1', 2, 'openrouter', T0)).toEqual({
      kind: 'grant', grant: { key: 'sk-or-1', expiresAtMs: T0 + 600_000, account: 'koda:global:fleet' },
    });
    expect(cache.requests()).toEqual([]);   // answered: nothing is asked for again
  });

  test('a grant lands on the epoch that asked, not on another epoch of the same job', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 5, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 5, 'openrouter', T0)).toMatchObject({ kind: 'grant' });
    expect(cache.state('j1', 6, 'openrouter', T0)).toEqual({ kind: 'pending' });
  });

  test('a grant for a provider that was not requested, or was dropped meanwhile, is ignored', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply([], [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'pending' });
    cache.drop('j1', 1);
    cache.apply([ask()], [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'pending' });
  });

  test('a grant whose expiresAt cannot be read is not invented, and stays asked for', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant({ expiresAt: 'not a time' })], []);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'pending' });
    expect(cache.requests()).toEqual([ask()]);
  });
});

describe('ProviderKeyCache serving window (US-008)', () => {
  test('AC-8: a grant with more than 60 s left is served and not asked for again', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0 + 600_000 - 60_001)).toMatchObject({ kind: 'grant' });
    expect(cache.requests()).toEqual([]);
  });

  test('AC-9: a grant within 60 s of its expiry is not served, so the provider is asked for again', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0 + 600_000 - 60_000)).toEqual({ kind: 'pending' });
    cache.want('j1', 1, 'openrouter');
    expect(cache.requests()).toEqual([ask()]);
  });

  test('an expired grant is never served', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0 + 600_000)).toEqual({ kind: 'pending' });
  });

  test('AC-10: a none for a provider never served to the job is a none', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'denied', reason: 'none' });
  });

  test('AC-11: a none for a provider the job was served before is a revocation', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    const late = T0 + 600_000 - 30_000;   // inside the refresh margin, so the socket asks for a new key
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', late)).toEqual({ kind: 'denied', reason: 'revoked' });
  });

  test('a live grant outranks a denial: a still-valid key keeps serving', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    cache.apply([ask()], [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', T0)).toMatchObject({ kind: 'grant' });
  });

  test('a disabled vault or an inactive job is a decline too, and a revocation after a grant', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial({ reason: 'vault_off' })]);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'denied', reason: 'none' });

    const served = new ProviderKeyCache(timing);
    served.want('j1', 1, 'openrouter');
    served.apply(served.requests(), [grant()], []);
    served.want('j1', 1, 'openrouter');
    served.apply(served.requests(), [], [denial({ reason: 'job_not_active' })]);
    expect(served.state('j1', 1, 'openrouter', T0 + 600_000)).toEqual({ kind: 'denied', reason: 'revoked' });
  });

  test('an answered denial is not asked for again until the socket asks once more', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.requests()).toEqual([]);
    cache.want('j1', 1, 'openrouter');
    expect(cache.requests()).toEqual([ask()]);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'pending' });
  });

  test('a grant after a denial clears the denial', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial({ reason: 'vault_off' })]);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    expect(cache.state('j1', 1, 'openrouter', T0)).toMatchObject({ kind: 'grant', grant: { key: 'sk-or-1' } });
  });
});

describe('ProviderKeyCache drop (US-008 release)', () => {
  test('AC-13: drop forgets the grant, the served set and any queued request of that job epoch', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [grant()], []);
    cache.drop('j1', 1);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'pending' });
    expect(cache.requests()).toEqual([]);
    // the served set is gone with it: the next `none` is a decline, not a revocation
    cache.want('j1', 1, 'openrouter');
    cache.apply(cache.requests(), [], [denial()]);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'denied', reason: 'none' });
  });

  test('drop leaves another epoch of the same job untouched', () => {
    const cache = new ProviderKeyCache(timing);
    cache.want('j1', 1, 'openrouter');
    cache.want('j1', 2, 'openrouter');
    cache.apply([ask('openrouter', 'j1', 1)], [grant()], []);   // the sync that carried epoch 1's request
    cache.apply([ask('openrouter', 'j1', 2)], [grant()], []);   // the one that carried epoch 2's
    cache.drop('j1', 1);
    expect(cache.state('j1', 1, 'openrouter', T0)).toEqual({ kind: 'pending' });
    expect(cache.state('j1', 2, 'openrouter', T0)).toMatchObject({ kind: 'grant' });
  });
});
