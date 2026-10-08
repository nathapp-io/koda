import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NOTIFICATION_CATEGORIES, NotificationCategory, NotificationChannel } from './notification.types';

export interface PreferenceItem {
  category: NotificationCategory;
  inApp: boolean;
}

/** Fleet S4a §1 (D503): (user, category, channel) switches; a missing row means enabled. */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /** Throws on a read failure: the producer's outbox retry is safer than notifying someone who opted out. */
  async disabledUserIds(userIds: readonly string[], category: NotificationCategory, channel: NotificationChannel): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db.notificationPreference.findMany({
      where: { userId: { in: [...userIds] }, category, channel, enabled: false },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  async list(userId: string): Promise<readonly PreferenceItem[]> {
    const rows = await this.db.notificationPreference.findMany({
      where: { userId, channel: 'IN_APP' },
      select: { category: true, enabled: true },
    });
    const enabled = new Map(rows.map((r) => [r.category, r.enabled]));
    return NOTIFICATION_CATEGORIES.map((category) => ({ category, inApp: enabled.get(category) ?? true }));
  }

  async update(userId: string, changes: readonly PreferenceItem[]): Promise<void> {
    await this.txManager.run(async () => {
      for (const change of changes) {
        await this.db.notificationPreference.upsert({
          where: { userId_category_channel: { userId, category: change.category, channel: 'IN_APP' } },
          create: { userId, category: change.category, channel: 'IN_APP', enabled: change.inApp },
          update: { enabled: change.inApp },
        });
      }
    });
  }
}
