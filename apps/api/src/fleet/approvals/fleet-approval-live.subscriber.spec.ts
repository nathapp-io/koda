import { APPROVAL_REQUEST_CHANGED } from '../../approvals/approval-request-events';
import type { LiveEvent } from '../../live/live-event';
import { FleetApprovalLiveSubscriber } from './fleet-approval-live.subscriber';

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: 'a1', status: 'executed', projectId: 'p1', permissionKey: 'fleet.budget.override', requiredMode: 'agent',
  actorType: 'SYSTEM', actorId: 'budget', onBehalfOfType: null, onBehalfOfId: null,
  expiresAt: new Date('2026-10-03T10:00:00.000Z').toISOString(), ...over,
});

/**
 * Permissions P3 US-007 fix round 3: the `fleet_approval` frame is derived from the durable event in its own consumer,
 * so a crash between the recorder's commit and any publication cannot lose it.
 */
function build() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const registry = { register: vi.fn((type: string, handler: (p: unknown) => void) => handlers.set(type, handler)) };
  const published: LiveEvent[] = [];
  const bus = { publish: vi.fn((event: LiveEvent) => { published.push(event); }) };
  const subscriber = new FleetApprovalLiveSubscriber(registry as never, bus as never);
  subscriber.onModuleInit();
  const handle = handlers.get(APPROVAL_REQUEST_CHANGED);
  if (handle === undefined) throw new Error('the subscriber did not register');
  return { handle, published };
}

describe('FleetApprovalLiveSubscriber (US-007 fix round 3)', () => {
  it.each([
    ['rejected', 'rejected'],
    ['executed', 'approved'],
    ['failed', 'cancelled'],
    ['expired', 'expired'],
  ] as const)('publishes the fleet frame of a settled %s ask as %s', (status, fleetStatus) => {
    const { handle, published } = build();

    handle(payload({ status }));

    expect(published).toEqual([expect.objectContaining({
      id: `a1:${status}:fleet`, type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: fleetStatus,
    })]);
  });

  it('skips the statuses the fleet writes itself, so a close is not announced twice', () => {
    for (const status of ['pending', 'approved', 'cancelled']) {
      const { handle, published } = build();
      handle(payload({ status }));
      expect(published).toEqual([]);
    }
  });

  it('skips a non-fleet key and a request with no project', () => {
    const other = build();
    other.handle(payload({ permissionKey: 'role.manage' }));
    expect(other.published).toEqual([]);

    const glob = build();
    glob.handle(payload({ projectId: null }));
    expect(glob.published).toEqual([]);
  });

  it('the frame id is the request and status, so a redelivered event repeats the same frame', () => {
    const { handle, published } = build();

    handle(payload({ status: 'executed' }));
    handle(payload({ status: 'executed' }));

    expect(published.map((e) => e.id)).toEqual(['a1:executed:fleet', 'a1:executed:fleet']);
  });

  it('a malformed payload is dropped, never a reason for the relay to retry', () => {
    const { handle, published } = build();
    expect(() => handle({ status: 'executed' })).not.toThrow();
    expect(published).toEqual([]);
  });
});
