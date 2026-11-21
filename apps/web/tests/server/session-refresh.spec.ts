import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clearAuthCookies as clearRealAuthCookies, setAuthCookies as setRealAuthCookies, forwardToApi as realForwardToApi } from '~/server/utils/api'

const middlewarePath = join(__dirname, '..', '..', 'server', 'middleware', 'session-refresh.ts')
const g = globalThis as Record<string, unknown>

jest.mock('../../server/utils/session-refresh', () => ({
  shouldRefreshSession: (...args: unknown[]) => (globalThis as Record<string, unknown>).shouldRefreshSession(...args),
  withAuthCookies: (...args: unknown[]) => (globalThis as Record<string, unknown>).withAuthCookies(...args),
}))
type Handler = (event: unknown) => Promise<void>

type TestEvent = {
  node: {
    req: { method: string; url: string; headers: { accept: string; cookie: string } }
    res: { headers: Record<string, string | string[]>; getHeader(name: string): string | string[] | undefined; setHeader(name: string, value: string | string[]): void; appendHeader(name: string, value: string): void; removeHeader(name: string): void; headersSent: boolean }
  }
  context: Record<string, unknown>
}

type CookieOptions = { path?: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'strict' | 'lax' | 'none' }

// Nitro auto-imports h3's cookie helpers into the server build, so `~/server/utils/api` calls them as globals.
// h3 is only a transitive dependency here (Nitro pulls it in), so the test supplies the two helpers it uses instead of
// importing h3 from its install location; serialization mirrors h3 v1 (`Name=Value; Max-Age=…; Path=…; HttpOnly; …`).
function setCookie(target: TestEvent, name: string, value: string, options: CookieOptions = {}): void {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`)
  target.node.res.appendHeader('set-cookie', parts.join('; '))
}

/** h3's `deleteCookie` clears the value and expires the cookie. */
function deleteCookie(target: TestEvent, name: string, options: CookieOptions = {}): void {
  setCookie(target, name, '', { ...options, maxAge: 0 })
}

const event = (): TestEvent => {
  const response: TestEvent['node']['res'] = {
    headers: {},
    headersSent: false,
    getHeader(name) { return this.headers[name.toLowerCase()] },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    appendHeader(name, value) {
      const key = name.toLowerCase()
      const current = this.headers[key]
      this.headers[key] = [...(Array.isArray(current) ? current : current ? [current] : []), value]
    },
    removeHeader(name) { delete this.headers[name.toLowerCase()] },
  }
  return {
    node: {
      req: { method: 'GET', url: '/projects', headers: { accept: 'text/html', cookie: 'koda_refresh=r1; koda_locale=zh' } },
      res: response,
    },
    context: {},
  }
}

function emittedCookies(req: TestEvent): string[] {
  const value = req.node.res.headers['set-cookie']
  return Array.isArray(value) ? value : value ? [value] : []
}

beforeEach(() => {
  jest.resetModules()
  g.defineEventHandler = (handler: unknown) => handler
  g.shouldRefreshSession = jest.fn(() => true)
  g.withAuthCookies = jest.fn(() => 'koda_refresh=r2; koda_locale=zh; koda_token=a2')
  g.forwardToApi = jest.fn(async () => ({ status: 200, body: { ret: 0, data: { accessToken: 'a2', refreshToken: 'r2' } } }))
  g.unwrapAuth = jest.fn((body: unknown) => {
    const envelope = body as { ret?: number; data?: unknown }
    if (envelope.ret !== undefined && envelope.ret !== 0) throw new Error('Authentication failed')
    return envelope.data
  })
  g.setAuthCookies = jest.fn(setRealAuthCookies)
  g.clearAuthCookies = jest.fn(clearRealAuthCookies)
  g.setCookie = setCookie
  g.deleteCookie = deleteCookie
})

async function loadHandler(): Promise<Handler> {
  const { default: handler } = await import(middlewarePath) as { default: Handler }
  return handler
}

describe('SSR session refresh middleware', () => {
  const realEligibility = jest.requireActual('../../server/utils/session-refresh') as typeof import('../../server/utils/session-refresh')
  const now = 1_700_000_000_000
  const jwt = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`

  function useRealEligibility() {
    g.shouldRefreshSession = realEligibility.shouldRefreshSession
    g.withAuthCookies = realEligibility.withAuthCookies
    jest.spyOn(Date, 'now').mockReturnValue(now)
  }

  function request(cookie: string, url = '/projects') {
    const req = event()
    req.node.req.headers.cookie = cookie
    req.node.req.url = url
    return req
  }

  test('AC-4 refreshes an expired legacy access JWT and replaces cookies before SSR', async () => {
    useRealEligibility()
    const req = request(`koda_token=${jwt(now / 1000 - 60)}; koda_refresh=${jwt(now / 1000 + 1000)}; koda_locale=zh`)
    await (await loadHandler())(req)
    expect(g.forwardToApi).toHaveBeenCalledTimes(1)
    expect(req.node.req.headers.cookie).toBe('koda_token=a2; koda_refresh=r2; koda_locale=zh')
    expect(emittedCookies(req)).toEqual(expect.arrayContaining([expect.stringMatching(/^koda_token=a2;/), expect.stringMatching(/^koda_refresh=r2;/)]))
    jest.restoreAllMocks()
  })

  test('AC-5 keeps a fresh access JWT and refreshes refresh-only HTML, but excludes API requests', async () => {
    useRealEligibility()
    const handler = await loadHandler()
    await handler(request(`koda_token=${jwt(now / 1000 + 60)}; koda_refresh=r1`))
    expect(g.forwardToApi).not.toHaveBeenCalled()
    await handler(request('koda_refresh=r1'))
    expect(g.forwardToApi).toHaveBeenCalledTimes(1)
    await handler(request('koda_refresh=r1', '/api/projects'))
    expect(g.forwardToApi).toHaveBeenCalledTimes(1)
    jest.restoreAllMocks()
  })

  test('AC-6 retains opaque-cookie exclusion and refreshes exactly at expiry', async () => {
    useRealEligibility()
    const handler = await loadHandler()
    await handler(request('koda_token=opaque; koda_refresh=r1'))
    expect(g.forwardToApi).not.toHaveBeenCalled()
    await handler(request(`koda_token=${jwt(now / 1000)}; koda_refresh=r1`))
    expect(g.forwardToApi).toHaveBeenCalledTimes(1)
    jest.restoreAllMocks()
  })

  test.each([
    ['503', async () => ({ status: 503, body: {} })],
    ['transport failure', async () => { throw new Error('offline') }],
  ])('AC-6 preserves incoming cookies on upstream %s', async (_label, upstream) => {
    useRealEligibility()
    g.forwardToApi = jest.fn(upstream)
    const cookie = `koda_token=${jwt(now / 1000 - 1)}; koda_refresh=r1; koda_locale=zh`
    const req = request(cookie)
    await expect((await loadHandler())(req)).resolves.toBeUndefined()
    expect(req.node.req.headers.cookie).toBe(cookie)
    expect(g.clearAuthCookies).not.toHaveBeenCalled()
    jest.restoreAllMocks()
  })

  test('AC-1 does not call upstream when ineligible', async () => {
    expect(existsSync(middlewarePath)).toBe(true)
    g.shouldRefreshSession = jest.fn(() => false)
    await (await loadHandler())(event())
    expect(g.forwardToApi).not.toHaveBeenCalled()
  })

  test('AC-2 forwards refresh bearer through forwardToApi', async () => {
    const req = event()
    await (await loadHandler())(req)
    expect(g.forwardToApi).toHaveBeenCalledTimes(1)
    expect((g.forwardToApi as jest.Mock).mock.calls[0]).toEqual([req, '/auth/refresh', { method: 'POST', cookieName: 'refresh' }])
  })

  test('AC-2 browser UA reaches upstream refresh', async () => {
    const req = event()
    Object.assign(req.node.req.headers, { 'user-agent': 'UA-1' })
    const raw = jest.fn(async () => ({ status: 503, _data: {} }))
    g.forwardToApi = realForwardToApi
    g.useRuntimeConfig = () => ({ apiInternalUrl: 'http://localhost:3100' })
    g.getCookie = () => 'r1'
    g.getRequestHeader = (e: TestEvent, name: string) => (e.node.req.headers as Record<string, string>)[name]
    g.$fetch = { raw }
    await (await loadHandler())(req)
    expect(raw).toHaveBeenCalledTimes(1)
    expect((raw.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers['User-Agent']).toBe('UA-1')
  })

  test('AC-3/4 writes response cookies and the same-render cookie header', async () => {
    const req = event()
    await (await loadHandler())(req)
    expect(emittedCookies(req)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^koda_token=a2;/),
      expect.stringMatching(/^koda_refresh=r2;/),
    ]))
    expect((req as { node: { req: { headers: { cookie: string } } } }).node.req.headers.cookie).toBe('koda_refresh=r2; koda_locale=zh; koda_token=a2')
    expect(g.withAuthCookies).toHaveBeenCalledWith('koda_refresh=r1; koda_locale=zh', { accessToken: 'a2', refreshToken: 'r2' })
  })

  test.each([401, 403, 200])('AC-5 clears cookies on auth failure status %s', async (status) => {
    g.forwardToApi = jest.fn(async () => ({ status, body: status === 200 ? { ret: 401, message: 'expired' } : {} }))
    const req = event()
    await (await loadHandler())(req)
    const cookies = emittedCookies(req)
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^koda_token=;.*Max-Age=0/),
      expect.stringMatching(/^koda_refresh=;.*Max-Age=0/),
    ]))
  })

  test.each([429, 503])('AC-6/7/11 preserves cookies on status %s', async (status) => {
    g.forwardToApi = jest.fn(async () => ({ status, body: {} }))
    const req = event()
    await expect((await loadHandler())(req)).resolves.toBeUndefined()
    expect(g.setAuthCookies).not.toHaveBeenCalled()
    expect(g.clearAuthCookies).not.toHaveBeenCalled()
    expect((req as { node: { req: { headers: { cookie: string } } } }).node.req.headers.cookie).toBe('koda_refresh=r1; koda_locale=zh')
  })

  test('AC-8/9 preserves cookies on network error', async () => {
    g.forwardToApi = jest.fn(async () => { throw new Error('network') })
    const req = event()
    await expect((await loadHandler())(req)).resolves.toBeUndefined()
    expect(g.setAuthCookies).not.toHaveBeenCalled()
    expect(g.clearAuthCookies).not.toHaveBeenCalled()
    expect((req as { node: { req: { headers: { cookie: string } } } }).node.req.headers.cookie).toBe('koda_refresh=r1; koda_locale=zh')
  })
})
