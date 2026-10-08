import type { Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { NOTIFICATIONS_PATH, READ_ALL_PATH, UNREAD_COUNT_PATH } from '~/lib/notification-types'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

/** The bell dropdown shows the newest 10 (S4a §5). */
export const LATEST_SIZE = 10
/** The inbox page size. */
export const LIST_SIZE = 20

/**
 * Fleet S4a §5: the signed-in user's inbox. `unreadCount` and `latest` live in tab state so the bell and the
 * inbox page show the same numbers; the API is the authority (every call is scoped to the caller).
 */
export function useNotifications() {
  const { $api } = useApi()
  // Keyed by user: after a logout the next user on this tab must never see the previous inbox, even briefly.
  const owner = useAuth().user.value?.id ?? 'anonymous'
  const unreadCount = useState<number>(`notifications-unread:${owner}`, () => 0) as Ref<number>
  const latest = useState<NotificationDto[]>(`notifications-latest:${owner}`, () => []) as Ref<NotificationDto[]>

  async function refresh(): Promise<void> {
    const [count, page] = await Promise.all([
      $api.get<{ count: number }>(UNREAD_COUNT_PATH),
      $api.get<NotificationPage>(NOTIFICATIONS_PATH, { query: { current: '1', size: String(LATEST_SIZE) } }),
    ])
    unreadCount.value = count.count
    latest.value = page.records ?? []
  }

  async function markRead(id: string): Promise<void> {
    await $api.post(apiPath`/me/notifications/${id}/read`)
    await refresh()
  }

  async function markAllRead(): Promise<void> {
    await $api.post(READ_ALL_PATH)
    await refresh()
  }

  async function list(opts: { current: number; unreadOnly: boolean }): Promise<NotificationPage> {
    const query: Record<string, string> = { current: String(opts.current), size: String(LIST_SIZE) }
    return $api.get<NotificationPage>(NOTIFICATIONS_PATH, { query: opts.unreadOnly ? { ...query, unread: 'true' } : query })
  }

  return { unreadCount, latest, refresh, markRead, markAllRead, list }
}
