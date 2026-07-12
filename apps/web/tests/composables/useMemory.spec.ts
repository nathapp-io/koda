import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import { ref } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useMemory.ts')
const useApiModulePath = join(webDir, 'composables', 'useApi.ts')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — same Nuxt-globals pattern as tests/composables/useTimelineEvents.spec.ts
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
// AC2 — loadMemory calls $api.get with /projects/<slug>/memory
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2: useMemory fetches /projects/<slug>/memory', () => {
  beforeEach(resetGlobals)

  test('loadMemory calls $api.get with the /projects/<slug>/memory path', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { items: [], total: 0 } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await mem.loadMemory()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:3100/projects/acme/memory')
    expect(opts).toBeDefined()
  })

  test('on success, items array is exposed with subject/predicate/object/kind/confidence/status fields', async () => {
    const fetched = [
      {
        id: 'mem-1',
        subject: 'ticket:42',
        predicate: 'status',
        object: 'open',
        kind: 'FACT',
        confidence: 0.95,
        status: 'active',
      },
      {
        id: 'mem-2',
        subject: 'agent:7',
        predicate: 'role',
        object: 'developer',
        kind: 'FACT',
        confidence: 0.8,
        status: 'active',
      },
    ]
    const fetchMock = jest.fn(() => Promise.resolve({ data: { items: fetched, total: 2 } }))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')
    await mem.loadMemory()

    expect(mem.items.value).toHaveLength(2)
    expect(mem.items.value[0]).toMatchObject({
      subject: 'ticket:42',
      predicate: 'status',
      object: 'open',
      kind: 'FACT',
      confidence: 0.95,
      status: 'active',
    })
    expect(mem.error.value).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — error path: $api.get rejects, error ref is set, items cleared, error
//        is re-thrown so the page-level toast wrapper can run.
// ─────────────────────────────────────────────────────────────────────────────

describe('AC5: useMemory error path', () => {
  beforeEach(resetGlobals)

  test('when $api.get rejects, useMemory sets error, clears items, and re-throws', async () => {
    const networkError = Object.assign(new Error('boom'), {
      data: { ret: 1, message: 'Memory down' },
    })
    const fetchMock = jest.fn(() => Promise.reject(networkError))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await expect(mem.loadMemory()).rejects.toBe(networkError)

    expect(mem.error.value).toBe(networkError)
    expect(mem.items.value).toEqual([])
    expect(mem.isLoading.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6/AC7 — filters populate query.kind / query.status
// ─────────────────────────────────────────────────────────────────────────────

describe('AC6/AC7: filter inputs populate the memory query', () => {
  beforeEach(resetGlobals)

  test('kind and status are sent as query params when set', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { items: [], total: 0 } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')
    mem.kindFilter.value = 'FACT'
    mem.statusFilter.value = 'active'

    await mem.loadMemory()

    const [, opts] = fetchMock.mock.calls[0]
    const query = (opts as { query?: Record<string, string> }).query
    expect(query).toEqual({
      kind: 'FACT',
      status: 'active',
    })
  })

  test('empty filters produce an empty query object', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { items: [], total: 0 } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')
    await mem.loadMemory()

    const [, opts] = fetchMock.mock.calls[0]
    const query = (opts as { query?: Record<string, string> }).query
    expect(query).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — page-number pagination: loadMore sends page and appends items
// ─────────────────────────────────────────────────────────────────────────────

describe('AC8: page-number pagination', () => {
  beforeEach(resetGlobals)

  test('loadMore sends the next page and appends items to existing list', async () => {
    const firstPage = {
      data: {
        items: [
          { id: 'mem-1', subject: 'a', predicate: 'b', object: 'c', kind: 'FACT', confidence: 0.9, status: 'active' },
        ],
        total: 3,
      },
    }
    const secondPage = {
      data: {
        items: [
          { id: 'mem-2', subject: 'd', predicate: 'e', object: 'f', kind: 'FACT', confidence: 0.7, status: 'active' },
        ],
        total: 3,
      },
    }
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await mem.loadMemory()
    expect(mem.items.value).toHaveLength(1)
    expect(mem.hasMore.value).toBe(true)

    await mem.loadMore()
    expect(mem.items.value).toHaveLength(2)
    expect(mem.items.value[1].id).toBe('mem-2')

    const [, page2Opts] = fetchMock.mock.calls[1]
    const page2Query = (page2Opts as { query?: Record<string, string> }).query
    expect(page2Query).toEqual({ page: '2' })
  })

  test('applyFilters resets the page before re-fetching', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        data: { items: [{ id: 'mem-1', subject: 'a', predicate: 'b', object: 'c', kind: 'FACT', confidence: 0.9, status: 'active' }], total: 3 },
      })
      .mockResolvedValueOnce({ data: { items: [], total: 1 } })
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')
    await mem.loadMemory()

    mem.kindFilter.value = 'FACT'
    await mem.applyFilters()

    const [, page2Opts] = fetchMock.mock.calls[1]
    const page2Query = (page2Opts as { query?: Record<string, string> }).query
    expect(page2Query).toEqual({ kind: 'FACT' })
    expect(page2Query?.page).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Page contract tests — composable exposes render-ready fields and state
// transitions for the page template.
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1 page contract: composable exposes render-ready item fields', () => {
  beforeEach(resetGlobals)

  test('on successful load, items carry subject/predicate/object/kind/confidence/status for template interpolation', async () => {
    const fetched = [
      { id: 'mem-1', subject: 'ticket:42', predicate: 'status', object: 'open', kind: 'FACT', confidence: 0.95, status: 'active' },
      { id: 'mem-2', subject: 'agent:7',  predicate: 'role',   object: 'developer', kind: 'FACT', confidence: 0.8, status: 'active' },
    ]
    const fetchMock = jest.fn(() => Promise.resolve({ data: { items: fetched, total: 2 } }))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await mem.loadMemory()

    expect(mem.items.value).toHaveLength(fetched.length)
    for (const item of mem.items.value) {
      expect(typeof item.subject).toBe('string')
      expect(typeof item.predicate).toBe('string')
      expect(typeof item.object).toBe('string')
      expect(typeof item.kind).toBe('string')
      expect(typeof item.confidence).toBe('number')
      expect(typeof item.status).toBe('string')
    }
  })

  test('when isLoading transitions to false and items are non-empty, page should render the table', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ data: { items: [{ id: 'mem-1', subject: 's', predicate: 'p', object: 'o', kind: 'FACT', confidence: 0.9, status: 'active' }], total: 1 } }),
    )
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    expect(mem.isLoading.value).toBe(false)
    expect(mem.items.value).toHaveLength(0)

    const promise = mem.loadMemory()
    expect(mem.isLoading.value).toBe(true)
    await promise

    expect(mem.isLoading.value).toBe(false)
    expect(mem.items.value).toHaveLength(1)
    expect(mem.error.value).toBeNull()
  })
})

describe('AC5 page contract: error propagates so page-level catch can feed extractApiError + toast', () => {
  beforeEach(resetGlobals)

  test('when loadMemory rejects, the thrown error is extractable by extractApiError', async () => {
    const { extractApiError } = await import(useApiModulePath)

    const networkError = Object.assign(new Error('boom'), {
      data: { ret: 1, message: 'Memory service unavailable' },
    })
    const fetchMock = jest.fn(() => Promise.reject(networkError))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    let caught: unknown = null
    try {
      await mem.loadMemory()
    }
    catch (err) {
      caught = err
    }

    expect(caught).not.toBeNull()
    const msg = extractApiError(caught)
    expect(msg).toBe('Memory service unavailable')
    expect(mem.items.value).toEqual([])
    expect(mem.isLoading.value).toBe(false)
  })

  test('when loadMemory rejects, isLoading resets to false so the page does not render the loading indicator', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('fail')))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    try { await mem.loadMemory() } catch { /* page wrapper catches */ }

    expect(mem.isLoading.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Recovery behavior — when loadMore fails after incrementing `page`, the
// composable must restore the previous page and preserve the already-loaded
// rows so the user can retry without losing data or skipping results.
// ─────────────────────────────────────────────────────────────────────────────

describe('useMemory: loadMore failure restores page and preserves items', () => {
  beforeEach(resetGlobals)

  test('when loadMore fails, page is restored to its pre-increment value', async () => {
    const firstPage = {
      data: {
        items: [
          { id: 'mem-1', subject: 'a', predicate: 'b', object: 'c', kind: 'FACT', confidence: 0.9, status: 'active' },
        ],
        total: 5,
      },
    }
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('page 2 down'))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await mem.loadMemory()
    expect(mem.page.value).toBe(1)
    expect(mem.hasMore.value).toBe(true)

    try {
      await mem.loadMore()
    }
    catch {
      /* expected: page 2 fetch failed */
    }

    // The page counter was incremented before the fetch; on failure it
    // must be decremented so the next retry fetches page 2 again instead
    // of skipping straight to page 3.
    expect(mem.page.value).toBe(1)

    // And the next retry should go out with page=2 (NOT page=3).
    fetchMock.mockResolvedValueOnce({
      data: {
        items: [
          { id: 'mem-2', subject: 'd', predicate: 'e', object: 'f', kind: 'FACT', confidence: 0.7, status: 'active' },
        ],
        total: 5,
      },
    })
    await mem.loadMore()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [, opts] = fetchMock.mock.calls[2]
    const query = (opts as { query?: Record<string, string> }).query
    expect(query.page).toBe('2')
  })

  test('when loadMore fails, the already-loaded items are preserved (not wiped)', async () => {
    const firstPage = {
      data: {
        items: [
          { id: 'mem-1', subject: 'a', predicate: 'b', object: 'c', kind: 'FACT', confidence: 0.9, status: 'active' },
        ],
        total: 5,
      },
    }
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('page 2 down'))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await mem.loadMemory()
    const itemsBeforeFailure = mem.items.value
    expect(itemsBeforeFailure).toHaveLength(1)

    try {
      await mem.loadMore()
    }
    catch {
      /* expected */
    }

    // The user must still see their already-loaded rows after a failed
    // append — only an initial-load failure clears items.
    expect(mem.items.value).toHaveLength(1)
    expect(mem.items.value[0].id).toBe('mem-1')
  })

  test('when the INITIAL loadMemory fails, items ARE cleared (empty state is correct)', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('boom')))
    applyNuxtGlobals({ fetchMock, tokenRef: ref(null), errorFn: jest.fn() })

    const { useMemory } = await import(composablePath)
    const mem = useMemory('acme')

    await expect(mem.loadMemory()).rejects.toThrow('boom')

    // Initial load failure: items are cleared so the empty-state copy
    // doesn't show stale rows.
    expect(mem.items.value).toEqual([])
  })
})
