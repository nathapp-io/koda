import { describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'
import type { ThreadEventHandlers } from '~/lib/thread-event-stream'
import { createThreadController, type ThreadController } from '~/lib/thread-controller'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'

const THREAD_PATH = '/projects/web/threads/th1'
const MESSAGES_PATH = '/projects/web/threads/th1/messages'

const message = (overrides: Record<string, unknown> = {}): ChatMessageDto => ({
  id: 'm1',
  seq: 1,
  jobId: 'j1',
  turnId: 't1',
  role: 'assistant',
  authorUserId: 'u1',
  clientMessageId: null,
  content: '',
  toolSummary: null,
  status: 'complete',
  errorReason: null,
  usage: null,
  costUsd: null,
  costSource: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  ...overrides,
})

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

/**
 * US-001: the body `ApprovalPendingFilter` answers a gated write with (HTTP 202), already unwrapped by
 * `useApi` — the real `ApprovalRequestSummaryDto` shape, not a marker made up for the test.
 */
const pendingApproval = (permissionKey: string): ApprovalRequestSummary => ({
  id: `approval-${permissionKey}`,
  permissionKey,
  projectId: 'p1',
  actorType: 'USER',
  actorId: 'u1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'rest',
  redeem: false,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-11-25T00:10:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-11-25T00:00:00.000Z',
})

/** A full page of messages is exactly this many items; any shorter page ends the load loop. */
const PAGE = 200

/** Builds n messages with the ids m<seq> and consecutive seqs starting at start. */
const sequence = (start: number, count: number): ChatMessageDto[] => {
  const items: ChatMessageDto[] = []
  for (let i = 0; i < count; i += 1) {
    const seq = start + i
    items.push(message({ id: `m${seq}`, seq, role: 'assistant', content: `c${seq}` }))
  }
  return items
}

interface Harness {
  ctl: ThreadController
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  close: jest.Mock
  /** The stream opener the controller called; a second call is the controller reopening its stream. */
  openStream: jest.Mock
  setTimer: jest.Mock
  /** The handler object openStream captured; valid once start() has run. */
  handlers: ThreadEventHandlers
  advance: (ms: number) => void
  now: jest.Mock
  messageCalls: () => unknown[][]
}

/** A promise whose settlement the test controls: a held background read. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

/**
 * A controller wired to a fake API (jest fns), a captured openStream handler object and a fake
 * timer/clock: `advance(ms)` moves the fake clock by `ms` and fires every timer armed for
 * exactly that many milliseconds, once each (a re-armed timer is not re-run in the same advance).
 */
function makeHarness(over: { get?: jest.Mock; post?: jest.Mock; patch?: jest.Mock } = {}): Harness {
  const get = over.get ?? jest.fn()
  const post = over.post ?? jest.fn()
  const patch = over.patch ?? jest.fn()
  let captured: ThreadEventHandlers | null = null
  const close = jest.fn()
  const openStream = jest.fn((handlers: ThreadEventHandlers) => {
    captured = handlers
    return { close }
  })
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
  const now = jest.fn(() => time)
  const ctl = createThreadController({
    api: { get, post, patch },
    slug: 'web',
    threadId: 'th1',
    openStream,
    setTimer,
    clearTimer,
    now,
  })
  return {
    ctl,
    get,
    post,
    patch,
    close,
    openStream,
    setTimer,
    get handlers() {
      if (captured === null) throw new Error('handlers are only captured after start()')
      return captured
    },
    now,
    messageCalls: () => get.mock.calls.filter(([path]) => path === MESSAGES_PATH),
    advance: (ms: number) => {
      time += ms
      const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms)
      for (const [handle] of due) timers.delete(handle)
      due.forEach(([, timer]) => timer.fn())
    },
  }
}

describe('US-003 thread-controller', () => {
  test('US-003 AC01: load() pages messages at 200 per page and holds 203 after a short second page', async () => {
    const wire: ChatMessageDto[] = [...sequence(1, 203)]
    const get = jest.fn(async (path: string, options?: { query?: { afterSeq?: string } }) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) {
        const after = Number(options?.query?.afterSeq ?? '0')
        return { items: wire.filter(m => m.seq > after).slice(0, PAGE) }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })

    await h.ctl.load()

    expect(h.ctl.messages.value).toHaveLength(203)
    expect(h.ctl.messages.value[0].seq).toBe(1)
    expect(h.ctl.messages.value[202].seq).toBe(203)
    expect(h.ctl.thread.value?.id).toBe('th1')
    expect(get).toHaveBeenCalledWith(MESSAGES_PATH, { query: { afterSeq: '0', limit: '200' } })
    expect(get).toHaveBeenCalledWith(MESSAGES_PATH, { query: { afterSeq: '200', limit: '200' } })
    expect(h.messageCalls()).toHaveLength(2)
  })

  test('US-003 AC01 (boundary): load() stops fetching after 50 full pages', async () => {
    const wire: ChatMessageDto[] = [...sequence(1, 50 * PAGE)]
    const get = jest.fn(async (path: string, options?: { query?: { afterSeq?: string } }) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) {
        const after = Number(options?.query?.afterSeq ?? '0')
        return { items: wire.filter(m => m.seq > after).slice(0, PAGE) }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })

    await h.ctl.load()

    expect(h.ctl.messages.value).toHaveLength(50 * PAGE)
    expect(h.messageCalls()).toHaveLength(50)
  })

  test('US-003 AC02: onDelta for a held message appends the delta text without any api.get call', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) {
        return { items: [message({ id: 'm1', seq: 1 }), message({ id: 'm2', seq: 2, status: 'streaming', content: 'He' })] }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()

    const callsBefore = h.get.mock.calls.length
    h.handlers.onDelta?.({ id: 'e1', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'delta', messageId: 'm2', text: 'x' })

    expect(h.ctl.messages.value.find(m => m.id === 'm2')?.content).toBe('Hex')
    expect(h.get.mock.calls.length).toBe(callsBefore)
  })

  test('US-003 AC03: onDelta for an unknown message id refetches with the refetchAfterSeq cursor as a string', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) {
        return {
          items: [
            message({ id: 'm1', seq: 1, status: 'complete' }),
            message({ id: 'm2', seq: 2, status: 'streaming' }),
            message({ id: 'm3', seq: 3, status: 'pending' }),
          ],
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()

    h.handlers.onDelta?.({ id: 'e1', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'delta', messageId: 'nope', text: 'x' })

    expect(h.messageCalls()).toHaveLength(2)
    expect(get).toHaveBeenLastCalledWith(MESSAGES_PATH, { query: { afterSeq: '1', limit: '200' } })
  })

  test('US-003 AC04: onResync reloads from sequence zero, encoded as a string', async () => {
    const get = jest.fn(async (path: string, options?: { query?: { afterSeq?: string } }) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) {
        const after = Number(options?.query?.afterSeq ?? '0')
        return { items: [...sequence(1, 3)].filter(m => m.seq > after) }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()

    h.handlers.onResync()
    await settle()

    const fromZero = h.messageCalls().filter(([, options]) => {
      const query = options as { query?: { afterSeq?: string } } | undefined
      return query?.query?.afterSeq === '0'
    })
    expect(fromZero).toHaveLength(2)
  })

  test('US-003 AC05: with live false and a streaming message, advancing 2000 ms refetches messages once', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [message({ id: 'm1', seq: 1, status: 'streaming' })] }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)
    h.handlers.onLiveChange(false)

    const before = h.messageCalls().length
    h.advance(2000)
    await settle()

    expect(h.messageCalls().length).toBe(before + 1)
  })

  test('US-003 AC07: send holds a pending local: user message keyed by clientMessageId before the post resolves', async () => {
    let resolvePost: ((value: { message: ChatMessageDto; jobId: null }) => void) | undefined
    const post = jest.fn(() => new Promise<{ message: ChatMessageDto; jobId: null }>((resolve) => {
      resolvePost = resolve
    }))
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const pending = h.ctl.send('hi')
    await settle()

    const locals = h.ctl.messages.value.filter(m => m.id.startsWith('local:'))
    expect(locals).toHaveLength(1)
    expect(locals[0].id).toBe(`local:${locals[0].clientMessageId}`)
    expect(locals[0].role).toBe('user')
    expect(locals[0].status).toBe('pending')
    expect(locals[0].clientMessageId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)

    if (resolvePost === undefined) throw new Error('send never called api.post')
    resolvePost({ message: message({ id: 'm9', seq: 9, role: 'user', clientMessageId: locals[0].clientMessageId }), jobId: null })
    await settle()
    await pending
  })

  test('US-003 AC08: send posts { text, clientMessageId } to the messages route, using the optimistic id', async () => {
    let resolvePost: ((value: { message: ChatMessageDto; jobId: null }) => void) | undefined
    const post = jest.fn(() => new Promise<{ message: ChatMessageDto; jobId: null }>((resolve) => {
      resolvePost = resolve
    }))
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const pending = h.ctl.send('hi')
    await settle()

    const local = h.ctl.messages.value.find(m => m.id.startsWith('local:'))
    if (local === undefined) throw new Error('no optimistic message held while the post is pending')
    const [path, body] = post.mock.calls[0]
    expect(path).toBe(MESSAGES_PATH)
    expect(body).toEqual({ text: 'hi', clientMessageId: local.clientMessageId })

    if (resolvePost === undefined) throw new Error('send never called api.post')
    resolvePost({ message: message({ id: 'm9', seq: 9, role: 'user', clientMessageId: local.clientMessageId }), jobId: null })
    await settle()
    await pending
  })

  test('US-003 AC09: a resolved send replaces the optimistic message with the server message', async () => {
    const post = jest.fn(async (_path: string, body: { clientMessageId: string }) => ({
      message: message({ id: 'm9', seq: 9, role: 'user', clientMessageId: body.clientMessageId }),
      jobId: null,
    }))
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const result = await h.ctl.send('hi')

    expect(result.ok).toBe(true)
    expect(h.ctl.messages.value.map(m => m.id)).toEqual(['m9'])
    expect(h.ctl.messages.value.some(m => m.id.startsWith('local:'))).toBe(false)
  })

  test('US-003 AC10: a 409 closing refusal reloads the thread, then reposts with the same clientMessageId after 2000 ms', async () => {
    let threadGets = 0
    let attempts = 0
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) {
        threadGets += 1
        return thread({ sendRefusal: threadGets >= 2 ? 'closing' : null })
      }
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async (_path: string, body: { clientMessageId: string }) => {
      attempts += 1
      if (attempts === 1) throw new ApiError(409, 'threads.closing')
      return { message: message({ id: 'm9', seq: 9, role: 'user', clientMessageId: body.clientMessageId }), jobId: null }
    })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const result = h.ctl.send('hi')
    await settle()

    // The 409 was answered by reloading the thread, and only after the timer advances is the retry fired.
    expect(post).toHaveBeenCalledTimes(1)
    expect(threadGets).toBe(2)
    const firstBody = post.mock.calls[0][1] as { clientMessageId: string }

    h.advance(2000)
    await settle()

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1][0]).toBe(MESSAGES_PATH)
    expect(post.mock.calls[1][1]).toEqual({ text: 'hi', clientMessageId: firstBody.clientMessageId })

    const out = await result
    expect(out.ok).toBe(true)
    expect(h.ctl.messages.value.map(m => m.id)).toEqual(['m9'])
  })

  test('US-003 AC11: closing refusals past 15000 ms give up, resolving ok false with no optimistic message', async () => {
    let threadGets = 0
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) {
        threadGets += 1
        return thread({ sendRefusal: threadGets >= 2 ? 'closing' : null })
      }
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async () => { throw new ApiError(409, 'threads.closing') })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const result = h.ctl.send('hi')
    await settle()
    expect(post).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 10; i += 1) {
      h.advance(2000)
      await settle()
    }

    const out = await result
    expect(out.ok).toBe(false)
    expect(out.error).toBeInstanceOf(ApiError)
    expect(h.ctl.messages.value.some(m => m.id.startsWith('local:'))).toBe(false)

    const postsAtGiveUp = post.mock.calls.length
    h.advance(2000)
    await settle()
    expect(post.mock.calls.length).toBe(postsAtGiveUp)
  })

  test('US-003 AC12: a 409 turnRunning refusal resolves ok false after exactly one post', async () => {
    let threadGets = 0
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) {
        threadGets += 1
        return thread({ sendRefusal: threadGets >= 2 ? 'turnRunning' : null })
      }
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async () => { throw new ApiError(409, 'threads.turnRunning') })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const out = await h.ctl.send('hi')

    expect(out.ok).toBe(false)
    expect(out.error).toBeInstanceOf(ApiError)
    expect(post).toHaveBeenCalledTimes(1)
    expect(h.ctl.messages.value.some(m => m.id.startsWith('local:'))).toBe(false)

    h.advance(2000)
    await settle()
    expect(post).toHaveBeenCalledTimes(1)
  })

  test('US-001 AC-10: a send answered with a pending approval makes exactly one post and resolves its request id', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async () => pendingApproval('thread.message.send'))
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const out = await h.ctl.send('Wait for approval')

    // The approval summary is not an executed message and not a transport failure: it is neither `ok`
    // nor carrying an `error`, and the request it waits on is what the caller needs.
    expect(out).toEqual({ ok: false, pendingApproval: 'approval-thread.message.send' })
    expect('error' in out).toBe(false)
    // Exactly one POST: a pending approval is never retried like a closing refusal.
    expect(post).toHaveBeenCalledTimes(1)
    h.advance(2000)
    await settle()
    expect(post).toHaveBeenCalledTimes(1)
    // AC-9: the optimistic echo is the only thing to remove, so the transcript is back where it was.
    expect(h.ctl.messages.value).toHaveLength(0)
  })

  test('US-001 AC-15: a non-409 transport error still resolves { ok: false, error } with the original error', async () => {
    const error = new ApiError(-1, 'network down')
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async () => { throw error })
    const h = makeHarness({ get, post })
    await h.ctl.load()
    h.ctl.start()
    h.handlers.onLiveChange(true)

    const out = await h.ctl.send('hi')

    expect(out).toEqual({ ok: false, error })
    expect(out.error).toBe(error)
    expect('pendingApproval' in out).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
    expect(h.ctl.messages.value).toHaveLength(0)
  })

  test('US-003 AC13: answer posts { requestId, text } to the answer route and reloads the thread on success', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const post = jest.fn(async () => ({}))
    const h = makeHarness({ get, post })
    await h.ctl.load()

    const result = await h.ctl.answer('q1', 'yes')

    expect(result.ok).toBe(true)
    expect(post).toHaveBeenCalledWith('/projects/web/threads/th1/answer', { requestId: 'q1', text: 'yes' })
    expect(h.get.mock.calls.filter(([path]) => path === THREAD_PATH)).toHaveLength(2)
  })

  test('US-003 AC14: raiseCap patches the thread with maxCostUsd and reloads it on success', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [] }
      throw new Error(`unexpected path ${path}`)
    })
    const patch = jest.fn(async () => ({}))
    const h = makeHarness({ get, patch })
    await h.ctl.load()

    const result = await h.ctl.raiseCap(8)

    expect(result.ok).toBe(true)
    expect(patch).toHaveBeenCalledWith(THREAD_PATH, { maxCostUsd: 8 })
  })
})

/**
 * A server that holds m2 as streaming until the test flips it to errored (the job ended). Messages
 * are served by seq, so an afterSeq GET returns every message at or after the cursor.
 */
function serverWithStreamingMessage(): { get: jest.Mock; finish: () => void } {
  let m2Status: 'streaming' | 'errored' = 'streaming'
  const get = jest.fn(async (path: string, options?: { query?: { afterSeq?: string } }) => {
    if (path === THREAD_PATH) return thread()
    if (path === MESSAGES_PATH) {
      const after = Number(options?.query?.afterSeq ?? 0)
      const all = [
        message({ id: 'm1', seq: 1, status: 'complete' }),
        message({ id: 'm2', seq: 2, status: m2Status, errorReason: m2Status === 'errored' ? 'crashed' : null }),
      ]
      return { items: all.filter(item => item.seq > after) }
    }
    throw new Error(`unexpected path ${path}`)
  })
  return { get, finish: () => { m2Status = 'errored' } }
}

describe('US-003 thread-controller: a job end leaves the streaming state', () => {
  test('US-003 AC15: onMessage for a held streaming message that became errored refetches it as errored', async () => {
    const server = serverWithStreamingMessage()
    const h = makeHarness({ get: server.get })
    await h.ctl.load()
    h.ctl.start()
    server.finish()

    h.handlers.onMessage?.({ id: 'e2', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'message', messageId: 'm2' })
    await settle()

    expect(h.ctl.messages.value.find(m => m.id === 'm2')?.status).toBe('errored')
    expect(h.ctl.messages.value.find(m => m.id === 'm2')?.errorReason).toBe('crashed')
  })

  test('US-003 AC16: onThread while a held message is streaming refetches messages, so it becomes errored', async () => {
    const server = serverWithStreamingMessage()
    const h = makeHarness({ get: server.get })
    await h.ctl.load()
    h.ctl.start()
    server.finish()

    h.handlers.onThread?.({ id: 'e3', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'thread' })
    await settle()

    expect(h.ctl.messages.value.find(m => m.id === 'm2')?.status).toBe('errored')
    expect(h.messageCalls()).toHaveLength(2)
    expect(h.get).toHaveBeenLastCalledWith(MESSAGES_PATH, { query: { afterSeq: '1', limit: '200' } })
  })

  test('US-003 AC17: onThread with no turn running reloads only the thread, not the messages', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) return { items: [message({ id: 'm1', seq: 1, status: 'complete' })] }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()
    const messageCallsBefore = h.messageCalls().length

    h.handlers.onThread?.({ id: 'e4', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'thread' })
    await settle()

    expect(h.messageCalls()).toHaveLength(messageCallsBefore)
  })
})

describe('US-004 thread-controller: the threadPath option', () => {
  /**
   * A controller over one thread with a jest-fn api and a no-op stream. `threadPath` is the S5b 1d
   * WORKSPACE case (no project in the path); `slug` alone is the unchanged project case.
   */
  function make(over: { slug?: string; threadPath?: string } = {}) {
    const get = jest.fn(async (path: string) => (path.endsWith('/messages') ? { items: [] } : thread()))
    const post = jest.fn(async () => ({ message: message({ id: 'srv1', seq: 1, role: 'user' }) }))
    const patch = jest.fn()
    const ctl = createThreadController({
      api: { get, post, patch },
      ...(over.slug === undefined ? {} : { slug: over.slug }),
      ...(over.threadPath === undefined ? {} : { threadPath: over.threadPath }),
      threadId: 't1',
      openStream: () => ({ close: () => undefined }),
      setTimer: () => 0,
      clearTimer: () => undefined,
      now: () => 0,
    })
    return { ctl, get, post }
  }

  test('AC-3: load() reads the thread at the given threadPath', async () => {
    const { ctl, get } = make({ threadPath: '/threads/t1' })

    await ctl.load()

    expect(get).toHaveBeenCalledWith('/threads/t1')
    expect(ctl.thread.value?.id).toBe('th1')
  })

  test('AC-4: a send posts to the threadPath messages route', async () => {
    const { ctl, post } = make({ threadPath: '/threads/t1' })

    const result = await ctl.send('hello')

    expect(result.ok).toBe(true)
    expect(post).toHaveBeenCalledWith('/threads/t1/messages', { text: 'hello', clientMessageId: expect.any(String) })
  })

  test('AC-5: without threadPath the thread path still comes from slug', async () => {
    const { ctl, get } = make({ slug: 'web' })

    await ctl.load()

    expect(get).toHaveBeenCalledWith('/projects/web/threads/t1')
  })
})

/**
 * US-002 (finding 11): the delayed-subscription server. The transcript answers from `live` state, and the
 * next messages GET can be held, so a test can settle a newer read or a live delta first and only then
 * the catch-up snapshot whose rows were taken before it.
 */
function heldCatchUpServer() {
  let holdNext = false
  let held = deferred<{ items: ChatMessageDto[] }>()
  let live: ChatMessageDto[] = []
  const get = jest.fn(async (path: string, options?: { query?: { afterSeq?: string } }) => {
    if (path === THREAD_PATH) return thread()
    if (path === MESSAGES_PATH) {
      if (holdNext) {
        holdNext = false
        return held.promise
      }
      const after = Number(options?.query?.afterSeq ?? 0)
      return { items: live.filter(item => item.seq > after) }
    }
    throw new Error(`unexpected path ${path}`)
  })
  return {
    get,
    /** Hold the next messages GET: the ready-triggered catch-up. */
    hold: (): void => {
      holdNext = true
      held = deferred<{ items: ChatMessageDto[] }>()
    },
    /** Settle the held snapshot with the rows the API held when that read started. */
    release: async (items: ChatMessageDto[]): Promise<void> => {
      held.resolve({ items })
      await settle()
    },
    /** What every unheld read answers from now on. */
    setLive: (items: ChatMessageDto[]): void => { live = items },
  }
}

type HeldCatchUpServer = ReturnType<typeof heldCatchUpServer>

/**
 * The finding-11 sequence up to the held catch-up: the page's initial load, `start()`, then the ready
 * frame whose catch-up messages read is held in flight.
 */
async function upToHeldCatchUp(initial: ChatMessageDto[]): Promise<{ h: Harness; server: HeldCatchUpServer }> {
  const server = heldCatchUpServer()
  server.setLive(initial)
  const h = makeHarness({ get: server.get })
  await h.ctl.load()
  h.ctl.start()
  server.hold()
  h.handlers.onResync()
  await settle()
  return { h, server }
}

describe('US-002 thread-controller: a held catch-up snapshot cannot undo newer state', () => {
  /** What the initial load saw: the turn mid-stream. */
  const partial = (): ChatMessageDto => message({ id: 'm2', seq: 2, status: 'streaming', content: 'Partial response' })
  /** What the newer read sees once the runner finished the turn. */
  const final = (): ChatMessageDto => message({ id: 'm2', seq: 2, status: 'complete', content: 'Final response' })
  const messageEvent = { id: 'e2', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'message' as const, messageId: 'm2' }

  test('US-002 AC-4: a held catch-up snapshot does not regress the terminal status a newer onMessage read returned', async () => {
    const { h, server } = await upToHeldCatchUp([partial()])

    // The runner finished and published its message event; the newer refetch already knows.
    server.setLive([final()])
    h.handlers.onMessage?.(messageEvent)
    await settle()
    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.status).toBe('complete')

    // The snapshot taken before the finish resolves last: the status it carries is older news.
    await server.release([partial()])

    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.status).toBe('complete')
  })

  test('US-002 AC-4: a held catch-up snapshot does not regress the status a live delta left in place', async () => {
    const { h, server } = await upToHeldCatchUp([partial()])

    h.handlers.onDelta?.({ id: 'e1', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'delta', messageId: 'm2', text: ' (more)' })
    await settle()

    await server.release([partial()])

    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.status).toBe('streaming')
  })

  test('US-002 AC-5: a held catch-up snapshot does not overwrite the content a newer onMessage read returned', async () => {
    const { h, server } = await upToHeldCatchUp([partial()])

    server.setLive([final()])
    h.handlers.onMessage?.(messageEvent)
    await settle()
    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.content).toBe('Final response')

    await server.release([partial()])

    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.content).toBe('Final response')
  })

  test('US-002 AC-5: a held catch-up snapshot does not drop the text a live delta appended', async () => {
    const { h, server } = await upToHeldCatchUp([message({ id: 'm2', seq: 2, status: 'streaming', content: 'He' })])

    h.handlers.onDelta?.({ id: 'e1', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'delta', messageId: 'm2', text: 'llo' })
    await settle()

    await server.release([message({ id: 'm2', seq: 2, status: 'streaming', content: 'He' })])

    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.content).toBe('Hello')
  })

  test('US-002 AC-6: the transcript keeps exactly one copy of the message the stale snapshot repeated', async () => {
    // The newer-read arm: the refetched terminal message and the snapshot's streaming copy are one message.
    const read = await upToHeldCatchUp([partial()])
    read.server.setLive([final()])
    read.h.handlers.onMessage?.(messageEvent)
    await settle()
    await read.server.release([partial()])

    expect(read.h.ctl.messages.value.map(item => item.id)).toEqual(['m2'])

    // The delta arm: the appended text and the snapshot's shorter copy are the same message.
    const streamed = await upToHeldCatchUp([message({ id: 'm2', seq: 2, status: 'streaming', content: 'He' })])
    streamed.h.handlers.onDelta?.({ id: 'e1', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'delta', messageId: 'm2', text: 'llo' })
    await settle()
    await streamed.server.release([message({ id: 'm2', seq: 2, status: 'streaming', content: 'He' })])

    expect(streamed.h.ctl.messages.value.map(item => item.id)).toEqual(['m2'])
  })

  test('US-002 AC-7: a rejected ready-triggered read is handled, and a later reconnect recovers the transcript', async () => {
    const unhandled: unknown[] = []
    const recordRejection = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', recordRejection)
    try {
      const recovered = [message({ id: 'm2', seq: 2, status: 'complete', content: 'Final response' })]
      let messagesCalls = 0
      const get = jest.fn(async (path: string) => {
        if (path === THREAD_PATH) return thread()
        if (path === MESSAGES_PATH) {
          messagesCalls += 1
          // 1 = the page's initial load, 2 = the ready-triggered catch-up, 3 = the recovery's read.
          if (messagesCalls === 1) return { items: [partial()] }
          if (messagesCalls === 2) throw new ApiError(503, 'threads.unavailable')
          return { items: recovered }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const h = makeHarness({ get })
      await h.ctl.load()
      h.ctl.start()

      // The ready frame's catch-up read fails: the rejection is handled, never an unhandled rejection.
      h.handlers.onResync()
      await settle()
      expect(unhandled).toEqual([])

      // A later reconnect (its own ready frame) reads again and restores the transcript.
      h.handlers.onResync()
      await settle()

      expect(h.ctl.messages.value.map(item => item.id)).toEqual(['m2'])
      expect(h.ctl.messages.value[0].status).toBe('complete')
    } finally {
      process.off('unhandledRejection', recordRejection)
    }
  })

  test('US-002 AC-8: a catch-up that resolves after stop() does not reopen the stream', async () => {
    const { h, server } = await upToHeldCatchUp([partial()])
    expect(h.openStream).toHaveBeenCalledTimes(1)

    // The page is torn down while the recovery is still in flight.
    h.ctl.stop()
    expect(h.close).toHaveBeenCalledTimes(1)

    await server.release([final()])

    expect(h.openStream).toHaveBeenCalledTimes(1)
  })

  test('US-002 AC-9: a catch-up that resolves after stop() does not restart polling', async () => {
    const { h, server } = await upToHeldCatchUp([partial()])
    const timersArmedByStop = h.setTimer.mock.calls.length
    // The running turn had the fallback poll armed while the controller was live: the guard has teeth.
    expect(timersArmedByStop).toBeGreaterThan(0)
    h.ctl.stop()

    await server.release([final()])

    // The recovery would otherwise resume the page's live machinery: the fallback poll included.
    expect(h.setTimer.mock.calls.length).toBe(timersArmedByStop)
  })
})

/**
 * F1 (US-002): two reads can be in flight at once — the ready catch-up and the reload a live event triggers.
 * The order that matters is when each read *started*, not which response the network delivers first: the
 * later-started read holds the fresher snapshot, so the earlier one must not commit over it (and must be
 * discarded itself, not the other way round).
 */
describe('US-002 (F1) thread-controller: overlapping reads are ordered by when they started', () => {
  test('US-002 AC-1: the later-started detail read still lands after the earlier one committed', async () => {
    const heldDetail: Deferred<ThreadDetailDto>[] = []
    let threadGets = 0
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) {
        threadGets += 1
        if (threadGets === 1) return thread({ title: 'Initial' })
        // Every later detail read is held, so the test picks the resolution order.
        const held = deferred<ThreadDetailDto>()
        heldDetail.push(held)
        return held.promise
      }
      if (path === MESSAGES_PATH) return { items: [message({ id: 'm1', seq: 1, status: 'complete' })] }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()

    // The ready catch-up's detail read starts first; a live event's reload starts second, while it is held.
    h.handlers.onResync()
    await settle()
    h.handlers.onThread?.({ id: 'e3', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'thread' })
    await settle()
    expect(heldDetail).toHaveLength(2)

    // The older read answers first: its snapshot is older news than the read already in flight, so it is
    // discarded rather than shown and then replaced.
    heldDetail[0].resolve(thread({ title: 'Stale snapshot' }))
    await settle()
    expect(h.ctl.thread.value?.title).toBe('Initial')

    // The read that started later answers last: its detail is the fresher one and must be the one held.
    heldDetail[1].resolve(thread({ title: 'Fresh detail' }))
    await settle()

    expect(h.ctl.thread.value?.title).toBe('Fresh detail')
  })

  test('US-002 AC-4: the later-started transcript read still lands after the earlier one committed', async () => {
    const heldMessages: Deferred<{ items: ChatMessageDto[] }>[] = []
    let messagesGets = 0
    const get = jest.fn(async (path: string) => {
      if (path === THREAD_PATH) return thread()
      if (path === MESSAGES_PATH) {
        messagesGets += 1
        if (messagesGets === 1) return { items: [message({ id: 'm1', seq: 1, status: 'complete' })] }
        const held = deferred<{ items: ChatMessageDto[] }>()
        heldMessages.push(held)
        return held.promise
      }
      throw new Error(`unexpected path ${path}`)
    })
    const h = makeHarness({ get })
    await h.ctl.load()
    h.ctl.start()

    // The catch-up's transcript read starts first; the message event's refetch starts second.
    h.handlers.onResync()
    await settle()
    h.handlers.onMessage?.({ id: 'e2', threadId: 'th1', at: '2026-10-14T00:00:00.000Z', type: 'message', messageId: 'm2' })
    await settle()
    expect(heldMessages).toHaveLength(2)

    // The older read answers first, with the turn still streaming.
    heldMessages[0].resolve({ items: [message({ id: 'm2', seq: 2, status: 'streaming', content: 'Partial response' })] })
    await settle()
    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.status).toBe('streaming')

    // The read that started later answers last, having seen the turn finish.
    heldMessages[1].resolve({ items: [message({ id: 'm2', seq: 2, status: 'complete', content: 'Final response' })] })
    await settle()

    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.status).toBe('complete')
    expect(h.ctl.messages.value.find(item => item.id === 'm2')?.content).toBe('Final response')
  })
})
