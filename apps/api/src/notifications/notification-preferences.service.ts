import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { IPreferenceService, PREFERENCE_SERVICE } from '@nathapp/nestjs-notify';
import { EmailAvailability } from '../email/email-availability';
import { KODA_TENANT_ID } from '../email/koda-tenant';
import {
  EMAIL_CATEGORY_DEFAULTS, NOTIFICATION_CATEGORIES, NotificationCategory, NotificationChannelValue,
} from './notification.types';

export interface PreferenceItem {
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
}

export interface PreferencesView {
  emailAvailable: boolean;
  emailEnabled: boolean;
  items: readonly PreferenceItem[];
}

export interface PreferencesChange {
  emailEnabled?: boolean;
  items?: ReadonlyArray<{ category: NotificationCategory; inApp?: boolean; email?: boolean }>;
}

export type EmailDecision = { allowed: true } | { allowed: false; reason: 'EMAIL_OFF' | 'CATEGORY_OFF' };

const IN_APP = 'in_app';
const EMAIL = 'email';

/**
 * Fleet S4a D503 + S4b §3.1: in-app switches in `NotificationCategoryPreference`; the email master switch is
 * nestjs-notify's `NotificationPreference` `(userId, KODA_TENANT_ID, 'email')`; email per-category defaults are
 * `EMAIL_CATEGORY_DEFAULTS`. A missing row means on (in-app) / per-default (email).
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(PREFERENCE_SERVICE) private readonly packagePrefs: IPreferenceService,
    private readonly email: EmailAvailability,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /** Throws on a read failure: the producer's outbox retry is safer than notifying someone who opted out. */
  async disabledUserIds(userIds: readonly string[], category: NotificationCategory, channel: NotificationChannelValue): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db.notificationCategoryPreference.findMany({
      where: { userId: { in: [...userIds] }, category, channel, enabled: false },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /** Availability plus the master switch and every category's in-app/email values. */
  async list(userId: string): Promise<PreferencesView> {
    const [categoryRows, masterRows] = await Promise.all([
      this.db.notificationCategoryPreference.findMany({
        where: { userId, channel: { in: [IN_APP, EMAIL] } },
        select: { category: true, channel: true, enabled: true },
      }),
      this.db.notificationPreference.findMany({
        where: { userId, tenantId: KODA_TENANT_ID, channel: EMAIL },
        select: { enabled: true },
      }),
    ]);
    const inApp = new Map(categoryRows.filter((r) => r.channel === IN_APP).map((r) => [r.category, r.enabled]));
    const email = new Map(categoryRows.filter((r) => r.channel === EMAIL).map((r) => [r.category, r.enabled]));
    const items = NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      inApp: inApp.get(category) ?? true,
      email: email.get(category) ?? EMAIL_CATEGORY_DEFAULTS[category],
    }));
    const master = masterRows[0];
    return {
      emailAvailable: this.email.configured,
      emailEnabled: master ? master.enabled : true,
      items,
    };
  }

  /** Writes only the supplied fields: the master switch through the package service, each item per channel. */
  async update(userId: string, change: PreferencesChange): Promise<void> {
    if (change.emailEnabled !== undefined) {
      await this.packagePrefs.updatePreference(userId, KODA_TENANT_ID, EMAIL, change.emailEnabled);
    }
    const items = change.items ?? [];
    if (items.length === 0) return;
    await this.txManager.run(async () => {
      const client = this.txnClient();
      for (const item of items) {
        if (item.inApp !== undefined) await this.upsertCategory(client, userId, item.category, IN_APP, item.inApp);
        if (item.email !== undefined) await this.upsertCategory(client, userId, item.category, EMAIL, item.email);
      }
    });
  }

  /** The transactional Prisma client when one is open; otherwise the global one. */
  private txnClient(): PrismaClient {
    return this.txManager.getClient<PrismaClient>() ?? this.db;
  }

  /** The users for whom both the master switch and the category's email switch are on. */
  async emailAllowedUserIds(userIds: readonly string[], category: NotificationCategory): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const ids = [...userIds];
    const [masterRows, categoryRows] = await Promise.all([
      this.db.notificationPreference.findMany({
        where: { userId: { in: ids }, tenantId: KODA_TENANT_ID, channel: EMAIL },
        select: { userId: true, enabled: true },
      }),
      this.db.notificationCategoryPreference.findMany({
        where: { userId: { in: ids }, category, channel: EMAIL },
        select: { userId: true, enabled: true },
      }),
    ]);
    const master = new Map(masterRows.map((r) => [r.userId, r.enabled]));
    const categoryPref = new Map(categoryRows.map((r) => [r.userId, r.enabled]));
    const allowed = new Set<string>();
    for (const id of ids) {
      if (master.get(id) === false) continue;
      const on = categoryPref.get(id) ?? EMAIL_CATEGORY_DEFAULTS[category];
      if (on) allowed.add(id);
    }
    return allowed;
  }

  /** Why one user's email for one category is or is not allowed; EMAIL_OFF outranks CATEGORY_OFF. */
  async emailAllowed(userId: string, category: NotificationCategory): Promise<EmailDecision> {
    const [masterRows, categoryRows] = await Promise.all([
      this.db.notificationPreference.findMany({
        where: { userId, tenantId: KODA_TENANT_ID, channel: EMAIL },
        select: { enabled: true },
      }),
      this.db.notificationCategoryPreference.findMany({
        where: { userId, category, channel: EMAIL },
        select: { enabled: true },
      }),
    ]);
    if (masterRows[0]?.enabled === false) return { allowed: false, reason: 'EMAIL_OFF' };
    const categoryOn = categoryRows[0] ? categoryRows[0].enabled : EMAIL_CATEGORY_DEFAULTS[category];
    if (!categoryOn) return { allowed: false, reason: 'CATEGORY_OFF' };
    return { allowed: true };
  }

  private async upsertCategory(client: PrismaClient, userId: string, category: NotificationCategory, channel: string, enabled: boolean): Promise<void> {
    await client.notificationCategoryPreference.upsert({
      where: { userId_category_channel: { userId, category, channel } },
      create: { userId, category, channel, enabled },
      update: { enabled },
    });
  }
}
