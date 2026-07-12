import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import { ref } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useTimelineEvents.ts')
const useApiModulePath = join(webDir, 'composables', 'useApi.ts')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — same Nuxt-globals pattern as tests/composables/useApi.spec.ts
// ─────────────────────────────────────────────────────────────────────────────

function applyNuxtGlobals(env: {
  fetchMock: jest.Mock
  tokenRef: { value: string | null }
  errorFn: jest.Mock
}) {
  (globalThis as Record<string, unknown>).useApi = () => ({
    $api: {
      get: async (path: string, opts?: Record<string, unknown>) => {
        const envelope = await env.fetchMock(`http://localhost:3100${path}`, opts)
        return envelope?.data ?? envelope
      },
    },
  })
}

function resetGlobals() {
  const g = globalThis as Record<string, unknown>
  g.useApi = undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1/AC2 — loadEvents calls $api.get with /projects/<slug>/timeline; appends
//            rows for AC1 and exposes eventType/actorId/action on returned
//            events (AC9 row shape)
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2: useTimelineEvents fetches /projects/<slug>/timeline', () => {
  beforeEach(resetGlobals)

  test('loadEvents calls $api.get with the /projects/<slug>/timeline path', async () => {
    const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
      Promise.resolve({ data: { events: [], nextCursor: undefined } }),
    )
    const errorFn = jest.fn()
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    await tl.loadEvents()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:3100/projects/acme/timeline')
    expect(opts).toBeDefined()
  })

  test('on success, the returned events are exposed with eventType/actorId/action fields', async () => {
    const fetchedEvents = [
      { id: 'e1', eventType: 'ticket_event', actorId: 'user-1', action: 'create', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'e2', eventType: 'agent_event', actorId: 'agent-7', action: 'pause', createdAt: '2026-01-02T00:00:00Z' },
    ]
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { events: fetchedEvents, nextCursor: undefined } }),
    )
    const errorFn = jest.fn()
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    await tl.loadEvents()

    expect(tl.events.value).toHaveLength(2)
    expect(tl.events.value[0]).toMatchObject({
      eventType: 'ticket_event',
      actorId: 'user-1',
      action: 'create',
    })
    expect(tl.error.value).toBeNull()
    expect(errorFn).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — error path: $api.get rejects, error ref is set, events cleared, error
//            is re-thrown so the page-level toast wrapper can run.
// ─────────────────────────────────────────────────────────────────────────────

describe('AC5: useTimelineEvents error path', () => {
  beforeEach(resetGlobals)

  test('when $api.get rejects, useTimelineEvents sets error, clears events, and re-throws', async () => {
    const networkError = Object.assign(new Error('boom'), {
      data: { ret: 1, message: 'Timeline down' },
    })
    const fetchMock = jest.fn(() => Promise.reject(networkError))
    const errorFn = jest.fn()
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    await expect(tl.loadEvents()).rejects.toBe(networkError)

    expect(tl.error.value).toBe(networkError)
    expect(tl.events.value).toEqual([])
    expect(tl.isLoading.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6/AC7 — filters populate query.eventTypes / from / to
// ─────────────────────────────────────────────────────────────────────────────

describe('AC6/AC7: filter inputs populate the timeline query', () => {
  beforeEach(resetGlobals)

  test('eventTypes, from and to are sent as query params when set', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { events: [], nextCursor: undefined } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    tl.eventTypeFilter.value = 'ticket_event'
    tl.fromFilter.value = '2026-01-01'
    tl.toFilter.value = '2026-01-31'

    await tl.loadEvents()

    const [, opts] = fetchMock.mock.calls[0]
    const query = (opts as { query?: Record<string, string> }).query
    expect(query).toEqual({
      eventTypes: 'ticket_event',
      from: '2026-01-01',
      to: '2026-01-31',
    })
  })

  test('empty filters produce an empty query object', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { events: [], nextCursor: undefined } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    await tl.loadEvents()

    const [, opts] = fetchMock.mock.calls[0]
    const query = (opts as { query?: Record<string, string> }).query
    expect(query).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — cursor pagination: loadMore sends cursor and appends events
// ─────────────────────────────────────────────────────────────────────────────

describe('AC8: cursor pagination', () => {
  beforeEach(resetGlobals)

  test('loadMore sends cursor and appends events to existing list', async () => {
    const firstPage = {
      data: {
        events: [
          { id: 'e1', eventType: 'ticket_event', actorId: 'u', action: 'create', createdAt: '2026-01-01T00:00:00Z' },
        ],
        nextCursor: 'cursor-1',
      },
    }
    const secondPage = {
      data: {
        events: [
          { id: 'e2', eventType: 'agent_event', actorId: 'a', action: 'pause', createdAt: '2026-01-02T00:00:00Z' },
        ],
        nextCursor: undefined,
      },
    }
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    await tl.loadEvents()
    expect(tl.events.value).toHaveLength(1)
    expect(tl.hasMore.value).toBe(true)

    await tl.loadMore()
    expect(tl.events.value).toHaveLength(2)
    expect(tl.events.value[1].eventType).toBe('agent_event')

    const [, page2Opts] = fetchMock.mock.calls[1]
    const page2Query = (page2Opts as { query?: Record<string, string> }).query
    expect(page2Query).toEqual({ cursor: 'cursor-1' })
  })

  test('applyFilters resets the cursor before re-fetching', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        data: { events: [{ id: 'e1', eventType: 't', actorId: 'u', action: 'a', createdAt: 'now' }], nextCursor: 'cursor-x' },
      })
      .mockResolvedValueOnce({ data: { events: [], nextCursor: 'cursor-y' } })
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    await tl.loadEvents()

    tl.eventTypeFilter.value = 'ticket_event'
    await tl.applyFilters()

    const [, page2Opts] = fetchMock.mock.calls[1]
    const page2Query = (page2Opts as { query?: Record<string, string> }).query
    expect(page2Query).toEqual({ eventTypes: 'ticket_event' })
    expect(page2Query?.cursor).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2/AC5 page contract — sidebar behavioral tests that verify the composable's
// data flow conforms to what the page template expects at render time.
// These bridge the gap between composable unit tests and page source-scans.
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2 page contract: composable exposes render-ready event fields', () => {
  beforeEach(resetGlobals)

  test('on successful load, events array items carry eventType, actorId, and action for template interpolation', async () => {
    const fetched = [
      { id: 'e1', eventType: 'ticket_event', actorId: 'usr-1', action: 'created ticket #42', createdAt: '2026-06-01T12:00:00Z' },
      { id: 'e2', eventType: 'agent_event',  actorId: 'ag-7',  action: 'paused',              createdAt: '2026-06-02T08:30:00Z' },
    ]
    const fetchMock = jest.fn(() => Promise.resolve({ data: { events: fetched, nextCursor: undefined } }))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    await tl.loadEvents()

    expect(tl.events.value).toHaveLength(fetched.length)
    for (const ev of tl.events.value) {
      expect(ev).toHaveProperty('id')
      expect(typeof ev.eventType).toBe('string')
      expect(typeof ev.actorId).toBe('string')
      expect(typeof ev.action).toBe('string')
      expect(typeof ev.createdAt).toBe('string')
    }
  })

  test('when isLoading transitions to false and events are non-empty, page should render the table (not loading/empty/error)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { events: [{ id: 'e1', eventType: 't', actorId: 'u', action: 'a', createdAt: 'now' }], nextCursor: undefined } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    expect(tl.isLoading.value).toBe(false)
    expect(tl.events.value).toHaveLength(0)

    const promise = tl.loadEvents()
    // isLoading must be true while the request is in flight
    expect(tl.isLoading.value).toBe(true)
    await promise

    // After load: not loading, has events, no error — template should show the table
    expect(tl.isLoading.value).toBe(false)
    expect(tl.events.value).toHaveLength(1)
    expect(tl.error.value).toBeNull()
  })
})

describe('AC5 page contract: error propagates so page-level catch can feed extractApiError + toast', () => {
  beforeEach(resetGlobals)

  test('when loadEvents rejects, the thrown error is extractable by extractApiError', async () => {
    const { extractApiError } = await import(useApiModulePath)

    const networkError = Object.assign(new Error('boom'), {
      data: { ret: 1, message: 'Timeline service unavailable' },
    })
    const fetchMock = jest.fn(() => Promise.reject(networkError))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    let caught: unknown = null
    try {
      await tl.loadEvents()
    } catch (err) {
      caught = err
    }

    expect(caught).not.toBeNull()
    const msg = extractApiError(caught)
    expect(msg).toBe('Timeline service unavailable')
    expect(tl.events.value).toEqual([])
    expect(tl.isLoading.value).toBe(false)
  })

  test('when loadEvents rejects, isLoading resets to false so the page does not render the loading indicator', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('fail')))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    try { await tl.loadEvents() } catch { /* page wrapper catches */ }

    expect(tl.isLoading.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial finding: overlapping initial/filter requests must not let a stale
// response overwrite a newer one. If the user changes a filter while the
// initial request is pending, only the most-recent request's result should be
// visible.
// ─────────────────────────────────────────────────────────────────────────────

describe('Stale-response guard: newer request wins over older one', () => {
  beforeEach(resetGlobals)

  test('a stale response does not overwrite events from a newer successful request', async () => {
    const initialEvents = [
      { id: 'stale-1', eventType: 'ticket_event', actorId: 'u', action: 'old', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const freshEvents = [
      { id: 'fresh-1', eventType: 'agent_event', actorId: 'a', action: 'new', createdAt: '2026-02-01T00:00:00Z' },
    ]

    let resolveInitial!: (value: unknown) => void
    const initialPromise = new Promise<unknown>((resolve) => { resolveInitial = resolve })
    const fetchMock = jest.fn()
      .mockReturnValueOnce(initialPromise)
      .mockResolvedValueOnce({ data: { events: freshEvents, nextCursor: undefined } })
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    const initialCall = tl.loadEvents()
    // Simulate user changing filter and triggering a new request before the
    // initial one resolves.
    tl.eventTypeFilter.value = 'agent_event'
    const secondCall = tl.loadEvents()

    // Resolve the second request first; then resolve the (now stale) initial.
    await secondCall
    resolveInitial({ data: { events: initialEvents, nextCursor: undefined } })
    await initialCall

    // Stale response must NOT have overwritten the fresh events.
    expect(tl.events.value.map(e => e.id)).toEqual(['fresh-1'])
    expect(tl.error.value).toBeNull()
    expect(tl.isLoading.value).toBe(false)
  })

  test('a stale rejection does not surface as the active error after a newer success', async () => {
    let rejectInitial!: (err: unknown) => void
    const initialPromise = new Promise<unknown>((_resolve, reject) => { rejectInitial = reject })
    const fetchMock = jest.fn()
      .mockReturnValueOnce(initialPromise)
      .mockResolvedValueOnce({ data: { events: [{ id: 'fresh', eventType: 't', actorId: 'u', action: 'a', createdAt: 'now' }], nextCursor: undefined } })
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')

    const initialCall = tl.loadEvents()
    tl.eventTypeFilter.value = 'x'
    const secondCall = tl.loadEvents()

    await secondCall
    rejectInitial(new Error('stale boom'))
    await initialCall.catch(() => { /* swallow — this is the stale request */ })

    expect(tl.error.value).toBeNull()
    expect(tl.events.value.map(e => e.id)).toEqual(['fresh'])
    expect(tl.isLoading.value).toBe(false)
  })
})
