import { NotificationChannel } from '@nathapp/nestjs-notify';

/** Fleet S4a: the notification contract shared by the pipeline, producers and API (spec §1-§3). */
export const NOTIFICATION_CATEGORIES = ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** S4b D524: nestjs-notify's lowercase channel values. */
export type NotificationChannelValue = `${NotificationChannel.IN_APP}` | `${NotificationChannel.EMAIL}`;
export const NOTIFICATION_CHANNELS: readonly NotificationChannelValue[] = [NotificationChannel.IN_APP, NotificationChannel.EMAIL];

/**
 * S4b D517 (US-001): email default per category when a user has no `(category, 'email')` row. The in-app
 * default stays "missing row = on".
 */
export const EMAIL_CATEGORY_DEFAULTS: Readonly<Record<NotificationCategory, boolean>> = {
  ASSIGNED: true,
  MENTIONED: true,
  FLEET_NEEDS_YOU: true,
  WATCHED_ACTIVITY: false,
  FLEET_HEALTH: false,
};

export const WATCH_REASONS = ['REPORTER', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL'] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];

export type NotificationSourceType =
  'ticket_event' | 'fleet_job' | 'fleet_approval' | 'fleet_budget_incident' | 'fleet_health_alert';

export type NotificationParams = Readonly<Record<string, string | number>>;

export interface NotificationDraft {
  readonly userId: string;
  readonly projectId: string | null;
  readonly category: NotificationCategory;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly link: string;
  readonly params: NotificationParams;
  readonly sourceType: NotificationSourceType;
  readonly sourceId: string;
  readonly actorId: string | null;
}

/**
 * S4b US-002: what `NotificationsRepository.insertMany` returns for each row it actually inserted.
 * The scheduling fields let `NotificationWriter` build one `EmailSchedule` row per new notification.
 */
export interface NotificationInserted {
  id: string;
  userId: string;
  category: NotificationCategory;
  kind: string;
  createdAt: Date;
}

export interface NotificationRow {
  id: string;
  userId: string;
  projectId: string | null;
  category: string;
  kind: string;
  title: string;
  body: string | null;
  link: string;
  params: NotificationParams;
  actorId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export const TITLE_MAX = 200;
export const BODY_MAX = 280;

/**
 * One-line excerpt of at most `max` UTF-16 units: whitespace runs collapse to one space; text over
 * the limit is cut at a code-point boundary and ends with '…' (Review Focus 4).
 */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const points = Array.from(flat);
  const kept: string[] = [];
  let length = 0;
  for (const point of points) {
    if (length + point.length > max - 1) break;
    kept.push(point);
    length += point.length;
  }
  return `${kept.join('')}…`;
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}
