import { createHmac } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDeliveryHandler } from '../../../src/webhook/webhook-delivery.handler';
import { PrismaWebhookRepository } from '../../../src/webhook/prisma-webhook.repository';
import { WebhookModule } from '../../../src/webhook/webhook.module';
import { OutboxFanOutRegistry } from '../../../src/outbox/outbox-fan-out-registry';
import { WebhookDispatcherService } from '../../../src/webhook/webhook-dispatcher.service';
import { OutboxService } from '../../../src/outbox/outbox.service';
import { GlobalStubsModule } from '../../../src/common/test-helpers/global-stubs.module';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const activeWebhook = {
  id: 'w1',
  projectId: 'p1',
  url: 'https://example.com/hook',
  secret: 's3cret',
  events: JSON.stringify(['STATUS_CHANGE']),
  active: true,
  createdAt: new Date(),
};

const stubEnqueuedEvent = {
  id: 'evt-id',
  projectId: 'p1',
  eventType: 'webhook_delivery',
  eventId: 'stub-uuid',
  payload: '{}',
  status: 'pending',
  attempts: 0,
  lastError: null,
  nextAttemptAt: null,
  processedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ---------------------------------------------------------------------------
// AC-1 to AC-9: WebhookDeliveryHandler
// ---------------------------------------------------------------------------
describe('WebhookDeliveryHandler', () => {
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

  it('AC-1: calls fetch exactly once with the webhook url as first argument', async () => {
    mockRepo.findById.mockResolvedValue(activeWebhook);

    await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/hook');
  });

  it('AC-2: fetch called with method POST and matching X-Koda-Event header', async () => {
    mockRepo.findById.mockResolvedValue(activeWebhook);

    await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(options.method).toBe('POST');
    expect(options.headers['X-Koda-Event']).toBe('STATUS_CHANGE');
  });

  it('AC-3: X-Koda-Signature is sha256=<64-hex> equalling HMAC-SHA256 of JSON.stringify(payload)', async () => {
    const payload = { a: 1 };
    mockRepo.findById.mockResolvedValue(activeWebhook);

    await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const sig = options.headers['X-Koda-Signature'];
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    const expectedHex = createHmac('sha256', activeWebhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    expect(sig).toBe(`sha256=${expectedHex}`);
  });

  it('AC-4: fetch called with signal that is an AbortSignal instance', async () => {
    mockRepo.findById.mockResolvedValue(activeWebhook);

    await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.signal instanceof AbortSignal).toBe(true);
  });

  it('AC-5: handle() fulfills when fetch resolves with ok:true', async () => {
    mockRepo.findById.mockResolvedValue(activeWebhook);
    mockFetch.mockResolvedValue({ ok: true });

    let error: unknown = null;
    try {
      await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });
    } catch (e) {
      error = e;
    }

    expect(error).toBeNull();
  });

  it('AC-6: handle() rejects with an Error whose message includes "503" when fetch returns ok:false status:503', async () => {
    mockRepo.findById.mockResolvedValue(activeWebhook);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    let caught: Error | undefined;
    try {
      await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toContain('503');
  });

  it('AC-7: handle() propagates a network rejection as the exact same error reference', async () => {
    mockRepo.findById.mockResolvedValue(activeWebhook);
    const networkError = new Error('network down');
    mockFetch.mockRejectedValue(networkError);

    let caught: unknown;
    try {
      await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(networkError);
    expect((caught as Error).message).toBe('network down');
  });

  it('AC-8: handle() fulfills and fetch is never called when webhook is not found', async () => {
    mockRepo.findById.mockResolvedValue(null);

    let error: unknown = null;
    try {
      await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });
    } catch (e) {
      error = e;
    }

    expect(error).toBeNull();
    expect(mockFetch.mock.calls.length).toBe(0);
  });

  it('AC-9: handle() fulfills and fetch is never called when webhook active=false', async () => {
    mockRepo.findById.mockResolvedValue({ ...activeWebhook, active: false });

    let error: unknown = null;
    try {
      await handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });
    } catch (e) {
      error = e;
    }

    expect(error).toBeNull();
    expect(mockFetch.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-10, AC-11: WebhookModule DI compilation
// ---------------------------------------------------------------------------
describe('WebhookModule DI compilation', () => {
  const mockRepo = {
    findById: jest.fn(),
    findActiveByProject: jest.fn(),
    findByProject: jest.fn(),
    createWebhook: jest.fn(),
    deleteWebhook: jest.fn(),
    findProjectBySlug: jest.fn(),
  };

  it('AC-10: TestModule with WebhookModule + mocked repo compiles; get(WebhookDeliveryHandler) returns an instance', async () => {
    const module = await Test.createTestingModule({
      imports: [GlobalStubsModule, WebhookModule],
    })
      .overrideProvider(PrismaWebhookRepository)
      .useValue(mockRepo)
      .compile();

    const deliveryHandler = module.get(WebhookDeliveryHandler);

    expect(deliveryHandler).not.toBeNull();
    expect(deliveryHandler).not.toBeUndefined();
    expect(deliveryHandler).toBeInstanceOf(WebhookDeliveryHandler);
  });

  it('AC-11: same TestModule (no PrismaService) compiles without throwing and WebhookDeliveryHandler is defined', async () => {
    let module: TestingModule | undefined;
    let threw = false;

    try {
      module = await Test.createTestingModule({
        imports: [GlobalStubsModule, WebhookModule],
      })
        .overrideProvider(PrismaWebhookRepository)
        .useValue(mockRepo)
        .compile();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    const deliveryHandler = module!.get(WebhookDeliveryHandler);
    expect(deliveryHandler).toBeDefined();
    expect(deliveryHandler).toBeInstanceOf(WebhookDeliveryHandler);
  });
});

// ---------------------------------------------------------------------------
// AC-12 to AC-15: OutboxFanOutRegistry webhook_delivery registration
// ---------------------------------------------------------------------------
describe('OutboxFanOutRegistry webhook_delivery', () => {
  it('AC-12: dispatch webhook_delivery calls webhookDeliveryHandler.handle once with correct payload', async () => {
    const mockWebhookHandler = { handle: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        OutboxFanOutRegistry,
        { provide: WebhookDeliveryHandler, useValue: mockWebhookHandler },
      ],
    }).compile();
    const registry = module.get(OutboxFanOutRegistry);

    await registry.dispatch({
      eventType: 'webhook_delivery',
      payload: { webhookId: 'w1', event: 'STATUS_CHANGE', payload: {} },
    });

    expect(mockWebhookHandler.handle).toHaveBeenCalledTimes(1);
    expect(mockWebhookHandler.handle.mock.calls[0][0]).toEqual({
      webhookId: 'w1',
      event: 'STATUS_CHANGE',
      payload: {},
    });
  });

  it('AC-13: getHandlers("webhook_delivery") returns [webhookDeliveryHandler] when handler is provided', async () => {
    const mockWebhookHandler = { handle: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        OutboxFanOutRegistry,
        { provide: WebhookDeliveryHandler, useValue: mockWebhookHandler },
      ],
    }).compile();
    const registry = module.get(OutboxFanOutRegistry);

    const result = registry.getHandlers('webhook_delivery');

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(typeof result[0]).toBe('function');
  });

  it('AC-14: getHandlers("webhook_delivery") returns [] when webhookDeliveryHandler is undefined', async () => {
    const module = await Test.createTestingModule({
      providers: [OutboxFanOutRegistry],
    }).compile();
    const registry = module.get(OutboxFanOutRegistry);

    const result = registry.getHandlers('webhook_delivery');

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('AC-15: OutboxFanOutRegistry resolves via TestingModule with no additional providers', async () => {
    const module = await Test.createTestingModule({
      providers: [OutboxFanOutRegistry],
    }).compile();
    await module.init();

    const instance = module.get(OutboxFanOutRegistry);

    expect(instance).not.toBeNull();
    expect(instance).not.toBeUndefined();
    expect(instance).toBeInstanceOf(OutboxFanOutRegistry);
  });
});

// ---------------------------------------------------------------------------
// AC-16 to AC-20: WebhookDispatcherService outbox-backed enqueue
// ---------------------------------------------------------------------------
describe('WebhookDispatcherService outbox enqueue', () => {
  let service: WebhookDispatcherService;
  let mockWebhookRepo: { findActiveByProject: jest.Mock };
  let mockOutboxService: { enqueue: jest.Mock };

  const makeWebhook = (id: string, events = ['STATUS_CHANGE']) => ({
    id,
    projectId: 'p1',
    url: `https://example.com/hook/${id}`,
    secret: 's3cret',
    events: JSON.stringify(events),
    active: true,
    createdAt: new Date(),
  });

  beforeEach(async () => {
    mockWebhookRepo = { findActiveByProject: jest.fn() };
    mockOutboxService = { enqueue: jest.fn().mockResolvedValue(stubEnqueuedEvent) };

    const module = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: PrismaWebhookRepository, useValue: mockWebhookRepo },
        { provide: OutboxService, useValue: mockOutboxService },
      ],
    }).compile();
    service = module.get(WebhookDispatcherService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('AC-16: dispatch() enqueues one webhook_delivery event with correct projectId, eventType, UUID eventId, and payload', async () => {
    const inputPayload = { ticketId: 't1', status: 'done' };
    mockWebhookRepo.findActiveByProject.mockResolvedValue([makeWebhook('w1')]);

    await service.dispatch('p1', 'STATUS_CHANGE', inputPayload);

    expect(mockOutboxService.enqueue).toHaveBeenCalledTimes(1);
    const arg = mockOutboxService.enqueue.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.projectId).toBe('p1');
    expect(arg.eventType).toBe('webhook_delivery');
    expect(arg.eventId).toMatch(UUID_V4_RE);
    expect(arg.payload).toEqual({
      webhookId: 'w1',
      event: 'STATUS_CHANGE',
      payload: inputPayload,
    });
    await expect(service.dispatch('p1', 'STATUS_CHANGE', inputPayload)).resolves.toBeUndefined();
  });

  it('AC-17: dispatch() enqueues both webhooks concurrently — both called before either resolves', async () => {
    mockWebhookRepo.findActiveByProject.mockResolvedValue([
      makeWebhook('w1'),
      makeWebhook('w2'),
    ]);

    const callOrder: string[] = [];
    let resolve1!: () => void;
    let resolve2!: () => void;

    mockOutboxService.enqueue
      .mockImplementationOnce(() => {
        callOrder.push('enqueue1');
        return new Promise<typeof stubEnqueuedEvent>((res) => {
          resolve1 = () => res(stubEnqueuedEvent);
        });
      })
      .mockImplementationOnce(() => {
        callOrder.push('enqueue2');
        return new Promise<typeof stubEnqueuedEvent>((res) => {
          resolve2 = () => res(stubEnqueuedEvent);
        });
      });

    const dispatchPromise = service.dispatch('p1', 'STATUS_CHANGE', {});

    // Yield enough microtask ticks for findActiveByProject to resolve and
    // for dispatch to reach the concurrent Promise.all enqueue calls.
    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder).toContain('enqueue1');
    expect(callOrder).toContain('enqueue2');

    const enqueuedWebhookIds = mockOutboxService.enqueue.mock.calls.map(
      (c: unknown[]) => (c[0] as { payload: { webhookId: string } }).payload.webhookId,
    );
    expect(enqueuedWebhookIds).toContain('w1');
    expect(enqueuedWebhookIds).toContain('w2');

    resolve1();
    resolve2();
    await dispatchPromise;
  });

  it('AC-18: dispatch() only enqueues webhooks whose events list contains the dispatched event', async () => {
    mockWebhookRepo.findActiveByProject.mockResolvedValue([
      makeWebhook('w1', ['STATUS_CHANGE']),
      makeWebhook('w2', ['TICKET_CREATED']),
      makeWebhook('w3', ['STATUS_CHANGE']),
    ]);

    await service.dispatch('p1', 'STATUS_CHANGE', {});

    expect(mockOutboxService.enqueue).toHaveBeenCalledTimes(2);
    const ids = mockOutboxService.enqueue.mock.calls.map(
      (c: unknown[]) => (c[0] as { payload: { webhookId: string } }).payload.webhookId,
    );
    expect(ids).toContain('w1');
    expect(ids).toContain('w3');
    expect(ids).not.toContain('w2');
  });

  it('AC-19: global fetch is never invoked during dispatch()', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as Record<string, unknown>).fetch = fetchSpy;
    mockWebhookRepo.findActiveByProject.mockResolvedValue([makeWebhook('w1')]);

    try {
      await service.dispatch('p1', 'STATUS_CHANGE', {});
    } finally {
      delete (global as unknown as Record<string, unknown>).fetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AC-20: dispatch() rejects with the same error when outboxService.enqueue rejects', async () => {
    const enqueueError = new Error('enqueue failed');
    mockWebhookRepo.findActiveByProject.mockResolvedValue([makeWebhook('w1')]);
    mockOutboxService.enqueue.mockRejectedValue(enqueueError);

    let caught: unknown;
    try {
      await service.dispatch('p1', 'STATUS_CHANGE', {});
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(enqueueError.message);
  });
});