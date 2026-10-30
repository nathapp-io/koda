import { currentContext, type ActionContext } from '../../action-context/action-context';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
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
    const repo = { findAll: vi.fn(async () => [policy('a'), policy('b')]), scopeExists: vi.fn(async () => true) };
    const evaluator = { evaluate: vi.fn(async (id: string) => { if (id === 'a') throw new Error('boom'); return { warned: false, stopped: false }; }) };
    const sweeper = new BudgetSweeper(repo as never, evaluator as never, {} as never, {} as never, { sweepEnabled: false }, {} as never, mockAuditRecorder);
    expect(await sweeper.tick(NOW)).toEqual({ deleted: 0, reset: 0, evaluated: 1, failed: 1 });
    expect(evaluator.evaluate).toHaveBeenCalledWith('b', NOW);
  });

  it('starts no timer when the sweep is disabled', () => {
    const spy = vi.spyOn(global, 'setInterval');
    const sweeper = new BudgetSweeper({} as never, {} as never, {} as never, {} as never, { sweepEnabled: false }, {} as never, mockAuditRecorder);
    sweeper.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('AC-8: the interval callback lists the policies as SYSTEM/budget (permissions P2 US-004)', async () => {
    vi.useFakeTimers();
    const seen: Array<ActionContext | undefined> = [];
    const repo = {
      findAll: vi.fn(async () => {
        seen.push(currentContext());
        return [];
      }),
      scopeExists: vi.fn(async () => true),
    };
    const sweeper = new BudgetSweeper(
      repo as never, { evaluate: vi.fn() } as never, { record: vi.fn() } as never,
      { run: vi.fn((fn: () => unknown) => fn()) } as never, { sweepEnabled: true }, {} as never, mockAuditRecorder,
    );

    sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    sweeper.onModuleDestroy();
    vi.useRealTimers();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'budget' });
  });
});
