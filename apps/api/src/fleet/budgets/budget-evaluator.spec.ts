import type { MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { BudgetEvaluator } from './budget-evaluator';

describe('BudgetEvaluator.signal (S1b §2.2, B7)', () => {
  let evaluator: BudgetEvaluator;
  let evaluateScope: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    evaluator = new BudgetEvaluator({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    evaluateScope = vi.spyOn(evaluator, 'evaluateScope').mockResolvedValue(undefined);
  });
  afterEach(() => {
    evaluator.onModuleDestroy();
    vi.useRealTimers();
  });

  it('coalesces signals per scope key inside the 1 s window', () => {
    evaluator.signal(['global', 'project:p']);
    evaluator.signal(['global', 'repo:r', 'repo:r']);
    vi.advanceTimersByTime(999);
    expect(evaluateScope).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(evaluateScope.mock.calls.map(([key]) => key).sort()).toEqual(['global', 'project:p', 'repo:r']);
    evaluator.signal(['global']);
    vi.advanceTimersByTime(1_000);
    expect(evaluateScope).toHaveBeenCalledTimes(4);
  });

  it('drops pending evaluations on shutdown', () => {
    evaluator.signal(['global']);
    evaluator.onModuleDestroy();
    vi.advanceTimersByTime(5_000);
    expect(evaluateScope).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed evaluation', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    evaluateScope.mockRejectedValueOnce(new Error('db down'));
    evaluator.signal(['global']);
    vi.advanceTimersByTime(1_000);
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection handler run
    expect(evaluateScope).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('db down'));
    logged.mockRestore();
  });
});
