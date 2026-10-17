import { afterEach, describe, expect, jest, test } from '@jest/globals'
import type { ThreadDto } from '~/lib/thread-types'

/**
 * US-004 (fleet S5b 1d): the personal thread list over the top-level `/threads` route. Every row is
 * the caller's own WORKSPACE thread, so a row carries its home project and no repository.
 */

const listItem = (overrides: Record<string, unknown> = {}): ThreadDto => ({
  id: 'th1',
  kind: 'WORKSPACE',
  repoId: null,
  baseRef: null,
  feature: null,
  title: 'Plan the rollout',
  createdById: 'u1',
  runnerId: null,
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: null,
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  homeProject: { slug: 'web', name: 'Web' },
  ...overrides,
})

const g = globalThis as Record<string, unknown>

describe('useWorkspaceThreads (US-004 AC-6, AC-7)', () => {
  afterEach(() => {
    delete g.useApi
  })

  test('AC-6: load(ARCHIVED) reads /threads with the status and size query and holds the response items', async () => {
    const items = [listItem({ id: 'th1' }), listItem({ id: 'th2' })]
    const get = jest.fn(async () => ({ items, threadsEnabled: true }))
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load('ARCHIVED')

    expect(get).toHaveBeenCalledWith('/threads', { query: { status: 'ARCHIVED', size: '100' } })
    expect(list.threads.value).toEqual(items)
    expect(list.status.value).toBe('ARCHIVED')
  })

  test('AC-7: load() defaults to ACTIVE and exposes threadsEnabled false from the response', async () => {
    const get = jest.fn(async () => ({ items: [], threadsEnabled: false }))
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load()

    expect(get).toHaveBeenCalledWith('/threads', { query: { status: 'ACTIVE', size: '100' } })
    expect(list.threadsEnabled.value).toBe(false)
    expect(list.threads.value).toEqual([])
  })
})

/**
 * B2: `GET /threads` is paged and a user may own more threads than one page holds. `load()` keeps
 * the first read exactly `{ status, size }` (AC-6); `loadMore()` asks for `page: 2`, appends, and a
 * page shorter than the maximum means there is nothing behind it.
 */
describe('useWorkspaceThreads pagination (B2)', () => {
  afterEach(() => {
    delete g.useApi
  })

  const fullPage = (prefix: string): ThreadDto[] =>
    Array.from({ length: 100 }, (_, index) => listItem({ id: `${prefix}${index}` }))

  /** A response the test resolves by hand, so a reload can happen while a page read is in flight. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }

  test('a short first page leaves nothing to load more of', async () => {
    const get = jest.fn(async () => ({ items: [listItem()], threadsEnabled: true }))
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load()

    expect(list.hasNext.value).toBe(false)
    expect(list.current.value).toBe(1)
    await list.loadMore()
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('a full first page offers the next one, and loadMore appends it', async () => {
    const first = fullPage('a')
    const second = [listItem({ id: 'b0' })]
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }) =>
      options?.query?.page === '2' ? { items: second, threadsEnabled: true } : { items: first, threadsEnabled: true })
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load('ARCHIVED')
    expect(list.hasNext.value).toBe(true)

    await list.loadMore()

    expect(get).toHaveBeenLastCalledWith('/threads', { query: { status: 'ARCHIVED', size: '100', page: '2' } })
    expect(list.threads.value).toHaveLength(101)
    expect(list.threads.value[0]?.id).toBe('a0')
    expect(list.threads.value[100]?.id).toBe('b0')
    expect(list.current.value).toBe(2)
    // The second page was short, so the list stops asking.
    expect(list.hasNext.value).toBe(false)
  })

  /**
   * A reload of the SAME status while `loadMore()` is in flight: the status guard alone lets the
   * stale page answer through, and appending it after `load()` reset to page 1 would skip a page.
   */
  test('a page read from before a same-status load() is dropped, so no page is skipped', async () => {
    const stale = deferred<{ items: ThreadDto[], threadsEnabled: boolean }>()
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }): Promise<{ items: ThreadDto[], threadsEnabled: boolean }> => {
      const page = options?.query?.page
      if (page === '3') return stale.promise
      if (page === '2') return { items: fullPage('b'), threadsEnabled: true }
      return { items: fullPage('a'), threadsEnabled: true }
    })
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load()
    await list.loadMore()
    expect(list.current.value).toBe(2)

    const pendingMore = list.loadMore()
    await list.load()
    expect(list.current.value).toBe(1)

    stale.resolve({ items: fullPage('c'), threadsEnabled: true })
    await pendingMore

    // Page 3 landed after page 1: appending it would skip page 2.
    expect(list.threads.value).toHaveLength(100)
    expect(list.threads.value[0]?.id).toBe('a0')
    expect(list.current.value).toBe(1)
    expect(list.hasNext.value).toBe(true)
  })

  /**
   * Out-of-order status selections: Archived is asked first, Active second, and Active answers
   * first. The discarded Archived read must report that it did not apply, so its caller does not
   * act on it (the page would otherwise rewrite the URL to status=ARCHIVED over an Active list).
   */
  test('a load() overtaken by a newer one resolves false and leaves the newer list in place', async () => {
    const archived = deferred<{ items: ThreadDto[], threadsEnabled: boolean }>()
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }): Promise<{ items: ThreadDto[], threadsEnabled: boolean }> =>
      options?.query?.status === 'ARCHIVED' ? archived.promise : { items: [listItem({ id: 'active' })], threadsEnabled: true })
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    const stale = list.load('ARCHIVED')
    const applied = await list.load('ACTIVE')
    archived.resolve({ items: [listItem({ id: 'archived', status: 'ARCHIVED' })], threadsEnabled: true })

    expect(applied).toBe(true)
    expect(await stale).toBe(false)
    expect(list.status.value).toBe('ACTIVE')
    expect(list.threads.value.map(thread => thread.id)).toEqual(['active'])
  })

  /** The same stale read, short this time: it must not convince the list there is nothing behind it. */
  test('a short page read from before a same-status load() does not hide Load more', async () => {
    const stale = deferred<{ items: ThreadDto[], threadsEnabled: boolean }>()
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }): Promise<{ items: ThreadDto[], threadsEnabled: boolean }> => {
      const page = options?.query?.page
      if (page === '3') return stale.promise
      if (page === '2') return { items: fullPage('b'), threadsEnabled: true }
      return { items: fullPage('a'), threadsEnabled: true }
    })
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load()
    await list.loadMore()

    const pendingMore = list.loadMore()
    await list.load()
    stale.resolve({ items: [listItem({ id: 'c0' })], threadsEnabled: true })
    await pendingMore

    expect(list.threads.value).toHaveLength(100)
    expect(list.hasNext.value).toBe(true)
    expect(list.current.value).toBe(1)
  })

  test('load() resets pagination when the status changes', async () => {
    const get = jest.fn(async (_path: string, options?: { query?: Record<string, string> }) =>
      options?.query?.page === '2' ? { items: [listItem({ id: 'b0' })], threadsEnabled: true } : { items: fullPage('a'), threadsEnabled: true })
    g.useApi = () => ({ $api: { get } })

    const { useWorkspaceThreads } = await import('~/composables/useWorkspaceThreads')
    const list = useWorkspaceThreads()
    await list.load()
    await list.loadMore()
    expect(list.current.value).toBe(2)

    await list.load('ARCHIVED')

    expect(list.current.value).toBe(1)
    expect(list.threads.value).toHaveLength(100)
    expect(get).toHaveBeenLastCalledWith('/threads', { query: { status: 'ARCHIVED', size: '100' } })
  })
})
