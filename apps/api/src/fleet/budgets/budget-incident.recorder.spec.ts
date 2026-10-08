import { BudgetIncidentRecorder } from './budget-incident.recorder';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol1', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 50, hardStop: true, runningJobs: 'finish', pausedAt: null, pausedWindowStart: null,
  createdById: 'u1', updatedById: 'u1', createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('BudgetIncidentRecorder (S4a §2.4, D508)', () => {
  const labels = { forScope: jest.fn(async () => 'project KODA') };
  const outbox = { record: jest.fn(async () => undefined) };
  const recorder = new BudgetIncidentRecorder(labels as never, outbox as never);
  const start = new Date('2026-10-01T00:00:00.000Z');
  afterEach(() => jest.clearAllMocks());

  it('enqueues the incident keyed by its dedupe columns', async () => {
    await recorder.record(policy(), 'warn', start, '6.0000');
    expect(outbox.record).toHaveBeenCalledWith({
      type: 'fleet_budget_incident',
      payload: { incidentId: 'pol1:warn:2026-10-01T00:00:00.000Z:10', kind: 'warn', scope: 'project KODA', spentUsd: '6.0000', amountUsd: '10' },
      metadata: { projectId: 'p1', eventId: 'pol1:warn:2026-10-01T00:00:00.000Z:10' },
    });
  });

  it('a global policy enqueues without a project', async () => {
    labels.forScope.mockResolvedValueOnce('global');
    await recorder.record(policy({ scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null }), 'hard_stop', start, '12.0000');
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ kind: 'hard_stop', scope: 'global' }),
      metadata: { projectId: null, eventId: 'pol1:hard_stop:2026-10-01T00:00:00.000Z:10' },
    }));
  });
});
