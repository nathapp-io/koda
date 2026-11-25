/**
 * Fleet S5a §4 (US-003): production adapter for the thread controller.
 *
 * Owns the page's one EventSource to the thread events route and the browser timers/clock; the
 * controller itself (`~/lib/thread-controller`) stays framework-free. Client-only: `load()` then
 * `start()` on mount, `stop()` on unmount.
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { createThreadController, type ThreadController } from '~/lib/thread-controller'
import { createThreadEventStream } from '~/lib/thread-event-stream'
import type { EventSourceLike } from '~/lib/project-event-stream'

export interface ProjectThreadController extends ThreadController {
  /** True while no detail has loaded and the initial read is pending. */
  loading: Ref<boolean>
  /** True after a failed detail read, until a subsequent valid detail is loaded. */
  loadFailed: Ref<boolean>
  /** 403 and 404 share one presentation so the page does not disclose thread existence. */
  unavailable: Ref<boolean>
  /** Retry the initial/detail load while keeping the existing stream alive. */
  loadThread: () => Promise<void>
}

/** The thread page's controller: thread/messages/live state, optimistic send and actions. */
export function useThread(slug: string, threadId: string): ProjectThreadController {
  const { $api } = useApi()
  const { refreshSession } = useAuth()
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
          refreshAuth: () => refreshSession(),
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      ),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  })

  const loading = ref(true)
  const loadFailed = ref(false)
  const unavailable = ref(false)

  const loadThread = async (): Promise<void> => {
    loading.value = true
    try {
      await controller.load()
      loadFailed.value = false
      unavailable.value = false
    } catch (error) {
      loadFailed.value = true
      const status = error !== null && typeof error === 'object'
        ? (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status
        : undefined
      unavailable.value = status === 403 || status === 404
    } finally {
      loading.value = false
    }
  }

  // Stream-triggered detail reads bypass loadThread. A valid live snapshot supersedes any old error.
  watch(controller.thread, (detail) => {
    if (detail !== null) {
      loadFailed.value = false
      unavailable.value = false
      loading.value = false
    }
  })

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    mounted = true
    // A failed initial load is visible but must not prevent the single live subscription from opening.
    // The mount guard also prevents an in-flight read from reopening the stream after unmount.
    void loadThread().then(() => {
      if (mounted) controller.start()
    })
  })

  onBeforeUnmount(() => {
    mounted = false
    controller.stop()
  })

  return { ...controller, loading, loadFailed, unavailable, loadThread }
}