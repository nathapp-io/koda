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