import type { Mocked } from 'vitest';
/**
 * US-004 — WebhookModule DI wiring for the guarded outbound client.
 *
 * Story: Deliver signed webhooks using guarded native HTTP transport.
 *
 * Invariants this file pins (the story's numbered ACs live in
 * `outbound/outbound-http-client.spec.ts`, `webhook-delivery.handler.spec.ts` and
 * `webhook-delivery.seam.spec.ts`; these are the wiring invariants the story names for
 * this file):
 * 1. Nest testing module constructed with WebhookDeliveryHandler, a mocked
 *    PrismaWebhookRepository and a mocked OutboundHttpClient (both useValue) ->
 *    compilation succeeds and module.get(WebhookDeliveryHandler) returns a defined
 *    instance without a database-backed Prisma provider.
 * 2. The resolved handler delivers through the injected OutboundHttpClient, so the
 *    client is a real constructor dependency and not an unused provider.
 * 3. The real WebhookModule provides OutboundHttpClient (the story: "WebhookModule
 *    registers OutboundHttpClient as a provider").
 *
 * Rationale: module-compilation and DI-wiring tests are unit tests, not integration
 * tests. They must not require a database and must be co-located as a module spec so
 * they run under bun run test. Mocks are provided as useValue so no Prisma client is
 * ever instantiated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { OutboundHttpClient } from './outbound/outbound-http-client';
import { WebhookModule } from './webhook.module';
import { WebhookDomain } from './domain/webhook.domain';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

function makeWebhookRepoMock(webhook: WebhookDomain | null = null): Mocked<PrismaWebhookRepository> {
  return {
    createWebhook: vi.fn(),
    findByProject: vi.fn(),
    findActiveByProject: vi.fn(),
    findById: vi.fn().mockResolvedValue(webhook),
    deleteWebhook: vi.fn(),
    findProjectBySlug: vi.fn(),
  } as unknown as Mocked<PrismaWebhookRepository>;
}

function makeActiveWebhook(): WebhookDomain {
  return {
    id: 'w1',
    projectId: 'p1',
    // A loopback destination that refuses connections: the DI test never leaves the
    // machine even when the client dependency is not wired yet.
    url: 'http://127.0.0.1:9/hook',
    secret: 's3cret',
    events: JSON.stringify(['STATUS_CHANGE']),
    active: true,
    createdAt: new Date(),
  };
}

describe('WebhookModule (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  describe('WebhookDeliveryHandler DI smoke', () => {
    it('US-004 wiring: compiles and resolves WebhookDeliveryHandler with a mocked PrismaWebhookRepository and a mocked OutboundHttpClient, with no database-backed Prisma provider', async () => {
      const webhookRepoMock = makeWebhookRepoMock();
      const httpMock = { post: vi.fn().mockResolvedValue(undefined) };

      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule],
        providers: [
          { provide: PrismaWebhookRepository, useValue: webhookRepoMock },
          { provide: OutboundHttpClient, useValue: httpMock },
          WebhookDeliveryHandler,
        ],
      }).compile();

      const handler = moduleRef.get(WebhookDeliveryHandler);
      expect(handler).toBeDefined();
      expect(handler).toBeInstanceOf(WebhookDeliveryHandler);
    });

    it('US-004 wiring boundary: module.get(WebhookDeliveryHandler) does not throw when only the two mocked collaborators are provided', async () => {
      const webhookRepoMock = makeWebhookRepoMock();
      const httpMock = { post: vi.fn().mockResolvedValue(undefined) };

      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule],
        providers: [
          { provide: PrismaWebhookRepository, useValue: webhookRepoMock },
          { provide: OutboundHttpClient, useValue: httpMock },
          WebhookDeliveryHandler,
        ],
      }).compile();

      expect(() => moduleRef.get(WebhookDeliveryHandler)).not.toThrow();
      expect(moduleRef.get(WebhookDeliveryHandler)).toBeDefined();
    });

    it('US-004 wiring: the resolved handler delivers through the injected OutboundHttpClient', async () => {
      const webhook = makeActiveWebhook();
      const webhookRepoMock = makeWebhookRepoMock(webhook);
      const post = vi.fn().mockResolvedValue(undefined);
      const httpMock = { post };

      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule],
        providers: [
          { provide: PrismaWebhookRepository, useValue: webhookRepoMock },
          { provide: OutboundHttpClient, useValue: httpMock },
          WebhookDeliveryHandler,
        ],
      }).compile();

      await moduleRef
        .get(WebhookDeliveryHandler)
        .handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } });

      expect(webhookRepoMock.findById).toHaveBeenCalledWith('w1');
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:9/hook');
    });
  });

  describe('US-004 wiring: WebhookModule registers OutboundHttpClient', () => {
    it('US-004 wiring: WebhookModule resolves OutboundHttpClient as a real instance', async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, WebhookModule],
      }).compile();

      expect(moduleRef.get(OutboundHttpClient)).toBeInstanceOf(OutboundHttpClient);
    });
  });
});
