import { Logger } from '@nestjs/common';
import type { Mock } from 'vitest';
import { IRagConfig } from '../../config/rag.config';
import { CounterOptimizeStrategy } from './counter-optimize.strategy';
import { FTS_OPTIMIZE_STRATEGY } from './fts-optimize-strategy.interface';
import type { OptimizeTask } from './fts-optimize-strategy.interface';

function mockRagConfig(overrides: Partial<IRagConfig> = {}): IRagConfig {
  return {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath: './lancedb',
    inMemoryOnly: true,
    ftsIndexMode: 'simple',
    similarityHigh: 0.85,
    similarityMedium: 0.70,
    similarityLow: 0.50,
    ftsOptimizeStrategy: 'counter',
    ftsOptimizeThreshold: 10,
    ftsOptimizeIntervalMs: 300_000,
    graphifyEnabledCacheTtlSec: 60,
    ...overrides,
  };
}

/** A lock-aware optimize task whose work is observable. */
function trackingTask(): { task: OptimizeTask; optimize: Mock } {
  const optimize = vi.fn().mockResolvedValue(undefined);
  const task: OptimizeTask = async () => {
    await optimize();
  };
  return { task, optimize };
}

/** Lets queued microtasks (and the fire-and-forget optimize) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('FTS_OPTIMIZE_STRATEGY token', () => {
  it('is a non-empty string', () => {
    expect(typeof FTS_OPTIMIZE_STRATEGY).toBe('string');
    expect(FTS_OPTIMIZE_STRATEGY.length).toBeGreaterThan(0);
  });
});

describe('CounterOptimizeStrategy', () => {
  describe('AC-1: onInsert() below the threshold never calls optimize', () => {
    it('does not run the task when the count is below the threshold', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 3 }));
      const { task, optimize } = trackingTask();

      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task); // 2 < 3

      expect(optimize).not.toHaveBeenCalled();
    });

    it('does not run the task for nine inserts at the default threshold of 10', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig());
      const { task, optimize } = trackingTask();

      for (let i = 0; i < 9; i++) await strategy.onInsert('p', task);

      expect(optimize).not.toHaveBeenCalled();
    });
  });

  describe('AC-2: onInsert() at the threshold calls optimize once', () => {
    it('runs the task exactly once when the insert count reaches the threshold', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 3 }));
      const { task, optimize } = trackingTask();

      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task); // 3rd → threshold
      await flush();

      expect(optimize).toHaveBeenCalledTimes(1);
    });

    it('triggers at a threshold of 2 read from ragConfig.ftsOptimizeThreshold', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      const { task, optimize } = trackingTask();

      await strategy.onInsert('p', task);
      await strategy.onInsert('p', task);
      await flush();

      expect(optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-3: onInsert() at the threshold resolves before the task settles', () => {
    it('resolves onInsert while the started optimize is still pending', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      let settleOptimize: (() => void) | undefined;
      let settled = false;
      const optimize = vi.fn(
        () => new Promise<void>((resolve) => {
          settleOptimize = () => {
            settled = true;
            resolve();
          };
        }),
      );
      const task: OptimizeTask = () => optimize();

      await strategy.onInsert('p1', task); // 1
      await expect(strategy.onInsert('p1', task)).resolves.toBeUndefined(); // 2 → threshold

      expect(optimize).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      settleOptimize?.();
      await flush();
      expect(settled).toBe(true);
    });
  });

  describe('AC-4: a rejecting optimize is logged as a warning naming the project', () => {
    it('logs a warning containing the project id', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      warnSpy.mockClear();
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      const task: OptimizeTask = () => Promise.reject(new Error('optimize boom'));

      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task); // threshold → background optimize rejects
      await flush();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('p1'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('optimize boom'));
    });
  });

  describe('AC-5: a rejecting optimize causes no unhandled rejection', () => {
    let unhandled: unknown[];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    beforeEach(() => {
      unhandled = [];
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    it('swallows the rejection of the task started at the threshold', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      const optimize = vi.fn(() => Promise.reject(new Error('optimize boom')));
      const task: OptimizeTask = () => optimize();

      await strategy.onInsert('p1', task);
      await expect(strategy.onInsert('p1', task)).resolves.toBeUndefined();
      await flush();
      await flush();

      expect(optimize).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  });

  describe('counter bookkeeping', () => {
    it('resets the counter after the threshold optimize', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 3 }));
      const { task, optimize } = trackingTask();

      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task); // triggers optimize, resets counter
      // next 2 inserts must NOT trigger another optimize
      await strategy.onInsert('p1', task);
      await strategy.onInsert('p1', task);
      await flush();

      expect(optimize).toHaveBeenCalledTimes(1);
    });

    it('maintains separate counters per projectId', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      const t1 = trackingTask();
      const t2 = trackingTask();

      await strategy.onInsert('p1', t1.task); // p1 count: 1
      await strategy.onInsert('p2', t2.task); // p2 count: 1
      await strategy.onInsert('p1', t1.task); // p1 count: 2 → optimize
      await flush();

      expect(t1.optimize).toHaveBeenCalledTimes(1);
      expect(t2.optimize).not.toHaveBeenCalled();
    });
  });

  describe('onFirstAccess()', () => {
    it('runs the task and returns void synchronously', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 10 }));
      const { task, optimize } = trackingTask();

      const result = strategy.onFirstAccess('p1', task);

      expect(result).toBeUndefined();
      await flush();
      expect(optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup', () => {
    it('clearProject removes project counter state', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      const { task, optimize } = trackingTask();

      await strategy.onInsert('p1', task); // p1 count: 1
      strategy.clearProject('p1');
      await strategy.onInsert('p1', task); // count should restart at 1
      await flush();

      expect(optimize).not.toHaveBeenCalled();
    });

    it('onDestroy clears all counters', async () => {
      const strategy = new CounterOptimizeStrategy(mockRagConfig({ ftsOptimizeThreshold: 2 }));
      const t1 = trackingTask();
      const t2 = trackingTask();

      await strategy.onInsert('p1', t1.task);
      await strategy.onInsert('p2', t2.task);
      await strategy.onDestroy();
      await strategy.onInsert('p1', t1.task);
      await strategy.onInsert('p2', t2.task);
      await flush();

      expect(t1.optimize).not.toHaveBeenCalled();
      expect(t2.optimize).not.toHaveBeenCalled();
    });
  });
});
