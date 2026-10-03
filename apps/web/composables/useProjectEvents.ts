import { onBeforeUnmount, onMounted } from 'vue'
import { apiPath } from '~/lib/api-path'
import { createProjectEventHub } from '~/lib/project-event-hub'
import type { ProjectEventHub } from '~/lib/project-event-hub'
import type { EventSourceLike, ProjectEventHandlers } from '~/lib/project-event-stream'

let hub: ProjectEventHub | null = null
/** The newest component's useAuth().refresh; the shared stream reads it when it needs to recover. */
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
 * Live updates for one project (Track 1 Slice 5). Client-only: subscribes on mount and unsubscribes on unmount.
 * Every subscriber in the tab shares one EventSource per project (S1.5 1b D246).
 */
export function useProjectEvents(slug: string, handlers: ProjectEventHandlers): void {
  const { refresh } = useAuth()
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    latestRefresh = refresh
    unsubscribe = sharedHub().subscribe(apiPath`/api/projects/${slug}/events`, handlers)
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
