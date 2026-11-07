import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationWriter } from '../notification-writer';
import { FleetNotificationReader } from './fleet-notification.reader';
import { FleetFlowStoppedSubscriber } from './fleet-flow-stopped.subscriber';
import { FLEET_FLOW_STOPPED, type FleetFlowStoppedPayload } from './fleet-notification-events';
import { flowStoppedDraft, jobOutcomeDraft } from './fleet-notification-drafts';

const payload = (overrides: Partial<FleetFlowStoppedPayload> = {}): FleetFlowStoppedPayload => ({
  flowId: 'f1', projectId: 'p1', feature: 'search', stopReason: 'step_failed', detail: 'failure',
  approverId: 'u1', creatorType: 'USER', creatorId: 'u2', ...overrides,
});

describe('FleetFlowStoppedSubscriber', () => {
  const register = vi.fn();
  const deliver = vi.fn().mockResolvedValue(undefined);
  const projectSlug = vi.fn().mockResolvedValue('sandbox');
  let subscriber: FleetFlowStoppedSubscriber;
  let handler: (payload: unknown) => Promise<void>;

  beforeEach(() => {
    register.mockReset();
    deliver.mockReset().mockResolvedValue(undefined);
    projectSlug.mockReset().mockResolvedValue('sandbox');
    subscriber = new FleetFlowStoppedSubscriber({ register } as unknown as FanOutPublisher,
      { projectSlug } as unknown as FleetNotificationReader, { deliver } as unknown as NotificationWriter);
    subscriber.onModuleInit();
    handler = register.mock.calls[0][1];
  });

  it('registers an independently callable handler for fleet_flow_stopped', () => {
    expect(register).toHaveBeenCalledWith(FLEET_FLOW_STOPPED, expect.any(Function));
  });
  it('delivers to approver and distinct human creator', async () => {
    await handler(payload());
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].map((d) => d.userId)).toEqual(['u1', 'u2']);
  });
  it('deduplicates creator when creator is approver', async () => {
    await handler(payload({ creatorId: 'u1' }));
    expect(deliver.mock.calls[0][0].map((d) => d.userId)).toEqual(['u1']);
  });
  it('does not notify an agent creator', async () => {
    await handler(payload({ creatorType: 'AGENT' }));
    expect(deliver.mock.calls[0][0].map((d) => d.userId)).toEqual(['u1']);
  });
  it('does not deliver to an agent without an approver', async () => {
    await handler(payload({ creatorType: 'AGENT', approverId: null }));
    expect(deliver).not.toHaveBeenCalled();
  });
  it('builds the flow stopped notification draft', () => {
    expect(flowStoppedDraft(payload(), 'sandbox', 'u1')).toMatchObject({
      userId: 'u1', category: 'FLEET_NEEDS_YOU', kind: 'flow_stopped', title: 'Flow stopped: search',
      link: '/sandbox/flows/f1', sourceType: 'fleet_flow', sourceId: 'f1', body: 'failure',
      params: { flowId: 'f1', feature: 'search', stopReason: 'step_failed' },
    });
  });
  it('bounds detail body to 280 chars', () => {
    const body = flowStoppedDraft(payload({ detail: 'x'.repeat(400) }), 'sandbox', 'u1').body;
    expect(body).not.toBeNull();
    expect(body?.length).toBeLessThanOrEqual(280);
  });
  it('keeps fleet job drafts body-null', () => {
    const jobPayload = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', requestedById: 'u1', outcome: 'failed' as const,
      repo: 'owner/repo', feature: 'search', resultPrUrl: null };
    expect(jobOutcomeDraft(jobPayload, 'sandbox').body).toBeNull();
  });
  it('does not deliver when project is gone', async () => {
    projectSlug.mockResolvedValue(null);
    await handler(payload());
    expect(deliver).not.toHaveBeenCalled();
  });
  it('skips malformed events and warns', async () => {
    const warn = vi.spyOn(subscriber['logger'], 'warn');
    await handler({ bad: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed payload skipped'));
  });
});
