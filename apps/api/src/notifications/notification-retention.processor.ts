import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { INotificationsConfig, NOTIFICATIONS_CFG } from '../config/notifications.config';
import { NotificationsRepository } from './notifications.repository';
import { FleetHealthAlertsRepository } from './fleet/fleet-health-alerts.repository';

const HEALTH_ALERT_RETENTION_MS = 30 * 86_400_000;

const DAY_MS = 86_400_000;

/**
 * Fleet S4a (D511): nightly purge of read notifications older than NOTIFICATION_RETENTION_DAYS.
 * 04:00 is the outbox purge; this runs at 04:30. A failed purge is logged and swallowed — the next
 * night's run is the retry.
 */
@Injectable()
export class NotificationRetentionProcessor {
  private readonly logger = new Logger(NotificationRetentionProcessor.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly config: ConfigService,
    private readonly healthAlerts: FleetHealthAlertsRepository,
  ) {}

  @Cron('30 4 * * *')
  async scheduledPurge(): Promise<void> {
    await this.purge(new Date());
  }

  /** Each purge step logs and swallows its own failure, so one failing step never skips the next (Part D adds one). */
  async purge(now: Date): Promise<void> {
    await this.purgeReadNotifications(now);
    await this.purgeClosedHealthAlerts(now);
  }

  /** S4a §1: closed health episodes are kept 30 days, open ones forever. */
  private async purgeClosedHealthAlerts(now: Date): Promise<void> {
    try {
      const deleted = await this.healthAlerts.purgeClosed(new Date(now.getTime() - HEALTH_ALERT_RETENTION_MS));
      this.logger.log(`Purged ${deleted} closed fleet health alert(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Fleet health alert purge failed, will retry next run: ${message}`);
    }
  }

  private async purgeReadNotifications(now: Date): Promise<void> {
    const days = this.config.get<INotificationsConfig>(NOTIFICATIONS_CFG)?.retentionDays;
    if (days === null || days === undefined || days <= 0) return;
    const before = new Date(now.getTime() - days * DAY_MS);
    try {
      const deleted = await this.repo.purgeRead(before);
      this.logger.log(`Purged ${deleted} read notification(s) read before ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Notification retention purge failed, will retry next run: ${message}`);
    }
  }
}
