import { ApprovalCloser, MAX_ASKS_CLOSED_PER_CALL } from './approval-closer';
import { Logger } from '@nestjs/common';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { approvalWebhookPayload } from './approval-payloads';
import type { FleetApprovalRecord, NewFleetApproval } from './domain/approval.domain';
import type { FleetApprovalAskRecord, NewFleetApprovalAsk } from './domain/fleet-approval-ask.domain';
import { MAX_PENDING_ASKS_PER_JOB } from './domain/fleet-approval-ask.domain';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', pausedAt: NOW, pausedWindowStart: NOW,
  createdById: 'u0', updatedById: 'u1', createdAt: NOW, updatedAt: NOW, ...over,
});

/** The legacy `FleetApproval` repository: only `expire` still uses it, until US-012. */
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
 * US-006/US-007: the engine link table, as `FleetApprovalAskStore` publishes it. `insert` is the only write that
 * creates a row, so a test asserts on the link and on the view the closer reads back with the same store. The view
 * follows the two mapping rules the closer depends on: a cancelling link resolution reads `cancelled`, a
 * `manual_resume` one reads `approved` and reports the resumer the outcome records.
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
        id: link.requestId, type: d.kind === 'budget' ? 'budget_override_required' : 'nax_bash_escalate',
        status: 'pending', projectId: link.projectId, jobId: link.jobId, leaseEpoch: link.leaseEpoch, naxAskId: link.naxAskId,
        policyId: link.budgetPolicyId, payload: {}, outcome: null, requestedAt: NOW, expiresAt: null, decision: null,
        decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW,
      });
      return link;
    }),
    findByAsk: vi.fn(async (jobId: string, leaseEpoch: number, naxAskId: string) => {
      const ask = [...links.values()].find((l) => l.jobId === jobId && l.leaseEpoch === leaseEpoch && l.naxAskId === naxAskId);
      return ask === undefined ? null : { ask, status: (views.get(ask.requestId)?.status ?? 'pending') as 'pending' };
    }),
    findApproval: vi.fn(async (requestId: string) => views.get(requestId) ?? null),
    // The real reads are bounded: `findPendingForJob` is one page of the oldest requests, and the sweep pages
    // through with `findPendingForJobPage`, whose keyset is the (unique) request id.
    findPendingForJob: vi.fn(async (jobId: string) =>
      pendingOf(jobId).slice(0, MAX_PENDING_ASKS_PER_JOB).map((id) => links.get(id) as FleetApprovalAskRecord)),
    findPendingForJobPage: vi.fn(async (jobId: string, after?: string, limit = MAX_PENDING_ASKS_PER_JOB) =>
      pendingOf(jobId).filter((id) => after === undefined || id > after).slice(0, limit).map((id) => links.get(id) as FleetApprovalAskRecord)),
    setResolvedBy: vi.fn(async (requestId: string, resolvedBy: FleetApprovalAskRecord['resolvedBy']) => {
      const link = { ...(links.get(requestId) as FleetApprovalAskRecord), resolvedBy };
      links.set(requestId, link);
      const view = views.get(requestId);
      // The real view maps a cancelling link resolution to the fleet status `cancelled`, and a manual resume to
      // `approved` with the resumer's decision.
      if (view) {
        views.set(requestId, resolvedBy === 'manual_resume'
          ? { ...view, resolvedBy, status: 'approved', decision: 'raise_budget_and_resume' }
          : { ...view, resolvedBy, status: 'cancelled', decision: null });
      }
      return link;
    }),
    setOutcome: vi.fn(async (requestId: string, outcome: Record<string, unknown>) => {
      const link = { ...(links.get(requestId) as FleetApprovalAskRecord), outcome };
      links.set(requestId, link);
      const view = views.get(requestId);
      // `toFleetApproval` reports the resolved request's decider from the outcome's `resumedById`.
      const resumedById = outcome['resumedById'];
      if (view) views.set(requestId, { ...view, outcome, ...(typeof resumedById === 'string' ? { decidedById: resumedById } : {}) });
      return link;
    }),
    // US-007 (fix round 1): the policy close pages too, so a held ask is stepped over instead of ending the call.
    findPendingForPolicyPage: vi.fn(async (budgetPolicyId: string, after?: string, limit = MAX_PENDING_ASKS_PER_JOB) =>
      pendingOfPolicy(budgetPolicyId).filter((id) => after === undefined || id > after).slice(0, limit)
        .map((id) => links.get(id) as FleetApprovalAskRecord)),
    findProjectSlug: vi.fn(async () => 'web'),
  };

  /** Pending links of one policy, in the page order (`requestId` ascending). */
  function pendingOfPolicy(budgetPolicyId: string): string[] {
    return [...links.values()]
      .filter((l) => l.budgetPolicyId === budgetPolicyId && views.get(l.requestId)?.status === 'pending')
      .map((l) => l.requestId)
      .sort();
  }

  /** Pending links of one job, in the page order (`requestId` ascending). */
  function pendingOf(jobId: string): string[] {
    return [...links.values()]
      .filter((l) => l.jobId === jobId && views.get(l.requestId)?.status === 'pending')
      .map((l) => l.requestId)
      .sort();
  }
}

/** The engine's `ApprovalAskService`, as the closer uses it: it decides the ask and writes the request. */
function askService(store: ReturnType<typeof askStore>) {
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
    /** Null when the request is gone or no longer pending, which is what a held request answers. */
    close: vi.fn(async (requestId: string, close: unknown) => {
      closed.push({ requestId, close });
      const view = store.views.get(requestId);
      if (!view || view.status !== 'pending') return null;
      store.views.set(requestId, { ...view, status: 'cancelled' });
      return { id: requestId, status: 'cancelled' };
    }),
  };
}

function fakes() {
  const repo = legacyRepo();
  const store = askStore();
  const asks = askService(store);
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

describe('ApprovalCloser budget half on the approval engine (US-007)', () => {
  let closer!: ReturnType<typeof fakes>['closer'];
  let store!: ReturnType<typeof fakes>['store'];
  let asks!: ReturnType<typeof fakes>['asks'];
  let activity!: ReturnType<typeof fakes>['activity'];
  let webhooks!: ReturnType<typeof fakes>['webhooks'];
  let outbox!: ReturnType<typeof fakes>['outbox'];
  beforeEach(() => { ({ closer, store, asks, activity, webhooks, outbox } = fakes()); });
  const stop = { windowStart: NOW, spentUsd: '10.5' };
  const system = { type: 'SYSTEM' as const, id: 'system', responsibleUserId: 'u1' };
  const resumer = { type: 'USER' as const, id: 'u9', responsibleUserId: 'u9' };

  it('opens the ask on the engine as fleet.budget.override for the stop snapshot, then links it and announces the view', async () => {
    const r = await closer.openBudget(policy(), stop, NOW);

    expect(asks.open).toHaveBeenCalledWith({
      key: 'fleet.budget.override', projectId: 'p1', component: 'budget', onBehalfOf: null, origin: 'system',
      input: {
        policyId: 'pol', scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc',
        windowStart: NOW.toISOString(), spentUsd: '10.5', amountUsd: '10', requestedAt: NOW.toISOString(),
      },
      deadline: null,
    }, NOW);
    expect(store.insert).toHaveBeenCalledWith({ requestId: 'req-1', kind: 'budget', projectId: 'p1', budgetPolicyId: 'pol' });
    expect(r.approval).toEqual(expect.objectContaining({
      id: 'req-1', type: 'budget_override_required', status: 'pending', projectId: 'p1', policyId: 'pol', requestedAt: NOW,
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', action: 'approval.requested', entityType: 'approval', entityId: 'req-1', projectId: 'p1', responsibleUserId: 'u1',
    }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.objectContaining({ approvalId: 'req-1', path: '/web/fleet/approvals?id=req-1' }));
    expect(r.live).toEqual([{ approvalId: 'req-1', status: 'pending' }]);
  });

  it('enqueues a fleet_approval_requested outbox event for every fresh project budget ask (#208)', async () => {
    await closer.openBudget(policy(), stop, NOW);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fleet_approval_requested',
      payload: expect.objectContaining({ approvalId: 'req-1', projectId: 'p1', path: '/web/fleet/approvals?id=req-1' }),
      metadata: { projectId: 'p1', eventId: 'req-1' },
    }));
  });

  it('supersedes the stray pending ask on the engine before opening the new one and carries both live frames', async () => {
    const first = await closer.openBudget(policy(), stop, NOW);
    const second = await closer.openBudget(policy(), { ...stop, spentUsd: '11' }, NOW);

    expect(asks.close).toHaveBeenCalledWith('req-1', { status: 'cancelled', reason: 'superseded' }, NOW);
    expect(store.links.get('req-1')).toEqual(expect.objectContaining({ resolvedBy: 'superseded' }));
    expect(second.approval?.status).toBe('pending');
    // The stray's live frame is carried forward alongside the new one; the caller publishes both after commit.
    expect(second.live).toEqual([
      { approvalId: first.approval?.id, status: 'cancelled' },
      { approvalId: second.approval?.id, status: 'pending' },
    ]);
  });

  it('opens a global policy ask with no project, and sends no webhook, outbox row or live event', async () => {
    const r = await closer.openBudget(policy({ scopeType: 'global', scopeId: null, projectId: null }), stop, NOW);

    expect(asks.open.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ projectId: null }));
    expect(r.approval).toEqual(expect.objectContaining({ projectId: null }));
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
    expect(r.live).toEqual([]);
  });

  it('a hard stop whose ask the engine resolves to none throws rather than pausing with no ask', async () => {
    asks.open.mockResolvedValueOnce({ status: 'not-needed' });

    await expect(closer.openBudget(policy(), stop, NOW)).rejects.toThrow('budget override resolved to none');
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('closes the pending ask of a policy on the engine and stamps the link, or answers nothing when there is none', async () => {
    expect(await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'window_reset', actor: system }, NOW))
      .toEqual({ approval: null, live: [] });
    expect(asks.close).not.toHaveBeenCalled();

    await closer.openBudget(policy(), stop, NOW);
    const r = await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'policy_deleted', actor: resumer }, NOW);

    expect(asks.close).toHaveBeenLastCalledWith('req-1', { status: 'cancelled', reason: 'policy_deleted' }, NOW);
    expect(store.links.get('req-1')?.resolvedBy).toBe('policy_deleted');
    expect(r.approval).toEqual(expect.objectContaining({ status: 'cancelled', decidedById: null, decision: null }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u9', action: 'approval.cancelled' }));
    expect(webhooks.dispatch).toHaveBeenLastCalledWith('p1', 'fleet.approval.resolved', expect.objectContaining({ status: 'cancelled' }));
  });

  it('a manual resume closes the ask cancelled on the engine and reports approved through the link, with the resumer in the outcome', async () => {
    await closer.openBudget(policy(), stop, NOW);
    const r = await closer.closeForPolicy('pol', {
      status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume', actor: resumer,
      outcome: { resumedAmountUsd: '20', requeueResults: [] },
    }, NOW);

    // The engine status is always `cancelled`; the fleet reports `approved` through the link's resolution.
    expect(asks.close).toHaveBeenLastCalledWith('req-1', { status: 'cancelled', reason: 'manual_resume' }, NOW);
    expect(store.setOutcome).toHaveBeenCalledWith('req-1', { resumedAmountUsd: '20', requeueResults: [], resumedById: 'u9' });
    expect(r.approval).toEqual(expect.objectContaining({
      status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume', decidedById: 'u9',
      outcome: { resumedAmountUsd: '20', requeueResults: [], resumedById: 'u9' },
    }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u9', action: 'approval.decided' }));
    expect(webhooks.dispatch).toHaveBeenLastCalledWith('p1', 'fleet.approval.resolved', expect.objectContaining({ status: 'approved' }));
  });

  it('a close the engine skipped (request held elsewhere) answers nothing and writes nothing', async () => {
    await closer.openBudget(policy(), stop, NOW);
    asks.close.mockResolvedValueOnce(null);
    activity.record.mockClear();

    expect(await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'policy_deleted', actor: resumer }, NOW))
      .toEqual({ approval: null, live: [] });
    expect(store.setResolvedBy).not.toHaveBeenCalled();
    expect(store.setOutcome).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('US-007 F3: a held ask does not stop the newer pending ask of the same policy from closing', async () => {
    // Reachable in production: a close that skipped a held request leaves it pending, and a later hard stop
    // opens a newer ask next to it. The resume, delete or superseding execute must still settle the newer one.
    await store.insert({ requestId: 'req-1', kind: 'budget', projectId: 'p1', budgetPolicyId: 'pol' });
    await store.insert({ requestId: 'req-2', kind: 'budget', projectId: 'p1', budgetPolicyId: 'pol' });
    asks.close.mockImplementation(async (requestId: string) => (requestId === 'req-1' ? null : { id: requestId, status: 'cancelled' }));

    const r = await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'policy_deleted', actor: resumer }, NOW);

    expect(asks.close.mock.calls.map(([requestId]) => requestId)).toEqual(['req-1', 'req-2']);
    // The held ask keeps its state and its link untouched; the newer one is settled and reported.
    expect(store.links.get('req-1')?.resolvedBy).toBeNull();
    expect(store.links.get('req-2')?.resolvedBy).toBe('policy_deleted');
    expect(r.approval).toEqual(expect.objectContaining({ id: 'req-2', status: 'cancelled' }));
    expect(r.live).toEqual([{ approvalId: 'req-2', status: 'cancelled' }]);
  });

  it('US-007 F3: every pending ask of the policy is settled, not only the oldest', async () => {
    await store.insert({ requestId: 'req-1', kind: 'budget', projectId: 'p1', budgetPolicyId: 'pol' });
    await store.insert({ requestId: 'req-2', kind: 'budget', projectId: 'p1', budgetPolicyId: 'pol' });

    const r = await closer.closeForPolicy('pol', { status: 'approved', resolvedBy: 'manual_resume', actor: resumer, outcome: { resumedAmountUsd: '20', requeueResults: [] } }, NOW);

    expect(store.setResolvedBy.mock.calls).toEqual([['req-1', 'manual_resume'], ['req-2', 'manual_resume']]);
    expect(store.setOutcome).toHaveBeenCalledWith('req-1', { resumedAmountUsd: '20', requeueResults: [], resumedById: 'u9' });
    expect(store.setOutcome).toHaveBeenCalledWith('req-2', { resumedAmountUsd: '20', requeueResults: [], resumedById: 'u9' });
    expect(r.approval).toEqual(expect.objectContaining({ id: 'req-1' }));
    expect(r.live).toEqual([{ approvalId: 'req-1', status: 'approved' }, { approvalId: 'req-2', status: 'approved' }]);
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

  /** Opens `total` distinct pending asks on one job and clears the mocks the sweep assertions read. */
  async function openMany(total: number): Promise<void> {
    for (let i = 0; i < total; i += 1) {
      await closer.openBash(job, ask({ naxAskId: `ask-${(0x1000 + i).toString(16).padStart(8, '0')}` }), 'r1', NOW);
    }
    asks.close.mockClear();
    store.setResolvedBy.mockClear();
  }

  it('US-006 AC-13 (F1 round 3): one call closes at most MAX_ASKS_CLOSED_PER_CALL asks, and repeated calls drain the job', async () => {
    // More asks than one bounded close may settle: the job transition transaction must stay inside Prisma's
    // interactive-transaction timeout, so the sweep stops at the bound and the continuation takes the rest.
    const total = MAX_ASKS_CLOSED_PER_CALL + 50;
    await openMany(total);

    const first = await closer.closeForJob(job, NOW);
    expect(first).toHaveLength(MAX_ASKS_CLOSED_PER_CALL);
    expect(asks.close).toHaveBeenCalledTimes(MAX_ASKS_CLOSED_PER_CALL);
    expect(store.findPendingForJobPage).toHaveBeenCalledTimes(1);   // one page == the bound

    const rest = await closer.closeForJob(job, NOW);
    expect(rest).toHaveLength(50);
    expect(asks.close).toHaveBeenCalledTimes(total);

    expect(await closer.closeForJob(job, NOW)).toEqual([]);
  });

  it('US-006 AC-13 (F1 round 3): a call that stops at its bound logs the backlog it left', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    await openMany(MAX_ASKS_CLOSED_PER_CALL + 5);

    await closer.closeForJob(job, NOW);

    expect(warn.mock.calls.filter(([message]) => String(message).includes('drained by the job-end sweeper'))).toHaveLength(1);
  });

  it('US-006 AC-14 (F1): a held ask is skipped and the sweep still reaches every ask past it', async () => {
    const total = MAX_ASKS_CLOSED_PER_CALL + 20;
    await openMany(total);
    // The third request of the sweep is held by an in-flight decide: the engine answers null for it.
    let calls = 0;
    asks.close.mockImplementation(async (requestId: string) => {
      calls += 1;
      return calls === 3 ? null : { id: requestId, status: 'cancelled' };
    });

    const first = await closer.closeForJob(job, NOW);
    const rest = await closer.closeForJob(job, NOW);

    // The held ask is stepped over in the first call and closed by the continuation, not met twice in a row.
    expect(first).toHaveLength(MAX_ASKS_CLOSED_PER_CALL - 1);
    expect(rest).toHaveLength(21);
    expect(store.setResolvedBy).toHaveBeenCalledTimes(total);
  });

  it('US-006 AC-13 (F1 round 3): repeated bounded calls drain a job far beyond one page', async () => {
    // A job with far more asks than one call may settle: each call stays inside the transaction budget and the
    // continuation (the job-end sweeper) keeps calling until the job has none left.
    const calls = 5;
    const total = calls * MAX_ASKS_CLOSED_PER_CALL;
    await openMany(total);

    let closed = 0;
    for (let call = 0; call < calls; call += 1) closed += (await closer.closeForJob(job, NOW)).length;

    expect(closed).toBe(total);
    expect(asks.close).toHaveBeenCalledTimes(total);
    expect(await closer.closeForJob(job, NOW)).toEqual([]);
  });

  it('expire still settles the legacy row until US-012', async () => {
    const { closer, repo, activity: legacyActivity } = fakes();
    const legacy = await repo.create({ type: 'nax_bash_escalate', projectId: 'p1', policyId: null, payload: {}, requestedAt: NOW, jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c' });
    const { approval: expired } = await closer.expire(legacy, job, NOW);
    expect(expired).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout', decidedAt: NOW }));
    expect(legacyActivity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.expired', actorType: 'SYSTEM', responsibleUserId: 'u9' }));
  });
});
