import { describe, expect, test } from 'bun:test';
import { backoffDelay } from './backoff';

describe('backoffDelay (full jitter, 1 s to 60 s)', () => {
  test('the ceiling doubles from 1 s and stops at 60 s', () => {
    const top = () => 0.999999;
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, top))).toEqual([999, 1999, 3999, 7999]);
    expect(backoffDelay(6, top)).toBeLessThan(60_000);
    expect(backoffDelay(6, top)).toBeGreaterThan(59_000);
    expect(backoffDelay(40, top)).toBeLessThan(60_000);
  });
  test('is uniform below the ceiling, so a zero draw is a zero delay', () => {
    expect(backoffDelay(5, () => 0)).toBe(0);
    expect(backoffDelay(0, () => 0.5)).toBe(500);
  });
  test('an optional cap replaces 60 s (S2a plan D326)', () => {
    const top = () => 0.999999;
    expect(backoffDelay(10, top, 30_000)).toBeLessThan(30_000);
    expect(backoffDelay(10, top, 30_000)).toBeGreaterThan(29_000);
    expect(backoffDelay(1, top, 30_000)).toBe(1999);
  });
});
