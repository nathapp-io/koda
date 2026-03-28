import { ManualOptimizeStrategy } from './manual-optimize.strategy';

function mockTable() {
  return {
    optimize: jest.fn().mockResolvedValue(undefined),
  };
}

describe('ManualOptimizeStrategy', () => {
  let strategy: ManualOptimizeStrategy;

  beforeEach(() => {
    strategy = new ManualOptimizeStrategy();
  });

  describe('AC-14: onInsert() never calls table.optimize()', () => {
    it('does not call table.optimize() regardless of call count', async () => {
      const table = mockTable();
      for (let i = 0; i < 50; i++) await strategy.onInsert('p1', table);
      expect(table.optimize).not.toHaveBeenCalled();
    });
  });

  describe('AC-15: onFirstAccess() is fire-and-forget', () => {
    it('calls table.optimize() and returns void synchronously', () => {
      const table = mockTable();
      const result = strategy.onFirstAccess('p1', table);
      expect(result).toBeUndefined();
      expect(table.optimize).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-16: onDestroy() completes without error', () => {
    it('resolves successfully', async () => {
      await expect(strategy.onDestroy()).resolves.toBeUndefined();
    });
  });
});
