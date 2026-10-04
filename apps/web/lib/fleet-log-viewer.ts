import type { EntriesPageRequest } from '~/lib/fleet-log-query'
import type { FleetJobLogEntriesDto } from '~/lib/fleet-log-types'
import { openedView, withEarlier, withLater, type LogView } from '~/lib/fleet-log-view'

/** Rows per user-driven page (the API default). */
export const LOG_PAGE_LIMIT = 200
/** Rows per follow page: catching up a burst takes fewer requests (API max 500). */
export const FOLLOW_PAGE_LIMIT = 500
/** Spec §4.1: on 429 wait 2 s, 4 s, 8 s, then give up with an error. */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2000, 4000, 8000]

export interface LogViewerState {
  view: LogView | null
  loading: boolean
  follow: boolean
  rateLimited: boolean
  /** A read answered 410: the stream was deleted by retention. */
  expired: boolean
  error: string | null
}

export interface LogViewerDeps {
  /** One entries request for the viewer's stream, attempt and filters. */
  fetchPage: (page: EntriesPageRequest) => Promise<FleetJobLogEntriesDto>
  sleep: (ms: number) => Promise<void>
  /** Any filter is active: an empty follow page then stops instead of scanning on (criterion 3). */
  filtered: boolean
  onChange: (state: LogViewerState) => void
  describeError: (err: unknown) => string
}

export interface LogViewer {
  open: () => Promise<void>
  loadEarlier: () => Promise<void>
  loadMore: () => Promise<void>
  keepSearching: () => Promise<void>
  /** A fleet_log for this stream and attempt (or a resync): fetch forward while following. */
  onGrowth: () => Promise<void>
  setFollow: (on: boolean) => void
  /** Reopen at the end with follow on (spec §4.1 "Jump to latest"). */
  jumpToLatest: () => Promise<void>
  dispose: () => void
}

/** ApiError carries the envelope `ret` (429, 410) as `code`; a bare fetch error carries `status`. */
function errorCode(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const e = err as { code?: unknown; status?: unknown }
  if (typeof e.code === 'number') return e.code
  return typeof e.status === 'number' ? e.status : undefined
}

/**
 * Spec §4.1 viewer behaviour, framework-free: one request at a time, growth notices coalesced into one follow-up
 * fetch, user actions ignored while a request runs. The page owns one viewer per (stream, attempt, filters).
 */
export function createLogViewer(deps: LogViewerDeps, initial: { follow: boolean }): LogViewer {
  let state: LogViewerState = { view: null, loading: false, follow: initial.follow, rateLimited: false, expired: false, error: null }
  let disposed = false
  let growthPending = false

  const set = (patch: Partial<LogViewerState>): void => {
    state = { ...state, ...patch }
    if (!disposed) deps.onChange(state)
  }

  async function request(page: EntriesPageRequest): Promise<FleetJobLogEntriesDto | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await deps.fetchPage(page)
        if (disposed) return null
        if (state.rateLimited) set({ rateLimited: false })
        return result
      }
      catch (err: unknown) {
        if (disposed) return null
        const code = errorCode(err)
        if (code === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
          set({ rateLimited: true })
          await deps.sleep(RATE_LIMIT_BACKOFF_MS[attempt])
          if (disposed) return null
          continue
        }
        if (code === 410) set({ expired: true, view: null, follow: false, rateLimited: false })
        else set({ error: deps.describeError(err), rateLimited: false })
        return null
      }
    }
  }

  async function exclusive(task: () => Promise<void>): Promise<void> {
    if (state.loading || disposed) return
    set({ loading: true, error: null })
    try {
      await task()
    }
    finally {
      if (!disposed) set({ loading: false })
    }
    if (growthPending && !disposed) {
      growthPending = false
      await exclusive(followForward)
    }
  }

  /** Forward from the tail until the end, or until a filtered page matches nothing (then "Keep searching"). */
  async function followForward(): Promise<void> {
    while (state.follow && state.view && !disposed) {
      const from = state.view.tail
      const page = await request({ direction: 'forward', cursor: from, limit: FOLLOW_PAGE_LIMIT })
      if (!page || !state.view) return
      set({ view: withLater(state.view, page) })
      if (page.atEnd || page.nextCursor <= from) return
      if (page.entries.length === 0 && deps.filtered) return
    }
  }

  const open = (): Promise<void> => exclusive(async () => {
    const page = await request({ direction: 'backward', limit: LOG_PAGE_LIMIT })
    if (page) set({ view: openedView(page) })
  })

  const loadEarlier = (): Promise<void> => exclusive(async () => {
    const view = state.view
    if (!view || view.atStart) return
    const page = await request({ direction: 'backward', cursor: view.head, limit: LOG_PAGE_LIMIT })
    if (page && state.view) set({ view: withEarlier(state.view, page) })
  })

  const loadMore = (): Promise<void> => exclusive(async () => {
    const view = state.view
    if (!view) return
    const page = await request({ direction: 'forward', cursor: view.tail, limit: LOG_PAGE_LIMIT })
    if (page && state.view) set({ view: withLater(state.view, page) })
  })

  const keepSearching = (): Promise<void> => (state.view?.searching?.direction === 'backward' ? loadEarlier() : loadMore())

  async function onGrowth(): Promise<void> {
    if (!state.follow || disposed) return
    // Recorded even while the opening request runs (no view yet): its answer may predate this growth.
    if (state.loading) {
      growthPending = true
      return
    }
    if (!state.view) return
    await exclusive(followForward)
  }

  async function jumpToLatest(): Promise<void> {
    if (state.loading || disposed) return
    set({ follow: true, view: null })
    await open()
  }

  return {
    open,
    loadEarlier,
    loadMore,
    keepSearching,
    onGrowth,
    setFollow: (on) => { if (state.follow !== on) set({ follow: on }) },
    jumpToLatest,
    dispose: () => { disposed = true },
  }
}
