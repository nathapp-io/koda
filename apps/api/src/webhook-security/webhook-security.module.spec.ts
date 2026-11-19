import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
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
});
