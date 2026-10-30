import { Logger } from '@nestjs/common';
import type { ApprovalRequestRecord } from '../../../approvals/domain/approval.domain';
import { ApprovalRequestQueries } from '../../../approvals/approval-request.queries';
import { FleetBudgetOverrideCommand } from './fleet-budget-override.command';
import { FleetShellEscalateCommand } from './fleet-shell-escalate.command';

const date = new Date('2026-11-10T09:00:00.000Z');
const input = { policyId: 'frozen-policy', scopeType: 'project', scopeId: 'p', windowKind: 'calendar_month_utc', windowStart: date.toISOString(), spentUsd: '10', amountUsd: '10', requestedAt: date.toISOString() };
const row: ApprovalRequestRecord = {
  id: 'request', permissionKey: 'fleet.budget.override', variant: 'test', projectId: 'p', actor: { type: 'AGENT', id: 'a' },
  onBehalfOf: null, origin: 'rest', correlationId: 'c', input, inputHash: 'hash', requiredMode: 'human', policyId: null,
  onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending', satisfiedBy: null,
  approverType: null, approverId: null, expiresAt: date, decidedAt: null, settledAt: null, result: null, createdAt: date,
};
function build() {
  const asks = { findApproval: vi.fn().mockResolvedValue({ jobId: 'J', policyId: 'view-policy', resolvedBy: null, outcome: null }), findRequeueCandidates: vi.fn().mockResolvedValue([]) };
  const budget = new FleetBudgetOverrideCommand({} as never, {} as never, {} as never, asks as never, {} as never, {} as never, {} as never, {} as never);
  const bash = new FleetShellEscalateCommand({} as never, asks as never, {} as never, {} as never);
  return { asks, budget, bash };
}
describe('command-owned ask details', () => {
  it('AC-1: bash projects only the link detail fields', async () => {
    const { asks, bash } = build();
    expect(await bash.details(row)).toEqual({ kind: 'bash', jobId: 'J', resolvedBy: null, outcome: null });
    expect(asks.findApproval).toHaveBeenCalledWith(row.id);
  });
  it('AC-2: pending budget maps candidates to ISO dates', async () => {
    const { asks, budget } = build();
    asks.findRequeueCandidates.mockResolvedValue([{ jobId: 'J', projectId: 'p', feature: 'f', queuedAt: date }]);
    expect(await budget.details(row)).toEqual({ kind: 'budget', policyId: 'view-policy', resolvedBy: null, outcome: null, requeueCandidates: [{ jobId: 'J', projectId: 'p', feature: 'f', queuedAt: date.toISOString() }], requeueCandidatesTruncated: false });
  });
  it('AC-3: frozen input controls the 201-row probe, not the view', async () => {
    const { asks, budget } = build();
    asks.findRequeueCandidates.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ jobId: `j${i}`, projectId: 'p', feature: 'f', queuedAt: date })));
    const detail = await budget.details(row);
    expect(asks.findRequeueCandidates).toHaveBeenCalledWith('frozen-policy', date, 201);
    expect(detail).toMatchObject({ policyId: 'view-policy', requeueCandidatesTruncated: true });
    expect(detail?.requeueCandidates).toHaveLength(200);
  });
  it('AC-4: settled budgets omit candidates and do not parse input', async () => {
    const { asks, budget } = build();
    asks.findApproval.mockResolvedValue({ policyId: 'view-policy', resolvedBy: 'window_reset', outcome: null });
    expect(await budget.details({ ...row, status: 'cancelled', input: null })).toEqual({ kind: 'budget', policyId: 'view-policy', resolvedBy: 'window_reset', outcome: null });
    expect(asks.findRequeueCandidates).not.toHaveBeenCalled();
  });
  it('AC-5/10: missing links return null for both commands', async () => {
    const { asks, bash, budget } = build();
    asks.findApproval.mockResolvedValue(null);
    expect(await bash.details(row)).toBeNull();
    expect(await budget.details(row)).toBeNull();
    expect(asks.findRequeueCandidates).not.toHaveBeenCalled();
  });
});
function queries() {
  const requests = { findById: vi.fn().mockResolvedValue(row), findDecisions: vi.fn().mockResolvedValue([]) };
  const permissions = { approvalDecideScopes: vi.fn().mockResolvedValue({ everywhere: true }) };
  const details = vi.fn().mockResolvedValue({ kind: 'test' });
  const registry = { get: vi.fn().mockReturnValue({ details }) };
  return { query: new ApprovalRequestQueries(requests as never, permissions as never, registry as never), requests, registry, details };
}
describe('detail enrichment visibility and isolation', () => {
  const principal = { type: 'USER', id: 'u' } as const;
  it('AC-8: get stays independent; getDetail resolves the exact variant after visibility', async () => {
    const { query, registry, details } = queries();
    expect(await query.get(principal, row.id)).toEqual({ request: row, decisions: [] });
    expect(registry.get).not.toHaveBeenCalled();
    expect(details).not.toHaveBeenCalled();
    expect(await query.getDetail(principal, row.id)).toMatchObject({ details: { kind: 'test' } });
    expect(registry.get).toHaveBeenCalledWith(row.permissionKey, row.variant);
    expect(details).toHaveBeenCalledWith(row);
  });
  it('AC-7/11: failing enrichment logs one warning with the request id', async () => {
    const { query, details } = queries();
    details.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    warn.mockClear();
    try {
      expect(await query.getDetail(principal, row.id)).toEqual({ request: row, decisions: [], details: null });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).toContain(row.id);
    } finally { warn.mockRestore(); }
  });
  it.each([undefined, {}])('AC-6: absent command or hook returns null (%j)', async (command) => {
    const { query, registry } = queries();
    registry.get.mockReturnValue(command);
    expect((await query.getDetail(principal, row.id)).details).toBeNull();
  });
  it('never enriches an invisible or missing request', async () => {
    const { query, requests, registry } = queries();
    requests.findById.mockResolvedValue(null);
    await expect(query.getDetail(principal, row.id)).rejects.toThrow();
    expect(registry.get).not.toHaveBeenCalled();
  });
});
