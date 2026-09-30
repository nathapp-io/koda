import { describe, expect, test } from 'bun:test';
import { mapLimit } from './map-limit';

describe('mapLimit', () => {
  test('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(n * 3);
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
  test('an empty list resolves at once', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
