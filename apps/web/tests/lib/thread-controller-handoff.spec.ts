import { describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import { createThreadController, type ThreadController } from '~/lib/thread-controller'
import type { ThreadDetailDto } from '~/lib/thread-types'

const THREAD_PATH = '/projects/web/threads/th1'

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
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  sendRefusal: null,
  handoff: { plan: null, run: null },
  ...overrides,
})

interface Harness {
  ctl: ThreadController
  get: jest.Mock
  post: jest.Mock
}

/** A controller over a fake API; the stream and timers are inert because the actions never use them. */
function makeHarness(over: { get?: jest.Mock; post?: jest.Mock } = {}): Harness {
  const get = over.get ?? jest.fn(async () => thread())
  const post = over.post ?? jest.fn(async () => ({}))
  const ctl = createThreadController({
    api: { get, post, patch: jest.fn() },
    slug: 'web',
    threadId: 'th1',
    openStream: () => ({ close: () => undefined }),
    setTimer: () => null,
    clearTimer: () => undefined,
    now: () => 0,
  })
  return { ctl, get, post }
}

describe('US-002 thread-controller handoff actions', () => {
  test('US-002 AC-1: publish() posts an empty body to the publish route', async () => {
    const h = makeHarness()

    await h.ctl.publish()

    expect(h.post).toHaveBeenCalledWith('/projects/web/threads/th1/publish', {})
  })

  test('US-002 AC-2: publish() resolves ok and reloads the thread into the controller ref', async () => {
    const reloaded = thread({ specPublished: true, publishedSha: 'abc123' })
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return reloaded
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get, post: jest.fn(async () => ({ jobId: 'j1' })) })

    const result = await h.ctl.publish()

    expect(result).toEqual({ ok: true })
    expect(h.ctl.thread.value).toEqual(reloaded)
    expect(get).toHaveBeenCalledWith(THREAD_PATH)
  })

  test('US-002 AC-3: discard() posts an empty body to the discard route', async () => {
    const h = makeHarness()

    await h.ctl.discard()

    expect(h.post).toHaveBeenCalledWith('/projects/web/threads/th1/discard', {})
  })

  test('US-002 AC-4: plan() posts its body to the plan route', async () => {
    const h = makeHarness()

    await h.ctl.plan({ maxCostUsd: 5 })

    expect(h.post).toHaveBeenCalledWith('/projects/web/threads/th1/plan', { maxCostUsd: 5 })
  })

  test('US-002 AC-5: run() posts its body to the run route', async () => {
    const h = makeHarness()

    await h.ctl.run({ maxCostUsd: 2, bashMode: 'gated' })

    expect(h.post).toHaveBeenCalledWith('/projects/web/threads/th1/run', { maxCostUsd: 2, bashMode: 'gated' })
  })

  test('US-002 AC-6: plan() whose post rejects with a 409 resolves ok false with that same error instance', async () => {
    const conflict = new ApiError(409, 'fleet.runnerOffline')
    const h = makeHarness({ post: jest.fn(async () => { throw conflict }) })

    const result = await h.ctl.plan({ maxCostUsd: 5 })

    expect(result.ok).toBe(false)
    expect(result.error).toBe(conflict)
  })

  test('US-002 AC-7: reloadThread() GETs the thread and sets the controller ref to it', async () => {
    const fresh = thread({ feature: 'renamed' })
    const get = jest.fn(async () => fresh)
    const h = makeHarness({ get })

    await h.ctl.reloadThread()

    expect(get).toHaveBeenCalledWith(THREAD_PATH)
    expect(h.ctl.thread.value).toEqual(fresh)
  })
})
