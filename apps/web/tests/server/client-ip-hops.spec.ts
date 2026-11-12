import { parseTrustedProxyHops, resolveClientIp } from '~/server/utils/client-ip'

/**
 * #444 #445: with N trusted reverse proxies in front of this server, the client is the N-th
 * `x-forwarded-for` entry from the right (the one the outermost trusted proxy appended).
 * Anything a browser put in front of it is ignored; a missing or unusable entry falls back
 * to the socket peer.
 */

const req = (peer: string | undefined, xff?: string) => ({
  socket: { remoteAddress: peer },
  ...(xff === undefined ? {} : { headers: { 'x-forwarded-for': xff } }),
})

describe('resolveClientIp with trusted proxy hops', () => {
  test('hops 0: the socket peer, x-forwarded-for ignored', () => {
    expect(resolveClientIp(req('172.25.0.5', '203.0.113.5'), 0)).toBe('172.25.0.5')
  })

  test('hops 1: the single forwarded entry', () => {
    expect(resolveClientIp(req('::ffff:172.25.0.5', '198.51.100.9'), 1)).toBe('198.51.100.9')
  })

  test('hops 1: the entry the proxy appended, not the one the client sent', () => {
    expect(resolveClientIp(req('172.25.0.5', '203.0.113.5, 172.25.0.1'), 1)).toBe('172.25.0.1')
  })

  test('hops 2: the second entry from the right', () => {
    expect(resolveClientIp(req('172.25.0.5', '203.0.113.5, 198.51.100.9, 10.0.0.2'), 2)).toBe('198.51.100.9')
  })

  test('hops 1 without x-forwarded-for: the socket peer', () => {
    expect(resolveClientIp(req('172.25.0.5'), 1)).toBe('172.25.0.5')
  })

  test('fewer entries than hops: the socket peer', () => {
    expect(resolveClientIp(req('172.25.0.5', '198.51.100.9'), 2)).toBe('172.25.0.5')
  })

  test('chosen entry is not an IP: the socket peer', () => {
    expect(resolveClientIp(req('172.25.0.5', 'not-an-ip'), 1)).toBe('172.25.0.5')
  })

  test('chosen entry carries a port: the socket peer', () => {
    expect(resolveClientIp(req('172.25.0.5', '198.51.100.9:443'), 1)).toBe('172.25.0.5')
  })

  test('trailing comma: the empty last entry counts and falls back to the socket peer', () => {
    expect(resolveClientIp(req('172.25.0.5', '203.0.113.5,'), 1)).toBe('172.25.0.5')
  })

  test('strips an IPv6 zone id from the chosen entry', () => {
    expect(resolveClientIp(req('172.25.0.5', 'fe80::1%eth0'), 1)).toBe('fe80::1')
  })

  test('in-process request inherits the outer client, whatever hops and headers say', () => {
    expect(resolveClientIp({
      socket: { remoteAddress: '' },
      headers: { 'x-forwarded-for': '203.0.113.5' },
      __unenv__: { clientIp: '198.51.100.9' },
    }, 1)).toBe('198.51.100.9')
  })
})

describe('parseTrustedProxyHops', () => {
  test('a number', () => {
    expect(parseTrustedProxyHops(1)).toBe(1)
  })

  test('a decimal string', () => {
    expect(parseTrustedProxyHops('2')).toBe(2)
  })

  test('unset: 0', () => {
    expect(parseTrustedProxyHops(undefined)).toBe(0)
  })

  test('negative: 0', () => {
    expect(parseTrustedProxyHops('-1')).toBe(0)
  })

  test('non-numeric: 0', () => {
    expect(parseTrustedProxyHops('abc')).toBe(0)
  })

  test('fractional: 0', () => {
    expect(parseTrustedProxyHops(1.5)).toBe(0)
  })
})
