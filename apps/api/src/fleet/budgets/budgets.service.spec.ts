import { BudgetsService } from './budgets.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

describe('BudgetsService', () => {
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
    const service = new BudgetsService(
      repo as never, { signal: vi.fn() } as never, { record: vi.fn() } as never, txManager as never,
      approvals as never, { publish: vi.fn() } as never, mockAuditRecorder,
    );
    mockAuditRecorder.record.mockClear();
    await service.resume('actor-1', { kind: 'project', projectId: 'project-1' }, 'policy-1', 20, new Date(), { approvalId: 'a1' });
    expect(mockAuditRecorder.record).not.toHaveBeenCalled();

    await service.resume('actor-1', { kind: 'project', projectId: 'project-1' }, 'policy-1', 20);
    expect(mockAuditRecorder.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'fleet.budget.resume' }));
  });
});
