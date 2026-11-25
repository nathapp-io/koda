import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { EventSourceLike } from '~/lib/project-event-stream'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'

/**
 * US-004 (fleet S5b 1d): the WORKSPACE thread controller adapter. Same shape as `useThread`, but
 * the thread is not project-scoped: every request path is `/threads/<id>` and the live stream is
 * `/api/threads/<id>/events`.
 */
const THREAD_PATH = '/threads/t1'
const MESSAGES_PATH = '/threads/t1/messages'

/** Global EventSource stub: records every URL it was constructed with, and every frame the test delivers. */
class StubEventSource implements EventSourceLike {
  static instances: StubEventSource[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners = new Map<string, (ev: { data: string }) => void>()

  constructor(readonly url: string) {
    StubEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, listener)
  }

  close(): void {}

  /** Deliver one SSE frame of `type` (the browser's dispatch), as the API's stream would. */
  emit(type: string, data: unknown = {}): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) })
  }
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

/** One transcript message (the API's ChatMessageDto shape the probe renders). */
const chatMessage = (overrides: Record<string, unknown> = {}): ChatMessageDto => ({
  id: 'm1',
  seq: 1,
  jobId: 'j1',
  turnId: 't1',
  role: 'assistant',
  authorUserId: 'u1',
  clientMessageId: null,
  content: 'Partial response',
  toolSummary: null,
  status: 'streaming',
  errorReason: null,
  usage: null,
  costUsd: null,
  costSource: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  ...overrides,
})

/**
 * The review's delayed-subscription server (finding 11): the thread and its messages answer from state
 * the test can move, so the turn can finish *after* the initial GET and *before* the subscription.
 */
function threadServer(
  initial: ChatMessageDto[],
  finished: ChatMessageDto[],
): { get: jest.Mock; finishTurn: () => void } {
  let items = initial
  const get = jest.fn(async (path: string) => {
    if (path === THREAD_PATH) return thread()
    if (path === MESSAGES_PATH) return { items }
    throw new Error(`unexpected path ${path}`)
  })
  return { get, finishTurn: () => { items = finished } }
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
    g.useAuth = () => ({ refresh: jest.fn(async () => true), refreshSession: jest.fn(async () => 'ok') })

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

describe('useWorkspaceThread (US-002): the ready frame catches up the initial GET-to-subscription gap', () => {
  afterEach(() => {
    StubEventSource.instances = []
    delete g.EventSource
    delete g.useApi
    delete g.useAuth
  })

  /** Mounts the workspace probe over `finishTurn()`-able server state (the review's delayed-subscription case). */
  async function mountDelayedSubscription(): Promise<{
    app: ReturnType<typeof mountSfc>
    server: ReturnType<typeof threadServer>
  }> {
    const server = threadServer(
      [chatMessage()],
      [chatMessage({ status: 'complete', content: 'Final response' })],
    )
    g.EventSource = StubEventSource
    g.useApi = () => ({ $api: { get: server.get, post: jest.fn(), patch: jest.fn() } })
    g.useAuth = () => ({ refresh: jest.fn(async () => true), refreshSession: jest.fn(async () => 'ok') })
    const app = mountSfc(webFile('tests', 'fixtures', 'workspace-thread-client-probe.vue'), {
      globals: { useApi: g.useApi, useAuth: g.useAuth },
    })
    await settle()
    return { app, server }
  }

  test('US-002 AC-1: a turn that finished between the initial GET and the subscription is reconciled when ready arrives', async () => {
    const { app, server } = await mountDelayedSubscription()
    try {
      expect(app.one('[data-message="m1"]')?.props['data-status']).toBe('streaming')
      expect(app.text()).toContain('Partial response')
      expect(server.get.mock.calls.filter(([path]) => path === MESSAGES_PATH)).toHaveLength(1)

      // The runner finishes after the snapshot and before the server accepts the subscription.
      server.finishTurn()
      const source = StubEventSource.instances[0]
      expect(source.url).toBe('/api/threads/t1/events')
      source.emit('ready')
      await settle()

      expect(server.get.mock.calls.filter(([path]) => path === MESSAGES_PATH)).toHaveLength(2)
      expect(app.one('[data-message="m1"]')?.props['data-status']).toBe('complete')
      expect(app.text()).toContain('Final response')
    } finally {
      app.unmount()
    }
  })

  test('US-002 AC-2: the mounted composer becomes available once ready reconciles the finished turn', async () => {
    const { app, server } = await mountDelayedSubscription()
    try {
      expect(app.one('[data-testid="composer"]')?.props.disabled).toBe(true)

      server.finishTurn()
      StubEventSource.instances[0].emit('ready')
      await settle()

      expect(app.one('[data-testid="composer"]')?.props.disabled).toBe(false)
    } finally {
      app.unmount()
    }
  })
})
