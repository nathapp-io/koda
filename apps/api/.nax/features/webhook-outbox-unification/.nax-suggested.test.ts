import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { WebhookDeliveryHandler } from '../../../src/webhook/webhook-delivery.handler';
import { PrismaWebhookRepository } from '../../../src/webhook/prisma-webhook.repository';
import { OutboxFanOutRegistry } from '../../../src/outbox/outbox-fan-out-registry';
import { WebhookDispatcherService } from '../../../src/webhook/webhook-dispatcher.service';
import { OutboxService } from '../../../src/outbox/outbox.service';

const makeActiveWebhook = (overrides: { secret?: string; id?: string } = {}) => ({
  id: overrides.id ?? 'wh-1',
  projectId: 'p1',
  url: 'https://hooks.example.com/recv',
  secret: overrides.secret ?? 'original-secret',
  events: JSON.stringify(['ticket.updated']),
  active: true,
  createdAt: new Date(),
});

// ---------------------------------------------------------------------------
// AC-1: fetch body equals JSON.stringify({webhookId,event,payload}) and Content-Type is application/json
// ---------------------------------------------------------------------------
describe('AC-1: WebhookDeliveryHandler fetch body shape and Content-Type', () => {
  let handler: WebhookDeliveryHandler;
  let mockRepo: { findById: jest.Mock };
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    mockRepo = { findById: jest.fn() };
    mockFetch = jest.fn().mockResolvedValue({ ok: true });
    (global as unknown as Record<string, unknown>).fetch = mockFetch;

    const module = await Test.createTestingModule({
      providers: [
        WebhookDeliveryHandler,
        { provide: PrismaWebhookRepository, useValue: mockRepo },
      ],
    }).compile();
    handler = module.get(WebhookDeliveryHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (global as unknown as Record<string, unknown>).fetch;
  });

  it('AC-1: body strictly equals JSON.stringify({webhookId,event,payload}) and Content-Type header is application/json', async () => {
    const webhookId = 'wh-1';
    const event = 'ticket.updated';
    const payload = { ticketId: 't1', status: 'done' };

    mockRepo.findById.mockResolvedValue(makeActiveWebhook());

    await handler.handle({ webhookId, event, payload });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { body: string; headers: Record<string, string> },
    ];

    expect(options.body).toBe(JSON.stringify({ webhookId, event, payload }));
    expect(options.headers['Content-Type']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// AC-2: secret is resolved from a fresh findById call at delivery time, not cached
// ---------------------------------------------------------------------------
describe('AC-2: WebhookDeliveryHandler resolves signingSecret at delivery time (no caching)', () => {
  let handler: WebhookDeliveryHandler;
  let mockRepo: { findById: jest.Mock };
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    mockRepo = { findById: jest.fn() };
    mockFetch = jest.fn().mockResolvedValue({ ok: true });
    (global as unknown as Record<string, unknown>).fetch = mockFetch;

    const module = await Test.createTestingModule({
      providers: [
        WebhookDeliveryHandler,
        { provide: PrismaWebhookRepository, useValue: mockRepo },
      ],
    }).compile();
    handler = module.get(WebhookDeliveryHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (global as unknown as Record<string, unknown>).fetch;
  });

  it('AC-2: second delivery uses new-secret from the fresh findById result, not a pre-cached old-secret', async () => {
    const webhookId = 'wh-1';
    const input = { webhookId, event: 'ticket.updated', payload: { a: 1 } };

    // First call returns old-secret; second call returns new-secret (simulating rotation)
    mockRepo.findById
      .mockResolvedValueOnce(makeActiveWebhook({ secret: 'old-secret' }))
      .mockResolvedValueOnce(makeActiveWebhook({ secret: 'new-secret' }));

    await handler.handle(input);
    await handler.handle(input);

    // findById must be called once per handle() invocation
    expect(mockRepo.findById).toHaveBeenCalledTimes(2);
    expect(mockRepo.findById).toHaveBeenNthCalledWith(1, webhookId);
    expect(mockRepo.findById).toHaveBeenNthCalledWith(2, webhookId);

    // The body sent to fetch is JSON.stringify of the full delivery payload envelope
    const body = JSON.stringify({ webhookId, event: 'ticket.updated', payload: { a: 1 } });
    const secondFetchOptions = mockFetch.mock.calls[1][1] as {
      headers: Record<string, string>;
    };
    const sigHeader = secondFetchOptions.headers['X-Koda-Signature'];

    const expectedSig = `sha256=${createHmac('sha256', 'new-secret').update(body).digest('hex')}`;
    const staleOldSig = `sha256=${createHmac('sha256', 'old-secret').update(body).digest('hex')}`;

    expect(sigHeader).toBe(expectedSig);
    expect(sigHeader).not.toBe(staleOldSig);
  });
});

// ---------------------------------------------------------------------------
// AC-3: OutboxFanOutRegistry failure count increments then self-resets on consume
// ---------------------------------------------------------------------------
describe('AC-3: OutboxFanOutRegistry dispatch failure counting for webhook_delivery', () => {
  it('AC-3: consumeLastDispatchFailureCount() returns 1 after webhook_delivery handler throws, then 0 on the subsequent call', async () => {
    const failingWebhookHandler = {
      handle: jest.fn().mockRejectedValue(new Error('simulated delivery failure')),
    };

    const module = await Test.createTestingModule({
      providers: [
        OutboxFanOutRegistry,
        { provide: WebhookDeliveryHandler, useValue: failingWebhookHandler },
      ],
    }).compile();
    const registry = module.get(OutboxFanOutRegistry);

    await registry.dispatch({
      eventType: 'webhook_delivery',
      payload: { webhookId: 'wh-1', event: 'delivered', payload: {} },
    });

    const firstCount = registry.consumeLastDispatchFailureCount();
    const secondCount = registry.consumeLastDispatchFailureCount();

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: WebhookDispatcherService never calls enqueue when no webhooks are active/matching
// ---------------------------------------------------------------------------
describe('AC-4: WebhookDispatcherService skips enqueue when active webhook list is empty', () => {
  it('AC-4: OutboxService.enqueue is never called and dispatch resolves undefined when findActiveByProjectAndEvent returns []', async () => {
    const mockWebhookRepo = {
      findActiveByProject: jest.fn().mockResolvedValue([]),
      findActiveByProjectAndEvent: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      createWebhook: jest.fn(),
      deleteWebhook: jest.fn(),
      findByProject: jest.fn(),
      findProjectBySlug: jest.fn(),
    };
    const mockOutboxService = {
      enqueue: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: PrismaWebhookRepository, useValue: mockWebhookRepo },
        { provide: OutboxService, useValue: mockOutboxService },
      ],
    }).compile();
    const service = module.get(WebhookDispatcherService);

    const result = await service.dispatch('p1', 'ticket.updated', { ticketId: 't1' });

    expect(mockOutboxService.enqueue).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});