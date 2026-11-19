import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaWebhookDeliveryRepository } from './prisma-webhook-delivery.repository';
import { WebhookDeliveryRetentionProcessor } from './webhook-delivery-retention.processor';
import { WebhookReplayGuard } from './webhook-replay.guard';

@Module({
  imports: [PrismaModule],
  // The delivery repository is module-private: nothing outside this module may depend on the replay
  // guard's storage (US-002).
  providers: [WebhookReplayGuard, PrismaWebhookDeliveryRepository, WebhookDeliveryRetentionProcessor],
  exports: [WebhookReplayGuard],
})
export class WebhookSecurityModule {}
