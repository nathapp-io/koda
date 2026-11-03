import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { join } from 'path'

const routePath = join(__dirname, '..', '..', 'server', 'api', 'auth', 'logout.post.ts')
const g = globalThis as Record<string, unknown>
type Handler = (event: unknown) => Promise<unknown>

type Scenario = {
  name: string
  cookies?: Record<string, string>
  responses?: Array<{ status: number; body?: unknown }>
  throwsAt?: number
  expectedStatus: number
  expectedCalls: Array<[string, Record<string, unknown> | undefined]>
}

const scenarios: Scenario[] = [
  { name: 'access cookie and successful logout', cookies: { koda_token: 'at-1' }, responses: [{ status: 200 }], expectedStatus: 204, expectedCalls: [['/auth/logout', { method: 'POST' }]] },
  { name: 'access cookie and rejected logout', cookies: { koda_token: 'at-1' }, responses: [{ status: 500 }], expectedStatus: 502, expectedCalls: [['/auth/logout', { method: 'POST' }]] },
  { name: 'access cookie and thrown logout', cookies: { koda_token: 'at-1' }, throwsAt: 1, expectedStatus: 502, expectedCalls: [['/auth/logout', { method: 'POST' }]] },
  { name: 'refresh then logout using returned access token', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 200, body: { ret: 0, data: { accessToken: 'new-at' } } }, { status: 204 }], expectedStatus: 204, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }], ['/auth/logout', { method: 'POST', bearer: 'new-at' }]] },
  { name: 'refresh unauthorized needs no logout', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 401 }], expectedStatus: 204, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }]] },
  { name: 'refresh forbidden needs no logout', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 403 }], expectedStatus: 204, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }]] },
  { name: 'refresh unavailable', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 503 }], expectedStatus: 502, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }]] },
  { name: 'refresh with no access token', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 200, body: { ret: 0, data: {} } }], expectedStatus: 502, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }]] },
  { name: 'refresh call throws', cookies: { koda_refresh: 'rt-1' }, throwsAt: 1, expectedStatus: 502, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }]] },
  { name: 'no auth cookies', expectedStatus: 204, expectedCalls: [] },
  { name: 'refresh envelope unwrap failure', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 200, body: { ret: 1 } }], expectedStatus: 502, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }]] },
  { name: 'logout after refresh throws', cookies: { koda_refresh: 'rt-1' }, responses: [{ status: 200, body: { ret: 0, data: { accessToken: 'new-at' } } }], throwsAt: 2, expectedStatus: 502, expectedCalls: [['/auth/refresh', { method: 'POST', cookieName: 'refresh' }], ['/auth/logout', { method: 'POST', bearer: 'new-at' }]] },
]

beforeEach(() => {
  g.ACCESS_COOKIE = 'koda_token'
  g.REFRESH_COOKIE = 'koda_refresh'
  g.defineEventHandler = (handler: unknown) => handler
  g.createError = (input: unknown) => Object.assign(new Error('upstream error'), input)
  g.unwrapAuth = (body: { ret?: number; data?: unknown }) => {
    if (body.ret !== undefined && body.ret !== 0) throw Object.assign(new Error('bad envelope'), { statusCode: 401 })
    return body.data ?? body
  }
})

describe('POST /api/auth/logout', () => {
  test.each(scenarios)('AC logout flow: $name', async (scenario) => {
    const event = { node: { res: { statusCode: 200 } } }
    g.getCookie = (_event: unknown, name: string) => scenario.cookies?.[name]
    let callNumber = 0
    const forward = jest.fn(async (_event: unknown, _path: string, _init?: Record<string, unknown>) => {
      callNumber += 1
      if (scenario.throwsAt === callNumber) throw new Error('network failure')
      return scenario.responses?.[callNumber - 1] ?? { status: 200 }
    })
    const clear = jest.fn()
    g.forwardToApi = forward
    g.clearAuthCookies = clear
    g.setAuthCookies = jest.fn()

    const { default: handler } = await import(routePath) as { default: Handler }
    const result = await handler(event)

    expect(event.node.res.statusCode).toBe(scenario.expectedStatus)
    expect(forward.mock.calls.map(([, path, init]) => [path, init])).toEqual(scenario.expectedCalls)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(event)
    expect(g.setAuthCookies as jest.Mock).not.toHaveBeenCalled()
    if (scenario.expectedStatus === 502) expect(result).toEqual({ revoked: false })
    else expect(result).toBeNull()
  })
})
