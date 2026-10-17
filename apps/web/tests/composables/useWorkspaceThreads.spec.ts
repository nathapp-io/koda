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
