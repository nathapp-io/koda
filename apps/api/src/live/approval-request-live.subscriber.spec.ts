import { Logger } from '@nestjs/common';
import { FanOutPublisher, type OutboxHandlerFn } from '../outbox/fan-out-publisher';
import { ProjectEventBus } from './project-event-bus';

const payload = {
  requestId: 'r1', projectId: 'p1', status: 'approved', permissionKey: 'label.delete',
  requiredMode: 'human', actorType: 'AGENT', actorId: 'a1', onBehalfOfType: null,
  onBehalfOfId: null, expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('ApprovalRequestLiveSubscriber', () => {
  let handler: OutboxHandlerFn;
  let register: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    register = vi.fn((_type: string, fn: OutboxHandlerFn) => { handler = fn; });
    publish = vi.fn();
    const { ApprovalRequestLiveSubscriber } = await import('./approval-request-live.subscriber');
    new ApprovalRequestLiveSubscriber({ register } as unknown as FanOutPublisher, { publish } as unknown as ProjectEventBus).onModuleInit();
    vi.mocked(Logger.prototype.warn).mockClear();
  });

  it('AC-1: registers the fan-out handler on init', () => {
    expect(register).toHaveBeenCalledExactlyOnceWith('approval_request_changed', expect.any(Function));
  });
  it('AC-2: publishes exactly the content-free event with stable id and ISO time', async () => {
    await handler(payload);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      type: 'approval_request', projectId: 'p1', requestId: 'r1', status: 'approved', id: 'r1:approved', at: expect.any(String),
    });
    const at = publish.mock.calls[0][0].at;
    expect(new Date(at).toISOString()).toBe(at);
  });
  it('AC-3: ignores null-project requests', async () => {
    await handler({ ...payload, projectId: null });
    expect(publish).not.toHaveBeenCalled();
  });
  it('AC-4: malformed payload does not publish or throw', async () => {
    await expect(Promise.resolve().then(() => handler({ foo: 1 }))).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });
  it('AC-13: malformed payload warns', async () => {
    await handler({ foo: 1 });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });
  it('logs bus failures without causing outbox retries', async () => {
    publish.mockImplementation(() => { throw new Error('bus unavailable'); });
    await expect(Promise.resolve().then(() => handler(payload))).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });
});
