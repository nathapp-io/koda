/**
 * Fleet S5a §4: framework-free client for GET /api/projects/:slug/threads/:id/events.
 *
 * Mirrors createProjectEventStream: the browser EventSource reconnects after transient drops and
 * the next open fires onResync; terminal failures (readyState CLOSED — 401 after the cookie
 * expired, 403, 429) wait the backoff, then refresh auth and reopen, giving up after MAX_TERMINAL_FAILURES.
 * US-007: the refresh is tri-state, so only an 'unauthorized' answer stops the stream — an API
 * outage ('unavailable') keeps retrying, capped at BACKOFF_CAP_MS per wait.
 * The stream lives only once a `ready` frame arrives; any stream error (transient or terminal)
 * marks it not live (the US-003 controller contract).
 * Malformed SSE event data is ignored.
 *
 * US-002 (finding 11): the catch-up belongs to server readiness, not to the transport. The page loads
 * the thread and only then subscribes, so a turn that finished in between is delivered to nobody; the
 * first `ready` frame of each connection therefore fires onResync too — one catch-up per connected
 * stream, the reconnect paths included, and duplicate `ready` frames add none. `onopen` alone never
 * catches up: the transport is open before the server has accepted the subscription.
 */
import {
  backoffMs,
  EVENT_SOURCE_CLOSED,
  MAX_TERMINAL_FAILURES,
  type EventSourceLike,
  type ProjectEventStreamDeps,
} from '~/lib/project-event-stream'
import type { ThreadLiveEvent } from '~/lib/thread-types'

const DEDUPE_WINDOW = 200

export interface ThreadEventHandlers {
  onDelta?: (event: ThreadLiveEvent) => void
  onMessage?: (event: ThreadLiveEvent) => void
  onQuestion?: (event: ThreadLiveEvent) => void
  onThread?: (event: ThreadLiveEvent) => void
  onResync: () => void
  onLiveChange: (live: boolean) => void
}

/** Parses one SSE frame named `type`. Null unless the payload is a JSON object with string id, threadId and the type's fields. */
export function parseThreadLiveEvent(type: string, raw: string): ThreadLiveEvent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return null
    if (typeof value.id !== 'string' || typeof value.threadId !== 'string' || typeof value.at !== 'string') return null
    if (value.type !== type) return null
    switch (type) {
      case 'delta': {
        if (typeof value.messageId !== 'string' || typeof value.text !== 'string') return null
        return { id: value.id, threadId: value.threadId, at: value.at, type: 'delta', messageId: value.messageId, text: value.text }
      }
      case 'message': {
        if (typeof value.messageId !== 'string') return null
        return { id: value.id, threadId: value.threadId, at: value.at, type: 'message', messageId: value.messageId }
      }
      case 'question': {
        if (typeof value.requestId !== 'string' || typeof value.text !== 'string') return null
        return { id: value.id, threadId: value.threadId, at: value.at, type: 'question', requestId: value.requestId, text: value.text }
      }
      case 'thread':
        return { id: value.id, threadId: value.threadId, at: value.at, type: 'thread' }
      default:
        return null
    }
  }
  catch {
    return null
  }
}

export function createThreadEventStream(
  url: string,
  handlers: ThreadEventHandlers,
  deps: ProjectEventStreamDeps,
): { close: () => void } {
  let source: EventSourceLike | null = null
  let timer: unknown = null
  let stopped = false
  /**
   * US-002: true once the connection now open has caught up. Reset by every successful (re)open — the
   * browser reconnects the same EventSource after a transient drop — so each connection catches up once.
   */
  let caughtUp = false
  /** Drives the delay; grows on every error and only an onopen resets it. */
  let failures = 0
  /** US-007: consecutive recoveries that a live session allowed; the cap applies to these only. */
  let authedFailures = 0
  // seen intentionally persists across reconnects: once resync refetches the gap, a redelivered
  // pre-gap event is still dropped by this window.
  let seen: readonly string[] = []

  const isNew = (id: string): boolean => {
    if (seen.includes(id)) return false
    seen = [...seen, id].slice(-DEDUPE_WINDOW)
    return true
  }

  /** Refreshes auth, then reopens on 'ok' or 'unavailable'; any other answer stops the stream. */
  const refreshThenReopen = async (): Promise<void> => {
    if (stopped) return
    const outcome = await deps.refreshAuth()
    if (stopped) return
    if (outcome === 'unauthorized') {
      // The session is gone (or the refresh said nothing this build understands): stop, no reopen.
      stopped = true
      return
    }
    if (outcome === 'ok') {
      authedFailures += 1
    }
    else if (outcome !== 'unavailable') {
      // Fail closed on any other value: only an explicit outage may keep the stream retrying.
      stopped = true
      return
    }
    // 'ok' and 'unavailable' both reopen; an outage is not counted against MAX_TERMINAL_FAILURES, so a
    // deploy can never end the stream, and backoffMs caps the wait.
    open()
  }

  const recover = (): void => {
    if (authedFailures >= MAX_TERMINAL_FAILURES) {
      stopped = true
      return
    }
    const delay = backoffMs(failures)
    failures += 1
    // The refresh waits for the backoff instead of going out at once: a navigation closes the page's
    // streams, and a refresh sent right then is aborted by the browser after the API already rotated the
    // token, leaving a spent refresh cookie. An unloading page takes this timer with it.
    timer = deps.setTimer(() => {
      timer = null
      void refreshThenReopen()
    }, delay)
  }

  const open = (): void => {
    if (stopped) return
    const es = deps.createEventSource(url)
    source = es
    es.onopen = () => {
      failures = 0
      authedFailures = 0
      // A fresh connection owes the page a catch-up; its ready frame collects it.
      caughtUp = false
    }
    es.addEventListener('ready', () => {
      handlers.onLiveChange(true)
      // US-002: readiness is the one place the page learns what it missed between its GET and its
      // subscription. A duplicate ready frame on the same connection reconciles nothing new.
      if (caughtUp) return
      caughtUp = true
      handlers.onResync()
    })
    es.addEventListener('delta', (ev) => {
      const event = parseThreadLiveEvent('delta', ev.data)
      if (event && isNew(event.id)) handlers.onDelta?.(event)
    })
    es.addEventListener('message', (ev) => {
      const event = parseThreadLiveEvent('message', ev.data)
      if (event && isNew(event.id)) handlers.onMessage?.(event)
    })
    es.addEventListener('question', (ev) => {
      const event = parseThreadLiveEvent('question', ev.data)
      if (event && isNew(event.id)) handlers.onQuestion?.(event)
    })
    es.addEventListener('thread', (ev) => {
      const event = parseThreadLiveEvent('thread', ev.data)
      if (event && isNew(event.id)) handlers.onThread?.(event)
    })
    es.onerror = () => {
      // Any stream error kills the live flag (US-003 contract); the native EventSource still
      // reconnects on its own after a transient drop, and terminal failures recover below.
      handlers.onLiveChange(false)
      if (stopped || es.readyState !== EVENT_SOURCE_CLOSED) return
      es.close()
      source = null
      recover()
    }
  }

  open()

  return {
    close: () => {
      stopped = true
      if (timer !== null) deps.clearTimer(timer)
      timer = null
      source?.close()
      source = null
    },
  }
}