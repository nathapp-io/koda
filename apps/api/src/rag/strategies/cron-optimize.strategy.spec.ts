import { IRagConfig } from '../../config/rag.config';
import { CronOptimizeStrategy } from './cron-optimize.strategy';

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

function mockTable() {
  return {
    optimize: jest.fn().mockResolvedValue(undefined),
  };
}

function mockSchedulerRegistry() {
  return { addInterval: jest.fn(), deleteInterval: jest.fn() };
}

function makeStrategy(intervalMs?: number) {
  return new CronOptimizeStrategy(
    mockRagConfig(intervalMs !== undefined ? { ftsOptimizeIntervalMs: intervalMs } : {}),
    mockSchedulerRegistry() as never,
  );
}

describe('CronOptimizeStrategy', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('AC-10: constructor registers interval with SchedulerRegistry', () => {
    it('calls schedulerRegistry.addInterval("fts-optimize", interval) during construction', () => {
      const schedulerRegistry = mockSchedulerRegistry();
      new CronOptimizeStrategy(
        mockRagConfig({ ftsOptimizeIntervalMs: 60_000 }),
        schedulerRegistry as never,
      );
      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith('fts-optimize', expect.anything());
    });
  });

  describe('AC-11: reads interval from config', () => {
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

  describe('AC-8: onInsert() adds table to dirtyTables map', () => {
    it('marks the table as dirty so optimizeDirtyTables() will process it', async () => {
      const strategy = makeStrategy(60_000);
      const table = mockTable();
      strategy.onInsert('p1', table);
      await strategy.optimizeDirtyTables();
      expect(table.optimize).toHaveBeenCalled();
    });
  });

  describe('AC-9: optimizeDirtyTables() processes and clears dirty tables', () => {
    it('calls optimize() for each dirty table', async () => {
      const strategy = makeStrategy(60_000);
      const t1 = mockTable();
      const t2 = mockTable();
      strategy.onInsert('p1', t1);
      strategy.onInsert('p2', t2);
      await strategy.optimizeDirtyTables();
      expect(t1.optimize).toHaveBeenCalledTimes(1);
      expect(t2.optimize).toHaveBeenCalledTimes(1);
    });

    it('clears the map so subsequent calls do not re-optimize', async () => {
      const strategy = makeStrategy(60_000);
      const table = mockTable();
      strategy.onInsert('p1', table);
      await strategy.optimizeDirtyTables();
      await strategy.optimizeDirtyTables(); // second call — map should be empty
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-12: onDestroy() flushes remaining dirty tables', () => {
    it('calls optimizeDirtyTables() to flush on destroy', async () => {
      const strategy = makeStrategy(60_000);
      const table = mockTable();
      strategy.onInsert('p1', table);
      await strategy.onDestroy();
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-13: onFirstAccess() is fire-and-forget', () => {
    it('calls table.optimize() and returns void synchronously', () => {
      const strategy = makeStrategy(60_000);
      const table = mockTable();
      const result = strategy.onFirstAccess('p1', table);
      expect(result).toBeUndefined();
      expect(table.optimize).toHaveBeenCalled();
    });
  });
});
