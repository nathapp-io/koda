import { describe, expect, test } from 'bun:test';
import { systemSleep } from './time';

describe('systemSleep', () => {
  test('waits roughly the requested time', async () => {
    const start = performance.now();
    await systemSleep(40);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
  });
  test('resolves early, without rejecting, when the signal aborts, and at once when already aborted', async () => {
    const controller = new AbortController();
    const start = performance.now();
    const pending = systemSleep(5_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await pending;
    expect(performance.now() - start).toBeLessThan(1_000);
    await systemSleep(5_000, AbortSignal.abort());
  });
});
