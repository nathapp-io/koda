import { Module } from '@nestjs/common';
import { WEBHOOK_REPOSITORY } from './domain/webhook.domain';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/** Transactional dispatch without the gated routes (which depend on the approval engine). */
@Module({
  providers: [
    PrismaWebhookRepository,
    { provide: WEBHOOK_REPOSITORY, useExisting: PrismaWebhookRepository },
    WebhookDispatcherService,
  ],
  exports: [WebhookDispatcherService],
})
export class WebhookDispatchModule {}
