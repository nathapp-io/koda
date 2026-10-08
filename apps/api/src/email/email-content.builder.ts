import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';
import { EmailAvailability } from './email-availability';
import { EmailScheduleRow, SkipReason } from './schedule/email-schedule.types';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import type { NotificationCategory } from '../notifications/notification.types';

/**
 * Fleet S4b US-002: turns one claimed `EmailSchedule` row into either a skip reason or the template
 * data the notify service renders. The dispatcher never reads a notification itself.
 */
export type EmailContent =
  | { skip: SkipReason }
  | { data: Record<string, unknown>; userId: string | null };

/**
 * Fleet S4b US-002: the notification-email build order — SOURCE_GONE, READ, USER_DISABLED, the
 * `emailAllowed` reason, then the template data. MEMBER_ADDED content belongs to US-004.
 */
@Injectable()
export class EmailContentBuilder {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly preferences: NotificationPreferencesService,
    private readonly email: EmailAvailability,
  ) {}

  async build(row: EmailScheduleRow): Promise<EmailContent> {
    // US-004 test-writer stub (RED): the implementer owns the MEMBER_ADDED build order.
    if (row.kind === 'MEMBER_ADDED') return { skip: 'READ' };

    if (row.kind !== 'NOTIFICATION' || !row.notificationId) return { skip: 'SOURCE_GONE' };

    const notification = await this.prisma.client.notification.findUnique({
      where: { id: row.notificationId },
      select: { id: true, readAt: true, category: true, title: true, body: true, link: true },
    });
    if (!notification) return { skip: 'SOURCE_GONE' };
    if (notification.readAt) return { skip: 'READ' };

    const user = row.userId
      ? await this.prisma.client.user.findUnique({ where: { id: row.userId }, select: { id: true, disabled: true } })
      : null;
    if (!user || user.disabled) return { skip: 'USER_DISABLED' };

    const decision = await this.preferences.emailAllowed(user.id, notification.category as NotificationCategory);
    if (decision.allowed === false) return { skip: decision.reason };

    return {
      data: {
        title: notification.title,
        body: notification.body ?? '',
        url: this.email.webUrl(notification.link),
        prefsUrl: this.email.webUrl('/settings/notifications'),
      },
      userId: user.id,
    };
  }
}
