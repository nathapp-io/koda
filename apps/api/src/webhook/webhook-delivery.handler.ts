import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaWebhookRepository } from './prisma-webhook.repository';

export interface WebhookDeliveryPayload {
  webhookId: string;
  event: string;
  payload: unknown;
}

@Injectable()
export class WebhookDeliveryHandler {
  constructor(private readonly webhookRepo: PrismaWebhookRepository) {}

  async handle(input: WebhookDeliveryPayload): Promise<void> {
    const webhook = await this.webhookRepo.findById(input.webhookId);

    if (!webhook || !webhook.active) {
      return;
    }

    let body: string;
    try {
      body = JSON.stringify(input.payload ?? null);
    } catch (err) {
      throw new Error(`Webhook payload serialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const sig = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Koda-Signature': `sha256=${sig}`,
        'X-Koda-Event': input.event,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed with status ${response.status}`);
    }
  }
}
