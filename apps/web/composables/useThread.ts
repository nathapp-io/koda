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
  // True between onMounted and onBeforeUnmount; guards the load()/start() chain so an unmount
  // that races the in-flight load cannot reopen the stream after stop().
  let mounted = false
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
    mounted = true
    // A transient mount failure must not kill live updates: swallow the load rejection and still
    // start the stream (its own refetch/page handlers and the polling fallback cover the missing
    // initial page). `.then` is guarded by `mounted` so an unmount that races the in-flight load
    // cannot reopen the stream after `stop()` has closed it.
    void controller.load().catch(() => undefined).then(() => {
      if (mounted) controller.start()
    })
  })

  onBeforeUnmount(() => {
    mounted = false
    controller.stop()
  })

  return controller
}