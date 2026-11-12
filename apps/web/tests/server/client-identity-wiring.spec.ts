import { join } from 'node:path'
import { clientIpHeaders } from '~/server/utils/client-ip'
import { forwardToApi } from '~/server/utils/api'

/**
 * #444 #445: every upstream call names one client address in both x-client-ip and
 * x-forwarded-for. The API reads x-forwarded-for first, so a browser-supplied value must
 * never reach it.
 */

const g = globalThis as Record<string, unknown>
type Handler = (event: unknown) => Promise<unknown>

describe('clientIpHeaders', () => {
  test('one address in both headers', () => {
    expect(clientIpHeaders('198.51.100.9')).toEqual({ 'x-client-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9' })
  })

  test('fails closed: both headers carry the shared placeholder', () => {
    expect(clientIpHeaders(undefined)).toEqual({ 'x-client-ip': '0.0.0.0', 'x-forwarded-for': '0.0.0.0' })
  })
})

describe('entry points', () => {
  beforeEach(() => {
    g.defineEventHandler = (handler: unknown) => handler
    g.useRuntimeConfig = () => ({ apiInternalUrl: 'http://api:3100' })
  })

  afterEach(() => {
    for (const key of ['defineEventHandler', 'useRuntimeConfig', 'getRequestHeader', 'proxyRequest', 'readBody',
      'forwardToApi', 'unwrapAuth', 'setAuthCookies', 'createError', '$fetch', 'getCookie']) delete g[key]
  })

  test('catch-all /api proxy sends the event client in x-forwarded-for', async () => {
    const proxyRequest = jest.fn(async () => ({}))
    g.proxyRequest = proxyRequest
    g.getRequestHeader = (_event: unknown, name: string) =>
      (name === 'x-forwarded-for' ? '203.0.113.5' : undefined)
    const { default: handler } = await import(join(__dirname, '..', '..', 'server', 'api', '[...].ts')) as { default: Handler }

    await handler({ path: '/api/projects', context: { clientIp: '172.25.0.1' } })

    expect(proxyRequest).toHaveBeenCalledTimes(1)
    const opts = (proxyRequest.mock.calls[0] as unknown[])[2] as { headers: Record<string, string> }
    expect(opts.headers['x-forwarded-for']).toBe('172.25.0.1')
  })

  test('login route sends the event client in both headers', async () => {
    const raw = jest.fn(async () => ({ status: 200, _data: { ret: 0, data: { accessToken: 'a', refreshToken: 'r', user: {} } } }))
    g.$fetch = { raw }
    g.readBody = async () => ({ email: 'a@b.test', password: 'pw' })
    g.getRequestHeader = (_event: unknown, name: string) => {
      if (name === 'content-type') return 'application/json'
      if (name === 'x-forwarded-for') return '203.0.113.5'
      return undefined
    }
    g.getCookie = () => undefined
    g.forwardToApi = forwardToApi
    g.unwrapAuth = (body: { data: unknown }) => body.data
    g.setAuthCookies = jest.fn()
    g.createError = (input: unknown) => Object.assign(new Error('upstream'), input)
    const { default: handler } = await import(join(__dirname, '..', '..', 'server', 'api', 'auth', 'login.post.ts')) as { default: Handler }

    await handler({ context: { clientIp: '172.25.0.1' } })

    expect(raw).toHaveBeenCalledTimes(1)
    const [url, opts] = raw.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toBe('http://api:3100/api/auth/login')
    expect(opts.headers['x-forwarded-for']).toBe('172.25.0.1')
    expect(opts.headers['x-client-ip']).toBe('172.25.0.1')
  })
})
