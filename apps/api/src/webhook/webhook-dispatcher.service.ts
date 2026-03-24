import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class WebhookDispatcherService {
  constructor(private prisma: PrismaService<PrismaClient>) {}

  async dispatch(projectId: string, event: string, payload: object): Promise<void> {
    const webhooks = await this.prisma.client.webhook.findMany({
      where: { projectId, active: true },
    });

    // Filter webhooks that have the event in their events array
    const matchingWebhooks = webhooks.filter((webhook: { events: string }) => {
      const events = JSON.parse(webhook.events) as string[];
      return events.includes(event);
    });

    for (const webhook of matchingWebhooks) {
      this.dispatchToWebhook(webhook.url, webhook.secret, event, payload).catch((err) => {
        // fire-and-forget — log but don't throw
        console.warn(`Webhook dispatch failed for ${webhook.url}:`, err);
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
