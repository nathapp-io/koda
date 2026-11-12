import { join } from 'node:path'

/**
 * #444: server/middleware/client-ip.ts resolves the client with the trusted hop count from
 * runtime config (`trustedProxyHops`, set by NUXT_TRUSTED_PROXY_HOPS).
 */

const middlewarePath = join(__dirname, '..', '..', 'server', 'middleware', 'client-ip.ts')
const g = globalThis as Record<string, unknown>
type Handler = (event: unknown) => void

const makeEvent = (peer: string, xff: string) => ({
  node: { req: { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': xff } } },
  context: {} as Record<string, unknown>,
})

async function loadHandler(): Promise<Handler> {
  const { default: handler } = await import(middlewarePath) as { default: Handler }
  return handler
}

beforeEach(() => {
  g.defineEventHandler = (handler: unknown) => handler
})

afterEach(() => {
  delete g.defineEventHandler
  delete g.useRuntimeConfig
})

describe('client-ip middleware', () => {
  test('trustedProxyHops 1: the entry the proxy appended', async () => {
    g.useRuntimeConfig = () => ({ trustedProxyHops: 1 })
    const event = makeEvent('::ffff:172.25.0.5', '203.0.113.5, 172.25.0.1')
    ;(await loadHandler())(event)
    expect(event.context.clientIp).toBe('172.25.0.1')
  })

  test('no trustedProxyHops in runtime config: the socket peer', async () => {
    g.useRuntimeConfig = () => ({})
    const event = makeEvent('172.25.0.5', '203.0.113.5')
    ;(await loadHandler())(event)
    expect(event.context.clientIp).toBe('172.25.0.5')
  })
})
