import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { OutboxService } from '../outbox/outbox.service';

@Injectable()
export class WebhookDispatcherService {
  constructor(
    private readonly webhookRepo: PrismaWebhookRepository,
    private readonly outboxService: OutboxService,
  ) {}

  async dispatch(projectId: string, event: string, payload: object): Promise<void> {
    const webhooks = await this.webhookRepo.findActiveByProject(projectId);

    const matchingWebhooks = webhooks.filter((webhook) => {
      const events = JSON.parse(webhook.events) as string[];
      return events.includes(event);
    });

    await Promise.all(
      matchingWebhooks.map((webhook) =>
        this.outboxService.enqueue({
          projectId,
          eventType: 'webhook_delivery',
          eventId: randomUUID(),
          payload: {
            webhookId: webhook.id,
            event,
            payload,
          },
        }),
      ),
    );
  }
}
