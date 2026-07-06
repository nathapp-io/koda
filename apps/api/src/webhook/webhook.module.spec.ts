import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

/**
 * WebhookModule DI wiring tests
 *
 * Story: Wire WebhookModule for outbox-backed delivery
 *
 * Acceptance Criteria:
 * AC1: Nest testing module constructed with WebhookDeliveryHandler as a provider and
 *     a mocked PrismaWebhookRepository provider (useValue) -> compilation succeeds
 *     and module.get(WebhookDeliveryHandler) returns a defined instance.
 * AC2: When the WebhookDeliveryHandler DI smoke test provides only a mocked
 *     PrismaWebhookRepository and no database-backed Prisma provider, resolving
 *     module.get(WebhookDeliveryHandler) does not throw.
 *
 * Rationale: module-compilation and DI-wiring tests are unit tests, not integration
 * tests. They must not require a database and must be co-located as a module spec so
 * they run under bun run test. Mocks are provided as useValue so no Prisma client is
 * ever instantiated.
 */

function makeWebhookRepoMock(): jest.Mocked<PrismaWebhookRepository> {
  return {
    createWebhook: jest.fn(),
    findByProject: jest.fn(),
    findActiveByProject: jest.fn(),
    findById: jest.fn(),
    deleteWebhook: jest.fn(),
    findProjectBySlug: jest.fn(),
  } as unknown as jest.Mocked<PrismaWebhookRepository>;
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
    it('AC1: compiles and resolves WebhookDeliveryHandler with mocked PrismaWebhookRepository and no database-backed Prisma provider', async () => {
      const webhookRepoMock = makeWebhookRepoMock();

      await expect(
        Test.createTestingModule({
          imports: [GlobalStubsModule],
          providers: [
            { provide: PrismaWebhookRepository, useValue: webhookRepoMock },
            WebhookDeliveryHandler,
          ],
        }).compile(),
      ).resolves.toBeDefined();
    });

    it('AC2: module.get(WebhookDeliveryHandler) does not throw and returns a defined instance when only a mocked PrismaWebhookRepository is provided', async () => {
      const webhookRepoMock = makeWebhookRepoMock();

      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule],
        providers: [
          { provide: PrismaWebhookRepository, useValue: webhookRepoMock },
          WebhookDeliveryHandler,
        ],
      }).compile();

      expect(() => moduleRef.get(WebhookDeliveryHandler)).not.toThrow();
      const handler = moduleRef.get(WebhookDeliveryHandler);
      expect(handler).toBeDefined();
      expect(handler).toBeInstanceOf(WebhookDeliveryHandler);
    });
  });
});