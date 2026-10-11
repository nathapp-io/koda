import type { Mock, Mocked } from 'vitest';
/**
 * US-004 — the delivery seam: `FanOutPublisher.publish` → `WebhookOutboxSubscriber`
 * → `WebhookDeliveryHandler` → `OutboundHttpClient` → `OutboundUrlGuard`.
 *
 * This is the only place the story's classes are wired to each other as they are in
 * production (`WebhookOutboxSubscriber.onModuleInit` registers the handler for
 * `webhook_delivery`), so it pins what an admin actually sees in the outbox row's
 * `lastError`: a fixed delivery code and nothing else. Only the database seam
 * (`PrismaWebhookRepository`) and the DNS seam (`DnsResolver`) are stubbed; the
 * publisher, subscriber, handler, client and guard are the real ones.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IWebhookConfig } from '../config/webhook.config';
import { FanOutPublisher, OutboxFanOutError } from '../outbox/fan-out-publisher';
import { outboxRecord } from '../../test/helpers/outbox-record';
import { WebhookDomain } from './domain/webhook.domain';
import { OutboundHttpClient } from './outbound/outbound-http-client';
import { OutboundUrlGuard } from './outbound/outbound-url-guard';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { WebhookOutboxSubscriber } from './webhook-outbox.subscriber';

const ALLOWED_HOST = 'allowed.test';
const REBIND_HOST = 'rebind.test';

type ResolveMock = Mock<(...args: [string]) => Promise<string[]>>;
type RecordLastErrorMock = Mock<(...args: [string, string]) => Promise<void>>;

interface SeamHarness {
  publisher: FanOutPublisher;
  recordLastError: RecordLastErrorMock;
  resolve: ResolveMock;
}

function makeWebhookRepo(url: string): Mocked<PrismaWebhookRepository> {
  const webhook: WebhookDomain = {
    id: 'w1',
    projectId: 'p1',
    url,
    secret: 's3cret',
    events: JSON.stringify(['STATUS_CHANGE']),
    active: true,
    createdAt: new Date(),
  };

  return {
    createWebhook: vi.fn(),
    findByProject: vi.fn(),
    findById: vi.fn().mockResolvedValue(webhook),
    deleteWebhook: vi.fn(),
    findProjectBySlug: vi.fn(),
  } as unknown as Mocked<PrismaWebhookRepository>;
}

/** The production chain, with the webhook url the handler looks up set to `url`. */
function makeSeam(
  url: string,
  options: { config?: Partial<IWebhookConfig>; addresses?: readonly string[] } = {},
): SeamHarness {
  const recordLastError: RecordLastErrorMock = vi.fn<(...args: [string, string]) => Promise<void>>(
    (): Promise<void> => Promise.resolve(),
  );
  const publisher = new FanOutPublisher({ recordLastError });

  const addresses = options.addresses ?? ['127.0.0.1'];
  const resolve: ResolveMock = vi.fn<(...args: [string]) => Promise<string[]>>(
    (): Promise<string[]> => Promise.resolve([...addresses]),
  );
  const config: IWebhookConfig = {
    allowedHostnames: [],
    allowedCidrs: [],
    deliveryTimeoutMs: 2000,
    ...options.config,
  };

  const guard = new OutboundUrlGuard(config, { resolve });
  const client = new OutboundHttpClient(guard, config);
  const handler = new WebhookDeliveryHandler(makeWebhookRepo(url), client);

  new WebhookOutboxSubscriber(publisher, handler).onModuleInit();

  return { publisher, recordLastError, resolve };
}

const DELIVERY_PAYLOAD = { webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } };

describe('US-004: FanOutPublisher → WebhookOutboxSubscriber → delivery seam', () => {
  describe('AC14: a blocked destination reaches the outbox as the code alone', () => {
    it('AC14: publish of a webhook_delivery record for a rebinding host rejects and records exactly "1 fan-out handler(s) failed for webhook_delivery: blocked_destination"', async () => {
      const { publisher, recordLastError, resolve } = makeSeam(`https://${REBIND_HOST}/hook`);
      const record = outboxRecord('webhook_delivery', DELIVERY_PAYLOAD);

      await expect(publisher.publish(record)).rejects.toBeInstanceOf(OutboxFanOutError);

      expect(resolve).toHaveBeenCalledWith(REBIND_HOST);
      expect(recordLastError).toHaveBeenCalledTimes(1);
      expect(recordLastError).toHaveBeenCalledWith(
        record.id,
        '1 fan-out handler(s) failed for webhook_delivery: blocked_destination',
      );
    });

    it('AC14 boundary: an allow-listed destination that answers 503 records exactly "1 fan-out handler(s) failed for webhook_delivery: http_5xx"', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(503);
        res.end();
      });
      await new Promise<void>((fulfilled) => server.listen(0, '127.0.0.1', () => fulfilled()));
      const { port } = server.address() as AddressInfo;

      try {
        const { publisher, recordLastError } = makeSeam(
          `http://${ALLOWED_HOST}:${port}/hook`,
          { config: { allowedHostnames: [ALLOWED_HOST] } },
        );
        const record = outboxRecord('webhook_delivery', DELIVERY_PAYLOAD);

        await expect(publisher.publish(record)).rejects.toBeInstanceOf(OutboxFanOutError);

        expect(recordLastError).toHaveBeenCalledTimes(1);
        expect(recordLastError).toHaveBeenCalledWith(
          record.id,
          '1 fan-out handler(s) failed for webhook_delivery: http_5xx',
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((fulfilled) => server.close(() => fulfilled()));
      }
    });
  });
});
