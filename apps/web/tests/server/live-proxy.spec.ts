import { describe, expect, jest, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildLiveUpstreamUrl, LIVE_STREAM_HEADERS, openLiveUpstream } from '~/server/utils/live-proxy'

const API = 'http://api:3100'

function streamResponse(): Response {
  return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('buildLiveUpstreamUrl', () => {
  test('targets the API events endpoint for a valid slug', () => {
    expect(buildLiveUpstreamUrl('my-project', API)).toBe('http://api:3100/api/projects/my-project/events')
  })

  test.each([
    ['a traversal attempt', '..%2F..%2Fadmin%2Fusers'],
    ['a decoded traversal', '../admin'],
    ['a nested path', 'a/b'],
    ['uppercase', 'Project'],
    ['a query injection', 'p?x=1'],
    ['empty', ''],
    ['a leading hyphen', '-p'],
  ])('rejects %s', (_label, slug) => {
    expect(buildLiveUpstreamUrl(slug, API)).toBeNull()
  })
})

describe('openLiveUpstream', () => {
  test('forwards the cookie and asks for an event stream', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => streamResponse())
    const result = await openLiveUpstream({
      slug: 'p1', cookie: 'koda_token=abc', apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.kind).toBe('stream')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api:3100/api/projects/p1/events')
    expect(init?.headers).toEqual({ accept: 'text/event-stream', cookie: 'koda_token=abc' })
  })

  test('aborts the upstream request when the client goes away', async () => {
    let signal: AbortSignal | undefined
    let clientClosed: () => void = () => undefined
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return streamResponse()
    })
    await openLiveUpstream({
      slug: 'p1', cookie: undefined, apiInternalUrl: API,
      onClientClose: (cb) => { clientClosed = cb },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(signal?.aborted).toBe(false)
    clientClosed()
    expect(signal?.aborted).toBe(true)
  })

  test('passes an upstream refusal through with its status', async () => {
    const fetchImpl = jest.fn(async () => new Response('{"ret":40003}', { status: 403 }))
    const result = await openLiveUpstream({
      slug: 'p1', cookie: undefined, apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ kind: 'error', status: 403, body: '{"ret":40003}' })
  })

  test('maps an unreachable API to 502', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNREFUSED') })
    const result = await openLiveUpstream({
      slug: 'p1', cookie: undefined, apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 502 }))
  })

  test('rejects an invalid slug with 400 without calling the API', async () => {
    const fetchImpl = jest.fn(async () => streamResponse())
    const result = await openLiveUpstream({
      slug: '../admin', cookie: undefined, apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 400 }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('LIVE_STREAM_HEADERS', () => {
  test('disables caching, transforms and proxy buffering', () => {
    expect(LIVE_STREAM_HEADERS).toEqual(expect.objectContaining({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    }))
    // Hop-by-hop: invalid under HTTP/2 and stripped by some proxies, so not sent.
    expect(LIVE_STREAM_HEADERS).not.toHaveProperty('connection')
  })
})

describe('events.get.ts route', () => {
  const source = readFileSync(path.join(__dirname, '../../server/api/projects/[slug]/events.get.ts'), 'utf-8')

  test('streams through openLiveUpstream with the live headers', () => {
    expect(source).toContain('openLiveUpstream')
    expect(source).toContain('sendStream')
    expect(source).toContain('LIVE_STREAM_HEADERS')
  })

  test('treats the abort-on-disconnect stream error as a normal end', () => {
    expect(source).toContain('sendStream(event, result.body).catch(')
  })

  test('detects client disconnect on the response, not the request', () => {
    expect(source).toContain("node.res.on('close'")
    expect(source).not.toContain("node.req.on('close'")
  })
})
