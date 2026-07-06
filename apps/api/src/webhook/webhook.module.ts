import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WEBHOOK_REPOSITORY } from './domain/webhook.domain';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  // OutboxModule imports WebhookModule via forwardRef to resolve WebhookDeliveryHandler
  // for fan-out; mirror the edge with forwardRef here to break the cycle.
  imports: [PrismaModule, forwardRef(() => OutboxModule)],
  controllers: [WebhookController],
  providers: [
    PrismaWebhookRepository,
    { provide: WEBHOOK_REPOSITORY, useExisting: PrismaWebhookRepository },
    WebhookService,
    WebhookDispatcherService,
    WebhookDeliveryHandler,
  ],
  exports: [WebhookService, WebhookDispatcherService, WebhookDeliveryHandler],
})
export class WebhookModule {}
