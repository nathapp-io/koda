import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { WebhookDomain } from './domain/webhook.domain';

type Fetch = typeof fetch;

describe('WebhookDispatcherService', () => {
  const webhookRepo = {
    findActiveByProject: jest.fn(),
  };

  const outbox = {
    record: jest.fn(),
  };

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

  let service: WebhookDispatcherService;

  beforeEach(() => {
    webhookRepo.findActiveByProject.mockReset();
    outbox.record.mockReset();
    outbox.record.mockResolvedValue(undefined);

    originalFetch = global.fetch;
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as Fetch;

    service = new WebhookDispatcherService(
      webhookRepo as unknown as ConstructorParameters<typeof WebhookDispatcherService>[0],
      outbox as unknown as NathappOutboxService,
    );
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      delete (global as { fetch?: Fetch }).fetch;
    } else {
      global.fetch = originalFetch;
    }
  });

  describe('AC1: matches a single webhook and records an outbox row with the correct shape', () => {
    it('calls OutboxService.record exactly once with a webhook_delivery outbox event', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({ id: 'w1' });
      webhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      const payload = { ticketId: 't-1', status: 'open' };
      await service.dispatch(projectId, 'STATUS_CHANGE', payload);

      expect(outbox.record).toHaveBeenCalledTimes(1);
      expect(outbox.record).toHaveBeenCalledWith({
        type: 'webhook_delivery',
        payload: {
          webhookId: 'w1',
          event: 'STATUS_CHANGE',
          payload,
        },
        metadata: { projectId, eventId: expect.any(String) },
      });
    });
  });

  describe('AC2: matches multiple webhooks and records one row per webhook', () => {
    it('calls OutboxService.record once per webhook in project order', async () => {
      const projectId = 'project-123';
      const webhook1 = buildWebhook({ id: 'w1' });
      const webhook2 = buildWebhook({ id: 'w2' });
      webhookRepo.findActiveByProject.mockResolvedValue([webhook1, webhook2]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(outbox.record).toHaveBeenCalledTimes(2);

      const calledWithIds = outbox.record.mock.calls.map(
        (call: unknown[]) => (call[0] as { payload: { webhookId: string } }).payload,
      );
      expect(calledWithIds).toEqual([
        expect.objectContaining({ webhookId: 'w1' }),
        expect.objectContaining({ webhookId: 'w2' }),
      ]);
    });
  });

  describe('AC3: skips webhooks whose events array does not include the dispatched event', () => {
    it('does not call OutboxService.record for a webhook that subscribed to a different event', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({
        id: 'w1',
        events: JSON.stringify(['TICKET_CREATED']),
      });
      webhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(outbox.record).not.toHaveBeenCalled();
    });
  });

  describe('AC4: dispatch never invokes the global fetch function', () => {
    it('does not call global.fetch under any dispatch path', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({ id: 'w1' });
      webhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not call global.fetch even when a webhook matches that event', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({
        id: 'w1',
        url: 'https://attacker.example.com/steal',
      });
      webhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('dispatch with zero active webhooks', () => {
    it('resolves and does not call OutboxService.record when findActiveByProject returns an empty array', async () => {
      const projectId = 'project-123';
      webhookRepo.findActiveByProject.mockResolvedValue([]);

      await expect(
        service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' }),
      ).resolves.toBeUndefined();

      expect(outbox.record).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('AC5: rejection propagation when OutboxService.record rejects', () => {
    it('rejects the dispatch promise when record rejects for a matching webhook', async () => {
      const projectId = 'project-123';
      const webhook = buildWebhook({ id: 'w1' });
      webhookRepo.findActiveByProject.mockResolvedValue([webhook]);

      const boom = new Error('record blew up');
      outbox.record.mockRejectedValue(boom);

      await expect(
        service.dispatch(projectId, 'STATUS_CHANGE', { hello: 'world' }),
      ).rejects.toBe(boom);
    });
  });

  it('records one row per matching webhook, sequentially', async () => {
    const order: string[] = [];
    outbox.record.mockImplementation(async (input: { payload: { webhookId: string } }) => {
      order.push(`start:${input.payload.webhookId}`);
      await Promise.resolve();
      order.push(`end:${input.payload.webhookId}`);
    });
    webhookRepo.findActiveByProject.mockResolvedValue([
      { id: 'w1', events: '["STATUS_CHANGE"]' },
      { id: 'w2', events: '["STATUS_CHANGE"]' },
    ]);

    await service.dispatch('p1', 'STATUS_CHANGE', {});

    expect(order).toEqual(['start:w1', 'end:w1', 'start:w2', 'end:w2']);
  });

  it('skips a webhook whose events column is not valid JSON instead of throwing', async () => {
    webhookRepo.findActiveByProject.mockResolvedValue([
      { id: 'broken', events: 'not-json' },
      { id: 'ok', events: '["STATUS_CHANGE"]' },
    ]);

    await expect(service.dispatch('p1', 'STATUS_CHANGE', {})).resolves.toBeUndefined();

    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ webhookId: 'ok' }) }));
  });
});
