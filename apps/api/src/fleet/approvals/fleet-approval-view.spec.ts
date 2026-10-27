import type { ApprovalDecisionRecord, ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';
import { CANCELLING_RESOLUTIONS, FLEET_ASK_KEY, FLEET_ASK_KEYS } from './domain/approval.domain';
import { fleetStatusWhere, toFleetApproval, type FleetAskRow } from './fleet-approval-view';

/**
 * Permissions P3 (US-002) — the pure fleet projection: one `ApprovalRequest`, its `FleetApprovalAsk`
 * link and its last decision become the `FleetApprovalRecord` view every fleet output already renders.
 */
const T0 = new Date('2026-10-04T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

const BASH_KEY = 'fleet.job.shell.escalate';
const BUDGET_KEY = 'fleet.budget.override';

const request = (over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  id: 'req-1', permissionKey: BASH_KEY, projectId: 'project-1',
  actor: { type: 'SYSTEM', id: 'runner' }, onBehalfOf: null, origin: 'runner', correlationId: 'corr-1',
  input: {}, inputHash: 'hash-1', requiredMode: 'agent', policyId: null, onTimeout: 'reject',
  approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending', satisfiedBy: null,
  approverType: null, approverId: null, expiresAt: at(3_600), decidedAt: null, settledAt: null, result: null,
  createdAt: T0, ...over,
});

const link = (over: Partial<FleetApprovalAskRecord> = {}): FleetApprovalAskRecord => ({
  requestId: 'req-1', kind: 'bash', projectId: 'project-1', jobId: 'job-1', leaseEpoch: 3, naxAskId: 'ask-1',
  budgetPolicyId: null, resolvedBy: null, outcome: null, createdAt: T0, updatedAt: at(60), ...over,
});

const decision = (over: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord => ({
  id: 'dec-1', requestId: 'req-1', deciderType: 'USER', deciderId: 'u1', decision: 'approve', comment: null,
  decidedAt: at(120), params: null, ...over,
});

const row = (parts: { request?: Partial<ApprovalRequestRecord>; link?: Partial<FleetApprovalAskRecord>; decision?: ApprovalDecisionRecord | null } = {}): FleetAskRow => ({
  request: request(parts.request),
  link: link(parts.link),
  decision: parts.decision === undefined ? null : parts.decision,
});

/** The bash ask input US-003 parses, frozen as the request stores it. */
const bashInput = (payload: Record<string, unknown> = { command: 'ls', options: ['allow', 'allow-remember'] }) =>
  ({ jobId: 'job-1', leaseEpoch: 3, naxAskId: 'ask-1', payload });

describe('toFleetApproval', () => {
  it('AC-1: a pending bash row answers the type, the pending status, the input payload and the link ids', () => {
    const payload = { command: 'rm -rf build', options: ['allow', 'allow-remember'] };
    const mapped = toFleetApproval(row({
      request: { input: { jobId: 'job-1', leaseEpoch: 3, naxAskId: 'ask-1', payload } },
      link: { jobId: 'job-9', leaseEpoch: 7, naxAskId: 'ask-9' },
    }));

    expect(mapped).toEqual(expect.objectContaining({
      type: 'nax_bash_escalate', status: 'pending', payload, jobId: 'job-9', leaseEpoch: 7, naxAskId: 'ask-9', decision: null,
    }));
    // The request is the row's identity; the rest of the view is carried across unchanged.
    expect(mapped).toEqual({
      id: 'req-1', type: 'nax_bash_escalate', status: 'pending', projectId: 'project-1',
      jobId: 'job-9', leaseEpoch: 7, naxAskId: 'ask-9', policyId: null, payload,
      outcome: null, requestedAt: T0, expiresAt: at(3_600), decision: null, decidedById: null,
      decidedAt: null, resolvedBy: null, comment: null, createdAt: T0, updatedAt: at(60),
    });
  });

  it('AC-2: an executed bash row whose last decision is an allow_for_job approve is approved by that decider', () => {
    const mapped = toFleetApproval(row({
      request: { status: 'executed', input: bashInput() },
      decision: decision({ params: { choice: 'allow_for_job' } }),
    }));

    expect(mapped).toEqual(expect.objectContaining({
      status: 'approved', decision: 'allow_for_job', decidedById: 'u1', resolvedBy: 'user',
    }));
    expect(mapped.decidedAt).toEqual(at(120));
  });

  it('AC-3: a rejected bash row with a null link resolvedBy is rejected by the user', () => {
    const mapped = toFleetApproval(row({
      request: { status: 'rejected', settledAt: at(200) },
      decision: decision({ decision: 'reject' }),
    }));

    expect(mapped).toEqual(expect.objectContaining({ status: 'rejected', decision: 'deny', resolvedBy: 'user' }));
    expect(mapped.decidedById).toBe('u1');
  });

  it('AC-4: an executed bash row a job end resolved is cancelled', () => {
    expect(toFleetApproval(row({
      request: { status: 'executed', input: bashInput() },
      link: { resolvedBy: 'job_ended' },
      decision: decision({ params: { choice: 'allow' } }),
    }))).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'job_ended' }));
  });

  it('AC-5: a cancelled budget row a manual resume resolved is approved for the user who resumed it', () => {
    const mapped = toFleetApproval(row({
      request: { permissionKey: BUDGET_KEY, status: 'cancelled', settledAt: at(300) },
      link: { kind: 'budget', jobId: null, leaseEpoch: null, naxAskId: null, budgetPolicyId: 'policy-1', resolvedBy: 'manual_resume', outcome: { resumedById: 'u1' } },
    }));

    expect(mapped).toEqual(expect.objectContaining({
      status: 'approved', decision: 'raise_budget_and_resume', decidedById: 'u1', resolvedBy: 'manual_resume', policyId: 'policy-1',
    }));
  });

  it('AC-6: a pending budget row answers its input without policyId and requestedAt, and the link policy', () => {
    const input = {
      policyId: 'policy-1', scopeType: 'project', scopeId: 'project-1', windowKind: 'day',
      windowStart: '2026-10-04T00:00:00.000Z', spentUsd: '10.5', amountUsd: '20', requestedAt: '2026-10-04T09:00:00.000Z',
    };
    const mapped = toFleetApproval(row({
      request: { permissionKey: BUDGET_KEY, input },
      link: { kind: 'budget', jobId: null, leaseEpoch: null, naxAskId: null, budgetPolicyId: 'policy-1' },
    }));

    expect(mapped.type).toBe('budget_override_required');
    expect(mapped.payload).toEqual({
      scopeType: 'project', scopeId: 'project-1', windowKind: 'day',
      windowStart: '2026-10-04T00:00:00.000Z', spentUsd: '10.5', amountUsd: '20',
    });
    expect(mapped.policyId).toBe('policy-1');
    expect(mapped.payload).not.toHaveProperty('policyId');
    expect(mapped.payload).not.toHaveProperty('requestedAt');
  });

  it('AC-7: a failed row is cancelled', () => {
    expect(toFleetApproval(row({
      request: { status: 'failed', settledAt: at(400) },
      decision: decision({ decision: 'reject' }),
    }))).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'user' }));
  });

  it('AC-8: an expired row with no decision answers the request settlement time and a timeout resolution', () => {
    const mapped = toFleetApproval(row({ request: { status: 'expired', settledAt: at(3_600) } }));

    expect(mapped).toEqual(expect.objectContaining({ status: 'expired', decidedAt: at(3_600), decidedById: null, decision: null }));
    expect(mapped.resolvedBy).toBe('timeout');
  });

  it('a bash approve without params is allow, so the generic decide route needs no choice name', () => {
    expect(toFleetApproval(row({ request: { status: 'executed', input: bashInput() }, decision: decision() })))
      .toEqual(expect.objectContaining({ status: 'approved', decision: 'allow' }));
    expect(toFleetApproval(row({ request: { status: 'executed', input: bashInput() }, decision: decision({ params: { choice: 'allow' } }) })))
      .toEqual(expect.objectContaining({ decision: 'allow' }));
  });

  it('a budget decision maps to its two choices and a bash reject to deny', () => {
    const budget = (d: Partial<ApprovalDecisionRecord>) => toFleetApproval(row({
      request: { permissionKey: BUDGET_KEY, input: {} },
      link: { kind: 'budget', jobId: null, leaseEpoch: null, naxAskId: null, budgetPolicyId: 'policy-1' },
      decision: decision(d),
    })).decision;
    expect(budget({ decision: 'approve' })).toBe('raise_budget_and_resume');
    expect(budget({ decision: 'reject' })).toBe('keep_paused');
    expect(toFleetApproval(row({ request: { status: 'rejected' }, decision: decision({ decision: 'reject', params: { choice: 'deny' } }) })).decision)
      .toBe('deny');
  });

  it('a superseded or window-reset link cancels an otherwise approved ask, and an unknown status cannot', () => {
    for (const resolvedBy of ['superseded', 'window_reset', 'policy_deleted'] as const) {
      expect(toFleetApproval(row({ request: { status: 'approved', input: bashInput() }, link: { resolvedBy } })).status).toBe('cancelled');
    }
    expect(toFleetApproval(row({ request: { status: 'cancelled' } })).status).toBe('cancelled');
  });

  it('the cancellation set holds the four link resolutions the fleet closes with, and not the two that decide', () => {
    expect([...CANCELLING_RESOLUTIONS].sort()).toEqual(['job_ended', 'policy_deleted', 'superseded', 'window_reset']);
    expect(CANCELLING_RESOLUTIONS).not.toContain('manual_resume');
    expect(CANCELLING_RESOLUTIONS).not.toContain('user');
  });

  it('the engine key of each fleet type is the catalog key the request stores', () => {
    expect(FLEET_ASK_KEY).toEqual({ nax_bash_escalate: 'fleet.job.shell.escalate', budget_override_required: 'fleet.budget.override' });
    expect([...FLEET_ASK_KEYS]).toEqual(['fleet.job.shell.escalate', 'fleet.budget.override']);
  });
});

describe('fleetStatusWhere', () => {
  const base = { permissionKey: { in: [...FLEET_ASK_KEYS] }, fleetAsk: { isNot: null } };

  it('every status carries the fleet keys and the link existence, so a link-less ask is never listed', () => {
    for (const status of ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const) {
      expect(fleetStatusWhere(status)).toEqual(expect.objectContaining(base));
    }
  });

  it('pending and expired are the request status alone', () => {
    expect(fleetStatusWhere('pending').AND).toEqual([{ status: 'pending' }]);
    expect(fleetStatusWhere('expired').AND).toEqual([{ status: 'expired' }]);
  });

  it('approved takes an approved or executed request the link has not cancelled, or a manual resume', () => {
    const and = fleetStatusWhere('approved').AND as unknown[];
    expect(and).toEqual([
      { OR: [
        { status: { in: ['approved', 'executed'] }, fleetAsk: { OR: [{ resolvedBy: null }, { resolvedBy: { notIn: [...CANCELLING_RESOLUTIONS] } }] } },
        { fleetAsk: { resolvedBy: 'manual_resume' } },
      ] },
    ]);
  });

  it('rejected is a rejected request the link has not cancelled', () => {
    expect(fleetStatusWhere('rejected')).toEqual(expect.objectContaining({
      AND: [{ status: 'rejected', fleetAsk: { OR: [{ resolvedBy: null }, { resolvedBy: { notIn: [...CANCELLING_RESOLUTIONS] } }] } }],
    }));
  });

  it('cancelled covers a cancelled request, a failed one and a decided one the link cancelled', () => {
    expect(fleetStatusWhere('cancelled').AND).toEqual([
      { OR: [
        { status: 'cancelled', fleetAsk: { OR: [{ resolvedBy: null }, { resolvedBy: { not: 'manual_resume' } }] } },
        { status: 'failed' },
        { status: { in: ['approved', 'executed', 'rejected'] }, fleetAsk: { resolvedBy: { in: [...CANCELLING_RESOLUTIONS] } } },
      ] },
    ]);
  });
});
