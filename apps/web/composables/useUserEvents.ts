import { onBeforeUnmount, onMounted } from 'vue'
import { useVisiblePolling } from '~/composables/useVisiblePolling'
import { createProjectEventHub } from '~/lib/project-event-hub'
import type { ProjectEventHub } from '~/lib/project-event-hub'
import type { EventSourceLike } from '~/lib/project-event-stream'

export const USER_EVENTS_URL = '/api/me/events'
/** S4a §5: backstop poll; the stream is refused past the per-user stream cap (D509) or when the API is down. */
export const USER_EVENTS_POLL_MS = 60_000

let hub: ProjectEventHub | null = null
let latestRefresh: () => Promise<boolean> = async () => false

/** Created on first client mount only, so it never exists during SSR. */
function sharedHub(): ProjectEventHub {
  hub ??= createProjectEventHub({
    createEventSource: url => new EventSource(url) as unknown as EventSourceLike,
    refreshAuth: () => latestRefresh(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  return hub
}

/**
 * Fleet S4a §5: the signed-in user's notification notices. Every subscriber in the tab shares one EventSource
 * (the bell and the inbox page); `onEvent` also runs on resync and every 60 s while the tab is visible.
 * Client-only: subscribes on mount and unsubscribes on unmount.
 */
export function useUserEvents(onEvent: () => void): void {
  const { refresh } = useAuth()
  const polling = useVisiblePolling(async () => { onEvent() }, USER_EVENTS_POLL_MS)
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    polling.start()
    if (typeof EventSource === 'undefined') return
    latestRefresh = refresh
    unsubscribe = sharedHub().subscribe(USER_EVENTS_URL, {
      onNotification: () => onEvent(),
      onResync: () => onEvent(),
    })
  })

  onBeforeUnmount(() => {
    polling.stop()
    unsubscribe?.()
    unsubscribe = null
  })
}
