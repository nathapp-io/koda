import { SystemWriter } from '../permissions/system-writer.decorator';
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WEBHOOK_SIGNATURE_CFG, type IWebhookSignatureConfig } from '../config/webhook-signature.config';
import { signatureV1, signatureV2 } from '../webhook-security/webhook-signature';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { OutboundHttpClient } from './outbound/outbound-http-client';

export interface WebhookDeliveryPayload {
  webhookId: string;
  event: string;
  payload: unknown;
}

@Injectable()
@SystemWriter('system.webhook.deliver')
export class WebhookDeliveryHandler {
  constructor(
    private readonly webhookRepo: PrismaWebhookRepository,
    private readonly http: OutboundHttpClient,
    private readonly config: ConfigService,
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
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = crypto.createHash('sha256').update(`${input.webhookId}:${input.event}:${body}`).digest('hex');
    const signatureConfig = this.config.get<IWebhookSignatureConfig>(WEBHOOK_SIGNATURE_CFG);
    const v1Enabled = signatureConfig?.v1Enabled ?? true;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Koda-Event': input.event,
      'X-Koda-Delivery-Id': deliveryId,
      'X-Koda-Timestamp': timestamp,
      'X-Koda-Signature-V2': signatureV2(webhook.secret, timestamp, deliveryId, body),
    };
    if (v1Enabled) {
      headers['X-Koda-Signature'] = signatureV1(webhook.secret, body);
    }

    // The transport owns redirect/SSRF guardrails and throws a `WebhookDeliveryError`
    // whose message is exactly one delivery code, so it propagates unchanged.
    await this.http.post(
      webhook.url,
      headers,
      body,
    );
  }
}
