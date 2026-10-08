import type { NotificationDto } from '~/lib/notification-types'

export interface NotificationI18n {
  t: (key: string, named?: Record<string, unknown>) => string
  te: (key: string) => boolean
}

/** S4a §1: the web words a notification from `kind` + `params`; an unknown kind shows the API's English title. */
export function notificationText(n: NotificationDto, i18n: NotificationI18n): string {
  const key = `notifications.kinds.${n.kind}`
  return i18n.te(key) ? i18n.t(key, { ...n.params }) : n.title
}

/** A notification link is followed only when it is a same-origin path (never `//host` or a scheme). */
export function isInAppPath(link: unknown): link is string {
  return typeof link === 'string' && /^\/(?!\/)/.test(link)
}
