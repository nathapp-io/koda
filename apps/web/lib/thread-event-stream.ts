/**
 * Fleet S5a §4: framework-free client for GET /api/projects/:slug/threads/:id/events.
 *
 * Mirrors createProjectEventStream: the browser EventSource reconnects after transient drops and
 * the next open fires onResync; terminal failures (readyState CLOSED — 401 after the cookie
 * expired, 403, 429) refresh auth then reopen with backoff, giving up after MAX_TERMINAL_FAILURES.
 * The stream lives only once a `ready` frame arrives; any stream error (transient or terminal)
 * marks it not live (the US-003 controller contract), and a reconnect after an error resyncs once.
 * Malformed SSE event data is ignored.
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
  let hadError = false
  let failures = 0
  // seen intentionally persists across reconnects: once resync refetches the gap, a redelivered
  // pre-gap event is still dropped by this window.
  let seen: readonly string[] = []

  const isNew = (id: string): boolean => {
    if (seen.includes(id)) return false
    seen = [...seen, id].slice(-DEDUPE_WINDOW)
    return true
  }

  const recover = async (): Promise<void> => {
    if (failures >= MAX_TERMINAL_FAILURES) {
      stopped = true
      return
    }
    const delay = backoffMs(failures)
    failures += 1
    const ok = await deps.refreshAuth()
    if (stopped) return
    if (!ok) {
      stopped = true
      return
    }
    timer = deps.setTimer(() => {
      timer = null
      open()
    }, delay)
  }

  const open = (): void => {
    if (stopped) return
    const es = deps.createEventSource(url)
    source = es
    es.onopen = () => {
      failures = 0
      if (hadError) {
        hadError = false
        handlers.onResync()
      }
    }
    es.addEventListener('ready', () => {
      handlers.onLiveChange(true)
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
      hadError = true
      // Any stream error kills the live flag (US-003 contract); the native EventSource still
      // reconnects on its own after a transient drop, and terminal failures recover below.
      handlers.onLiveChange(false)
      if (stopped || es.readyState !== EVENT_SOURCE_CLOSED) return
      es.close()
      source = null
      void recover()
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