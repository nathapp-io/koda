import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { PrismaWebhookRepository } from './prisma-webhook.repository';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly webhookRepo: PrismaWebhookRepository,
    private readonly outbox: NathappOutboxService,
  ) {}

  /**
   * Records one webhook_delivery outbox row per active webhook subscribed to
   * `event`. Call inside the triggering write's txManager.run so the rows
   * commit with it. Sequential: Prisma interactive transactions must not run
   * queries in parallel.
   */
  async dispatch(projectId: string, event: string, payload: object): Promise<void> {
    const webhooks = await this.webhookRepo.findActiveByProject(projectId);
    for (const webhook of webhooks) {
      if (!this.subscribesTo(webhook, event)) continue;
      await this.outbox.record({
        type: 'webhook_delivery',
        payload: { webhookId: webhook.id, event, payload },
        metadata: { projectId, eventId: randomUUID() },
      });
    }
  }

  /** A malformed events column must not fail the triggering write: skip and log it. */
  private subscribesTo(webhook: { id: string; events: string }, event: string): boolean {
    try {
      const events = JSON.parse(webhook.events) as unknown;
      return Array.isArray(events) && events.includes(event);
    } catch {
      this.logger.warn(`Webhook ${webhook.id} has malformed events JSON; skipping`);
      return false;
    }
  }
}
