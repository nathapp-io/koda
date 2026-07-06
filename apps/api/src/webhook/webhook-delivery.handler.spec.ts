import * as crypto from 'crypto';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WebhookDomain } from './domain/webhook.domain';

/**
 * WebhookDeliveryHandler Tests
 *
 * Story: Add webhook delivery handler
 * Description: Handler that owns the actual signed HTTP delivery, looked up
 * fresh by webhook id at delivery time (does NOT snapshot url/secret into outbox payload).
 *
 * Acceptance Criteria:
 * AC1: findById resolves active webhook -> global fetch called exactly once with webhook.url
 * AC2: fetch receives method POST and headers['X-Koda-Event'] = event
 * AC3: fetch receives headers['X-Koda-Signature'] = `sha256=${hex}` where hex is HMAC-SHA256(secret, JSON.stringify(payload))
 * AC4: fetch receives a signal that is an instance of AbortSignal
 * AC5: fetch resolves { ok: true } -> handle() resolves without throwing
 * AC6: fetch resolves { ok: false, status: 503 } -> handle() rejects with Error whose message includes '503'
 * AC7: fetch rejects with Error -> handle() rejects with that same error
 * AC8: findById resolves null -> handle() resolves without throwing, fetch not called
 * AC9: findById resolves { active: false } -> handle() resolves without throwing, fetch not called
 *
 * Note: handler has no Nest lifecycle (no OnModuleInit) -> use direct instantiation,
 * matching the existing style in src/outbox/outbox-fan-out-registry.spec.ts.
 */

type WebhookRepoShape = Pick<PrismaWebhookRepository, 'findById'>;

function makeWebhook(overrides: Partial<WebhookDomain> = {}): WebhookDomain {
  return {
    id: 'w1',
    projectId: 'p1',
    url: 'https://example.com/hook',
    secret: 's3cret',
    events: JSON.stringify(['STATUS_CHANGE']),
    active: true,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('WebhookDeliveryHandler', () => {
  let mockRepo: { findById: jest.Mock };
  let handler: WebhookDeliveryHandler;
  let mockFetch: jest.Mock;
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(() => {
    mockRepo = {
      findById: jest.fn(),
    };
    handler = new WebhookDeliveryHandler(
      mockRepo as unknown as WebhookRepoShape as PrismaWebhookRepository,
    );

    originalFetch = global.fetch;
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      delete (global as { fetch?: typeof global.fetch }).fetch;
    } else {
      global.fetch = originalFetch;
    }
  });

  describe('AC1: active webhook triggers single fetch with webhook.url', () => {
    it('AC1: handle() calls global fetch exactly once with webhook.url as the first argument', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook());
      mockFetch.mockResolvedValue({ ok: true });

      await handler.handle({
        webhookId: 'w1',
        event: 'STATUS_CHANGE',
        payload: { a: 1 },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/hook');
    });
  });

  describe('AC2: POST method and X-Koda-Event header', () => {
    it('AC2: fetch second argument has method POST and headers["X-Koda-Event"] equal to event', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook());
      mockFetch.mockResolvedValue({ ok: true });

      await handler.handle({
        webhookId: 'w1',
        event: 'STATUS_CHANGE',
        payload: { a: 1 },
      });

      const init = mockFetch.mock.calls[0][1] as { method?: string; headers?: Record<string, string> };
      expect(init.method).toBe('POST');
      expect(init.headers?.['X-Koda-Event']).toBe('STATUS_CHANGE');
    });
  });

  describe('AC3: X-Koda-Signature header is sha256=HMAC-SHA256(secret, body)', () => {
    it('AC3: X-Koda-Signature equals sha256=<hex> where hex is HMAC-SHA256 of JSON.stringify(payload) keyed by secret', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook({ secret: 's3cret' }));
      mockFetch.mockResolvedValue({ ok: true });

      const payload = { a: 1 };
      await handler.handle({
        webhookId: 'w1',
        event: 'STATUS_CHANGE',
        payload,
      });

      const init = mockFetch.mock.calls[0][1] as { headers?: Record<string, string> };
      const signatureHeader = init.headers?.['X-Koda-Signature'];

      const expectedHex = crypto
        .createHmac('sha256', 's3cret')
        .update(JSON.stringify(payload))
        .digest('hex');

      expect(signatureHeader).toBe(`sha256=${expectedHex}`);
    });

    it('AC3 boundary: different secrets produce different signatures', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook({ secret: 'other-secret' }));
      mockFetch.mockResolvedValue({ ok: true });

      await handler.handle({
        webhookId: 'w1',
        event: 'STATUS_CHANGE',
        payload: { a: 1 },
      });

      const init = mockFetch.mock.calls[0][1] as { headers?: Record<string, string> };
      const signatureHeader = init.headers?.['X-Koda-Signature'];

      const expectedHex = crypto
        .createHmac('sha256', 'other-secret')
        .update(JSON.stringify({ a: 1 }))
        .digest('hex');

      expect(signatureHeader).toBe(`sha256=${expectedHex}`);
      expect(signatureHeader).not.toBe(
        `sha256=${crypto.createHmac('sha256', 's3cret').update(JSON.stringify({ a: 1 })).digest('hex')}`,
      );
    });
  });

  describe('AC4: AbortSignal passed to fetch', () => {
    it('AC4: fetch second argument has signal that is an instance of AbortSignal', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook());
      mockFetch.mockResolvedValue({ ok: true });

      await handler.handle({
        webhookId: 'w1',
        event: 'STATUS_CHANGE',
        payload: { a: 1 },
      });

      const init = mockFetch.mock.calls[0][1] as { signal?: AbortSignal };
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('AC5: fetch { ok: true } resolves without throwing', () => {
    it('AC5: when fetch resolves with { ok: true }, handle() resolves without throwing', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook());
      mockFetch.mockResolvedValue({ ok: true });

      await expect(
        handler.handle({
          webhookId: 'w1',
          event: 'STATUS_CHANGE',
          payload: { a: 1 },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('AC6: fetch { ok: false, status: 503 } rejects with Error containing "503"', () => {
    it('AC6: when fetch resolves { ok: false, status: 503 }, handle() rejects with Error whose message includes "503"', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook());
      mockFetch.mockResolvedValue({ ok: false, status: 503 });

      await expect(
        handler.handle({
          webhookId: 'w1',
          event: 'STATUS_CHANGE',
          payload: { a: 1 },
        }),
      ).rejects.toThrow(/503/);
    });
  });

  describe('AC7: fetch rejection propagates', () => {
    it('AC7: when fetch rejects with new Error("network down"), handle() rejects with that same error', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook());
      const networkError = new Error('network down');
      mockFetch.mockRejectedValue(networkError);

      await expect(
        handler.handle({
          webhookId: 'w1',
          event: 'STATUS_CHANGE',
          payload: { a: 1 },
        }),
      ).rejects.toBe(networkError);
    });
  });

  describe('AC8: missing webhook -> no-op (no fetch)', () => {
    it('AC8: when findById resolves null, handle() resolves without throwing and fetch is not called', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(
        handler.handle({
          webhookId: 'missing',
          event: 'STATUS_CHANGE',
          payload: { a: 1 },
        }),
      ).resolves.toBeUndefined();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('AC9: inactive webhook -> no-op (no fetch)', () => {
    it('AC9: when findById resolves { active: false }, handle() resolves without throwing and fetch is not called', async () => {
      mockRepo.findById.mockResolvedValue(makeWebhook({ active: false }));

      await expect(
        handler.handle({
          webhookId: 'w1',
          event: 'STATUS_CHANGE',
          payload: { a: 1 },
        }),
      ).resolves.toBeUndefined();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
