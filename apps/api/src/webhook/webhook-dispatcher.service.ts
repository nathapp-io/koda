import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaWebhookRepository } from './prisma-webhook.repository';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(private readonly webhookRepo: PrismaWebhookRepository) {}

  async dispatch(projectId: string, event: string, payload: object): Promise<void> {
    const webhooks = await this.webhookRepo.findActiveByProject(projectId);

    const matchingWebhooks = webhooks.filter((webhook) => {
      const events = JSON.parse(webhook.events) as string[];
      return events.includes(event);
    });

    for (const webhook of matchingWebhooks) {
      this.dispatchToWebhook(webhook.url, webhook.secret, event, payload).catch((err) => {
        this.logger.warn(`Webhook dispatch failed for ${webhook.url}: ${err}`);
      });
    }
  }

  private async dispatchToWebhook(
    url: string,
    secret: string,
    event: string,
    payload: object,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const sig = this.sign(body, secret);

    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Koda-Signature': `sha256=${sig}`,
        'X-Koda-Event': event,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
  }

  private sign(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }
}
