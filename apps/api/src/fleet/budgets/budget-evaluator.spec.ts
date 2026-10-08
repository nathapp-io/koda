import { Logger } from '@nestjs/common';
import { BudgetEvaluator } from './budget-evaluator';

describe('BudgetEvaluator.signal (S1b §2.2, B7)', () => {
  let evaluator: BudgetEvaluator;
  let evaluateScope: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    evaluator = new BudgetEvaluator({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    evaluateScope = jest.spyOn(evaluator, 'evaluateScope').mockResolvedValue(undefined);
  });
  afterEach(() => {
    evaluator.onModuleDestroy();
    jest.useRealTimers();
  });

  it('coalesces signals per scope key inside the 1 s window', () => {
    evaluator.signal(['global', 'project:p']);
    evaluator.signal(['global', 'repo:r', 'repo:r']);
    jest.advanceTimersByTime(999);
    expect(evaluateScope).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(evaluateScope.mock.calls.map(([key]) => key).sort()).toEqual(['global', 'project:p', 'repo:r']);
    evaluator.signal(['global']);
    jest.advanceTimersByTime(1_000);
    expect(evaluateScope).toHaveBeenCalledTimes(4);
  });

  it('drops pending evaluations on shutdown', () => {
    evaluator.signal(['global']);
    evaluator.onModuleDestroy();
    jest.advanceTimersByTime(5_000);
    expect(evaluateScope).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed evaluation', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    evaluateScope.mockRejectedValueOnce(new Error('db down'));
    evaluator.signal(['global']);
    jest.advanceTimersByTime(1_000);
    jest.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection handler run
    expect(evaluateScope).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('db down'));
    logged.mockRestore();
  });
});
