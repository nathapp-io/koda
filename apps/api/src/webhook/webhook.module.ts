import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { WebhookRouteCommands } from './webhook-route.commands';
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { WebhookOutboxSubscriber } from './webhook-outbox.subscriber';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WEBHOOK_REPOSITORY } from './domain/webhook.domain';
import { DnsResolver } from './outbound/dns-resolver';
import { OutboundHttpClient } from './outbound/outbound-http-client';
import { OutboundUrlGuard } from './outbound/outbound-url-guard';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';

@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, OutboxModule, ProjectAccessModule],
  controllers: [WebhookController],
  providers: [
    WebhookRouteCommands,
    PrismaWebhookRepository,
    { provide: WEBHOOK_REPOSITORY, useExisting: PrismaWebhookRepository },
    WebhookService,
    WebhookDispatcherService,
    WebhookDeliveryHandler,
    WebhookOutboxSubscriber,
    DnsResolver,
    OutboundUrlGuard,
    OutboundHttpClient,
  ],
  exports: [WebhookService, WebhookDispatcherService, WebhookDeliveryHandler],
})
export class WebhookModule {}
