import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { EventSourceLike } from '~/lib/project-event-stream'
import type { ThreadDetailDto } from '~/lib/thread-types'

/**
 * US-004 (fleet S5b 1d): the WORKSPACE thread controller adapter. Same shape as `useThread`, but
 * the thread is not project-scoped: every request path is `/threads/<id>` and the live stream is
 * `/api/threads/<id>/events`.
 */
const THREAD_PATH = '/threads/t1'
const MESSAGES_PATH = '/threads/t1/messages'

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
  id: 't1',
  kind: 'WORKSPACE',
  repoId: null,
  baseRef: null,
  feature: null,
  title: 'Plan the rollout',
  createdById: 'u1',
  runnerId: 'rn1',
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
  sendRefusal: null,
  handoff: { plan: null, run: null },
  ...overrides,
})

const g = globalThis as Record<string, unknown>

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

describe('useWorkspaceThread (US-004)', () => {
  afterEach(() => {
    StubEventSource.instances = []
    delete g.EventSource
    delete g.useApi
    delete g.useAuth
  })

  test('AC-8: mounted useWorkspaceThread loads /threads/t1 and opens one EventSource on /api/threads/t1/events', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    g.EventSource = StubEventSource
    g.useApi = () => ({ $api: { get, post: jest.fn(), patch: jest.fn() } })
    g.useAuth = () => ({ refresh: jest.fn(async () => true) })

    const app = mountSfc(webFile('tests', 'fixtures', 'workspace-thread-client-probe.vue'), {
      globals: { useApi: g.useApi, useAuth: g.useAuth },
    })
    await settle()

    expect(StubEventSource.instances.map(source => source.url)).toEqual(['/api/threads/t1/events'])
    expect(get).toHaveBeenCalledWith(THREAD_PATH)
    expect(get).toHaveBeenCalledWith(MESSAGES_PATH, { query: { afterSeq: '0', limit: '200' } })

    app.unmount()
  })
})
