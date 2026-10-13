import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { EventSourceLike } from '~/lib/project-event-stream'
import type { ThreadDetailDto } from '~/lib/thread-types'

const THREAD_PATH = '/projects/web/threads/th1'

/** Global EventSource stub: records every URL it was constructed with. */
class StubEventSource implements EventSourceLike {
  static instances: StubEventSource[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(readonly url: string) {
    StubEventSource.instances.push(this)
  }

  addEventListener(): void {}
  close(): void {}
}

const thread = (overrides: Record<string, unknown> = {}): ThreadDetailDto => ({
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
  sendRefusal: null,
  ...overrides,
})

const g = globalThis as Record<string, unknown>

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

describe('useThread mount lifecycle (US-003)', () => {
  afterEach(() => {
    StubEventSource.instances = []
    delete g.EventSource
    delete g.useApi
    delete g.useAuth
  })

  test('a failing mount load still starts the stream, so live updates are not killed permanently', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) throw new ApiError(500, 'mount load exploded')
      throw new Error(`unexpected path ${path}`)
    })
    g.EventSource = StubEventSource
    g.useApi = () => ({ $api: { get, post: jest.fn(), patch: jest.fn() } })
    g.useAuth = () => ({ refresh: jest.fn(async () => true) })

    const app = mountSfc(webFile('tests', 'fixtures', 'thread-client-probe.vue'), {
      globals: { useApi: g.useApi, useAuth: g.useAuth },
    })
    await settle()

    expect(get).toHaveBeenCalledWith(THREAD_PATH)
    expect(StubEventSource.instances.map(source => source.url)).toEqual(['/api/projects/web/threads/th1/events'])

    app.unmount()
  })

  test('an unmount racing the in-flight load never reopens the stream after stop()', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    const get = jest.fn((_path: string) => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    g.EventSource = StubEventSource
    g.useApi = () => ({ $api: { get, post: jest.fn(), patch: jest.fn() } })
    g.useAuth = () => ({ refresh: jest.fn(async () => true) })

    const app = mountSfc(webFile('tests', 'fixtures', 'thread-client-probe.vue'), {
      globals: { useApi: g.useApi, useAuth: g.useAuth },
    })
    await settle()
    expect(get).toHaveBeenCalledWith(THREAD_PATH)

    // Unmount while load() is still in flight, then let the load finish.
    app.unmount()
    resolvers.splice(0).forEach(resolve => resolve(thread()))
    await settle()
    resolvers.splice(0).forEach(resolve => resolve({ items: [] }))
    await settle()

    expect(StubEventSource.instances).toEqual([])
  })
})