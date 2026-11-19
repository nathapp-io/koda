import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AbstractPrismaRepository } from '@nathapp/nestjs-prisma';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { WEBHOOK_DELIVERY_REPOSITORY } from './domain/webhook-delivery.domain';
import { PrismaWebhookDeliveryRepository } from './prisma-webhook-delivery.repository';
import { WebhookDeliveryRetentionProcessor } from './webhook-delivery-retention.processor';
import { WebhookReplayGuard } from './webhook-replay.guard';
import { WebhookSecurityModule } from './webhook-security.module';

/**
 * DI wiring for the webhook delivery purge (review-1119 US-002), with no database and no scheduler:
 * the module is compiled, never initialised, so `@Cron` registers nothing.
 */
describe('WebhookSecurityModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;
  afterEach(async () => {
    await moduleRef?.close();
  });
  const compile = () => Test.createTestingModule({ imports: [GlobalStubsModule, WebhookSecurityModule] }).compile();

  it('AC-13: resolves WebhookDeliveryRetentionProcessor', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(WebhookDeliveryRetentionProcessor)).toBeInstanceOf(WebhookDeliveryRetentionProcessor);
  });

  it('keeps the replay guard and the delivery repository private to the module', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(WebhookReplayGuard)).toBeInstanceOf(WebhookReplayGuard);
    expect(moduleRef.get(PrismaWebhookDeliveryRepository, { strict: false }))
      .toBeInstanceOf(PrismaWebhookDeliveryRepository);
  });

  /**
   * B3: every repository is registered behind a symbol token in its module — here a module-private one,
   * because nothing outside this module may depend on the replay guard's storage.
   */
  it('B3: binds the delivery repository behind a module-private token and exports neither', async () => {
    moduleRef = await compile();
    const repository = moduleRef.get(PrismaWebhookDeliveryRepository, { strict: false });

    expect(moduleRef.get(WEBHOOK_DELIVERY_REPOSITORY, { strict: false })).toBe(repository);
    const exported = Reflect.getMetadata('exports', WebhookSecurityModule) as unknown[];
    expect(exported).not.toContain(WEBHOOK_DELIVERY_REPOSITORY);
    expect(exported).not.toContain(PrismaWebhookDeliveryRepository);
  });

  it('F1: builds the delivery repository as an AbstractPrismaRepository over the transaction manager', async () => {
    moduleRef = await compile();
    const repository = moduleRef.get(PrismaWebhookDeliveryRepository, { strict: false });

    expect(repository).toBeInstanceOf(AbstractPrismaRepository);
    // The base class only holds the transaction manager it was constructed with; a repository built
    // without one cannot type-cast to this property at all (`tx` lives on the abstract base).
    expect(repository).toHaveProperty('tx', moduleRef.get(TRANSACTION_MANAGER));
  });
});
