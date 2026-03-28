import type { ConfigService } from '@nestjs/config';
import { CounterOptimizeStrategy } from './counter-optimize.strategy';
import { FTS_OPTIMIZE_STRATEGY } from './fts-optimize-strategy.interface';

function mockConfigService(values: Record<string, unknown> = {}): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function mockTable() {
  return {
    optimize: jest.fn().mockResolvedValue(undefined),
  };
}

describe('FTS_OPTIMIZE_STRATEGY token (AC-1)', () => {
  it('is a non-empty string', () => {
    expect(typeof FTS_OPTIMIZE_STRATEGY).toBe('string');
    expect(FTS_OPTIMIZE_STRATEGY.length).toBeGreaterThan(0);
  });
});

describe('CounterOptimizeStrategy', () => {
  describe('AC-7: threshold config', () => {
    it('reads threshold from rag.ftsOptimizeThreshold', async () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 2 }),
      );
      const table = mockTable();
      await strategy.onInsert('p', table);
      await strategy.onInsert('p', table); // should trigger at 2
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });

    it('defaults to 10 when rag.ftsOptimizeThreshold is not set', async () => {
      const strategy = new CounterOptimizeStrategy(mockConfigService({}));
      const table = mockTable();
      for (let i = 0; i < 9; i++) await strategy.onInsert('p', table);
      expect(table.optimize).not.toHaveBeenCalled();
    });
  });

  describe('AC-2: onInsert() triggers optimize at threshold', () => {
    it('calls table.optimize() when insert count reaches threshold', async () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 3 }),
      );
      const table = mockTable();
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table); // 3rd → threshold
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-3: onInsert() does not trigger below threshold', () => {
    it('does NOT call table.optimize() when count is below threshold', async () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 3 }),
      );
      const table = mockTable();
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table); // 2 < 3
      expect(table.optimize).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: onInsert() resets counter after optimize', () => {
    it('resets counter to 0 after calling table.optimize()', async () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 3 }),
      );
      const table = mockTable();
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table); // triggers optimize, resets counter
      // next 2 inserts must NOT trigger another optimize
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table);
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-5: onInsert() handles table.optimize() rejection gracefully', () => {
    it('logs warning and does not throw when table.optimize() rejects', async () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 3 }),
      );
      const table = mockTable();
      table.optimize.mockRejectedValue(new Error('optimize boom'));
      await strategy.onInsert('p1', table);
      await strategy.onInsert('p1', table);
      await expect(strategy.onInsert('p1', table)).resolves.toBeUndefined();
    });
  });

  describe('AC-6: onFirstAccess() is fire-and-forget', () => {
    it('calls table.optimize() and returns void synchronously', () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 10 }),
      );
      const table = mockTable();
      const result = strategy.onFirstAccess('p1', table);
      expect(result).toBeUndefined();
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('counter isolation per projectId', () => {
    it('maintains separate counters per projectId', async () => {
      const strategy = new CounterOptimizeStrategy(
        mockConfigService({ 'rag.ftsOptimizeThreshold': 2 }),
      );
      const t1 = mockTable();
      const t2 = mockTable();
      await strategy.onInsert('p1', t1); // p1 count: 1
      await strategy.onInsert('p2', t2); // p2 count: 1
      await strategy.onInsert('p1', t1); // p1 count: 2 → optimize
      expect(t1.optimize).toHaveBeenCalledTimes(1);
      expect(t2.optimize).not.toHaveBeenCalled();
    });
  });
});
