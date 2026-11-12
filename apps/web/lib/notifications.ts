import type { NotificationDto } from '~/lib/notification-types'
import { humanizeCode } from '~/lib/humanize-code'

export interface NotificationI18n {
  t: (key: string, named?: Record<string, unknown>) => string
  te: (key: string) => boolean
}

/** S4a §1: the web words a notification from `kind` + `params`; an unknown kind shows the API's English title. */
export function notificationText(n: NotificationDto, i18n: NotificationI18n): string {
  const key = `notifications.kinds.${n.kind}`
  return i18n.te(key) ? i18n.t(key, { ...n.params }) : n.title
}

/** A localized detail for flow stops; other notification kinds keep their API-provided body. */
export function notificationDetail(n: NotificationDto, i18n: NotificationI18n): string | null {
  if (n.kind !== 'flow_stopped' || typeof n.params.stopReason !== 'string') return n.body
  const key = `fleet.flows.stopReason.${n.params.stopReason}`
  return i18n.te(key) ? i18n.t(key) : humanizeCode(n.params.stopReason)
}

/** A notification link is followed only when it is a same-origin path (never `//host` or a scheme). */
export function isInAppPath(link: unknown): link is string {
  return typeof link === 'string' && /^\/(?!\/)/.test(link)
}
