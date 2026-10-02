import { FLEET_ACTIVITY_SECRET_KEY } from '../activity/fleet-activity.service';
import { approvalActivityPayload, approvalPath, approvalWebhookPayload } from './approval-payloads';
import type { FleetApprovalRecord } from './domain/approval.domain';

const T = new Date('2026-10-02T10:00:00.000Z');
const approval = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: { spentUsd: '10', command: 'rm -rf /' }, outcome: null, requestedAt: T, expiresAt: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: T, updatedAt: T, ...over,
});

describe('approval payloads', () => {
  it('builds the inbox path', () => {
    expect(approvalPath('web', 'a1')).toBe('/web/fleet/approvals?id=a1');
  });

  it('webhook body carries ids and state, never the payload (A8)', () => {
    const body = approvalWebhookPayload(approval({ status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user' }), 'web');
    expect(body).toEqual({
      approvalId: 'a1', type: 'budget_override_required', status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user',
      projectId: 'p1', jobId: null, policyId: 'pol', expiresAt: null, path: '/web/fleet/approvals?id=a1',
    });
    expect(JSON.stringify(body)).not.toContain('rm -rf');
  });

  it('activity payload keys never trip the secret check', () => {
    const payload = approvalActivityPayload(approval(), { requeueJobIds: ['j1'] });
    expect(Object.keys(payload).some((k) => FLEET_ACTIVITY_SECRET_KEY.test(k))).toBe(false);
    expect(payload).toEqual({ type: 'budget_override_required', status: 'pending', decision: null, resolvedBy: null, policyId: 'pol', jobId: null, requeueJobIds: ['j1'] });
  });
});
