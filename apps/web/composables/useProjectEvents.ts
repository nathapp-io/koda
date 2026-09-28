import { onBeforeUnmount, onMounted } from 'vue'
import { apiPath } from '~/lib/api-path'
import {
  createProjectEventStream,
  type EventSourceLike,
  type ProjectEventHandlers,
} from '~/lib/project-event-stream'

/**
 * Live ticket updates for one project (Track 1 Slice 5). Client-only: opens
 * the stream on mount and closes it on unmount, so it never runs during SSR.
 */
export function useProjectEvents(slug: string, handlers: ProjectEventHandlers): void {
  const { refresh } = useAuth()
  let stream: { close: () => void } | null = null

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    stream = createProjectEventStream(apiPath`/api/projects/${slug}/events`, handlers, {
      createEventSource: url => new EventSource(url) as unknown as EventSourceLike,
      refreshAuth: refresh,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
  })

  onBeforeUnmount(() => {
    stream?.close()
    stream = null
  })
}
