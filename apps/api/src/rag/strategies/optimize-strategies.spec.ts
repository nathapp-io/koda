import type { IRagConfig } from '../../config/rag.config';
import { CounterOptimizeStrategy } from './counter-optimize.strategy';
import { ManualOptimizeStrategy } from './manual-optimize.strategy';
import { CronOptimizeStrategy } from './cron-optimize.strategy';
import { optimizeInBackground } from './optimize-in-background';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rejectingTable(): { optimize: jest.Mock } {
  return { optimize: jest.fn().mockRejectedValue(new Error('lance busy')) };
}

const ragConfig = { ftsOptimizeThreshold: 10, ftsOptimizeIntervalMs: 60_000 } as IRagConfig;

describe('background optimize() on first access', () => {
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

  it('optimizeInBackground logs a rejection instead of leaking it', async () => {
    const logger = { warn: jest.fn() };
    optimizeInBackground(rejectingTable(), 'proj-1', logger);
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('proj-1'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lance busy'));
    expect(unhandled).toEqual([]);
  });

  it('optimizeInBackground also catches a synchronous throw', async () => {
    const logger = { warn: jest.fn() };
    const table = {
      optimize: jest.fn(() => {
        throw new Error('sync boom');
      }),
    };
    expect(() => optimizeInBackground(table, 'proj-2', logger)).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sync boom'));
  });

  it.each([
    ['counter', () => new CounterOptimizeStrategy(ragConfig)],
    ['manual', () => new ManualOptimizeStrategy()],
  ])('%s strategy onFirstAccess does not leak a rejection', async (_name, make) => {
    const strategy = make();
    strategy.onFirstAccess('proj-3', rejectingTable());
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('cron strategy onFirstAccess does not leak a rejection', async () => {
    const registry = { addInterval: jest.fn(), deleteInterval: jest.fn() };
    const strategy = new CronOptimizeStrategy(ragConfig, registry);
    try {
      strategy.onFirstAccess('proj-4', rejectingTable());
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      await strategy.onDestroy();
    }
  });
});
