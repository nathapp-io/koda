import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WEBHOOK_REPOSITORY } from './domain/webhook.domain';

@Module({
  imports: [PrismaModule],
  controllers: [WebhookController],
  providers: [
    PrismaWebhookRepository,
    { provide: WEBHOOK_REPOSITORY, useExisting: PrismaWebhookRepository },
    WebhookService,
    WebhookDispatcherService,
  ],
  exports: [WebhookService, WebhookDispatcherService],
})
export class WebhookModule {}
