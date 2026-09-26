import { LiveStreamRegistry } from './live-stream-registry';

describe('LiveStreamRegistry', () => {
  it('admits up to the limit per user and refuses the next', () => {
    const registry = new LiveStreamRegistry();
    for (let i = 0; i < 5; i += 1) expect(registry.tryAcquire('u1', 5)).toBe(true);
    expect(registry.tryAcquire('u1', 5)).toBe(false);
    expect(registry.activeFor('u1')).toBe(5);
  });

  it('counts users independently', () => {
    const registry = new LiveStreamRegistry();
    for (let i = 0; i < 5; i += 1) registry.tryAcquire('u1', 5);
    expect(registry.tryAcquire('u2', 5)).toBe(true);
  });

  it('release frees a slot and never goes below zero', () => {
    const registry = new LiveStreamRegistry();
    for (let i = 0; i < 5; i += 1) registry.tryAcquire('u1', 5);
    registry.release('u1');
    expect(registry.tryAcquire('u1', 5)).toBe(true);
    registry.release('ghost');
    registry.release('ghost');
    expect(registry.activeFor('ghost')).toBe(0);
  });
});
