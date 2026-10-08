/** S4a §1/§3: the five notification categories, in the order the settings page lists them. */
export const NOTIFICATION_CATEGORIES = ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** GET /me/notifications rows (S4a §3). Times are ISO strings. */
export interface NotificationDto {
  id: string
  category: NotificationCategory
  /** e.g. ticket_assigned, job_escalated; the web words it from `notifications.kinds.<kind>`. */
  kind: string
  /** English fallback text for kinds this build does not know. */
  title: string
  body: string | null
  /** In-app path, e.g. /koda/tickets/KODA-12. */
  link: string
  params: Record<string, string | number>
  projectId: string | null
  actorId: string | null
  readAt: string | null
  createdAt: string
}

/** The `@nathapp` Page<T> envelope every koda list returns (KodaPageQuery: `current`, `size`). */
export interface NotificationPage {
  records: NotificationDto[]
  total: number
  size: number
  current: number
  hasNext: boolean
  hasPrev?: boolean
}

export interface NotificationPreferenceDto {
  category: NotificationCategory
  inApp: boolean
  email: boolean
}

export interface PreferencesView {
  emailAvailable: boolean
  emailEnabled: boolean
  items: NotificationPreferenceDto[]
}

/** PUT/DELETE .../watch and GET .../watchers; `count` = unmuted watchers. */
export interface WatchStateDto {
  watching: boolean
  count: number
}

export const NOTIFICATIONS_PATH = '/me/notifications'
export const UNREAD_COUNT_PATH = '/me/notifications/unread-count'
export const READ_ALL_PATH = '/me/notifications/read-all'
export const PREFERENCES_PATH = '/me/notification-preferences'
export const NOTIFICATION_PAGE_PARAM = 'current'
export const NOTIFICATION_PAGE_SIZE_PARAM = 'size'
