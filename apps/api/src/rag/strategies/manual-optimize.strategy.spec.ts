import type { Mock } from 'vitest';
import { ManualOptimizeStrategy } from './manual-optimize.strategy';
import type { OptimizeTask } from './fts-optimize-strategy.interface';

/** A lock-aware optimize task whose work is observable. */
function trackingTask(): { task: OptimizeTask; optimize: Mock } {
  const optimize = vi.fn().mockResolvedValue(undefined);
  const task: OptimizeTask = async () => {
    await optimize();
  };
  return { task, optimize };
}

describe('ManualOptimizeStrategy', () => {
  let strategy: ManualOptimizeStrategy;

  beforeEach(() => {
    strategy = new ManualOptimizeStrategy();
  });

  describe('onInsert() never calls optimize', () => {
    it('does not run the task regardless of call count', async () => {
      const { task, optimize } = trackingTask();
      for (let i = 0; i < 50; i++) await strategy.onInsert('p1', task);
      expect(optimize).not.toHaveBeenCalled();
    });
  });

  describe('AC-9: onFirstAccess() runs the task once without awaiting it', () => {
    it('starts the task and returns void synchronously', () => {
      const { task, optimize } = trackingTask();

      const result = strategy.onFirstAccess('p1', task);

      expect(result).toBeUndefined();
      expect(optimize).toHaveBeenCalledTimes(1);
    });

    it('does not wait for a pending task before returning', () => {
      let settleTask: (() => void) | undefined;
      const task: OptimizeTask = () => new Promise<void>((resolve) => {
        settleTask = resolve;
      });

      const result = strategy.onFirstAccess('p1', task);

      expect(result).toBeUndefined();
      // The task started (its executor ran) and is still pending — onFirstAccess did not await it.
      expect(settleTask).toBeTypeOf('function');
      settleTask?.();
    });
  });

  describe('onDestroy() completes without error', () => {
    it('resolves successfully', async () => {
      await expect(strategy.onDestroy()).resolves.toBeUndefined();
    });
  });
});
