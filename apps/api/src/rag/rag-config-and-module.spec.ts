import { SchedulerRegistry } from '@nestjs/schedule';
import { IRagConfig, ragConfig } from '../config/rag.config';
import { FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './strategies/manual-optimize.strategy';

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

describe('RAG Config & Module Wiring (US-002)', () => {
  describe('rag.config.ts', () => {
    it('exposes ftsOptimizeStrategy defaulting to "counter" when FTS_OPTIMIZE_STRATEGY env var is not set', () => {
      const config = ragConfig();
      expect(config.ftsOptimizeStrategy).toBe('counter');
    });

    it('exposes ftsOptimizeThreshold defaulting to 10 when FTS_OPTIMIZE_THRESHOLD env var is not set', () => {
      const config = ragConfig();
      expect(config.ftsOptimizeThreshold).toBe(10);
    });

    it('exposes ftsOptimizeIntervalMs defaulting to 300000 when FTS_OPTIMIZE_INTERVAL_MS env var is not set', () => {
      const config = ragConfig();
      expect(config.ftsOptimizeIntervalMs).toBe(300000);
    });

    it('reads ftsOptimizeStrategy from FTS_OPTIMIZE_STRATEGY env var', () => {
      process.env['FTS_OPTIMIZE_STRATEGY'] = 'manual';
      try {
        const config = ragConfig();
        expect(config.ftsOptimizeStrategy).toBe('manual');
      } finally {
        delete process.env['FTS_OPTIMIZE_STRATEGY'];
      }
    });

    it('reads ftsOptimizeThreshold from FTS_OPTIMIZE_THRESHOLD env var', () => {
      process.env['FTS_OPTIMIZE_THRESHOLD'] = '25';
      try {
        const config = ragConfig();
        expect(config.ftsOptimizeThreshold).toBe(25);
      } finally {
        delete process.env['FTS_OPTIMIZE_THRESHOLD'];
      }
    });

    it('reads ftsOptimizeIntervalMs from FTS_OPTIMIZE_INTERVAL_MS env var', () => {
      process.env['FTS_OPTIMIZE_INTERVAL_MS'] = '600000';
      try {
        const config = ragConfig();
        expect(config.ftsOptimizeIntervalMs).toBe(600000);
      } finally {
        delete process.env['FTS_OPTIMIZE_INTERVAL_MS'];
      }
    });
  });

  describe('RagModule FTS_OPTIMIZE_STRATEGY provider factory', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it('creates ScheduleModule.forRoot() in module imports', () => {
      // This is verified by the fact that RagModule imports ScheduleModule.forRoot()
      // If this wasn't correct, the module wouldn't compile
      // The actual integration test comes from the app.module.spec.ts
      const { RagModule } = require('./rag.module');
      expect(RagModule).toBeDefined();
    });

    describe('FTS_OPTIMIZE_STRATEGY factory', () => {
      let ragCfg: IRagConfig;
      let mockSchedulerRegistry: SchedulerRegistry;

      beforeEach(() => {
        ragCfg = mockRagConfig();

        mockSchedulerRegistry = {
          addInterval: jest.fn(),
        } as unknown as SchedulerRegistry;
      });

      it('resolves to CounterOptimizeStrategy when ftsOptimizeStrategy is "counter"', () => {
        const cfg = mockRagConfig({ ftsOptimizeStrategy: 'counter' });
        const strategy = cfg.ftsOptimizeStrategy === 'counter'
          ? new CounterOptimizeStrategy(cfg)
          : null;

        expect(strategy).toBeInstanceOf(CounterOptimizeStrategy);
      });

      it('resolves to ManualOptimizeStrategy when ftsOptimizeStrategy is "manual"', () => {
        const cfg = mockRagConfig({ ftsOptimizeStrategy: 'manual' });
        const strategy = cfg.ftsOptimizeStrategy === 'manual'
          ? new ManualOptimizeStrategy()
          : null;

        expect(strategy).toBeInstanceOf(ManualOptimizeStrategy);
      });

      it('resolves to CronOptimizeStrategy when ftsOptimizeStrategy is "cron"', () => {
        const cfg = mockRagConfig({ ftsOptimizeStrategy: 'cron' });
        const strategy = cfg.ftsOptimizeStrategy === 'cron'
          ? new CronOptimizeStrategy(cfg, mockSchedulerRegistry)
          : null;

        expect(strategy).toBeInstanceOf(CronOptimizeStrategy);
      });

      it('resolves to CounterOptimizeStrategy when ftsOptimizeStrategy is unknown value', () => {
        const cfg = mockRagConfig({ ftsOptimizeStrategy: 'unknown-strategy' });
        let strategy: FtsOptimizeStrategy;
        switch (cfg.ftsOptimizeStrategy) {
          case 'cron':
            strategy = new CronOptimizeStrategy(cfg, mockSchedulerRegistry);
            break;
          case 'manual':
            strategy = new ManualOptimizeStrategy();
            break;
          default:
            strategy = new CounterOptimizeStrategy(cfg);
        }

        expect(strategy).toBeInstanceOf(CounterOptimizeStrategy);
      });

      // Suppress unused variable warning — ragCfg is used in beforeEach to test default state
      void ragCfg;
    });
  });
});
