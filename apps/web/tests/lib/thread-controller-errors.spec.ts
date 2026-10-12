import { describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import { createThreadController } from '~/lib/thread-controller'
import type { ThreadDetailDto } from '~/lib/thread-types'

const THREAD_PATH = '/projects/web/threads/th1'
const MESSAGES_PATH = '/projects/web/threads/th1/messages'

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

interface Harness {
  ctl: ReturnType<typeof createThreadController>
  get: jest.Mock
  post: jest.Mock
  close: jest.Mock
  advance: (ms: number) => void
}

/** A controller wired to a fake api and a fake timer/clock. */
function makeHarness(get: jest.Mock, post: jest.Mock): Harness {
  const close = jest.fn()
  const openStream = jest.fn(() => ({ close }))
  let time = 0
  let seq = 0
  const timers = new Map<object, { fn: () => void; ms: number }>()
  const setTimer = jest.fn((fn: () => void, ms: number) => {
    const handle = { n: ++seq }
    timers.set(handle, { fn, ms })
    return handle
  })
  const clearTimer = jest.fn((handle: unknown) => {
    timers.delete(handle as object)
  })
  const ctl = createThreadController({
    api: { get, post, patch: jest.fn() },
    slug: 'web',
    threadId: 'th1',
    openStream,
    setTimer,
    clearTimer,
    now: () => time,
  })
  return {
    ctl,
    get,
    post,
    close,
    advance: (ms: number) => {
      time += ms
      const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms)
      for (const [handle] of due) timers.delete(handle)
      due.forEach(([, timer]) => timer.fn())
    },
  }
}

describe('US-003 thread-controller recovery', () => {
  test('a 409 whose thread reload rejects resolves ok false, drops the optimistic echo and never retries', async () => {
    let threadGets = 0
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) {
        threadGets += 1
        if (threadGets === 1) return thread()
        throw new ApiError(500, 'reload exploded')
      }
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async () => { throw new ApiError(409, 'threads.closing') })
    const h = makeHarness(get, post)
    await h.ctl.load()
    h.ctl.start()

    const out = await h.ctl.send('hi')

    // The 409 was answered by a thread reload (which then rejected): the send must still resolve
    // { ok: false } with the ApiError, and the local: echo must not stay held forever.
    expect(threadGets).toBe(2)
    expect(out.ok).toBe(false)
    expect(out.error).toBeInstanceOf(ApiError)
    expect(h.ctl.messages.value.some(m => m.id.startsWith('local:'))).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)

    h.advance(2000)
    expect(post).toHaveBeenCalledTimes(1)
  })
})