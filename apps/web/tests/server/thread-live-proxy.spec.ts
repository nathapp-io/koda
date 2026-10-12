import { describe, expect, jest, test } from '@jest/globals'
import { buildThreadLiveUpstreamUrl, openThreadLiveUpstream } from '~/server/utils/live-proxy'

const API = 'http://api:3100'

function streamResponse(): Response {
  return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('US-002 buildThreadLiveUpstreamUrl', () => {
  test('US-002: builds the API thread events URL for a valid slug and thread id', () => {
    expect(buildThreadLiveUpstreamUrl('web', 'th1', API)).toBe('http://api:3100/api/projects/web/threads/th1/events')
    expect(buildThreadLiveUpstreamUrl('web', 'th1', 'http://api:3100/api/')).toBe('http://api:3100/api/projects/web/threads/th1/events')
    expect(buildThreadLiveUpstreamUrl('my-project', 'Th_1-x', API)).toBe('http://api:3100/api/projects/my-project/threads/Th_1-x/events')
  })

  test.each([
    ['a traversal thread id', '../x'],
    ['a nested thread id', 'a/b'],
    ['a thread id with a space', 'x y'],
    ['an empty thread id', ''],
    ['a too-long thread id', 'x'.repeat(65)],
    ['a thread id with a query', 'a?b=1'],
  ])('US-002: rejects %s', (_label, threadId) => {
    expect(buildThreadLiveUpstreamUrl('web', threadId, API)).toBeNull()
  })

  test.each([
    ['a traversal slug', '../admin'],
    ['an empty slug', ''],
  ])('US-002: rejects %s in the slug too', (_label, slug) => {
    expect(buildThreadLiveUpstreamUrl(slug, 'th1', API)).toBeNull()
  })
})

describe('US-002 openThreadLiveUpstream', () => {
  test('US-002 AC2: forwards the cookie to the thread events upstream exactly once', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => streamResponse())
    const result = await openThreadLiveUpstream({
      slug: 'web',
      threadId: 'th1',
      cookie: 'koda_token=x',
      apiInternalUrl: API,
      onClientClose: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.kind).toBe('stream')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(buildThreadLiveUpstreamUrl('web', 'th1', API))
    expect(url).toBe('http://api:3100/api/projects/web/threads/th1/events')
    expect(init?.headers).toEqual({ accept: 'text/event-stream', cookie: 'koda_token=x' })
  })

  test('US-002 AC15: rejects a traversal thread id with 400 without calling the upstream', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => streamResponse())
    const result = await openThreadLiveUpstream({
      slug: 'web',
      threadId: '../x',
      cookie: 'koda_token=x',
      apiInternalUrl: API,
      onClientClose: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 400 }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('US-002: rejects an invalid slug with 400 without calling the upstream', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => streamResponse())
    const result = await openThreadLiveUpstream({
      slug: '../admin',
      threadId: 'th1',
      cookie: 'koda_token=x',
      apiInternalUrl: API,
      onClientClose: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 400 }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('US-002: aborts the upstream request when the browser disconnects', async () => {
    let signal: AbortSignal | undefined
    let clientClosed: () => void = () => undefined
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return streamResponse()
    })
    await openThreadLiveUpstream({
      slug: 'web',
      threadId: 'th1',
      cookie: undefined,
      apiInternalUrl: API,
      onClientClose: (cb) => { clientClosed = cb },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(signal?.aborted).toBe(false)
    clientClosed()
    expect(signal?.aborted).toBe(true)
  })

  test('US-002: passes a refused upstream through with its status and body', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('stream cap', { status: 429 }))
    const result = await openThreadLiveUpstream({
      slug: 'web',
      threadId: 'th1',
      cookie: undefined,
      apiInternalUrl: API,
      onClientClose: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result).toEqual({ kind: 'error', status: 429, body: 'stream cap' })
  })

  test('US-002: maps an unreachable API to 502', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNREFUSED') })
    const result = await openThreadLiveUpstream({
      slug: 'web',
      threadId: 'th1',
      cookie: undefined,
      apiInternalUrl: API,
      onClientClose: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 502 }))
  })
})