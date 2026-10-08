/**
 * Fleet S4b §2.2: kinds, statuses and constants of the `EmailSchedule` table.
 *
 * US-001: type/constant declarations only — the implementer owns persistence and claiming.
 */
export type EmailKind = 'NOTIFICATION' | 'INVITE' | 'MEMBER_ADDED';
export type EmailStatus = 'PENDING' | 'SENDING' | 'SENT' | 'SKIPPED' | 'FAILED';
export type SkipReason = 'READ' | 'EMAIL_OFF' | 'CATEGORY_OFF' | 'USER_DISABLED' | 'SOURCE_GONE';

/** Claim lock: two minutes (spec §2.2). */
export const LOCK_MS = 2 * 60_000;
/** `lastError` is capped at 500 characters (US-001 AC7). */
export const LAST_ERROR_MAX = 500;

export interface EmailScheduleRow {
  id: string;
  kind: EmailKind;
  notificationId: string | null;
  inviteId: string | null;
  userId: string | null;
  projectId: string | null;
  toEmail: string;
  locale: string;
  attempts: number;
  dueAt: Date;
}

export interface NewNotificationEmail {
  notificationId: string;
  userId: string;
  toEmail: string;
  dueAt: Date;
}

export interface MemberAddedEmail {
  userId: string;
  projectId: string;
  toEmail: string;
  locale: string;
  dueAt: Date;
}

export interface InviteSend {
  inviteId: string;
  toEmail: string;
  locale: string;
  now: Date;
}
