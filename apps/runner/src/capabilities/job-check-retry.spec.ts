import { describe, expect, test } from 'bun:test';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import type { JobRow } from '../journal/types';
import type { JobCheck } from './job-check';
import { RetryingJobCheck, isTransientJobCheckReason } from './job-check-retry';

const REPO = '/w/acme/app';
const JOB = { jobId: 'job-1', leaseEpoch: 1, assign: { profiles: [] } as unknown as AssignPayload } as unknown as JobRow;
const TRUST_TIMEOUT = 'trust check failed: NAX_TIMEOUT';
const CONFIG_TIMEOUT = 'capability mismatch: profile resolve failed (NAX_TIMEOUT)';

/** A check that answers each call from `answers` in order, repeating the last one. */
function scripted(answers: readonly (string | null)[]): JobCheck & { calls: number } {
  const inner = {
    calls: 0,
    check: async () => {
      const answer = answers[Math.min(inner.calls, answers.length - 1)] ?? null;
      inner.calls += 1;
      return answer;
    },
  };
  return inner;
}

function retrying(inner: JobCheck, isCancelled?: () => boolean) {
  const slept: number[] = [];
  const check = new RetryingJobCheck({ inner, retries: 2, backoffMs: 2_000, sleep: async (ms) => { slept.push(ms); } });
  return { slept, run: () => check.check(JOB, REPO, isCancelled ? { isCancelled } : undefined) };
}

describe('isTransientJobCheckReason (#406)', () => {
  test('a NAX_TIMEOUT from any job-check call is transient', () => {
    expect(isTransientJobCheckReason(TRUST_TIMEOUT)).toBe(true);
    expect(isTransientJobCheckReason(CONFIG_TIMEOUT)).toBe(true);
    expect(isTransientJobCheckReason('capability mismatch: auth list failed (NAX_TIMEOUT)')).toBe(true);
  });

  test('a real verdict is not transient', () => {
    expect(isTransientJobCheckReason('project untrusted')).toBe(false);
    expect(isTransientJobCheckReason('capability mismatch: profile resolve failed (NAX_ERROR)')).toBe(false);
    expect(isTransientJobCheckReason('capability mismatch: provider zai missing')).toBe(false);
    expect(isTransientJobCheckReason('trust check failed: NAX_OUTPUT_UNPARSEABLE')).toBe(false);
  });
});

describe('RetryingJobCheck (#406)', () => {
  test('a passing check is asked once and never sleeps', async () => {
    const inner = scripted([null]);
    const { slept, run } = retrying(inner);
    expect(await run()).toBeNull();
    expect(inner.calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test('a timeout then a pass: the job passes after one backoff', async () => {
    const inner = scripted([TRUST_TIMEOUT, null]);
    const { slept, run } = retrying(inner);
    expect(await run()).toBeNull();
    expect(inner.calls).toBe(2);
    expect(slept).toEqual([2_000]);
  });

  test('every attempt times out: the last reason still names NAX_TIMEOUT, backoff doubles', async () => {
    const inner = scripted([TRUST_TIMEOUT, TRUST_TIMEOUT, CONFIG_TIMEOUT]);
    const { slept, run } = retrying(inner);
    expect(await run()).toBe(CONFIG_TIMEOUT);
    expect(inner.calls).toBe(3);
    expect(slept).toEqual([2_000, 4_000]);
  });

  test('a real verdict is terminal on the first attempt', async () => {
    const inner = scripted(['project untrusted', null]);
    const { slept, run } = retrying(inner);
    expect(await run()).toBe('project untrusted');
    expect(inner.calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test('a timeout followed by a real verdict returns the verdict without more retries', async () => {
    const inner = scripted([TRUST_TIMEOUT, 'capability mismatch: provider zai missing', null]);
    const { run } = retrying(inner);
    expect(await run()).toBe('capability mismatch: provider zai missing');
    expect(inner.calls).toBe(2);
  });

  test('a cancelled job is not retried', async () => {
    const inner = scripted([TRUST_TIMEOUT, null]);
    const { slept, run } = retrying(inner, () => true);
    expect(await run()).toBe(TRUST_TIMEOUT);
    expect(inner.calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test('a cancel that lands during the backoff stops the next attempt', async () => {
    const inner = scripted([TRUST_TIMEOUT, null]);
    let cancelled = false;
    const check = new RetryingJobCheck({ inner, retries: 2, backoffMs: 2_000, sleep: async () => { cancelled = true; } });
    expect(await check.check(JOB, REPO, { isCancelled: () => cancelled })).toBe(TRUST_TIMEOUT);
    expect(inner.calls).toBe(1);
  });

  test('retries: 0 behaves like the inner check', async () => {
    const inner = scripted([TRUST_TIMEOUT, null]);
    const check = new RetryingJobCheck({ inner, retries: 0, backoffMs: 2_000, sleep: async () => undefined });
    expect(await check.check(JOB, REPO)).toBe(TRUST_TIMEOUT);
    expect(inner.calls).toBe(1);
  });
});
