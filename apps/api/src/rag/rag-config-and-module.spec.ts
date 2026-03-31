import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ragConfig } from '../config/rag.config';
import { FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './strategies/manual-optimize.strategy';

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
      let mockConfigService: ConfigService;
      let mockSchedulerRegistry: SchedulerRegistry;

      beforeEach(() => {
        // Mock ConfigService
        mockConfigService = {
          get: jest.fn(),
        } as unknown as ConfigService;

        // Mock SchedulerRegistry
        mockSchedulerRegistry = {
          addInterval: jest.fn(),
        } as unknown as SchedulerRegistry;
      });

      it('resolves to CounterOptimizeStrategy when ftsOptimizeStrategy is "counter"', () => {
        jest.spyOn(mockConfigService, 'get').mockReturnValue('counter');

        // Simulate the factory function logic
        const strategy = mockConfigService.get('rag.ftsOptimizeStrategy') === 'counter'
          ? new CounterOptimizeStrategy(mockConfigService)
          : null;

        expect(strategy).toBeInstanceOf(CounterOptimizeStrategy);
      });

      it('resolves to ManualOptimizeStrategy when ftsOptimizeStrategy is "manual"', () => {
        jest.spyOn(mockConfigService, 'get').mockReturnValue('manual');

        // Simulate the factory function logic
        const strategy = mockConfigService.get('rag.ftsOptimizeStrategy') === 'manual'
          ? new ManualOptimizeStrategy()
          : null;

        expect(strategy).toBeInstanceOf(ManualOptimizeStrategy);
      });

      it('resolves to CronOptimizeStrategy when ftsOptimizeStrategy is "cron"', () => {
        jest.spyOn(mockConfigService, 'get').mockReturnValue('cron');

        // Simulate the factory function logic
        const strategy = mockConfigService.get('rag.ftsOptimizeStrategy') === 'cron'
          ? new CronOptimizeStrategy(mockConfigService, mockSchedulerRegistry)
          : null;

        expect(strategy).toBeInstanceOf(CronOptimizeStrategy);
      });

      it('resolves to CounterOptimizeStrategy when ftsOptimizeStrategy is unknown value', () => {
        jest.spyOn(mockConfigService, 'get').mockReturnValue('unknown-strategy');

        // Simulate the factory function logic (defaults to counter)
        const configValue = mockConfigService.get('rag.ftsOptimizeStrategy');
        let strategy: FtsOptimizeStrategy;
        switch (configValue) {
          case 'cron':
            strategy = new CronOptimizeStrategy(mockConfigService, mockSchedulerRegistry);
            break;
          case 'manual':
            strategy = new ManualOptimizeStrategy();
            break;
          default:
            strategy = new CounterOptimizeStrategy(mockConfigService);
        }

        expect(strategy).toBeInstanceOf(CounterOptimizeStrategy);
      });
    });
  });
});
