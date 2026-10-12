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