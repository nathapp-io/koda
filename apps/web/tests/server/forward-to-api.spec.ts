import { readFileSync } from 'node:fs'
import path from 'node:path'
import { forwardToApi, ACCESS_COOKIE, REFRESH_COOKIE } from '~/server/utils/api'

/**
 * M22 — refresh flow cookie selection.
 *
 * server/utils/api.ts relies on Nitro auto-imports (getCookie, useRuntimeConfig,
 * $fetch). ts-jest compiles it with isolatedModules (transpile-only), so the
 * module is importable and those auto-imports resolve as globals at call time —
 * stub them on globalThis per test.
 */

const g = globalThis as Record<string, unknown>

const makeEvent = (clientIp?: string) =>
  ({ context: { clientIp } }) as unknown as Parameters<typeof forwardToApi>[0]

let rawMock: jest.Mock

beforeEach(() => {
  rawMock = jest.fn(() =>
    Promise.resolve({ status: 200, _data: { ret: 0, data: {} } })
  )
  g.useRuntimeConfig = () => ({ apiInternalUrl: 'http://localhost:3100' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  g.$fetch = { raw: rawMock }
})

afterEach(() => {
  delete g.useRuntimeConfig
  delete g.$fetch
  delete g.getCookie
  delete g.getRequestHeader
})

describe('M22: forwardToApi cookie selection', () => {
  test('exports the httpOnly cookie names used for selection', () => {
    expect(ACCESS_COOKIE).toBe('koda_token')
    expect(REFRESH_COOKIE).toBe('koda_refresh')
  })

  test('default (no cookieName) forwards the ACCESS cookie as Bearer', async () => {
    g.getCookie = (_event: unknown, name: string) =>
      name === 'koda_token' ? 'access-token-value' : 'refresh-token-value'
    g.getRequestHeader = () => undefined

    await forwardToApi(makeEvent(), '/auth/me', { method: 'GET' })

    expect(rawMock).toHaveBeenCalledTimes(1)
    const [, opts] = rawMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBe('Bearer access-token-value')
  })

  test("cookieName: 'refresh' forwards the REFRESH cookie as Bearer", async () => {
    g.getCookie = (_event: unknown, name: string) =>
      name === 'koda_token' ? 'access-token-value' : 'refresh-token-value'
    g.getRequestHeader = () => undefined

    await forwardToApi(makeEvent(), '/auth/refresh', {
      method: 'POST',
      cookieName: 'refresh',
    })

    expect(rawMock).toHaveBeenCalledTimes(1)
    const [, opts] = rawMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBe('Bearer refresh-token-value')
  })

  test("cookieName: 'refresh' omits the Authorization header when the refresh cookie is absent", async () => {
    g.getCookie = () => undefined
    g.getRequestHeader = () => undefined

    await forwardToApi(makeEvent(), '/auth/refresh', {
      method: 'POST',
      cookieName: 'refresh',
    })

    const [, opts] = rawMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBeUndefined()
  })

  test('default omits the Authorization header when the access cookie is absent', async () => {
    g.getCookie = () => undefined
    g.getRequestHeader = () => undefined

    await forwardToApi(makeEvent(), '/auth/me', { method: 'GET' })

    const [, opts] = rawMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBeUndefined()
  })
})

describe('forwardToApi client IP (see server/utils/client-ip.ts)', () => {
  beforeEach(() => {
    g.getCookie = () => undefined
    // A browser-sent header must never reach the API as the client IP.
    g.getRequestHeader = (_e: unknown, name: string) => (name === 'x-client-ip' ? '6.6.6.6' : undefined)
  })

  test('sends the event client IP as x-client-ip', async () => {
    await forwardToApi(makeEvent('198.51.100.9'), '/auth/login', { body: {} })

    const [, opts] = rawMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['x-client-ip']).toBe('198.51.100.9')
  })

  test('fails closed to the shared placeholder when the client IP is unknown', async () => {
    await forwardToApi(makeEvent(undefined), '/auth/login', { body: {} })

    const [, opts] = rawMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['x-client-ip']).toBe('0.0.0.0')
  })
})

describe('M22: refresh route wiring', () => {
  const routePath = path.join(__dirname, '..', '..', 'server', 'api', 'auth', 'refresh.post.ts')

  test('refresh.post.ts passes cookieName: refresh to forwardToApi', () => {
    const source = readFileSync(routePath, 'utf-8')
    expect(source).toMatch(/cookieName:\s*'refresh'/)
  })
})
