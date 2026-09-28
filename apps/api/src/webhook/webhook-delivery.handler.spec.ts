/**
 * US-004 — `WebhookDeliveryHandler` delegates signed delivery to `OutboundHttpClient`.
 *
 * The handler keeps its contract — look the webhook up fresh, sign the serialized
 * payload with the webhook secret and derive the delivery id — but it no longer owns
 * the transport: delivery goes through `OutboundHttpClient.post`, so a redirect can
 * never be followed and a `WebhookDeliveryError` (whose message is exactly one
 * delivery error code) is what reaches the outbox `lastError`.
 *
 * The transport itself is pinned in `outbound/outbound-http-client.spec.ts` and the
 * fan-out seam in `webhook-delivery.seam.spec.ts`.
 *
 * The handler has no Nest lifecycle (no OnModuleInit), so every case uses direct
 * instantiation, matching `src/outbox/fan-out-publisher.spec.ts`.
 */
import * as crypto from 'crypto';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import type { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WebhookDomain } from './domain/webhook.domain';
import { OutboundHttpClient, WebhookDeliveryError } from './outbound/outbound-http-client';

function makeWebhookRepo(): jest.Mocked<PrismaWebhookRepository> {
  return {
    createWebhook: jest.fn(),
    findByProject: jest.fn(),
    findById: jest.fn(),
    deleteWebhook: jest.fn(),
    findProjectBySlug: jest.fn(),
  } as unknown as jest.Mocked<PrismaWebhookRepository>;
}

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

type PostMock = jest.Mock<Promise<void>, [string, Record<string, string>, string]>;

interface HandlerHarness {
  handler: WebhookDeliveryHandler;
  post: PostMock;
  webhookRepo: jest.Mocked<PrismaWebhookRepository>;
}

function makeHandler(): HandlerHarness {
  const webhookRepo = makeWebhookRepo();
  const post: PostMock = jest.fn<Promise<void>, [string, Record<string, string>, string]>(
    (): Promise<void> => Promise.resolve(),
  );
  const http = { post } as unknown as OutboundHttpClient;

  return { handler: new WebhookDeliveryHandler(webhookRepo, http), post, webhookRepo };
}

function hmacHex(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('WebhookDeliveryHandler', () => {
  let harness: HandlerHarness;
  let originalFetch: typeof global.fetch | undefined;
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    harness = makeHandler();

    originalFetch = global.fetch;
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      delete (global as { fetch?: typeof global.fetch }).fetch;
    } else {
      global.fetch = originalFetch;
    }
  });

  describe('AC11: an active webhook is delivered through OutboundHttpClient.post', () => {
    it('AC11: handle calls post once with the webhook url, JSON.stringify(payload) and the four signed headers', async () => {
      harness.webhookRepo.findById.mockResolvedValue(
        makeWebhook({ url: 'https://example.com/hook', secret: 's3cret' }),
      );

      const payload = { a: 1 };
      await harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload });

      expect(harness.post).toHaveBeenCalledTimes(1);
      const [url, headers, body] = harness.post.mock.calls[0];
      const expectedBody = JSON.stringify(payload);

      expect(url).toBe('https://example.com/hook');
      expect(body).toBe(expectedBody);
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'X-Koda-Event': 'STATUS_CHANGE',
        'X-Koda-Signature': `sha256=${hmacHex('s3cret', expectedBody)}`,
        'X-Koda-Delivery-Id': crypto
          .createHash('sha256')
          .update(`w1:STATUS_CHANGE:${expectedBody}`)
          .digest('hex'),
      });
    });

    it('AC11 boundary: an absent payload is sent as the JSON body "null" and signed over that body', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook({ secret: 's3cret' }));

      await harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: undefined });

      const [, headers, body] = harness.post.mock.calls[0];
      expect(body).toBe('null');
      expect(headers['X-Koda-Signature']).toBe(`sha256=${hmacHex('s3cret', 'null')}`);
    });

    it('AC11 boundary: a different secret produces a different signature for the same body', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook({ secret: 'other-secret' }));

      await harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });

      const [, headers, body] = harness.post.mock.calls[0];
      expect(headers['X-Koda-Signature']).toBe(`sha256=${hmacHex('other-secret', body)}`);
      expect(headers['X-Koda-Signature']).not.toBe(`sha256=${hmacHex('s3cret', body)}`);
    });
  });

  describe('AC12: delivery never uses global fetch', () => {
    it('AC12: handle resolves through post and never calls globalThis.fetch', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook());

      await expect(
        harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } }),
      ).resolves.toBeUndefined();

      expect(harness.post).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('AC12 boundary: a failing delivery still never calls globalThis.fetch', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook());
      harness.post.mockRejectedValue(new WebhookDeliveryError('connect_failed'));

      await expect(
        harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } }),
      ).rejects.toThrow(WebhookDeliveryError);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC13: a missing or inactive webhook is not delivered', () => {
    it('AC13: when findById resolves null, handle resolves and post is not called', async () => {
      harness.webhookRepo.findById.mockResolvedValue(null);

      await expect(
        harness.handler.handle({ webhookId: 'missing', event: 'STATUS_CHANGE', payload: { a: 1 } }),
      ).resolves.toBeUndefined();

      expect(harness.post).not.toHaveBeenCalled();
    });

    it('AC13: when findById resolves an inactive webhook, handle resolves and post is not called', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook({ active: false }));

      await expect(
        harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } }),
      ).resolves.toBeUndefined();

      expect(harness.post).not.toHaveBeenCalled();
    });

    it('AC13 boundary: an inactive webhook with an unreachable url is still not delivered', async () => {
      harness.webhookRepo.findById.mockResolvedValue(
        makeWebhook({ active: false, url: 'https://rebind.test/hook' }),
      );

      await expect(
        harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } }),
      ).resolves.toBeUndefined();

      expect(harness.post).not.toHaveBeenCalled();
    });
  });

  describe('AC16: a WebhookDeliveryError propagates unchanged', () => {
    it('AC16: post rejecting with WebhookDeliveryError("http_5xx") rejects handle with that same error instance', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook());
      const deliveryError = new WebhookDeliveryError('http_5xx');
      harness.post.mockRejectedValue(deliveryError);

      await expect(
        harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } }),
      ).rejects.toBe(deliveryError);
    });

    it('AC16 boundary: the propagated message is exactly the delivery code with no added text', async () => {
      harness.webhookRepo.findById.mockResolvedValue(makeWebhook());
      harness.post.mockRejectedValue(new WebhookDeliveryError('blocked_destination'));

      let caught: unknown;
      try {
        await harness.handler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(WebhookDeliveryError);
      if (!(caught instanceof WebhookDeliveryError)) {
        throw new Error('handle did not reject with WebhookDeliveryError');
      }
      expect(caught.code).toBe('blocked_destination');
      expect(caught.message).toBe('blocked_destination');
    });
  });
});
