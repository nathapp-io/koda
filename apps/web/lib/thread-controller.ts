/**
 * Fleet S5a §4 (US-003): the thread page's stateful controller.
 *
 * Holds the page's state (thread, messages, live) and drives the events stream, the polling
 * fallback, optimistic sends and the action routes. Framework-free apart from Vue `ref`s: every
 * dependency (API client, stream opener, timers, clock) is injected, so unit tests drive it with
 * fakes — `useThread` wires the production deps. No business rules are re-implemented here: a send
 * refusal is read off the reloaded thread (`sendRefusal`), never parsed from a 409 message string.
 */
import { ref, type Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ThreadEventHandlers } from '~/lib/thread-event-stream'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'
import { applyDelta, isTurnRunning, mergeMessages, newClientMessageId, refetchAfterSeq } from '~/lib/thread-view'

/** Messages per GET page (the API page size); a shorter page ends the load loop. */
export const MESSAGES_PAGE_SIZE = 200
/** At most this many full pages are fetched in one load, bounding a pathological thread. */
export const MAX_PAGES = 50
/** Cadence of the polling fallback and of a closing-retry send. */
export const POLL_INTERVAL_MS = 2000
/** A send refused with 'closing' retries for this long since the first attempt, then gives up. */
export const CLOSING_RETRY_WINDOW_MS = 15000

/** The subset of `$api` the controller uses. */
export interface ThreadApi {
  get: <T = unknown>(path: string, options?: Record<string, unknown>) => Promise<T>
  post: <T = unknown>(path: string, body?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<T>
  patch: <T = unknown>(path: string, body?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<T>
}

export interface ThreadControllerDeps {
  api: ThreadApi
  slug: string
  threadId: string
  openStream: (handlers: ThreadEventHandlers) => { close: () => void }
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  now: () => number
}

export interface ThreadActionResult {
  ok: boolean
  /** Present exactly when `ok` is false; the page toasts `extractApiError(error)`. */
  error?: unknown
}

export interface ThreadController {
  thread: Ref<ThreadDetailDto | null>
  messages: Ref<ChatMessageDto[]>
  live: Ref<boolean>
  load: () => Promise<void>
  start: () => void
  stop: () => void
  send: (text: string) => Promise<ThreadActionResult>
  stopTurn: () => Promise<ThreadActionResult>
  endSession: () => Promise<ThreadActionResult>
  answer: (requestId: string, text: string) => Promise<ThreadActionResult>
  raiseCap: (maxCostUsd: number) => Promise<ThreadActionResult>
  archive: () => Promise<ThreadActionResult>
}

/** The API envelope `ret` as a number, when the error carries one (ApiError); undefined otherwise. */
function errorCode(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

export function createThreadController(deps: ThreadControllerDeps): ThreadController {
  const thread = ref<ThreadDetailDto | null>(null)
  const messages = ref<ChatMessageDto[]>([])
  const live = ref(false)

  const threadPath = apiPath`/projects/${deps.slug}/threads/${deps.threadId}`
  const messagesPath = `${threadPath}/messages`

  let stream: { close: () => void } | null = null
  let pollTimer: unknown = null
  let started = false

  const messagesPage = (afterSeq: number) => ({ query: { afterSeq: String(afterSeq), limit: String(MESSAGES_PAGE_SIZE) } })

  const reloadThread = async (): Promise<void> => {
    thread.value = await deps.api.get<ThreadDetailDto>(threadPath)
  }

  /** GET messages after the refetch cursor (`refetchAfterSeq`), merged so optimistic messages survive. */
  const refreshMessages = async (): Promise<void> => {
    const { items } = await deps.api.get<{ items: ChatMessageDto[] }>(messagesPath, messagesPage(refetchAfterSeq(messages.value)))
    messages.value = mergeMessages(messages.value, items)
    syncPolling()
  }

  /**
   * Full reload: the thread, then messages paged forward from sequence zero, 200 at a time, while a
   * page returns a full 200 items (at most `MAX_PAGES` pages).
   */
  const load = async (): Promise<void> => {
    thread.value = await deps.api.get<ThreadDetailDto>(threadPath)
    let afterSeq = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { items } = await deps.api.get<{ items: ChatMessageDto[] }>(messagesPath, messagesPage(afterSeq))
      messages.value = mergeMessages(messages.value, items)
      if (items.length < MESSAGES_PAGE_SIZE) break
      afterSeq = Math.max(...items.map(item => item.seq))
    }
    syncPolling()
  }

  const armPoll = (): void => {
    pollTimer = deps.setTimer(pollOnce, POLL_INTERVAL_MS)
  }

  const pollOnce = (): void => {
    pollTimer = null
    if (!started || live.value || !isTurnRunning(messages.value)) return
    void refreshMessages()
    void reloadThread()
    armPoll()
  }

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      deps.clearTimer(pollTimer)
      pollTimer = null
    }
  }

  /**
   * The polling fallback: while `live` is false and a turn is running, poll every
   * `POLL_INTERVAL_MS`; stop as soon as either condition ends.
   */
  const syncPolling = (): void => {
    if (!started || live.value || !isTurnRunning(messages.value)) {
      stopPolling()
      return
    }
    if (pollTimer === null) armPoll()
  }

  const handlers: ThreadEventHandlers = {
    onDelta: (event) => {
      if (event.type !== 'delta') return
      const next = applyDelta(messages.value, event.messageId, event.text)
      if (next === null) {
        // A delta for a message we do not hold: the load raced the stream, refetch the gap.
        void refreshMessages()
      } else {
        messages.value = next
      }
    },
    onMessage: () => {
      void refreshMessages()
    },
    onQuestion: () => {
      void reloadThread()
    },
    onThread: () => {
      void reloadThread()
    },
    onResync: () => {
      void load()
    },
    onLiveChange: (liveNow) => {
      live.value = liveNow
      syncPolling()
    },
  }

  const start = (): void => {
    if (stream !== null) return
    started = true
    stream = deps.openStream(handlers)
    syncPolling()
  }

  const stop = (): void => {
    started = false
    stream?.close()
    stream = null
    stopPolling()
  }

  /** Arm a send-retry through the injected timer; the retry continues once it fires. */
  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    deps.setTimer(resolve, ms)
  })

  const dropOptimistic = (cid: string): void => {
    messages.value = messages.value.filter(message => message.id !== `local:${cid}`)
  }

  /**
   * Send with an optimistic echo: `local:<cid>` is held as pending before the POST, replaced by the
   * server message on success. A 409 reloads the thread; while it answers `closing` (and under
   * `CLOSING_RETRY_WINDOW_MS` since the first attempt) the same `clientMessageId` is retried after
   * `POLL_INTERVAL_MS`, otherwise the echo is dropped and `{ ok: false, error }` resolved.
   */
  const send = async (text: string): Promise<ThreadActionResult> => {
    const cid = newClientMessageId()
    messages.value = [...messages.value, {
      id: `local:${cid}`,
      seq: 0,
      jobId: null,
      turnId: null,
      role: 'user',
      authorUserId: null,
      clientMessageId: cid,
      content: text,
      toolSummary: null,
      status: 'pending',
      errorReason: null,
      usage: null,
      costUsd: null,
      costSource: null,
      createdAt: new Date(deps.now()).toISOString(),
    }]
    syncPolling()
    const firstAttemptAt = deps.now()
    for (;;) {
      try {
        const { message } = await deps.api.post<{ message: ChatMessageDto }>(messagesPath, { text, clientMessageId: cid })
        messages.value = mergeMessages(messages.value, [message])
        syncPolling()
        return { ok: true }
      } catch (error: unknown) {
        if (errorCode(error) === 409) {
          await reloadThread()
          if (thread.value?.sendRefusal === 'closing' && deps.now() - firstAttemptAt < CLOSING_RETRY_WINDOW_MS) {
            await wait(POLL_INTERVAL_MS)
            continue
          }
        }
        dropOptimistic(cid)
        return { ok: false, error }
      }
    }
  }

  /** POST an action; reload the thread on success, resolve `{ ok: false, error }` on failure. */
  const postAction = async (path: string, body?: Record<string, unknown>): Promise<ThreadActionResult> => {
    try {
      await deps.api.post(path, body ?? {})
      await reloadThread()
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error }
    }
  }

  const stopTurn = (): Promise<ThreadActionResult> => postAction(`${threadPath}/stop`)
  const endSession = (): Promise<ThreadActionResult> => postAction(`${threadPath}/end-session`)
  const answer = (requestId: string, text: string): Promise<ThreadActionResult> =>
    postAction(`${threadPath}/answer`, { requestId, text })

  const raiseCap = async (maxCostUsd: number): Promise<ThreadActionResult> => {
    try {
      await deps.api.patch(threadPath, { maxCostUsd })
      await reloadThread()
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error }
    }
  }

  const archive = (): Promise<ThreadActionResult> => postAction(`${threadPath}/archive`)

  return {
    thread,
    messages,
    live,
    load,
    start,
    stop,
    send,
    stopTurn,
    endSession,
    answer,
    raiseCap,
    archive,
  }
}