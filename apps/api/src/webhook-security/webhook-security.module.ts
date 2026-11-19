import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WEBHOOK_DELIVERY_REPOSITORY } from './domain/webhook-delivery.domain';
import { PrismaWebhookDeliveryRepository } from './prisma-webhook-delivery.repository';
import { WebhookDeliveryRetentionProcessor } from './webhook-delivery-retention.processor';
import { WebhookReplayGuard } from './webhook-replay.guard';

// The delivery repository is module-private: nothing outside this module may depend on the replay
// guard's storage (US-002), so it is bound behind a local token and neither the token nor the class is
// exported. Its consumer injects the concrete class for `deleteReceivedBefore`.
@Module({
  imports: [PrismaModule],
  providers: [
    WebhookReplayGuard,
    PrismaWebhookDeliveryRepository,
    { provide: WEBHOOK_DELIVERY_REPOSITORY, useExisting: PrismaWebhookDeliveryRepository },
    WebhookDeliveryRetentionProcessor,
  ],
  exports: [WebhookReplayGuard],
})
export class WebhookSecurityModule {}
