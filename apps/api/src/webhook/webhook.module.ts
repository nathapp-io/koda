import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { WebhookOutboxSubscriber } from './webhook-outbox.subscriber';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WEBHOOK_REPOSITORY } from './domain/webhook.domain';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [PrismaModule, OutboxModule],
  controllers: [WebhookController],
  providers: [
    PrismaWebhookRepository,
    { provide: WEBHOOK_REPOSITORY, useExisting: PrismaWebhookRepository },
    WebhookService,
    WebhookDispatcherService,
    WebhookDeliveryHandler,
    WebhookOutboxSubscriber,
  ],
  exports: [WebhookService, WebhookDispatcherService, WebhookDeliveryHandler],
})
export class WebhookModule {}
