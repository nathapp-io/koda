import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { ref } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useTimelineEvents.ts')
const timelineQueryPath = join(webDir, 'lib', 'timeline-query.ts')
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

function buildQueryInTimezone(timezone: string, filters: Record<string, string>) {
  const script = `
    const fs = require('fs')
    const ts = require('typescript')
    const source = fs.readFileSync(process.argv[1], 'utf8')
    const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
    const loaded = { exports: {} }
    new Function('exports', 'module', 'require', js)(loaded.exports, loaded, require)
    console.log(JSON.stringify(loaded.exports.buildTimelineQuery(JSON.parse(process.argv[2]))))
  `
  const result = spawnSync(process.execPath, ['-e', script, timelineQueryPath, JSON.stringify(filters)], {
    cwd: webDir,
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone },
  })
  if (result.status !== 0) throw new Error(result.stderr || 'Timezone query process failed')
  return JSON.parse(result.stdout) as Record<string, string>
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

describe('US-008 local calendar date bounds', () => {
  beforeEach(resetGlobals)

  // A Jest worker ignores a `process.env.TZ` assignment made after it started, so the Kuala Lumpur numbers below only
  // reproduce in a child process launched with TZ set — the same mechanism AC-4/AC-5 and the B2 regressions use. An
  // in-process switch passes on a host that already sits at UTC+8 and fails on a UTC runner.
  test('AC-1: Kuala Lumpur bounds run from local midnight to the last millisecond before the next one', () => {
    expect(buildQueryInTimezone('Asia/Kuala_Lumpur', { from: '2026-11-28', to: '2026-11-28' }))
      .toEqual({ from: '2026-11-27T16:00:00.000Z', to: '2026-11-28T15:59:59.999Z' })
  })

  test('AC-1 / AC-2 / AC-3: the selected day includes both endpoints but excludes the next midnight', async () => {
    const { buildTimelineQuery } = await import(timelineQueryPath)
    // Bounds of the selected day as this host's zone measures it, so the fixture sits exactly on both edges whatever
    // timezone the suite runs in. The exact Kuala Lumpur numbers are pinned by the child-process test above.
    const { from: expectedFrom = '', to: expectedTo = '' }
      = buildTimelineQuery({ from: '2026-11-28', to: '2026-11-28' })
    const fixture = [
      { id: 'before-from', at: new Date(Date.parse(expectedFrom) - 1).toISOString() },
      { id: 'from', at: expectedFrom },
      { id: 'to', at: expectedTo },
      { id: 'next-midnight', at: new Date(Date.parse(expectedTo) + 1).toISOString() },
    ]
    let capturedQuery: Record<string, string> = {}
    const fetchMock = jest.fn((_url: string, opts?: Record<string, unknown>) => {
      capturedQuery = (opts?.query ?? {}) as Record<string, string>
      const from = Date.parse(capturedQuery.from)
      const to = Date.parse(capturedQuery.to)
      return Promise.resolve({ data: { events: fixture.filter(event => {
        const time = Date.parse(event.at)
        return time >= from && time <= to
      }).map(event => ({ id: event.id, eventType: 'ticket_event', actorId: 'u', action: event.id, createdAt: event.at })) } })
    })
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })
    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    tl.fromFilter.value = '2026-11-28'
    tl.toFilter.value = '2026-11-28'

    await tl.loadEvents()

    expect(capturedQuery).toEqual({ from: expectedFrom, to: expectedTo })
    expect(tl.events.value.map(event => event.id)).toEqual(['from', 'to'])
  })

  test.each([
    ['America/New_York', '2026-03-08', 23],
    ['America/New_York', '2026-11-01', 25],
  ])('AC-4 / AC-5: %s %s local day spans %i hours', (timezone, date, hours) => {
    const query = buildQueryInTimezone(timezone, { from: date, to: date })
    const start = Date.parse(query.from)
    const exclusiveNextMidnight = Date.parse(query.to) + 1
    expect((exclusiveNextMidnight - start) / 3_600_000).toBe(hours)
  })

  // America/Santiago jumps forward at local midnight on 2026-09-06 (00:00 -> 01:00), so that calendar day has no
  // 00:00 and the day before it ends one hour before a naive "add a day" would say.
  test.each([
    ['America/Santiago', '2026-09-05', '2026-09-05T04:00:00.000Z', '2026-09-06T03:59:59.999Z', 24],
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T02:59:59.999Z', 23],
  ])('B2 regression: %s %s spans its own local day (%i hours) across the midnight DST jump', (timezone, date, expectedFrom, expectedTo, hours) => {
    const query = buildQueryInTimezone(timezone, { from: date, to: date })
    expect(query.from).toBe(expectedFrom)
    expect(query.to).toBe(expectedTo)
    // The bound is the instant before the next calendar day starts, so the following day's first hour is excluded.
    expect((Date.parse(query.to) + 1 - Date.parse(query.from)) / 3_600_000).toBe(hours)
  })

  test('AC-6 / AC-7: single-sided dates omit the unselected bound', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ data: { events: [] } }))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })
    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    tl.fromFilter.value = '2026-01-01'
    await tl.loadEvents()
    expect((fetchMock.mock.calls[0][1] as { query: Record<string, string> }).query).toEqual({ from: expect.any(String) })
    tl.fromFilter.value = ''
    tl.toFilter.value = '2026-01-01'
    await tl.loadEvents()
    expect((fetchMock.mock.calls[1][1] as { query: Record<string, string> }).query).toEqual({ to: expect.any(String) })
  })

  test('AC-8: explicit timestamps pass through unchanged', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ data: { events: [] } }))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })
    const { useTimelineEvents } = await import(composablePath)
    const tl = useTimelineEvents('acme')
    tl.fromFilter.value = '2026-01-01T12:34:56.789Z'
    tl.toFilter.value = '2026-01-02T00:00:00+03:00'
    await tl.loadEvents()
    expect((fetchMock.mock.calls[0][1] as { query: Record<string, string> }).query).toEqual({
      from: '2026-01-01T12:34:56.789Z', to: '2026-01-02T00:00:00+03:00',
    })
  })
})

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
      from: expect.stringMatching(/Z$/),
      to: expect.stringMatching(/Z$/),
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

  test('AC-9: loadMore preserves filtered bounds, sends cursor, and appends events', async () => {
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
    tl.fromFilter.value = '2026-01-01'
    tl.toFilter.value = '2026-01-31'

    await tl.loadEvents()
    expect(tl.events.value).toHaveLength(1)
    expect(tl.hasMore.value).toBe(true)

    await tl.loadMore()
    expect(tl.events.value).toHaveLength(2)
    expect(tl.events.value[1].eventType).toBe('agent_event')

    const [, page2Opts] = fetchMock.mock.calls[1]
    const page2Query = (page2Opts as { query?: Record<string, string> }).query
    const [, page1Opts] = fetchMock.mock.calls[0]
    const page1Query = (page1Opts as { query?: Record<string, string> }).query
    expect(page2Query).toEqual({ ...page1Query, cursor: 'cursor-1' })
  })

  test('AC-10: applyFilters clears the prior cursor before re-fetching', async () => {
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
