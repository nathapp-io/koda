import { afterEach, describe, expect, jest, test } from '@jest/globals'
import type { ThreadDto } from '~/lib/thread-types'

const listItem = (overrides: Record<string, unknown> = {}): ThreadDto => ({
  id: 'th1',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'f1',
  title: 'Plan the auth flow',
  createdById: 'u1',
  runnerId: 'rn1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '.nax/features/f1/prd.json',
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  ...overrides,
})

const g = globalThis as Record<string, unknown>

describe('useThreads (US-003)', () => {
  afterEach(() => {
    delete g.useApi
  })

  test('US-003 AC15: load exposes threadsEnabled false from the list response', async () => {
    const items = [listItem({ id: 'th1' })]
    const get = jest.fn(async () => ({ items, threadsEnabled: false }))
    g.useApi = () => ({ $api: { get } })

    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    await list.load()

    expect(list.threadsEnabled.value).toBe(false)
    expect(list.threads.value).toEqual(items)
    expect(get).toHaveBeenCalledWith('/projects/web/threads', { query: { status: 'ACTIVE', size: '100' } })
  })

  test('US-003 AC15 (boundary): load(status) passes a non-default status through as a string query value', async () => {
    const get = jest.fn(async () => ({ items: [], threadsEnabled: true }))
    g.useApi = () => ({ $api: { get } })

    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    await list.load('ARCHIVED')

    expect(list.threadsEnabled.value).toBe(true)
    expect(list.threads.value).toEqual([])
    expect(get).toHaveBeenCalledWith('/projects/web/threads', { query: { status: 'ARCHIVED', size: '100' } })
  })
})

describe('useThreads pagination (US-004)', () => {
  afterEach(() => {
    delete g.useApi
  })

  interface ThreadsResponse { items: ThreadDto[]; threadsEnabled: boolean }
  const deferred = () => {
    let resolve!: (value: ThreadsResponse) => void
    let reject!: (error: Error) => void
    const promise = new Promise<ThreadsResponse>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }
  const rows = (prefix: string, count: number): ThreadDto[] =>
    Array.from({ length: count }, (_, index) => listItem({ id: `${prefix}-${index + 1}` }))

  test('AC-1: page two sends the selected status in its query', async () => {
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }) =>
      options?.query?.page === '2' ? { items: [listItem({ id: 'row-101' })], threadsEnabled: true } : { items: rows('active', 100), threadsEnabled: true })
    g.useApi = () => ({ $api: { get } })
    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    await list.load('ARCHIVED')
    await list.loadMore()
    expect(get).toHaveBeenLastCalledWith('/projects/web/threads', { query: { status: 'ARCHIVED', size: '100', page: '2' } })
  })

  test.each(['status switch', 'same-status reload'] as const)('AC-4/5: held page two is discarded after %s', async (change) => {
    const pageTwo = deferred()
    const get = jest.fn((_path: string, options?: { query?: Record<string, string> }) => {
      if (options?.query?.page === '2') return pageTwo.promise
      if (options?.query?.status === 'ARCHIVED') return Promise.resolve({ items: [listItem({ id: 'archived', status: 'ARCHIVED' })], threadsEnabled: true })
      return Promise.resolve({ items: [listItem({ id: change === 'same-status reload' ? 'reloaded' : 'active' })], threadsEnabled: true })
    })
    g.useApi = () => ({ $api: { get } })
    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    await list.load()
    // Make the list eligible for a second page while retaining a recognizable first-page row.
    list.hasNext.value = true
    const append = list.loadMore()
    await list.load(change === 'status switch' ? 'ARCHIVED' : 'ACTIVE')
    pageTwo.resolve({ items: [listItem({ id: 'stale-row' })], threadsEnabled: true })
    await append
    expect(list.threads.value.map(row => row.id)).toEqual([change === 'status switch' ? 'archived' : 'reloaded'])
  })

  test('AC-6: duplicate loadMore calls share one in-flight page request', async () => {
    const page = deferred()
    const get = jest.fn((_path: string, options?: { query?: Record<string, string> }) => options?.query?.page === '2' ? page.promise : Promise.resolve({ items: rows('a', 100), threadsEnabled: true }))
    g.useApi = () => ({ $api: { get } })
    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    await list.load()
    const first = list.loadMore()
    const second = list.loadMore()
    expect(get).toHaveBeenCalledTimes(2)
    page.resolve({ items: [listItem({ id: 'row-101' })], threadsEnabled: true })
    await Promise.all([first, second])
  })

  test('AC-7: failure retries the same missing page and AC-8 retains visible rows', async () => {
    let fail = true
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }) => {
      if (options?.query?.page === '2' && fail) { fail = false; throw new Error('network') }
      return { items: options?.query?.page === '2' ? [listItem({ id: 'row-101' })] : rows('a', 100), threadsEnabled: true }
    })
    g.useApi = () => ({ $api: { get } })
    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    await list.load()
    await expect(list.loadMore()).rejects.toThrow('network')
    expect(list.threads.value).toHaveLength(100)
    expect(list.current.value).toBe(1)
    await list.loadMore()
    expect(get.mock.calls.filter(([, options]) => options?.query?.page === '2')).toHaveLength(2)
    expect(list.threads.value).toHaveLength(101)
  })
})

/**
 * koda#294 (2aw-D13): overlapping reads of the same list. Archived is asked first and Active second,
 * the Active read answers first, and the Archived one then lands. The overtaken read must write
 * nothing — not the rows, not the kill switch, not the status — and must tell its caller that it did
 * not apply, so the page keeps the URL on the list it shows. This mirrors
 * `useWorkspaceThreads` (US-004) and its own overtaken-read case.
 */
describe('useThreads out-of-order reads (#294)', () => {
  afterEach(() => {
    delete g.useApi
  })

  interface ThreadsResponse {
    items: ThreadDto[]
    threadsEnabled: boolean
  }

  /** A response the test settles by hand, so one read can answer before the other. */
  const deferred = () => {
    let resolve!: (value: ThreadsResponse) => void
    let reject!: (error: Error) => void
    const promise = new Promise<ThreadsResponse>((done, fail) => {
      resolve = done
      reject = fail
    })
    return { promise, resolve, reject }
  }

  const activeRows = [listItem({ id: 'active' })]
  const archivedRows = [listItem({ id: 'archived', status: 'ARCHIVED' })]

  /** Archived answers only when the test settles it; Active answers on the next microtask. */
  async function startRace() {
    const archived = deferred()
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }): Promise<ThreadsResponse> =>
      options?.query?.status === 'ARCHIVED' ? archived.promise : { items: activeRows, threadsEnabled: true })
    g.useApi = () => ({ $api: { get } })

    const { useThreads } = await import('~/composables/useThreads')
    const list = useThreads('web')
    const overtaken = list.load('ARCHIVED')
    const applied = await list.load('ACTIVE')
    return { list, archived, overtaken, applied }
  }

  test('AC-1: the overtaken ARCHIVED read leaves status on ACTIVE', async () => {
    const { list, archived, overtaken } = await startRace()

    archived.resolve({ items: archivedRows, threadsEnabled: true })
    await overtaken

    expect(list.status.value).toBe('ACTIVE')
  })

  test('AC-2: the overtaken ARCHIVED read leaves the ACTIVE rows in threads', async () => {
    const { list, archived, overtaken } = await startRace()

    archived.resolve({ items: archivedRows, threadsEnabled: true })
    await overtaken

    expect(list.threads.value.map(thread => thread.id)).toEqual(['active'])
  })

  test('AC-3: the overtaken ARCHIVED load resolves false', async () => {
    const { archived, overtaken } = await startRace()

    archived.resolve({ items: archivedRows, threadsEnabled: true })

    expect(await overtaken).toBe(false)
  })

  test('AC-4: the ACTIVE load that applied resolves true', async () => {
    const { applied } = await startRace()

    expect(applied).toBe(true)
  })

  /**
   * The overtaken read fails instead of answering. It still rejects (its caller sees the error), and
   * the rows the newer read already applied stay put.
   */
  test('AC-5: an overtaken load that rejects leaves the newer rows in threads', async () => {
    const { list, archived, overtaken } = await startRace()

    archived.reject(new Error('network'))
    await expect(overtaken).rejects.toThrow('network')

    expect(list.threads.value.map(thread => thread.id)).toEqual(['active'])
    expect(list.status.value).toBe('ACTIVE')
  })
})