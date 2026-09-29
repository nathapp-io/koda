import { RunnerNotifier } from './runner-notifier';

describe('RunnerNotifier', () => {
  it('returns at once when ready() already has work', async () => {
    const n = new RunnerNotifier();
    const started = Date.now();
    await n.wait('r1', 5_000, async () => true);
    expect(Date.now() - started).toBeLessThan(100);
    expect(n.waiterCount('r1')).toBe(0);
  });

  it('wakes on notify, and a notify during ready() is not lost', async () => {
    const n = new RunnerNotifier();
    const started = Date.now();
    await n.wait('r1', 5_000, async () => {
      n.notify('r1'); // the command landed between the caller's read and the wait
      return false;
    });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('times out, only wakes its own runner, and cleans up', async () => {
    const n = new RunnerNotifier();
    const waiting = n.wait('r1', 50, async () => false);
    expect(n.waiterCount('r1')).toBe(1);
    n.notify('r2');
    await waiting;
    expect(n.waiterCount('r1')).toBe(0);
  });

  it('does not wait at all for ms <= 0', async () => {
    const ready = jest.fn();
    await new RunnerNotifier().wait('r1', 0, ready);
    expect(ready).not.toHaveBeenCalled();
  });
});
