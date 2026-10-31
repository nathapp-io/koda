import { FLEET_ACTIVITY_SECRET_KEY } from '../activity/fleet-activity.service';
import { approvalActivityPayload } from './approval-payloads';
import type { FleetApprovalRecord } from './domain/approval.domain';

const T = new Date('2026-10-02T10:00:00.000Z');
const approval = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: { spentUsd: '10', command: 'rm -rf /' }, outcome: null, requestedAt: T, expiresAt: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: T, updatedAt: T, ...over,
});

describe('approval payloads', () => {
  it('activity payload keys never trip the secret check', () => {
    const payload = approvalActivityPayload(approval(), { requeueJobIds: ['j1'] });
    expect(Object.keys(payload).some((k) => FLEET_ACTIVITY_SECRET_KEY.test(k))).toBe(false);
    expect(payload).toEqual({ type: 'budget_override_required', status: 'pending', decision: null, resolvedBy: null, policyId: 'pol', jobId: null, requeueJobIds: ['j1'] });
  });
});
