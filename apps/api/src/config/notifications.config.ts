import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const NOTIFICATIONS_CFG = 'notifications';
export const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;

export interface INotificationsConfig {
  /** Days a read notification survives before the nightly purge. null disables the purge. */
  retentionDays: number | null;
}

export class NotificationsConfigSchema {
  // Digits-only to match the Joi `NOTIFICATION_RETENTION_DAYS` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^\d+$/)
  NOTIFICATION_RETENTION_DAYS?: string;
}

/**
 * Fleet S4a (D511): read notifications are purged after NOTIFICATION_RETENTION_DAYS (default 90);
 * unread rows are kept. Same default rule as outbox retention: off under NODE_ENV=test; 0 is the
 * kill switch.
 */
export const notificationsConfig = registerAs(NOTIFICATIONS_CFG, (): INotificationsConfig => {
  validateUtil(process.env, NotificationsConfigSchema);
  const raw = process.env['NOTIFICATION_RETENTION_DAYS'];
  if (raw !== undefined) {
    const days = parseInt(raw, 10);
    return { retentionDays: days > 0 ? days : null };
  }
  return { retentionDays: process.env['NODE_ENV'] !== 'test' ? DEFAULT_NOTIFICATION_RETENTION_DAYS : null };
});
