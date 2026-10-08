import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NotificationChannel } from '@nathapp/nestjs-notify';
import { UserEventBus } from '../live/user-event-bus';
import { EmailAvailability } from '../email/email-availability';
import { EmailScheduleService } from '../email/schedule/email-schedule.service';
import { NotificationEmailRecipients } from '../email/notification-email-recipients';
import { NotificationEligibility } from './notification-eligibility';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsRepository } from './notifications.repository';
import type { NotificationCategory, NotificationDraft } from './notification.types';

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Fleet S4a §2.1: the only writer of notifications. Eligibility, then IN_APP preferences per category,
 * then one idempotent insert (D501), then a content-free live signal per inserted row. Throws only
 * when the database does, so an outbox handler that calls it is retried.
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
    const inserted = await this.repo.insertMany(allowed);
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
}
