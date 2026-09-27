import { readFileSync } from 'node:fs'
import path from 'node:path'
import { clientIpHeaders, resolveClientIp, UNKNOWN_CLIENT_IP } from '~/server/utils/client-ip'

/**
 * The API trusts the web container as a proxy and then takes the client IP from
 * `x-client-ip` first, unfiltered (@nathapp/nestjs-common getClientIp). So every
 * upstream call made for a browser must set it to that browser's socket peer:
 * otherwise all browsers share the web container's IP (one login-throttle bucket
 * for everyone), and a browser-sent `x-client-ip` passed through by the proxy
 * would pick its own bucket.
 */

describe('resolveClientIp', () => {
  test('network request: the socket peer', () => {
    expect(resolveClientIp({ socket: { remoteAddress: '203.0.113.7' } })).toBe('203.0.113.7')
  })

  test('keeps private and IPv4-mapped peers (LAN clients get their own bucket)', () => {
    expect(resolveClientIp({ socket: { remoteAddress: '192.168.1.5' } })).toBe('192.168.1.5')
    expect(resolveClientIp({ socket: { remoteAddress: '::ffff:172.18.0.1' } })).toBe('::ffff:172.18.0.1')
  })

  test('strips an IPv6 zone id (the API rejects it as an IP)', () => {
    expect(resolveClientIp({ socket: { remoteAddress: 'fe80::1%eth0' } })).toBe('fe80::1')
  })

  test('in-process request (SSR useRequestFetch): inherits the outer request client IP', () => {
    // Nitro's local fetch has an empty socket and carries the caller's event.context as __unenv__.
    expect(resolveClientIp({ socket: { remoteAddress: '' }, __unenv__: { clientIp: '198.51.100.9' } })).toBe('198.51.100.9')
  })

  test('unknown peer resolves to undefined', () => {
    expect(resolveClientIp({ socket: { remoteAddress: '' } })).toBeUndefined()
    expect(resolveClientIp({})).toBeUndefined()
    expect(resolveClientIp({ __unenv__: {} })).toBeUndefined()
  })
})

describe('clientIpHeaders', () => {
  test('sets x-client-ip to the resolved client IP', () => {
    expect(clientIpHeaders('203.0.113.7')).toEqual({ 'x-client-ip': '203.0.113.7' })
  })

  test('fails closed: unknown client -> shared, unspoofable placeholder (never omitted)', () => {
    expect(UNKNOWN_CLIENT_IP).toBe('0.0.0.0')
    expect(clientIpHeaders(undefined)).toEqual({ 'x-client-ip': '0.0.0.0' })
  })
})

describe('wiring', () => {
  const read = (...p: string[]) => readFileSync(path.join(__dirname, '..', '..', ...p), 'utf-8')

  test('server middleware stores the resolved client IP on every event', () => {
    expect(read('server', 'middleware', 'client-ip.ts')).toMatch(
      /event\.context\.clientIp = resolveClientIp\(event\.node\.req/,
    )
  })

  test('forwardToApi sends the event client IP', () => {
    expect(read('server', 'utils', 'api.ts')).toMatch(/clientIpHeaders\(event\.context\.clientIp\)/)
  })

  test('catch-all /api proxy overrides browser headers with the event client IP', () => {
    expect(read('server', 'api', '[...].ts')).toMatch(
      /proxyRequest\(event, target, \{\s*headers: clientIpHeaders\(event\.context\.clientIp\)/,
    )
  })

  test('SSR useApi sends the request event client IP, applied last', () => {
    const source = read('composables', 'useApi.ts')
    expect(source).toMatch(/const ssrEvent = import\.meta\.server \? useRequestEvent\(\) : undefined/)
    expect(source).toMatch(/clientIpHeaders\(ssrEvent\.context\.clientIp\)/)
    expect(source).toMatch(/\.\.\.ssrClientIpHeaders,?\s*\}\)/)
  })
})
