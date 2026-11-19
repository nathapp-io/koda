import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { IRetentionConfig, RETENTION_CFG } from '../config/retention.config';
import { SystemWriter } from '../permissions/system-writer.decorator';
import { PrismaWebhookDeliveryRepository } from './prisma-webhook-delivery.repository';

/**
 * US-002: nightly purge of inbound `WebhookDelivery` rows older than WEBHOOK_DELIVERY_RETENTION_DAYS.
 * 04:00 is the outbox purge, 04:30 the notification purge; this runs at 05:00 and the audit log purge
 * at 05:30. A failed purge is logged and swallowed — the next night's run is the retry, and the row
 * stays for it.
 *
 * The row is also the replay guard's dedup record, so purging it means a delivery id older than the
 * horizon is no longer refused (ruling 10 accepts that; the guard's comment says "for the retention
 * horizon").
 */
@Injectable()
@SystemWriter('system.webhook-delivery.retention')
export class WebhookDeliveryRetentionProcessor {
  private readonly logger = new Logger(WebhookDeliveryRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    private readonly repository: PrismaWebhookDeliveryRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditRecorder,
  ) {}

  /** The cron method is the background entry; the purge runs as `webhook-delivery`. */
  @Cron('0 5 * * *')
  scheduledPurge(): Promise<void> {
    return runAsSystemWriter(this, () => this.purgeReceivedDeliveries());
  }

  private async purgeReceivedDeliveries(): Promise<void> {
    const days = this.config.get<IRetentionConfig>(RETENTION_CFG)?.webhookDeliveryDays;
    if (days === null || days === undefined || days <= 0) {
      return;
    }
    const before = new Date(Date.now() - days * WebhookDeliveryRetentionProcessor.DAY_MS);
    try {
      // The delete and its entry commit together, so a rejected record keeps the rows for the next
      // night and the catch below logs it.
      const deleted = await this.audit.audited(
        () => this.repository.deleteReceivedBefore(before),
        (count) => count === 0 ? [] : [{
          key: 'system.webhook-delivery.retention',
          resourceType: 'webhook-delivery',
          resourceId: 'all',
          projectId: null,
          summary: `purged ${count} webhook deliveries`,
        }],
      );
      this.logger.log(`Purged ${deleted} webhook delivery row(s) received before ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Webhook delivery retention purge failed, will retry next run: ${message}`, stack);
    }
  }
}
