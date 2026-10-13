import { describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
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
  /** The handler object openStream captured; valid once start() has run. */
  handlers: ThreadEventHandlers
  advance: (ms: number) => void
  now: jest.Mock
  messageCalls: () => unknown[][]
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
