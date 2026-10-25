import { BudgetsService } from './budgets.service';

describe('BudgetsService', () => {
  it('summarizes only supported update fields, never unknown request keys or server metadata', async () => {
    const policy = {
      id: 'policy-1', projectId: 'project-1', scopeType: 'project', scopeKey: 'project:project-1',
      windowKind: 'lifetime', amountUsd: '30', warnPercent: null, hardStop: false, runningJobs: 'finish',
      createdAt: new Date(), updatedAt: new Date(), pausedAt: null, pausedWindowStart: null,
    };
    const repo = {
      lockById: vi.fn().mockResolvedValue(policy), update: vi.fn().mockResolvedValue(policy),
      windowSpend: vi.fn().mockResolvedValue('0'),
    };
    const audit = { record: vi.fn() };
    const service = new BudgetsService(
      repo as never, { signal: vi.fn() } as never, { record: vi.fn() } as never,
      { run: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
      {} as never, {} as never, audit as never,
    );
    await service.update('actor-1', { kind: 'project', projectId: 'project-1' }, 'policy-1', {
      amountUsd: 30, hardStop: false, unownedClientField: 'secret', updatedById: 'spoofed',
    } as never);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      key: 'fleet.budget.update', summary: 'fields: amountUsd, hardStop',
    }));
    expect(repo.update).toHaveBeenCalledWith('policy-1', { amountUsd: '30', hardStop: false, updatedById: 'actor-1' });
  });

  it('AC-12: records route resume but not approval-driven resume', async () => {
    const policy = {
      id: 'policy-1', scopeType: 'project', scopeId: 'project-1', scopeKey: 'project:project-1', projectId: 'project-1',
      windowKind: 'lifetime', amountUsd: '10', warnPercent: null, hardStop: true, runningJobs: 'finish',
      pausedAt: new Date(), pausedWindowStart: new Date(0), createdById: 'actor-1', updatedById: 'actor-1', createdAt: new Date(), updatedAt: new Date(),
    };
    const repo = {
      lockById: vi.fn().mockResolvedValue(policy), windowSpend: vi.fn().mockResolvedValue('1'),
      update: vi.fn().mockResolvedValue({ ...policy, amountUsd: '20', pausedAt: null, pausedWindowStart: null }),
      insertIncident: vi.fn().mockResolvedValue(undefined),
    };
    const approvals = { closeForPolicy: vi.fn().mockResolvedValue({ approval: null, live: [] }) };
    const txManager = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    const audit = { record: vi.fn() };
    const service = new BudgetsService(
      repo as never, { signal: vi.fn() } as never, { record: vi.fn() } as never, txManager as never,
      approvals as never, { publish: vi.fn() } as never, audit as never,
    );
    await service.resume('actor-1', { kind: 'project', projectId: 'project-1' }, 'policy-1', 20, new Date(), { approvalId: 'a1' });
    expect(audit.record).not.toHaveBeenCalled();

    await service.resume('actor-1', { kind: 'project', projectId: 'project-1' }, 'policy-1', 20);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'fleet.budget.resume' }));
  });
});
