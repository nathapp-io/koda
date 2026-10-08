import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { IPreferenceService, PREFERENCE_SERVICE } from '@nathapp/nestjs-notify';
import { EmailAvailability } from '../email/email-availability';
import { NotificationCategory, NotificationChannelValue } from './notification.types';

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

/**
 * Fleet S4a D503 + S4b §3.1: in-app switches in `NotificationCategoryPreference`; the email master switch is
 * nestjs-notify's `NotificationPreference` `(userId, KODA_TENANT_ID, 'email')`; email per-category defaults are
 * `EMAIL_CATEGORY_DEFAULTS`. A missing row means on (in-app) / per-default (email).
 *
 * US-001: `disabledUserIds` is the S4a implementation; the email/preferences methods below are STUBS that the
 * implementer replaces with real reads and writes.
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

  /** STUB (US-001): the implementer returns availability plus master/email/in-app values. */
  async list(_userId: string): Promise<PreferencesView> {
    return { emailAvailable: false, emailEnabled: false, items: [] };
  }

  /** STUB (US-001). */
  async update(_userId: string, _change: PreferencesChange): Promise<void> {}

  /** STUB (US-001): the implementer applies the master switch, then the row, then the category default. */
  async emailAllowedUserIds(_userIds: readonly string[], _category: NotificationCategory): Promise<ReadonlySet<string>> {
    return new Set();
  }

  /** STUB (US-001). */
  async emailAllowed(_userId: string, _category: NotificationCategory): Promise<EmailDecision> {
    return { allowed: true };
  }
}
