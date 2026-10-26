import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalRequestEvents, APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from './approval-request-events';
import { GLOBAL_OUTBOX_TYPES } from '../outbox/global-outbox-types';

const request: ApprovalRequestRecord = {
  id: 'request-1', permissionKey: 'label.delete', projectId: 'p1', actor: { type: 'AGENT', id: 'agent-1' },
  onBehalfOf: { type: 'USER', id: 'user-1' }, origin: 'rest', correlationId: 'correlation', input: { private: 'never emit' },
  inputHash: 'hash', requiredMode: 'human', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
  requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
  expiresAt: new Date('2026-11-05T10:00:00.000Z'), decidedAt: null, settledAt: null, result: { private: true },
  createdAt: new Date('2026-11-05T09:00:00.000Z'),
};
const expectedPayload = {
  requestId: 'request-1', status: 'pending', projectId: 'p1', permissionKey: 'label.delete', requiredMode: 'human',
  actorType: 'AGENT', actorId: 'agent-1', onBehalfOfType: 'USER', onBehalfOfId: 'user-1', expiresAt: '2026-11-05T10:00:00.000Z',
};

describe('ApprovalRequestEvents', () => {
  it('AC-1/2/4: records one content-free event with the expected type, payload and metadata', async () => {
    const outbox = { record: vi.fn().mockResolvedValue(undefined) };
    await new ApprovalRequestEvents(outbox as never).record(request);
    expect(outbox.record).toHaveBeenCalledExactlyOnceWith({
      type: 'approval_request_changed', payload: expectedPayload,
      metadata: { eventId: 'request-1:pending', projectId: 'p1' },
    });
    expect(outbox.record.mock.calls[0]?.[0].payload).not.toHaveProperty('input');
    expect(outbox.record.mock.calls[0]?.[0].payload).not.toHaveProperty('result');
  });
  it('AC-3: omits projectId metadata for a global request', async () => {
    const outbox = { record: vi.fn().mockResolvedValue(undefined) };
    await new ApprovalRequestEvents(outbox as never).record({ ...request, projectId: null, status: 'expired' });
    expect(outbox.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      metadata: { eventId: 'request-1:expired' },
    }));
    expect(outbox.record.mock.calls[0]?.[0].metadata).not.toHaveProperty('projectId');
  });
  it("AC-5: allowlists the approval request event as global", () => {
    expect(GLOBAL_OUTBOX_TYPES.has(APPROVAL_REQUEST_CHANGED)).toBe(true);
  });
  it('AC-6/7: parses a valid event and rejects a missing request id', async () => {
    expect(parseApprovalRequestChangedPayload(expectedPayload)).toEqual(expectedPayload);
    expect(parseApprovalRequestChangedPayload({ ...expectedPayload, requestId: undefined })).toBeNull();
  });
});
