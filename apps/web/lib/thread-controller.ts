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
import { extractErrorStatus, isUnavailableError } from '~/composables/useApi'
import { backoffMs } from '~/lib/project-event-stream'
import { pendingApproval } from '~/lib/approval-requests'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'
import type { ThreadEventHandlers } from '~/lib/thread-event-stream'
import type { ThreadHandoffBody } from '~/lib/thread-handoff-form'
import type { ChatMessageDto, ThreadApprovalDecision, ThreadDetailDto, ThreadMode } from '~/lib/thread-types'
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
  /** The project of a project thread (fleet S5a); a WORKSPACE thread has none and passes `threadPath`. */
  slug?: string
  threadId: string
  /** Replaces the project path built from `slug`: `/threads/<id>` for a WORKSPACE thread (S5b 1d). */
  threadPath?: string
  openStream: (handlers: ThreadEventHandlers) => { close: () => void }
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  now: () => number
}

export interface ThreadActionResult {
  ok: boolean
  /** Present exactly when `ok` is false; the page toasts `extractApiError(error)`. */
  error?: unknown
  /**
   * US-001: the send waits for this approval request and wrote nothing yet. Neither an executed success
   * nor a transport failure, so the page words it and the composer keeps its draft.
   */
  pendingApproval?: string
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
  /**
   * Change the thread's execution profile (thread-agents-modes US-005). REPO threads only: a PROJECT or WORKSPACE
   * thread is always `read` and has no mode route.
   */
  changeMode: (mode: ThreadMode) => Promise<ThreadActionResult>
  /** Decide one pending session approval (US-008): Approve is `allow`, Deny is `deny`. */
  decideApproval: (requestId: string, decision: ThreadApprovalDecision) => Promise<ThreadActionResult>
  raiseCap: (maxCostUsd: number) => Promise<ThreadActionResult>
  archive: () => Promise<ThreadActionResult>
  publish: () => Promise<ThreadActionResult>
  discard: () => Promise<ThreadActionResult>
  plan: (body: ThreadHandoffBody) => Promise<ThreadActionResult>
  run: (body: ThreadHandoffBody) => Promise<ThreadActionResult>
  /** Re-GET the thread (the page calls it on a `fleet_job` event). */
  reloadThread: () => Promise<void>
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

  // A WORKSPACE thread is not project-scoped: `threadPath` is the whole path then, and `slug` is
  // never read. `apiPath` still refuses an empty segment, so a caller that passes neither fails
  // loudly instead of requesting `/projects//threads/<id>`.
  const threadPath = deps.threadPath ?? apiPath`/projects/${deps.slug ?? ''}/threads/${deps.threadId}`
  const messagesPath = `${threadPath}/messages`

  let stream: { close: () => void } | null = null
  let pollTimer: unknown = null
  let retryTimer: unknown = null
  let started = false

  // A request may settle out of order. Only a successful snapshot supersedes an earlier read.
  let detailReadSeq = 0
  let committedDetailSeq = 0
  let transcriptRevision = 0
  // Incremental refreshes and full transcript pages can cover different messages.
  const committedMessageReads = new Map<string, number>()
  const lastTextDelta = new Map<string, number>()
  let lastDeltaAt = 0
  let textRepairFailures = 0
  let textRepairTimer: unknown = null
  let repairingText = false
  let epoch = 0

  const messagesPage = (afterSeq: number, limit = MESSAGES_PAGE_SIZE) => ({ query: { afterSeq: String(afterSeq), limit: String(limit) } })

  /**
   * US-002 (finding 11): a read the page is not awaiting. Its rejection is handled here instead of escaping
   * as an unhandled rejection — the transcript keeps the state it had, the polling fallback covers a turn
   * that is still running, and the next ready frame (a reconnect) catches the page up again.
   */
  const inBackground = (run: () => Promise<void>): void => {
    void run().catch(() => undefined)
  }

  const reloadThread = async (): Promise<void> => {
    const session = epoch
    const readSeq = ++detailReadSeq
    const next = await deps.api.get<ThreadDetailDto>(threadPath)
    if (session !== epoch || readSeq < committedDetailSeq) return
    committedDetailSeq = readSeq
    thread.value = next
  }

  // Text events have no offsets: even a GET that finished before a delta arrived can already
  // include it. Once streaming quiets, confirm only rows that still carry unverified deltas.
  const scheduleTextRepair = (): void => {
    if (lastTextDelta.size === 0) {
      if (textRepairTimer !== null) deps.clearTimer(textRepairTimer)
      textRepairTimer = null
      textRepairFailures = 0
    } else if (textRepairTimer === null && !repairingText) {
      textRepairTimer = deps.setTimer(repairText, backoffMs(textRepairFailures + 1))
    }
  }

  const repairText = (): void => {
    const untilQuiet = lastDeltaAt + POLL_INTERVAL_MS - deps.now()
    if (untilQuiet > 0) {
      textRepairTimer = deps.setTimer(repairText, untilQuiet)
      return
    }
    textRepairTimer = null
    const session = epoch
    repairingText = true
    inBackground(async () => {
      let failed = false
      const rows = messages.value.filter(row => lastTextDelta.has(row.id))
      try {
        for (const row of rows) {
          if (session !== epoch) return
          if (!lastTextDelta.has(row.id)) continue
          try {
            const items = await readMessages(row.seq - 1, 1)
            if (session === epoch && items[0]?.id !== row.id) lastTextDelta.delete(row.id)
          } catch (error) {
            if (session !== epoch) return
            const status = extractErrorStatus(error) ?? errorCode(error)
            if (isUnavailableError(error) || (status === 401 || status === 400)) lastTextDelta.delete(row.id)
            else failed = true
          }
        }
      } finally {
        if (session === epoch) {
          repairingText = false
          textRepairFailures = failed ? textRepairFailures + 1 : 0
          scheduleTextRepair()
        }
      }
    })
  }

  /** Only a newer snapshot of the same row supersedes it. Deltas protect text alone. */
  const readMessages = async (afterSeq: number, limit = MESSAGES_PAGE_SIZE): Promise<ChatMessageDto[]> => {
    const session = epoch
    const readSeq = ++transcriptRevision
    const { items } = await deps.api.get<{ items: ChatMessageDto[] }>(messagesPath, messagesPage(afterSeq, limit))
    if (session !== epoch) return []

    const staleIds = new Set<string>()
    const liveTextIds = new Set<string>()
    for (const item of items) {
      if ((committedMessageReads.get(item.id) ?? 0) > readSeq) {
        staleIds.add(item.id)
        continue
      }
      committedMessageReads.set(item.id, readSeq)
      if (item.status === 'streaming' && (lastTextDelta.get(item.id) ?? 0) > readSeq) liveTextIds.add(item.id)
      else lastTextDelta.delete(item.id)
    }
    messages.value = mergeMessages(messages.value, items, { staleIds, liveTextIds })
    scheduleTextRepair()
    return items
  }

  const refreshMessages = async (): Promise<void> => {
    const session = epoch
    await readMessages(refetchAfterSeq(messages.value))
    if (session === epoch) syncPolling()
  }

  /** Reload the detail and up to MAX_PAGES transcript pages from sequence zero. */
  const load = async (): Promise<void> => {
    const session = epoch
    await reloadThread()
    let afterSeq = 0
    for (let page = 0; page < MAX_PAGES && session === epoch; page += 1) {
      const items = await readMessages(afterSeq)
      if (items.length < MESSAGES_PAGE_SIZE) break
      afterSeq = Math.max(...items.map(item => item.seq))
    }
    if (session === epoch) syncPolling()
  }

  const armPoll = (): void => {
    pollTimer = deps.setTimer(pollOnce, POLL_INTERVAL_MS)
  }

  const pollOnce = (): void => {
    pollTimer = null
    if (!started || live.value || !isTurnRunning(messages.value)) return
    inBackground(refreshMessages)
    inBackground(reloadThread)
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
        inBackground(refreshMessages)
      } else if (next !== messages.value) {
        lastTextDelta.set(event.messageId, ++transcriptRevision)
        lastDeltaAt = deps.now()
        messages.value = next
        scheduleTextRepair()
      }
    },
    onMessage: () => {
      inBackground(refreshMessages)
    },
    onQuestion: () => {
      inBackground(reloadThread)
    },
    onThread: () => {
      inBackground(reloadThread)
      // A thread event can mean the session or its job ended (#264), so a running turn also refetches
      // its messages; the refetch cursor starts at the first in-flight one.
      if (isTurnRunning(messages.value)) inBackground(refreshMessages)
    },
    onResync: () => {
      // US-002: the stream asks for this at every connection's ready frame, so the page collects what it
      // missed between its load and its subscription.
      inBackground(recover)
    },
    onLiveChange: (liveNow) => {
      live.value = liveNow
      syncPolling()
    },
  }

  /**
   * Ensure the page's live machinery: one stream, and the polling fallback while a turn runs without a
   * live stream. Idempotent — the catch-up asks again on a page that is already subscribed.
   */
  const start = (): void => {
    started = true
    if (stream === null) stream = deps.openStream(handlers)
    syncPolling()
  }

  const stop = (): void => {
    started = false
    // A read still in flight finishes after this: its completion must not resume what the teardown closed.
    epoch += 1
    lastTextDelta.clear()
    repairingText = false
    scheduleTextRepair()
    stream?.close()
    stream = null
    stopPolling()
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer)
      retryTimer = null
    }
  }

  /**
   * US-002 (finding 11): the catch-up a ready frame asks for. It reloads the thread detail and the
   * transcript — the two things a completion published between the page's GET and its subscription would
   * leave stale — and then confirms the live machinery is in place. A controller torn down while the read
   * was held stays torn down: nothing reopens its stream or restarts its poll after `stop()`.
   */
  const recover = async (): Promise<void> => {
    const session = epoch
    await load()
    if (session !== epoch) return
    start()
  }

  /** Arm a send-retry through the injected timer; the retry continues once it fires. `stop()` clears it. */
  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    retryTimer = deps.setTimer(() => { retryTimer = null; resolve() }, ms)
  })

  const dropOptimistic = (cid: string): void => {
    messages.value = messages.value.filter(message => message.id !== `local:${cid}`)
  }

  /**
   * Send with an optimistic echo: `local:<cid>` is held as pending before the POST, replaced by the
   * server message on success. A 409 reloads the thread; while it answers `closing` (and under
   * `CLOSING_RETRY_WINDOW_MS` since the first attempt) the same `clientMessageId` is retried after
   * `POLL_INTERVAL_MS`, otherwise the echo is dropped and `{ ok: false, error }` resolved.
   *
   * US-001: the route is approval-gated, so a 202 answer carries `ApprovalRequestSummary` instead of the
   * message. Nothing was written, so the echo goes and the send resolves `{ ok: false, pendingApproval }`
   * — the caller shows the request id and keeps the draft.
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
        const answer = await deps.api.post<{ message: ChatMessageDto } | ApprovalRequestSummary>(messagesPath, { text, clientMessageId: cid })
        if (pendingApproval(answer, 'thread.message.send')) {
          dropOptimistic(cid)
          syncPolling()
          return { ok: false, pendingApproval: answer.id }
        }
        const { message } = answer
        // A GET may have already replaced the echo and observed the runner consume it.
        if (!committedMessageReads.has(message.id)) messages.value = mergeMessages(messages.value, [message])
        syncPolling()
        return { ok: true }
      } catch (error: unknown) {
        if (errorCode(error) === 409) {
          try {
            await reloadThread()
          } catch {
            // The refusal could not be read off the thread: give up this send rather than leak the
            // optimistic echo or reject out of send().
            dropOptimistic(cid)
            return { ok: false, error }
          }
          if (thread.value?.sendRefusal === 'closing' && deps.now() - firstAttemptAt < CLOSING_RETRY_WINDOW_MS) {
            await wait(POLL_INTERVAL_MS)
            // The controller was stopped while the retry was armed: never POST after unmount.
            if (!started) {
              dropOptimistic(cid)
              return { ok: false }
            }
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

  /**
   * The mode change is its own `PATCH`: the API writes a system message with the old and new mode and, when a session is
   * idle, queues one THREAD_CLOSE, so the reload picks the new mode and that note up together (US-005).
   */
  const changeMode = async (mode: ThreadMode): Promise<ThreadActionResult> => {
    try {
      await deps.api.patch(`${threadPath}/mode`, { mode })
      await reloadThread()
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error }
    }
  }

  /**
   * One decision for one pending approval (US-008). The request id comes from the thread payload, so it is encoded into
   * its single path segment; the thread reload keeps the list honest if another viewer decided first.
   */
  const decideApproval = (requestId: string, decision: ThreadApprovalDecision): Promise<ThreadActionResult> =>
    postAction(`${threadPath}/approvals/${encodeURIComponent(requestId)}`, { decision })

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

  /** Fleet S5a handoff (US-002): Publish and Discard post an empty body; Plan and Run post their form body. */
  const publish = (): Promise<ThreadActionResult> => postAction(`${threadPath}/publish`, {})
  const discard = (): Promise<ThreadActionResult> => postAction(`${threadPath}/discard`, {})
  const plan = (body: ThreadHandoffBody): Promise<ThreadActionResult> => postAction(`${threadPath}/plan`, { ...body })
  const run = (body: ThreadHandoffBody): Promise<ThreadActionResult> => postAction(`${threadPath}/run`, { ...body })

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
    changeMode,
    decideApproval,
    raiseCap,
    archive,
    publish,
    discard,
    plan,
    run,
    reloadThread,
  }
}