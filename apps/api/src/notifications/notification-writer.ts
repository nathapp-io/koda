import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NotificationChannel } from '@nathapp/nestjs-notify';
import { UserEventBus } from '../live/user-event-bus';
import { EmailAvailability } from '../email/email-availability';
import { APPROVAL_REQUESTED_KIND, EMAIL_APPROVAL_DELAY_SEC, EMAIL_DELAY_SEC } from '../email/email.constants';
import { EmailScheduleService } from '../email/schedule/email-schedule.service';
import { NewNotificationEmail } from '../email/schedule/email-schedule.types';
import { NotificationEmailRecipients } from '../email/notification-email-recipients';
import { NotificationEligibility } from './notification-eligibility';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsRepository } from './notifications.repository';
import type {
  NotificationCategory, NotificationDraft, NotificationInserted,
} from './notification.types';

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Fleet S4a §2.1: the only writer of notifications. Eligibility, then IN_APP preferences per category,
 * then one idempotent insert (D501), then a content-free live signal per inserted row. Throws only
 * when the database does, so an outbox handler that calls it is retried.
 *
 * S4b US-002: when email is configured, one `EmailSchedule` row per email-opted-in inserted notification
 * is scheduled inside the same transaction, so a scheduling failure rolls the insert back and the outbox
 * retry redoes both. The live publishes run only after that transaction commits.
 */
@Injectable()
export class NotificationWriter {
  constructor(
    private readonly eligibility: NotificationEligibility,
    private readonly preferences: NotificationPreferencesService,
    private readonly repo: NotificationsRepository,
    private readonly bus: UserEventBus,
    private readonly email: EmailAvailability,
    private readonly schedule: EmailScheduleService,
    private readonly recipients: NotificationEmailRecipients,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async deliver(drafts: readonly NotificationDraft[]): Promise<number> {
    if (drafts.length === 0) return 0;
    const eligible = await this.eligibility.filter(drafts);
    const allowed = await this.applyPreferences(eligible);
    const inserted = await this.txManager.run(async () => {
      const rows = await this.repo.insertMany(allowed);
      if (this.email.configured) await this.scheduleEmails(rows);
      return rows;
    });
    const at = new Date().toISOString();
    for (const row of inserted) this.bus.publish({ type: 'notification', userId: row.userId, id: row.id, at });
    return inserted.length;
  }

  private async applyPreferences(drafts: readonly NotificationDraft[]): Promise<readonly NotificationDraft[]> {
    if (drafts.length === 0) return [];
    const categories = unique(drafts.map((d) => d.category));
    const off = new Map<NotificationCategory, ReadonlySet<string>>(await Promise.all(categories.map(async (category) => {
      const userIds = unique(drafts.filter((d) => d.category === category).map((d) => d.userId));
      return [category, await this.preferences.disabledUserIds(userIds, category, NotificationChannel.IN_APP)] as const;
    })));
    return drafts.filter((d) => !off.get(d.category)?.has(d.userId));
  }

  /**
   * D518/D519: one email row per inserted notification whose user opted into email for its category, due
   * `EMAIL_DELAY_SEC` after the notification (or `EMAIL_APPROVAL_DELAY_SEC` for an approval request).
   */
  private async scheduleEmails(rows: readonly NotificationInserted[]): Promise<void> {
    if (rows.length === 0) return;
    const categories = unique(rows.map((r) => r.category));
    const allowedByCategory = new Map<NotificationCategory, ReadonlySet<string>>(await Promise.all(
      categories.map(async (category) => {
        const userIds = unique(rows.filter((r) => r.category === category).map((r) => r.userId));
        return [category, await this.preferences.emailAllowedUserIds(userIds, category)] as const;
      }),
    ));
    const optedIn = rows.filter((r) => allowedByCategory.get(r.category)?.has(r.userId));
    if (optedIn.length === 0) return;
    const addresses = await this.recipients.emails(unique(optedIn.map((r) => r.userId)));
    await this.schedule.scheduleNotifications(optedIn.map((r): NewNotificationEmail => ({
      notificationId: r.id,
      userId: r.userId,
      toEmail: addresses.get(r.userId) ?? '',
      dueAt: new Date(r.createdAt.getTime() + this.delayMs(r.kind)),
    })));
  }

  private delayMs(kind: string): number {
    const seconds = kind === APPROVAL_REQUESTED_KIND ? EMAIL_APPROVAL_DELAY_SEC : EMAIL_DELAY_SEC;
    return seconds * 1000;
  }
}

