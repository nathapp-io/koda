import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WebhookDeliveryHandler, WebhookDeliveryPayload } from './webhook-delivery.handler';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class WebhookOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(WebhookOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly webhookDeliveryHandler: WebhookDeliveryHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register('webhook_delivery', this.handleWebhookDelivery.bind(this));
    this.logger.debug('Webhook outbox handler registered');
  }

  private async handleWebhookDelivery(payload: unknown): Promise<void> {
    await this.webhookDeliveryHandler.handle(payload as WebhookDeliveryPayload);
  }
}
