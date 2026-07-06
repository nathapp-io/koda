import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { OutboxService, OutboxEventData } from '../outbox/outbox.service';
import { OutboxEventInput } from '../outbox/domain/outbox-event.domain';
import { WebhookDomain } from './domain/webhook.domain';

type Fetch = typeof fetch;

describe('WebhookDispatcherService', () => {
  const mockWebhookRepo = {
    findActiveByProject: jest.fn(),
  };

  const mockOutboxService = {
    enqueue: jest.fn(),
  } as unknown as OutboxService;

  let originalFetch: Fetch | undefined;
  let mockFetch: jest.Mock;

  const buildWebhook = (overrides: Partial<WebhookDomain> = {}): WebhookDomain => ({
    id: 'w1',
    projectId: 'project-123',
    url: 'https://example.com/webhook',
    secret: 'test-secret',
    events: JSON.stringify(['STATUS_CHANGE']),
    active: true,
    createdAt: new Date(),
    ...overrides,
  });

  const buildEnqueuedEvent = (): OutboxEventData => ({
    id: 'outbox-1',
    projectId: 'project-123',
    eventType: 'webhook_delivery',
    eventId: 'evt-1',
    payload: '{}',
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  let service: WebhookDispatcherService;

  beforeEach(() => {
    mockWebhookRepo.findActiveByProject.mockReset();
    (mockOutboxService.enqueue as jest.Mock).mockReset();
    (mockOutboxService.enqueue as jest.Mock).mockResolvedValue(buildEnqueuedEvent());

    originalFetch = global.fetch;
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as Fetch;

    service = new WebhookDispatcherService(
      mockWebhookRepo as unknown as ConstructorParameters<typeof WebhookDispatcherService>[0],
      mockOutboxService,
    );
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      delete (global as { fetch?: Fetch }).fetch;
    } else {
      global.fetch = originalFetch;
    }
  });

  describe('AC1: matches a single webhook and enqueues an outbox event with the correct shape', () => {
    it('calls OutboxService.enqueue exactly once with a webhook_delivery outbox event', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({ id: 'w1' });
      mockWebhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      const payload = { ticketId: 't-1', status: 'open' };
      await service.dispatch(projectId, 'STATUS_CHANGE', payload);

      expect(mockOutboxService.enqueue).toHaveBeenCalledTimes(1);
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith({
        projectId,
        eventType: 'webhook_delivery',
        eventId: expect.any(String),
        payload: {
          webhookId: 'w1',
          event: 'STATUS_CHANGE',
          payload,
        },
      });

      const enqueueArg = (mockOutboxService.enqueue as jest.Mock).mock.calls[0][0] as OutboxEventInput;
      expect(typeof enqueueArg.eventId).toBe('string');
      expect(enqueueArg.eventId.length).toBeGreaterThan(0);
    });
  });

  describe('AC2: matches multiple webhooks and enqueues them concurrently', () => {
    it('calls OutboxService.enqueue once per webhook and both calls are issued before either mocked enqueue promise resolves', async () => {
      const projectId = 'project-123';
      const webhook1 = buildWebhook({ id: 'w1' });
      const webhook2 = buildWebhook({ id: 'w2' });
      mockWebhookRepo.findActiveByProject.mockResolvedValue([webhook1, webhook2]);

      let resolveFirst!: (value: OutboxEventData) => void;
      const firstEnqueuePromise = new Promise<OutboxEventData>((resolve) => {
        resolveFirst = resolve;
      });
      (mockOutboxService.enqueue as jest.Mock)
        .mockReturnValueOnce(firstEnqueuePromise)
        .mockResolvedValueOnce(buildEnqueuedEvent());

      const dispatchPromise = service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockOutboxService.enqueue).toHaveBeenCalledTimes(2);

      const calledWithIds = (mockOutboxService.enqueue as jest.Mock).mock.calls.map(
        (call: unknown[]) => (call[0] as OutboxEventInput).payload,
      );
      expect(calledWithIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ webhookId: 'w1' }),
          expect.objectContaining({ webhookId: 'w2' }),
        ]),
      );

      resolveFirst(buildEnqueuedEvent());
      await dispatchPromise;
    });
  });

  describe('AC3: skips webhooks whose events array does not include the dispatched event', () => {
    it('does not call OutboxService.enqueue for a webhook that subscribed to a different event', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({
        id: 'w1',
        events: JSON.stringify(['TICKET_CREATED']),
      });
      mockWebhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(mockOutboxService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('AC4: dispatch never invokes the global fetch function', () => {
    it('does not call global.fetch under any dispatch path', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({ id: 'w1' });
      mockWebhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not call global.fetch even when a webhook matches that event', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({
        id: 'w1',
        url: 'https://attacker.example.com/steal',
      });
      mockWebhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('AC5: rejection propagation when OutboxService.enqueue rejects', () => {
    it('rejects the dispatch promise when enqueue rejects for a matching webhook', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({ id: 'w1' });
      mockWebhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      const boom = new Error('enqueue blew up');
      (mockOutboxService.enqueue as jest.Mock).mockRejectedValue(boom);

      await expect(
        service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' }),
      ).rejects.toBe(boom);
    });
  });
});
