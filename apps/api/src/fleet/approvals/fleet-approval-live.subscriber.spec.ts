import { APPROVAL_REQUEST_CHANGED } from '../../approvals/approval-request-events';
import type { LiveEvent } from '../../live/live-event';
import { FleetApprovalLiveSubscriber } from './fleet-approval-live.subscriber';

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: 'a1', status: 'executed', projectId: 'p1', permissionKey: 'fleet.budget.override', requiredMode: 'agent',
  actorType: 'SYSTEM', actorId: 'budget', onBehalfOfType: null, onBehalfOfId: null,
  expiresAt: '2026-10-03T10:00:00.000Z', ...over,
});

function build(status = 'approved') {
  const handlers = new Map<string, (payload: unknown) => void | Promise<void>>();
  const registry = { register: vi.fn((type: string, handler: (p: unknown) => void | Promise<void>) => handlers.set(type, handler)) };
  const published: LiveEvent[] = [];
  const bus = { publishRetryable: vi.fn((event: LiveEvent) => { published.push(event); }) };
  const link = { publishedStatus: null as string | null };
  const store = {
    lockByRequest: vi.fn(async () => link),
    findApproval: vi.fn(async () => ({ id: 'a1', projectId: 'p1', status })),
    setPublishedStatus: vi.fn(async (_id: string, value: string) => { link.publishedStatus = value; }),
  };
  const tx = { run: vi.fn(async (fn: () => Promise<void>) => fn()) };
  const subscriber = new FleetApprovalLiveSubscriber(registry as never, bus as never, store as never, tx as never);
  subscriber.onModuleInit();
  const handle = handlers.get(APPROVAL_REQUEST_CHANGED);
  if (handle === undefined) throw new Error('the subscriber did not register');
  return { handle, published, bus, store, link };
}

describe('FleetApprovalLiveSubscriber', () => {
  it.each([
    ['rejected', 'rejected'], ['executed', 'approved'], ['failed', 'cancelled'], ['expired', 'expired'],
  ])('publishes the fleet view of a settled %s ask as %s', async (status, fleetStatus) => {
    const { handle, published } = build(fleetStatus);
    await handle(payload({ status }));
    expect(published).toEqual([expect.objectContaining({
      id: `a1:${status}:fleet`, type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: fleetStatus,
    })]);
  });

  it('F6: an executed job_ended ask publishes cancelled, as the fleet view reports', async () => {
    const { handle, published } = build('cancelled');
    await handle(payload({ permissionKey: 'fleet.job.shell.escalate' }));
    expect(published).toMatchObject([{ status: 'cancelled' }]);
  });

  it('F6: skips a fleet-key request without a fleet link', async () => {
    const { handle, published, store } = build();
    store.lockByRequest.mockResolvedValueOnce(null as never);
    await handle(payload());
    expect(published).toEqual([]);
  });

  it('skips the fleet-owned statuses, non-fleet keys, projectless and malformed payloads', async () => {
    const { handle, published, store } = build();
    for (const p of [payload({ status: 'pending' }), payload({ status: 'approved' }), payload({ status: 'cancelled' }),
      payload({ permissionKey: 'role.manage' }), payload({ projectId: null }), { status: 'executed' }]) await handle(p);
    expect(published).toEqual([]);
    expect(store.lockByRequest).not.toHaveBeenCalled();
  });

  it('F5: a redelivery is suppressed by the durable publication marker', async () => {
    const { handle, published, store } = build();
    await handle(payload());
    await handle(payload());
    expect(published).toHaveLength(1);
    expect(store.setPublishedStatus).toHaveBeenCalledWith('a1', 'executed');
  });

  it('F5: a publication failure rejects for relay retry and does not mark the frame delivered', async () => {
    const { handle, published, bus, store } = build();
    bus.publishRetryable.mockImplementationOnce(() => { throw new Error('unavailable'); });
    await expect(handle(payload())).rejects.toThrow('unavailable');
    expect(store.setPublishedStatus).not.toHaveBeenCalled();
    await handle(payload());
    expect(published).toHaveLength(1);
  });

  it('F5: a view lookup failure also rejects for relay retry', async () => {
    const { handle, published, store } = build();
    store.findApproval.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(handle(payload())).rejects.toThrow('db unavailable');
    expect(published).toEqual([]);
  });
});
