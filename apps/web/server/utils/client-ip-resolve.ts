import { isIP } from 'node:net'

/**
 * Which client address this server reports to the API (server only: imports
 * `node:net`; the browser-safe header helper is `./client-ip`).
 * Kept free of Nitro auto-import globals so unit tests can import it directly.
 *
 * With no reverse proxy in front of this server (`NUXT_TRUSTED_PROXY_HOPS` = 0,
 * the default) it is the socket peer. With N trusted proxies in front it is the
 * N-th `x-forwarded-for` entry from the right, the one the outermost trusted
 * proxy appended; entries a browser put before it are ignored (#444). That
 * setting must equal the real proxy count, and this server must be reachable only
 * through those proxies: a direct request, or a count above the real one, lets a
 * browser choose the address it is throttled as.
 */

export interface ClientIpRequest {
  socket?: { remoteAddress?: string }
  /** Node joins repeated x-forwarded-for headers into one comma-separated string. */
  headers?: { 'x-forwarded-for'?: string }
  /** Set by Nitro on in-process fetches: the calling request's event.context. */
  __unenv__?: { clientIp?: string }
}

/** The API rejects IPv6 zone ids (fe80::1%eth0) as invalid IPs. */
function stripZone(address: string): string {
  return address.split('%')[0] ?? ''
}

/** A non-negative integer (number or decimal string); anything else is 0, i.e. trust no proxy. */
export function parseTrustedProxyHops(raw: unknown): number {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  return /^\d+$/.test(text) ? Number(text) : 0
}

/** The entry the outermost of `hops` trusted proxies appended, when it is a bare IP address. */
function forwardedClient(forwardedFor: string | undefined, hops: number): string | undefined {
  if (!forwardedFor) return undefined
  // Empty entries are kept so they count toward the length (a trailing comma is not skipped over).
  const entries = forwardedFor.split(',').map((entry) => entry.trim())
  if (entries.length < hops) return undefined
  const candidate = stripZone(entries[entries.length - hops] ?? '')
  return isIP(candidate) ? candidate : undefined
}

/**
 * The browser's IP for this request. An in-process request (SSR useRequestFetch
 * to our own /api routes) has an empty socket, so it inherits the IP resolved for
 * the outer request; `__unenv__` cannot be set from the network.
 */
export function resolveClientIp(req: ClientIpRequest, trustedProxyHops = 0): string | undefined {
  if (req.__unenv__) return req.__unenv__.clientIp || undefined
  const peer = req.socket?.remoteAddress
  const peerIp = peer ? stripZone(peer) : undefined
  if (trustedProxyHops <= 0) return peerIp
  return forwardedClient(req.headers?.['x-forwarded-for'], trustedProxyHops) ?? peerIp
}
