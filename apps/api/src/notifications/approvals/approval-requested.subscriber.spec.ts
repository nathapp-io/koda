import { Logger } from '@nestjs/common';
import type { FanOutPublisher, OutboxHandlerFn } from '../../outbox/fan-out-publisher';
import type { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import type { PermissionService } from '../../permissions/permission.service';
import type { NotificationEligibility } from '../notification-eligibility';
import type { NotificationWriter } from '../notification-writer';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';

const payload = {
  requestId: 'r1', projectId: 'p1', status: 'pending', permissionKey: 'label.delete', requiredMode: 'human',
  actorType: 'AGENT', actorId: 'a1', onBehalfOfType: null, onBehalfOfId: null, expiresAt: '2099-01-01T00:00:00.000Z',
};
const request: ApprovalRequestRecord = {
  id: 'r1', projectId: 'p1', permissionKey: 'label.delete', status: 'pending', requiredMode: 'human',
  actor: { type: 'AGENT', id: 'a1' }, onBehalfOf: null, approverMustHoldAction: true, requireDistinctApprover: true,
  origin: 'api', correlationId: 'c1', input: {}, inputHash: 'hash', policyId: null, onTimeout: 'reject',
  satisfiedBy: null, approverType: null, approverId: null, expiresAt: new Date('2099-01-01'),
  decidedAt: null, settledAt: null, result: null, createdAt: new Date('2026-01-01'),
};
const draft = {
  userId: 'u1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'approval_request',
  title: 'Approval needed: label.delete', body: null, link: '/approvals?id=r1', params: { key: 'label.delete' },
  sourceType: 'approval_request', sourceId: 'r1', actorId: null,
};

describe('approvalRequestDrafts', () => {
  it('AC-5: builds exactly the specified draft', async () => {
    const { approvalRequestDrafts } = await import('./approval-request-drafts');
    expect(approvalRequestDrafts(['u1'], { requestId: 'r1', projectId: 'p1', permissionKey: 'label.delete' })).toEqual([draft]);
  });
  it('truncates titles and preserves null scope for every recipient', async () => {
    const { approvalRequestDrafts } = await import('./approval-request-drafts');
    const drafts = approvalRequestDrafts(['u1', 'u2'], { requestId: 'r1', projectId: null, permissionKey: 'x'.repeat(300) });
    expect(drafts.map(d => d.userId)).toEqual(['u1', 'u2']);
    for (const d of drafts) {
      expect(d.title).toHaveLength(200);
      expect(d.title.endsWith('…')).toBe(true);
      expect(d.projectId).toBeNull();
    }
  });
});

describe('ApprovalRequestedSubscriber', () => {
  let handler: OutboxHandlerFn;
  let register: ReturnType<typeof vi.fn>;
  let findById: ReturnType<typeof vi.fn>;
  let principalIdsWithKey: ReturnType<typeof vi.fn>;
  let effectiveKeys: ReturnType<typeof vi.fn>;
  let findGlobalAdminIds: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    register = vi.fn((_type: string, fn: OutboxHandlerFn) => { handler = fn; });
    findById = vi.fn().mockResolvedValue({ ...request });
    principalIdsWithKey = vi.fn().mockResolvedValue(['u1', 'u2']);
    effectiveKeys = vi.fn().mockImplementation(async (p: { id: string }) => new Set(p.id === 'u1' ? ['approval.decide', 'label.delete'] : ['approval.decide']));
    findGlobalAdminIds = vi.fn().mockResolvedValue(['u1']);
    deliver = vi.fn().mockResolvedValue(undefined);
    const { ApprovalRequestedSubscriber } = await import('./approval-requested.subscriber');
    new ApprovalRequestedSubscriber(
      { register } as unknown as FanOutPublisher, { findById } as unknown as ApprovalRequestQueries,
      { principalIdsWithKey, effectiveKeys } as unknown as PermissionService,
      { findGlobalAdminIds } as unknown as NotificationEligibility, { deliver } as unknown as NotificationWriter,
    ).onModuleInit();
    vi.mocked(Logger.prototype.warn).mockClear();
  });
  it('AC-6: registers the fan-out handler', () => {
    expect(register).toHaveBeenCalledExactlyOnceWith('approval_request_changed', expect.any(Function));
  });
  it('AC-7: delivers only to eligible human deciders holding the action', async () => {
    await handler(payload);
    expect(findById).toHaveBeenCalledExactlyOnceWith('r1');
    expect(principalIdsWithKey).toHaveBeenCalledExactlyOnceWith('USER', 'p1', 'approval.decide');
    expect(effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
    expect(effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u2' }, { projectId: 'p1' });
    expect(deliver).toHaveBeenCalledExactlyOnceWith([draft]);
  });
  it('AC-8: ignores nonpending payloads before looking up the source', async () => {
    await handler({ ...payload, status: 'approved' });
    expect(findById).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('AC-9: ignores sources already cancelled', async () => {
    findById.mockResolvedValue({ ...request, status: 'cancelled' });
    await handler(payload);
    expect(deliver).not.toHaveBeenCalled();
    expect(principalIdsWithKey).not.toHaveBeenCalled();
  });
  it('AC-10: global requests enumerate global admins and use global keys', async () => {
    findById.mockResolvedValue({ ...request, projectId: null });
    await handler({ ...payload, projectId: null });
    expect(findGlobalAdminIds).toHaveBeenCalledExactlyOnceWith();
    expect(principalIdsWithKey).not.toHaveBeenCalled();
    expect(effectiveKeys).toHaveBeenCalledExactlyOnceWith({ type: 'USER', id: 'u1' }, 'global');
    expect(deliver).toHaveBeenCalledExactlyOnceWith([{ ...draft, projectId: null }]);
  });
  it('AC-11: no eligible candidates means no delivery', async () => {
    effectiveKeys.mockResolvedValue(new Set());
    await handler(payload);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('AC-12: malformed payload returns without lookups, delivery or throwing', async () => {
    await expect(Promise.resolve().then(() => handler({ foo: 1 }))).resolves.toBeUndefined();
    expect(findById).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('AC-14: malformed payload warns', async () => {
    await handler({ foo: 1 });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });
  it('missing sources stop quietly', async () => {
    findById.mockResolvedValue(null);
    await handler(payload);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('database failures escape for outbox retry', async () => {
    deliver.mockRejectedValue(new Error('database unavailable'));
    await expect(handler(payload)).rejects.toThrow('database unavailable');
  });
});
