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

/** Fleet S1 slice 4c: content-free job notice; the page refetches the job (S1 spec §1). */
export const FLEET_JOB_STATES = [
  'QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED',
] as const
export type FleetJobState = typeof FLEET_JOB_STATES[number]

export interface LiveFleetJobEvent {
  id: string
  type: 'fleet_job'
  projectId: string
  jobId: string
  /** Any non-empty string: the notice only triggers a refetch, so a new API state must not be dropped (D139). */
  state: string
  at: string
}

/** S1.5 §2.5: content-free approval notice; the page refetches (project-scoped approvals only). */
export interface LiveFleetApprovalEvent {
  id: string
  type: 'fleet_approval'
  projectId: string
  approvalId: string
  /** Any non-empty string (D253, same rule as D139). */
  status: string
  at: string
}

/** S2a §2.3: content-free log growth of one stream of one attempt; the viewer fetches from its cursor. */
export interface LiveFleetLogEvent {
  id: string
  type: 'fleet_log'
  projectId: string
  jobId: string
  leaseEpoch: number
  stream: 'run' | 'stdout' | 'stderr'
  size: number
  complete: boolean
  at: string
}

/** S4a §4: content-free notice that the signed-in user has a new notification (GET /api/me/events); the bell refetches. */
export interface LiveNotificationEvent {
  id: string
  type: 'notification'
  userId: string
  at: string
}

/** All event handlers except the resync are optional; a page subscribes to what it shows. */
export interface ProjectEventHandlers {
  onEvent?: (event: LiveTicketEvent) => void
  onFleetJob?: (event: LiveFleetJobEvent) => void
  onFleetApproval?: (event: LiveFleetApprovalEvent) => void
  onFleetLog?: (event: LiveFleetLogEvent) => void
  onResync: () => void
  /** S4a: only the user stream (/api/me/events) sends these. */
  onNotification?: (event: LiveNotificationEvent) => void
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

export function parseFleetJobEvent(raw: string): LiveFleetJobEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveFleetJobEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'fleet_job' || typeof value.id !== 'string' || typeof value.jobId !== 'string') return null
    if (typeof value.state !== 'string' || value.state.length === 0) return null
    return value as LiveFleetJobEvent
  }
  catch {
    return null
  }
}

export function parseFleetApprovalEvent(raw: string): LiveFleetApprovalEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveFleetApprovalEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'fleet_approval' || typeof value.id !== 'string' || typeof value.approvalId !== 'string') return null
    if (typeof value.status !== 'string' || value.status.length === 0) return null
    return value as LiveFleetApprovalEvent
  }
  catch {
    return null
  }
}

const FLEET_LOG_STREAMS: readonly string[] = ['run', 'stdout', 'stderr']
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function parseFleetLogEvent(raw: string): LiveFleetLogEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveFleetLogEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'fleet_log' || typeof value.id !== 'string' || typeof value.jobId !== 'string') return null
    if (!isCount(value.leaseEpoch) || !isCount(value.size) || typeof value.complete !== 'boolean') return null
    if (!FLEET_LOG_STREAMS.includes(value.stream as string)) return null
    return value as LiveFleetLogEvent
  }
  catch {
    return null
  }
}

export function parseNotificationEvent(raw: string): LiveNotificationEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveNotificationEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'notification' || typeof value.id !== 'string' || value.id.length === 0) return null
    return value as LiveNotificationEvent
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
      if (event && isNew(event.id)) handlers.onEvent?.(event)
    })
    const onFleetJob = handlers.onFleetJob
    if (onFleetJob) {
      es.addEventListener('fleet_job', (ev) => {
        const event = parseFleetJobEvent(ev.data)
        if (event && isNew(event.id)) onFleetJob(event)
      })
    }
    const onFleetApproval = handlers.onFleetApproval
    if (onFleetApproval) {
      es.addEventListener('fleet_approval', (ev) => {
        const event = parseFleetApprovalEvent(ev.data)
        if (event && isNew(event.id)) onFleetApproval(event)
      })
    }
    const onFleetLog = handlers.onFleetLog
    if (onFleetLog) {
      es.addEventListener('fleet_log', (ev) => {
        const event = parseFleetLogEvent(ev.data)
        if (event && isNew(event.id)) onFleetLog(event)
      })
    }
    const onNotification = handlers.onNotification
    if (onNotification) {
      es.addEventListener('notification', (ev) => {
        const event = parseNotificationEvent(ev.data)
        if (event && isNew(event.id)) onNotification(event)
      })
    }
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
