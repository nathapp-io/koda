/**
 * Fleet S5a §4 (US-003): production adapter for the thread controller.
 *
 * Owns the page's one EventSource to the thread events route and the browser timers/clock; the
 * controller itself (`~/lib/thread-controller`) stays framework-free. Client-only: `load()` then
 * `start()` on mount, `stop()` on unmount.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { apiPath } from '~/lib/api-path'
import { createThreadController, type ThreadController } from '~/lib/thread-controller'
import { createThreadEventStream } from '~/lib/thread-event-stream'
import type { EventSourceLike } from '~/lib/project-event-stream'

/** The thread page's controller: thread/messages/live state, optimistic send and actions. */
export function useThread(slug: string, threadId: string): ThreadController {
  const { $api } = useApi()
  const { refresh } = useAuth()
  const controller = createThreadController({
    api: $api,
    slug,
    threadId,
    openStream: (handlers) =>
      createThreadEventStream(
        apiPath`/api/projects/${slug}/threads/${threadId}/events`,
        handlers,
        {
          createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
          refreshAuth: () => refresh(),
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      ),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  })

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    void controller.load().then(() => {
      controller.start()
    })
  })

  onBeforeUnmount(() => {
    controller.stop()
  })

  return controller
}