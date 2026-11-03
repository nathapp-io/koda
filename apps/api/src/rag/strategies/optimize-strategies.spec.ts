import type { Mock } from 'vitest';
import type { IRagConfig } from '../../config/rag.config';
import { CounterOptimizeStrategy } from './counter-optimize.strategy';
import { ManualOptimizeStrategy } from './manual-optimize.strategy';
import { CronOptimizeStrategy } from './cron-optimize.strategy';
import { optimizeInBackground } from './optimize-in-background';
import type { OptimizeTask } from './fts-optimize-strategy.interface';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rejectingTask(): { task: OptimizeTask; optimize: Mock } {
  const optimize = vi.fn(() => Promise.reject(new Error('lance busy')));
  return { optimize, task: () => optimize() };
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
    const logger = { warn: vi.fn() };
    const { task } = rejectingTask();
    optimizeInBackground(task, 'proj-1', logger);
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('proj-1'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lance busy'));
    expect(unhandled).toEqual([]);
  });

  it('optimizeInBackground also catches a synchronous throw', async () => {
    const logger = { warn: vi.fn() };
    const task: OptimizeTask = () => {
      throw new Error('sync boom');
    };
    expect(() => optimizeInBackground(task, 'proj-2', logger)).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sync boom'));
  });

  it.each([
    ['counter', () => new CounterOptimizeStrategy(ragConfig)],
    ['manual', () => new ManualOptimizeStrategy()],
  ])('%s strategy onFirstAccess does not leak a rejection', async (_name, make) => {
    const strategy = make();
    strategy.onFirstAccess('proj-3', () => Promise.reject(new Error('lance busy')));
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('cron strategy onFirstAccess does not leak a rejection', async () => {
    const registry = { addInterval: vi.fn(), deleteInterval: vi.fn() };
    const strategy = new CronOptimizeStrategy(ragConfig, registry);
    try {
      strategy.onFirstAccess('proj-4', () => Promise.reject(new Error('lance busy')));
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      await strategy.onDestroy();
    }
  });
});
