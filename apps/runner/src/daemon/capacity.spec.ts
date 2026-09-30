import { describe, expect, test } from 'bun:test';
import { createMemoryLogger } from '../logger';
import { CapacityTracker, freeSlots } from './capacity';

describe('freeSlots', () => {
  test.each([[null, 0, 0], [2, 0, 2], [2, 1, 1], [2, 2, 0], [2, 5, 0], [100, 0, 64], [0, 0, 0]])('capacity %p, active %p -> %p', (capacity, active, expected) => {
    expect(freeSlots(capacity, active)).toBe(expected);
  });
});

describe('CapacityTracker (#157)', () => {
  const me = (capacity: unknown) => ({ id: 'r', name: 'n', labels: [], capacity, enabled: true });
  test('unknown until the first successful refresh; keeps the last good value when a refresh fails', async () => {
    const answers: Array<() => Promise<unknown>> = [async () => { throw new Error('down'); }, async () => me(3), async () => { throw new Error('down'); }, async () => me(-2), async () => me('x')];
    const tracker = new CapacityTracker({ me: async () => answers.shift()?.() as never }, createMemoryLogger());
    expect(tracker.capacity).toBeNull();
    await tracker.refresh();
    expect(tracker.capacity).toBeNull();
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);                       // a negative value is ignored
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);                       // a non-number is ignored
  });
});
