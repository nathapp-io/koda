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
