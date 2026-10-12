import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { EventSourceLike } from '~/lib/project-event-stream'
import type { ThreadDetailDto } from '~/lib/thread-types'

const THREAD_PATH = '/projects/web/threads/th1'
const MESSAGES_PATH = '/projects/web/threads/th1/messages'

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

describe('useThread (US-003)', () => {
  afterEach(() => {
    StubEventSource.instances = []
    delete g.EventSource
    delete g.useApi
    delete g.useAuth
  })

  test('US-003 AC06: mounted useThread opens one EventSource on the thread events route via createThreadEventStream', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    g.EventSource = StubEventSource
    g.useApi = () => ({ $api: { get, post: jest.fn(), patch: jest.fn() } })
    g.useAuth = () => ({ refresh: jest.fn(async () => true) })

    const app = mountSfc(webFile('tests', 'fixtures', 'thread-client-probe.vue'), {
      globals: { useApi: g.useApi, useAuth: g.useAuth },
    })
    await settle()

    expect(StubEventSource.instances.map(source => source.url)).toEqual(['/api/projects/web/threads/th1/events'])
    expect(get).toHaveBeenCalledWith(THREAD_PATH)
    expect(get).toHaveBeenCalledWith(MESSAGES_PATH, { query: { afterSeq: '0', limit: '200' } })

    app.unmount()
  })
})