import { describe, expect, test } from 'bun:test';
import { fakeTime } from '../../test/helpers/fake-time';
import { startHeartbeat } from './heartbeat';

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('startHeartbeat', () => {
  test('emits one stamp per interval until stopped, then never again', async () => {
    const time = fakeTime();
    const stamps: string[] = [];
    const stop = startHeartbeat({ everyMs: 30_000, sleep: time.sleep, now: time.now, emit: (at) => { stamps.push(at); } });
    for (let i = 0; i < 4; i += 1) await settle();
    stop();
    const seen = stamps.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(stamps[0]).toBe('2026-10-01T00:00:30.000Z');
    for (let i = 0; i < 4; i += 1) await settle();
    expect(stamps.length).toBe(seen);
  });
  test('a stop before the first interval emits nothing', async () => {
    const time = fakeTime();
    const stamps: string[] = [];
    startHeartbeat({ everyMs: 30_000, sleep: time.sleep, now: time.now, emit: (at) => { stamps.push(at); } })();
    for (let i = 0; i < 3; i += 1) await settle();
    expect(stamps).toEqual([]);
  });
});
