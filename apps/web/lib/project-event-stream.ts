/**
 * Track 1 Slice 5: framework-free client for GET /api/projects/:slug/events.
 *
 * Transient drops: the browser EventSource reconnects by itself; the next
 * open fires onResync so pages refetch what they may have missed.
 * Terminal failures (readyState CLOSED, e.g. 401 after the access cookie
 * expired, 403, 429): refresh auth, then reopen with backoff. Give up after
 * MAX_TERMINAL_FAILURES in a row or when the refresh fails; the page keeps
 * working as a static page.
 */
export const LIVE_ACTIONS = ['created', 'updated', 'transitioned', 'assigned', 'commented', 'deleted'] as const
export type LiveAction = typeof LIVE_ACTIONS[number]

export interface LiveTicketEvent {
  id: string
  type: 'ticket'
  action: LiveAction
  projectId: string
  ticketId: string
  actorId: string
  at: string
}

export interface ProjectEventHandlers {
  onEvent: (event: LiveTicketEvent) => void
  onResync: () => void
}

export interface EventSourceLike {
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  addEventListener: (type: string, listener: (ev: { data: string }) => void) => void
  close: () => void
}

export interface ProjectEventStreamDeps {
  createEventSource: (url: string) => EventSourceLike
  refreshAuth: () => Promise<boolean>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export const EVENT_SOURCE_CLOSED = 2
export const MAX_TERMINAL_FAILURES = 5
export const BACKOFF_CAP_MS = 30_000
const DEDUPE_WINDOW = 200

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, BACKOFF_CAP_MS)
}

export function parseLiveEvent(raw: string): LiveTicketEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveTicketEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'ticket' || typeof value.id !== 'string' || typeof value.ticketId !== 'string') return null
    if (!LIVE_ACTIONS.includes(value.action as LiveAction)) return null
    return value as LiveTicketEvent
  }
  catch {
    return null
  }
}

export function createProjectEventStream(
  url: string,
  handlers: ProjectEventHandlers,
  deps: ProjectEventStreamDeps,
): { close: () => void } {
  let source: EventSourceLike | null = null
  let timer: unknown = null
  let stopped = false
  let hadError = false
  let failures = 0
  // seen intentionally persists across reconnects: once resync refetches the
  // gap, a redelivered pre-gap event is still dropped by this window.
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
    es.addEventListener('ticket', (ev) => {
      const event = parseLiveEvent(ev.data)
      if (event && isNew(event.id)) handlers.onEvent(event)
    })
    es.onerror = () => {
      hadError = true
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
