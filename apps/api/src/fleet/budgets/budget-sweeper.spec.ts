import { BudgetSweeper } from './budget-sweeper';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const NOW = new Date('2026-10-15T00:00:00.000Z');
const policy = (id: string): BudgetPolicyRecord => ({
  id, scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null, windowKind: 'lifetime', amountUsd: '1',
  warnPercent: null, hardStop: true, runningJobs: 'finish', pausedAt: null, pausedWindowStart: null,
  createdById: 'u', updatedById: 'u', createdAt: NOW, updatedAt: NOW,
});

describe('BudgetSweeper', () => {
  it('keeps sweeping after one policy fails', async () => {
    const repo = { findAll: jest.fn(async () => [policy('a'), policy('b')]), scopeExists: jest.fn(async () => true) };
    const evaluator = { evaluate: jest.fn(async (id: string) => { if (id === 'a') throw new Error('boom'); return { warned: false, stopped: false }; }) };
    const sweeper = new BudgetSweeper(repo as never, evaluator as never, {} as never, {} as never, { sweepEnabled: false }, {} as never, {} as never);
    expect(await sweeper.tick(NOW)).toEqual({ deleted: 0, reset: 0, evaluated: 1, failed: 1 });
    expect(evaluator.evaluate).toHaveBeenCalledWith('b', NOW);
  });

  it('starts no timer when the sweep is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const sweeper = new BudgetSweeper({} as never, {} as never, {} as never, {} as never, { sweepEnabled: false }, {} as never, {} as never);
    sweeper.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
