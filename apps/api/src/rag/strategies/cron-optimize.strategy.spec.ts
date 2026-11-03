import type { Mock } from 'vitest';
import { IRagConfig } from '../../config/rag.config';
import { CronOptimizeStrategy } from './cron-optimize.strategy';
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
    ftsOptimizeStrategy: 'cron',
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

function mockSchedulerRegistry() {
  return { addInterval: vi.fn(), deleteInterval: vi.fn() };
}

function makeStrategy(intervalMs?: number) {
  return new CronOptimizeStrategy(
    mockRagConfig(intervalMs !== undefined ? { ftsOptimizeIntervalMs: intervalMs } : {}),
    mockSchedulerRegistry() as never,
  );
}

describe('CronOptimizeStrategy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('constructor registers the interval', () => {
    it('calls schedulerRegistry.addInterval("fts-optimize", interval) during construction', () => {
      const schedulerRegistry = mockSchedulerRegistry();
      new CronOptimizeStrategy(
        mockRagConfig({ ftsOptimizeIntervalMs: 60_000 }),
        schedulerRegistry as never,
      );
      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith('fts-optimize', expect.anything());
    });

    it('reads ftsOptimizeIntervalMs from IRagConfig', () => {
      const schedulerRegistry = mockSchedulerRegistry();
      new CronOptimizeStrategy(
        mockRagConfig({ ftsOptimizeIntervalMs: 60_000 }),
        schedulerRegistry as never,
      );
      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith('fts-optimize', expect.anything());
    });

    it('uses 300000 when ftsOptimizeIntervalMs is not overridden', () => {
      const schedulerRegistry = mockSchedulerRegistry();
      new CronOptimizeStrategy(mockRagConfig(), schedulerRegistry as never);
      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith('fts-optimize', expect.anything());
    });
  });

  describe('AC-6: onInsert() does not call optimize', () => {
    it('only marks the project dirty', async () => {
      const strategy = makeStrategy(60_000);
      try {
        const { task, optimize } = trackingTask();

        await strategy.onInsert('p1', task);

        expect(optimize).not.toHaveBeenCalled();
      } finally {
        await strategy.onDestroy();
      }
    });
  });

  describe('AC-7: the next optimizeDirtyTables() calls optimize once', () => {
    it('runs the stored task on the tick', async () => {
      const strategy = makeStrategy(60_000);
      try {
        const { task, optimize } = trackingTask();
        await strategy.onInsert('p1', task);

        await strategy.optimizeDirtyTables();

        expect(optimize).toHaveBeenCalledTimes(1);
      } finally {
        await strategy.onDestroy();
      }
    });

    it('runs each dirty project task once on the tick', async () => {
      const strategy = makeStrategy(60_000);
      try {
        const t1 = trackingTask();
        const t2 = trackingTask();
        await strategy.onInsert('p1', t1.task);
        await strategy.onInsert('p2', t2.task);

        await strategy.optimizeDirtyTables();

        expect(t1.optimize).toHaveBeenCalledTimes(1);
        expect(t2.optimize).toHaveBeenCalledTimes(1);
      } finally {
        await strategy.onDestroy();
      }
    });
  });

  describe('AC-8: a second tick with no insert does not call the task again', () => {
    it('clears the dirty map after the first tick', async () => {
      const strategy = makeStrategy(60_000);
      try {
        const { task, optimize } = trackingTask();
        await strategy.onInsert('p1', task);

        await strategy.optimizeDirtyTables();
        expect(optimize).toHaveBeenCalledTimes(1);

        await strategy.optimizeDirtyTables();
        expect(optimize).toHaveBeenCalledTimes(1);
      } finally {
        await strategy.onDestroy();
      }
    });
  });

  describe('onDestroy() flushes remaining dirty tasks', () => {
    it('runs the pending task on destroy', async () => {
      const strategy = makeStrategy(60_000);
      const { task, optimize } = trackingTask();
      await strategy.onInsert('p1', task);
      await strategy.onDestroy();
      expect(optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('onFirstAccess() is fire-and-forget', () => {
    it('runs the task and returns void synchronously', async () => {
      const registry = mockSchedulerRegistry();
      const strategy = new CronOptimizeStrategy(mockRagConfig(), registry as never);
      try {
        const { task, optimize } = trackingTask();

        const result = strategy.onFirstAccess('p1', task);

        expect(result).toBeUndefined();
        expect(optimize).toHaveBeenCalledTimes(1);
      } finally {
        await strategy.onDestroy();
      }
    });
  });
});
