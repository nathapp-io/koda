/**
 * Fleet S5b 1d (US-004): production adapter for the WORKSPACE thread controller.
 *
 * The same controller as `useThread` (fleet S5a §4), over the personal `/threads/:id` routes
 * instead of the project ones: `threadPath` replaces the project path and the live stream is
 * `/api/threads/:id/events`. Client-only: `load()` then `start()` on mount, `stop()` on unmount.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { createThreadController, type ThreadController } from '~/lib/thread-controller'
import { createThreadEventStream } from '~/lib/thread-event-stream'
import type { EventSourceLike } from '~/lib/project-event-stream'

/**
 * The workspace thread page's controller, plus the mount-load outcome the page's error state reads.
 *
 * `createThreadController.load()` rejects on a failed GET, and the adapter deliberately swallows that
 * rejection so a transient mount failure cannot kill live updates. The page still has to tell "the
 * load failed" (a 404 for an unknown or foreign thread id) from "the thread is not in hand yet", so
 * the outcome is recorded here rather than lost.
 */
export interface WorkspaceThreadController extends ThreadController {
  /** True while the last load attempt has failed; false again once one succeeds. */
  loadFailed: Ref<boolean>
  /** Load the thread, recording a failure in `loadFailed` instead of rejecting (the page's retry). */
  loadThread: () => Promise<void>
}

/** The workspace thread page's controller: thread/messages/live state, optimistic send and actions. */
export function useWorkspaceThread(threadId: string): WorkspaceThreadController {
  const { $api } = useApi()
  const { refresh } = useAuth()
  // True between onMounted and onBeforeUnmount; guards the load()/start() chain so an unmount
  // that races the in-flight load cannot reopen the stream after stop().
  let mounted = false
  const controller = createThreadController({
    api: $api,
    threadId,
    threadPath: apiPath`/threads/${threadId}`,
    openStream: (handlers) =>
      createThreadEventStream(
        apiPath`/api/threads/${threadId}/events`,
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

  const loadFailed = ref(false)

  /**
   * Load, recording the outcome: the mount load and the page's error-state retry both go through
   * here, so a 404 leaves `loadFailed` true and any later success clears it. The rejection never
   * escapes — it is the error state's business, not the stream's.
   */
  const loadThread = async (): Promise<void> => {
    try {
      await controller.load()
      loadFailed.value = false
    } catch {
      loadFailed.value = true
    }
  }

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    mounted = true
    // A transient mount failure must not kill live updates: the load failure is recorded (for the
    // page's error state) and the stream still starts — its own refetch/page handlers and the
    // polling fallback cover the missing initial page. `.then` is guarded by `mounted` so an unmount
    // that races the in-flight load cannot reopen the stream after `stop()` has closed it.
    void loadThread().then(() => {
      if (mounted) controller.start()
    })
  })

  onBeforeUnmount(() => {
    mounted = false
    controller.stop()
  })

  return { ...controller, loadFailed, loadThread }
}
