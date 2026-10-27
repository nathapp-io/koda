import { ApprovalCloser } from './approval-closer';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { approvalWebhookPayload } from './approval-payloads';
import type { FleetApprovalRecord, NewFleetApproval } from './domain/approval.domain';
import type { FleetApprovalAskRecord, NewFleetApprovalAsk } from './domain/fleet-approval-ask.domain';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', pausedAt: NOW, pausedWindowStart: NOW,
  createdById: 'u0', updatedById: 'u1', createdAt: NOW, updatedAt: NOW, ...over,
});

/** The legacy `FleetApproval` repository: the budget half and `expire` still use it until US-007/US-012. */
function legacyRepo() {
  const rows = new Map<string, FleetApprovalRecord>();
  let seq = 0;
  return {
    rows,
    create: vi.fn(async (d: NewFleetApproval) => {
      const row = { id: `a${++seq}`, status: 'pending', jobId: null, leaseEpoch: null, naxAskId: null, outcome: null, expiresAt: null,
        decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...d } as FleetApprovalRecord;
      rows.set(row.id, row);
      return row;
    }),
    findPendingForPolicy: vi.fn(async (id: string) => [...rows.values()].find((r) => r.policyId === id && r.status === 'pending') ?? null),
    lockById: vi.fn(async (id: string) => rows.get(id) ?? null),
    resolve: vi.fn(async (id: string, x: Partial<FleetApprovalRecord>) => {
      const row = { ...(rows.get(id) as FleetApprovalRecord), ...x };
      rows.set(id, row);
      return row;
    }),
  };
}

/**
 * US-006: the engine link table, as `FleetApprovalAskStore` publishes it. `insert` is the only write that creates a
 * row, so a test asserts on the link and on the view the closer reads back with the same store.
 */
function askStore() {
  const links = new Map<string, FleetApprovalAskRecord>();
  const views = new Map<string, FleetApprovalRecord>();
  return {
    links,
    views,
    insert: vi.fn(async (d: NewFleetApprovalAsk) => {
      const link: FleetApprovalAskRecord = {
        requestId: d.requestId, kind: d.kind, projectId: d.projectId, jobId: d.jobId ?? null, leaseEpoch: d.leaseEpoch ?? null,
        naxAskId: d.naxAskId ?? null, budgetPolicyId: d.budgetPolicyId ?? null, resolvedBy: null, outcome: null,
        createdAt: NOW, updatedAt: NOW,
      };
      links.set(link.requestId, link);
      views.set(link.requestId, {
        id: link.requestId, type: 'nax_bash_escalate', status: 'pending', projectId: link.projectId, jobId: link.jobId,
        leaseEpoch: link.leaseEpoch, naxAskId: link.naxAskId, policyId: link.budgetPolicyId, payload: {}, outcome: null,
        requestedAt: NOW, expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null,
        comment: null, createdAt: NOW, updatedAt: NOW,
      });
      return link;
    }),
    findByAsk: vi.fn(async (jobId: string, leaseEpoch: number, naxAskId: string) => {
      const ask = [...links.values()].find((l) => l.jobId === jobId && l.leaseEpoch === leaseEpoch && l.naxAskId === naxAskId);
      return ask === undefined ? null : { ask, status: (views.get(ask.requestId)?.status ?? 'pending') as 'pending' };
    }),
    findApproval: vi.fn(async (requestId: string) => views.get(requestId) ?? null),
    findPendingForJob: vi.fn(async (jobId: string) =>
      [...links.values()].filter((l) => l.jobId === jobId && views.get(l.requestId)?.status === 'pending')),
    setResolvedBy: vi.fn(async (requestId: string, resolvedBy: FleetApprovalAskRecord['resolvedBy']) => {
      const link = { ...(links.get(requestId) as FleetApprovalAskRecord), resolvedBy };
      links.set(requestId, link);
      const view = views.get(requestId);
      // The real view maps a cancelling link resolution to the fleet status `cancelled`.
      if (view) views.set(requestId, { ...view, resolvedBy, status: resolvedBy === 'manual_resume' ? 'approved' : 'cancelled' });
      return link;
    }),
    findProjectSlug: vi.fn(async () => 'web'),
  };
}

/** The engine's `ApprovalAskService`, as the closer uses it: it decides the ask and writes the request. */
function askService() {
  let seq = 0;
  const opened: Array<Record<string, unknown>> = [];
  const closed: Array<{ requestId: string; close: unknown }> = [];
  return {
    opened,
    closed,
    open: vi.fn(async (ask: Record<string, unknown>) => {
      opened.push(ask);
      return { status: 'pending' as const, request: { id: `req-${++seq}` } };
    }),
    close: vi.fn(async (requestId: string, close: unknown) => {
      closed.push({ requestId, close });
      return { id: requestId, status: 'cancelled' };
    }),
  };
}

function fakes() {
  const repo = legacyRepo();
  const store = askStore();
  const asks = askService();
  const activity = { record: vi.fn(async () => undefined) };
  const webhooks = { dispatch: vi.fn(async () => undefined) };
  const live = { event: vi.fn((a: FleetApprovalRecord) => (a.projectId ? [{ approvalId: a.id, status: a.status }] : [])) };
  const outbox = { record: vi.fn(async (e: { type: string; payload?: Record<string, unknown> }) => ({ id: 'ob1', ...e })) };
  mockAuditRecorder.record.mockReset();
  mockAuditRecorder.record.mockImplementation(async () => undefined);
  const closer = new ApprovalCloser(
    repo as never, store as never, asks as never, activity as never, webhooks as never, live as never, outbox as never, mockAuditRecorder,
  );
  return { closer, repo, store, asks, activity, webhooks, outbox };
}

describe('ApprovalCloser budget half (legacy store until US-007)', () => {
  it('opens a budget approval with the stop snapshot, activity, webhook and live event', async () => {
    const { closer, activity, webhooks } = fakes();
    const r = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10.5' }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({
      type: 'budget_override_required', status: 'pending', projectId: 'p1', policyId: 'pol', requestedAt: NOW,
      payload: { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: NOW.toISOString(), spentUsd: '10.5', amountUsd: '10' },
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', action: 'approval.requested', entityType: 'approval', entityId: r.approval?.id, projectId: 'p1', responsibleUserId: 'u1',
    }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.objectContaining({ approvalId: r.approval?.id, path: `/web/fleet/approvals?id=${r.approval?.id}` }));
    expect(r.live).toHaveLength(1);
  });

  it('enqueues a fleet_approval_requested outbox event for every fresh project budget ask (#208)', async () => {
    const { closer, outbox } = fakes();
    const r = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10.5' }, NOW);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fleet_approval_requested',
      payload: expect.objectContaining({ approvalId: r.approval?.id, projectId: 'p1', path: `/web/fleet/approvals?id=${r.approval?.id}` }),
      metadata: { projectId: 'p1', eventId: r.approval?.id },
    }));
  });

  it('supersedes a stray pending approval before opening a new one', async () => {
    const { closer, repo } = fakes();
    const first = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const second = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '11' }, NOW);
    expect(repo.rows.get(first.approval?.id as string)).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'superseded' }));
    expect(second.approval?.status).toBe('pending');
    // The stray's live frame is carried forward alongside the new one; the caller publishes both after commit.
    expect(second.live).toEqual([
      { approvalId: first.approval?.id, status: 'cancelled' },
      { approvalId: second.approval?.id, status: 'pending' },
    ]);
  });

  it('sends no webhook and no live event for a policy with no project', async () => {
    const { closer, webhooks, outbox } = fakes();
    const r = await closer.openBudget(policy({ scopeType: 'global', scopeId: null, projectId: null }), { windowStart: NOW, spentUsd: '1' }, NOW);
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(r.live).toEqual([]);
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('closes the pending approval of a policy, or does nothing when there is none', async () => {
    const { closer, activity, webhooks } = fakes();
    expect(await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'window_reset', actor: { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' } }, NOW))
      .toEqual({ approval: null, live: [] });
    await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const r = await closer.closeForPolicy('pol', {
      status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume',
      actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' }, outcome: { resumedAmountUsd: '20', requeueResults: [] },
    }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({ status: 'approved', resolvedBy: 'manual_resume', decidedById: 'u9', decidedAt: NOW, outcome: { resumedAmountUsd: '20', requeueResults: [] } }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u9', action: 'approval.decided' }));
    expect(webhooks.dispatch).toHaveBeenLastCalledWith('p1', 'fleet.approval.resolved', expect.objectContaining({ status: 'approved' }));
  });

  it('records a cancelled close as approval.cancelled with no decider', async () => {
    const { closer, activity } = fakes();
    await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const r = await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'policy_deleted', actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' } }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({ status: 'cancelled', decidedById: null, decision: null }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.cancelled' }));
  });
});

describe('bash half on the approval engine (US-006)', () => {
  let closer!: ReturnType<typeof fakes>['closer'];
  let store!: ReturnType<typeof fakes>['store'];
  let asks!: ReturnType<typeof fakes>['asks'];
  let activity!: ReturnType<typeof fakes>['activity'];
  let webhooks!: ReturnType<typeof fakes>['webhooks'];
  let outbox!: ReturnType<typeof fakes>['outbox'];
  beforeEach(() => { ({ closer, store, asks, activity, webhooks, outbox } = fakes()); });
  const job = { id: 'j1', projectId: 'p1', leaseEpoch: 2, state: 'RUNNING', bashMode: 'escalate', approvalTimeoutSec: 600, requestedById: 'u9', requestedByType: 'USER' } as const;
  const ask = (over: Partial<{ naxAskId: string; deadlineAt: Date }> = {}) => ({
    naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date(NOW.getTime() + 300_000), payload: { command: 'bun run test', options: ['allow', 'deny'] }, ...over,
  });

  it('opens the ask on the engine as fleet.job.shell.escalate for the job requester, then links and announces it', async () => {
    const { approval, live } = await closer.openBash(job, ask(), 'r1', NOW);
    expect(asks.open).toHaveBeenCalledWith({
      key: 'fleet.job.shell.escalate', projectId: 'p1', component: 'runner',
      onBehalfOf: { type: 'USER', id: 'u9' }, origin: 'runner',
      input: { jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c', payload: { command: 'bun run test', options: ['allow', 'deny'] } },
      deadline: new Date(NOW.getTime() + 300_000),
    }, NOW);
    expect(store.insert).toHaveBeenCalledWith({ requestId: approval?.id, kind: 'bash', projectId: 'p1', jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c' });
    expect(approval).toEqual(expect.objectContaining({ id: 'req-1', type: 'nax_bash_escalate', status: 'pending', jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c' }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'RUNNER', actorId: 'r1', responsibleUserId: 'u9', action: 'approval.requested' }));
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({ key: 'runner.sync', resourceType: 'fleet-approval', resourceId: approval?.id, projectId: 'p1', summary: 'bash ask opened, pending' });
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.anything());
    expect(live).toHaveLength(1);
  });

  it('enqueues a fleet_approval_requested outbox event for every fresh project bash ask (#208)', async () => {
    const { approval } = await closer.openBash(job, ask(), 'r1', NOW);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fleet_approval_requested',
      payload: expect.objectContaining({ approvalId: approval?.id, projectId: 'p1', jobId: 'j1', path: `/web/fleet/approvals?id=${approval?.id}` }),
      metadata: { projectId: 'p1', eventId: approval?.id },
    }));
  });

  it('AC-19 (S5b US-001): a fresh escalated ask still enqueues exactly approvalWebhookPayload, with no action extras', async () => {
    const { approval } = await closer.openBash(job, ask(), 'r1', NOW);
    const expected = approvalWebhookPayload(approval as FleetApprovalRecord, 'web');

    expect(outbox.record).toHaveBeenCalledWith({ type: 'fleet_approval_requested', payload: expected, metadata: { projectId: 'p1', eventId: approval?.id } });

    const payload = outbox.record.mock.calls.at(-1)?.[0].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(Object.keys(expected).sort());
    for (const extra of ['requestedById', 'threadPath', 'tool']) expect(payload).not.toHaveProperty(extra);
  });

  it('US-006 AC-2/AC-3: gives the engine the earlier of the ask deadline and now + approvalTimeoutSec', async () => {
    await closer.openBash({ ...job, approvalTimeoutSec: 60 }, ask(), 'r1', NOW);
    expect(asks.open.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ deadline: new Date(NOW.getTime() + 60_000) }));

    const soon = new Date(NOW.getTime() + 30_000);
    await closer.openBash({ ...job, approvalTimeoutSec: 600 }, ask({ naxAskId: 'ask-00000002', deadlineAt: soon }), 'r1', NOW);
    expect(asks.open.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ deadline: soon }));
  });

  it('a re-reported ask answers the stored view and writes nothing', async () => {
    const first = await closer.openBash(job, ask(), 'r1', NOW);
    const again = await closer.openBash(job, ask(), 'r1', NOW);
    expect(again).toEqual({ approval: first.approval, live: [] });
    expect(asks.open).toHaveBeenCalledTimes(1);
    expect(store.insert).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(mockAuditRecorder.record).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ state: 'UPLOADING' }, {}, 'job not running'],
    [{ bashMode: 'raw' }, {}, 'raw mode'],
    [{}, { deadlineAt: new Date(NOW.getTime() - 1) }, 'past deadline'],
  ] as const)('an ask nax cannot wait for (%p %p) opens nothing and is audited as %s', async (jobOver, askOver, reason) => {
    const { approval, live } = await closer.openBash({ ...job, ...jobOver }, ask(askOver), 'r1', NOW);
    expect(approval).toBeNull();
    expect(live).toEqual([]);
    expect(asks.open).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({
      key: 'runner.sync', resourceType: 'fleet-job', resourceId: 'j1', projectId: 'p1', summary: `bash ask not opened: ${reason}`,
    });
  });

  it('an ask the policy resolves to none is answered allow at once, with no request and no link', async () => {
    asks.open.mockResolvedValueOnce({ status: 'not-needed' });
    const r = await closer.openBash(job, ask(), 'r1', NOW);
    expect(r).toEqual({ approval: null, live: [], answer: { naxAskId: 'ask-1f2e3d4c', choice: 'allow' } });
    expect(store.insert).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({
      key: 'runner.sync', resourceType: 'fleet-job', resourceId: 'j1', projectId: 'p1', summary: 'bash ask answered allow: no approval needed',
    });
  });

  it('an ask nax truncated can only be denied when the policy resolves it to none', async () => {
    asks.open.mockResolvedValueOnce({ status: 'not-needed' });
    const truncated = ask();
    const r = await closer.openBash(job, { ...truncated, payload: { ...truncated.payload, commandTruncated: true } }, 'r1', NOW);
    expect(r.answer).toEqual({ naxAskId: 'ask-1f2e3d4c', choice: 'deny' });
    expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({ summary: 'bash ask answered deny: no approval needed' }));
  });

  it('closeForJob cancels every pending ask job_ended on the engine and reports each resolution', async () => {
    await closer.openBash(job, ask(), 'r1', NOW);
    await closer.openBash(job, ask({ naxAskId: 'ask-00000002' }), 'r1', NOW);
    webhooks.dispatch.mockClear();
    mockAuditRecorder.record.mockClear();

    const live = await closer.closeForJob(job, NOW);

    expect(asks.close.mock.calls).toEqual([
      ['req-1', { status: 'cancelled', reason: 'job_ended' }, NOW],
      ['req-2', { status: 'cancelled', reason: 'job_ended' }, NOW],
    ]);
    expect(store.setResolvedBy.mock.calls).toEqual([['req-1', 'job_ended'], ['req-2', 'job_ended']]);
    expect(live).toHaveLength(2);
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.cancelled', actorType: 'SYSTEM', responsibleUserId: 'u9' }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.resolved', expect.anything());
  });

  it('US-006 AC-14: a close the engine skipped (request held elsewhere) writes nothing for that ask', async () => {
    await closer.openBash(job, ask(), 'r1', NOW);
    asks.close.mockResolvedValueOnce(null);
    activity.record.mockClear();

    const live = await closer.closeForJob(job, NOW);

    expect(live).toEqual([]);
    expect(store.setResolvedBy).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('closeForJob answers [] when the job has no pending ask', async () => {
    expect(await closer.closeForJob(job, NOW)).toEqual([]);
    expect(asks.close).not.toHaveBeenCalled();
  });

  it('expire still settles the legacy row until US-012', async () => {
    const { closer, repo, activity: legacyActivity } = fakes();
    const legacy = await repo.create({ type: 'nax_bash_escalate', projectId: 'p1', policyId: null, payload: {}, requestedAt: NOW, jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c' });
    const { approval: expired } = await closer.expire(legacy, job, NOW);
    expect(expired).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout', decidedAt: NOW }));
    expect(legacyActivity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.expired', actorType: 'SYSTEM', responsibleUserId: 'u9' }));
  });
});
