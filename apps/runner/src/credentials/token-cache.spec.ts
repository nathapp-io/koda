// apps/runner/src/credentials/token-cache.spec.ts
import { describe, expect, test } from 'bun:test';
import type { GitToken } from '@nathapp/fleet-protocol';
import { MAX_TOKEN_REQUESTS, TokenCache } from './token-cache';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const timing = { refreshMarginMs: 240_000, cooldownMs: 30_000 };
const tok = (jobId: string, expiresAt: string, token = 'ghs_1'): GitToken => ({ jobId, token, expiresAt, username: 'x-access-token' });

describe('TokenCache requests (D81)', () => {
  test('a wanted job with no token is requested; an unwanted one never is', () => {
    const cache = new TokenCache(timing);
    expect(cache.requests(T0)).toEqual([]);
    cache.want('j1', 1);
    expect(cache.requests(T0)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('a fresh token is not requested again; one within 240 s of expiry is', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.requests(T0)).toEqual([]);
    expect(cache.requests(T0 + 3_600_000 - 240_001)).toEqual([]);
    expect(cache.requests(T0 + 3_600_000 - 240_000)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('one request per job id, the highest wanted epoch', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.want('j1', 2);
    cache.want('j2', 1);
    expect(cache.requests(T0)).toEqual([{ jobId: 'j1', leaseEpoch: 2 }, { jobId: 'j2', leaseEpoch: 1 }]);
  });
  test(`at most ${MAX_TOKEN_REQUESTS} requests (the sync limit)`, () => {
    const cache = new TokenCache(timing);
    for (let i = 0; i < 70; i += 1) cache.want(`j${i}`, 1);
    expect(cache.requests(T0)).toHaveLength(MAX_TOKEN_REQUESTS);
  });
});

describe('TokenCache apply (D81, D82)', () => {
  test('a token lands on the epoch the request asked for, not on another epoch of the same job', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.want('j1', 2);
    cache.apply([{ jobId: 'j1', leaseEpoch: 2 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.state('j1', 2, T0)).toMatchObject({ kind: 'token', token: { token: 'ghs_1', username: 'x-access-token' } });
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
  });
  test('a token for a job that was not requested, or was dropped meanwhile, is ignored', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
    cache.drop('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.wanted('j1', 1)).toBe(false);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
  });
  test('a refresh that returns the same token (still inside the margin) cools the job down for 30 s', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    const exp = iso(T0 + 600_000);   // fresh when it first arrives: no cool-down
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', exp)], [], T0);
    const refresh = T0 + 400_000;    // now inside the margin, so the job asks again ...
    expect(cache.requests(refresh)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', exp)], [], refresh);   // ... and gets the same token back
    expect(cache.requests(refresh + 29_999)).toEqual([]);
    expect(cache.requests(refresh + 30_000)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('Review focus 1: a token that arrives already inside the margin is served but not asked for again at once', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 60_000))], [], T0);
    expect(cache.state('j1', 1, T0)).toMatchObject({ kind: 'token' });
    expect(cache.requests(T0 + 1)).toEqual([]);
    expect(cache.requests(T0 + 30_000)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('an expired token is not served', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 1_000))], [], T0);
    expect(cache.state('j1', 1, T0 + 1_000)).toEqual({ kind: 'pending' });
  });
  test('an error with no token is the state; with a live token the token still serves (D82); both cool down', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [], [{ jobId: 'j1', reason: 'app_not_installed' }], T0);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'error', reason: 'app_not_installed' });
    expect(cache.requests(T0 + 1)).toEqual([]);
    cache.want('j2', 1);
    cache.apply([{ jobId: 'j2', leaseEpoch: 1 }], [tok('j2', iso(T0 + 100_000))], [], T0);
    cache.apply([{ jobId: 'j2', leaseEpoch: 1 }], [], [{ jobId: 'j2', reason: 'provider_error' }], T0 + 30_000);
    expect(cache.state('j2', 1, T0 + 30_000)).toMatchObject({ kind: 'token' });
    expect(cache.state('j2', 1, T0 + 100_000)).toEqual({ kind: 'error', reason: 'provider_error' });
  });
  test('a new token clears an earlier error', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [], [{ jobId: 'j1', reason: 'provider_error' }], T0);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0 + 30_000);
    expect(cache.state('j1', 1, T0 + 30_000)).toMatchObject({ kind: 'token' });
  });
});

describe('TokenCache want, drop and listeners', () => {
  test('want notifies once per new key; the unsubscribe stops it', () => {
    const cache = new TokenCache(timing);
    let calls = 0;
    const off = cache.onNeed(() => { calls += 1; });
    cache.want('j1', 1);
    cache.want('j1', 1);
    cache.want('j1', 2);
    expect(calls).toBe(2);
    off();
    cache.want('j2', 1);
    expect(calls).toBe(2);
  });
  test('drop forgets the token and the want', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    cache.drop('j1', 1);
    expect(cache.wanted('j1', 1)).toBe(false);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
    expect(cache.requests(T0)).toEqual([]);
  });
});

describe('project code tokens', () => {
  test('project code AC-5: job and repository requests coexist without an undefined key', () => {
    const c = new TokenCache(timing);
    c.want('j1', 1); c.want('j1', 1, 'r1');
    expect(c.requests(T0)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }, { jobId: 'j1', leaseEpoch: 1, repoId: 'r1' }]);
    expect(c.requests(T0)[0]).not.toHaveProperty('repoId');
  });
  test('project code AC-6: prioritizes job tokens then first-wanted repositories; overflow waits', () => {
    const c = new TokenCache(timing);
    for (let i = 0; i < 70; i++) c.want('j1', 1, `r${i}`);
    c.want('j1', 1);
    const requests = c.requests(T0);
    expect(requests).toEqual([{ jobId: 'j1', leaseEpoch: 1 }, ...Array.from({ length: 63 }, (_, i) => ({ jobId: 'j1', leaseEpoch: 1, repoId: `r${i}` }))]);
    c.apply(requests, requests.map((r) => ({ ...tok(r.jobId, iso(T0 + 3_600_000)), ...(r.repoId === undefined ? {} : { repoId: r.repoId }) })), [], T0);
    expect(c.requests(T0).map((r) => r.repoId)).toEqual(['r63', 'r64', 'r65', 'r66', 'r67', 'r68', 'r69']);
  });
  test('project code AC-7: applies repository token only to the requested repository and epoch', () => {
    const c = new TokenCache(timing);
    c.want('j1', 1); c.want('j1', 1, 'r1');
    c.apply(c.requests(T0), [{ ...tok('j1', iso(T0 + 3_600_000)), repoId: 'r1' }], [], T0);
    expect(c.state('j1', 1, T0, 'r1').kind).toBe('token');
    expect(c.state('j1', 1, T0)).toEqual({ kind: 'pending' });
  });
  test('project code AC-8: applies and drops repository error without touching job token demand', () => {
    const c = new TokenCache(timing);
    c.want('j1', 1); c.want('j1', 1, 'r1');
    c.apply(c.requests(T0), [], [{ jobId: 'j1', repoId: 'r1', reason: 'repo_not_assigned' }], T0);
    expect(c.state('j1', 1, T0, 'r1')).toEqual({ kind: 'error', reason: 'repo_not_assigned' });
    c.drop('j1', 1, 'r1');
    expect(c.wanted('j1', 1, 'r1')).toBe(false);
    expect(c.wanted('j1', 1)).toBe(true);
  });
  test('project code: highest epoch is independent per repository, stale and unsolicited replies ignored', () => {
    const c = new TokenCache(timing);
    c.want('j1', 1, 'r1'); c.want('j1', 1, 'r2'); c.want('j1', 2, 'r1'); c.want('j1', 1);
    const requests = c.requests(T0);
    expect(requests).toEqual([{ jobId: 'j1', leaseEpoch: 1 }, { jobId: 'j1', leaseEpoch: 2, repoId: 'r1' }, { jobId: 'j1', leaseEpoch: 1, repoId: 'r2' }]);
    c.apply(requests, ['r1', 'r2', 'r3'].map((repoId) => ({ ...tok('j1', iso(T0 + 3_600_000)), repoId })), [], T0);
    expect(c.state('j1', 1, T0, 'r1').kind).toBe('pending');
    expect(c.state('j1', 2, T0, 'r1').kind).toBe('token');
    expect(c.state('j1', 1, T0, 'r2').kind).toBe('token');
    expect(c.wanted('j1', 1, 'r3')).toBe(false);
  });
});
