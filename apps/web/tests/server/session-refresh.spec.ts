import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clearAuthCookies as clearRealAuthCookies, setAuthCookies as setRealAuthCookies } from '~/server/utils/api'

const middlewarePath = join(__dirname, '..', '..', 'server', 'middleware', 'session-refresh.ts')
const g = globalThis as Record<string, unknown>

jest.mock('../../server/utils/session-refresh', () => ({
  shouldRefreshSession: (...args: unknown[]) => (globalThis as Record<string, unknown>).shouldRefreshSession(...args),
  withAuthCookies: (...args: unknown[]) => (globalThis as Record<string, unknown>).withAuthCookies(...args),
}))
type Handler = (event: unknown) => Promise<void>

const event = () => ({
  node: {
    req: { method: 'GET', url: '/projects', headers: { accept: 'text/html', cookie: 'koda_refresh=r1; koda_locale=zh' } },
    res: { headers: {} as Record<string, string | string[]> },
  },
  context: {},
})

function emittedCookies(req: ReturnType<typeof event>): string[] {
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
  g.setCookie = (target: unknown, name: string, value: string, options: { maxAge?: number }) => {
    const res = (target as ReturnType<typeof event>).node.res
    const current = res.headers['set-cookie']
    const cookie = `${name}=${value}; Path=/${options.maxAge ? `; Max-Age=${options.maxAge}` : ''}`
    res.headers['set-cookie'] = [...(Array.isArray(current) ? current : current ? [current] : []), cookie]
  }
  g.deleteCookie = (target: unknown, name: string) => {
    const res = (target as ReturnType<typeof event>).node.res
    const current = res.headers['set-cookie']
    res.headers['set-cookie'] = [...(Array.isArray(current) ? current : current ? [current] : []), `${name}=; Path=/; Max-Age=0`]
  }
})

async function loadHandler(): Promise<Handler> {
  const { default: handler } = await import(middlewarePath) as { default: Handler }
  return handler
}

describe('SSR session refresh middleware', () => {
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
