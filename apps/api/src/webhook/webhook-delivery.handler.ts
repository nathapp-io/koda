import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { OutboundHttpClient } from './outbound/outbound-http-client';

export interface WebhookDeliveryPayload {
  webhookId: string;
  event: string;
  payload: unknown;
}

@Injectable()
export class WebhookDeliveryHandler {
  constructor(
    private readonly webhookRepo: PrismaWebhookRepository,
    private readonly http: OutboundHttpClient,
  ) {}

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
    const deliveryId = crypto.createHash('sha256').update(`${input.webhookId}:${input.event}:${body}`).digest('hex');

    // The transport owns redirect/SSRF guardrails and throws a `WebhookDeliveryError`
    // whose message is exactly one delivery code, so it propagates unchanged.
    await this.http.post(
      webhook.url,
      {
        'Content-Type': 'application/json',
        'X-Koda-Signature': `sha256=${sig}`,
        'X-Koda-Event': input.event,
        'X-Koda-Delivery-Id': deliveryId,
      },
      body,
    );
  }
}
