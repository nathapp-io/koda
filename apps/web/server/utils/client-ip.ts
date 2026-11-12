import { isIP } from 'node:net'

/**
 * Client IP for every upstream API call made on a browser's behalf.
 * Kept free of Nitro auto-import globals so unit tests can import it directly.
 *
 * This server is the single authority for the client address it reports. The
 * API trusts it as a proxy and reads `x-forwarded-for` before `x-client-ip`
 * (@nathapp/nestjs-common getClientIp), so every upstream call sends the one
 * resolved address in BOTH headers, replacing anything the browser sent (#445).
 *
 * Which address: with no reverse proxy in front of this server
 * (`NUXT_TRUSTED_PROXY_HOPS` = 0, the default) it is the socket peer. With N
 * trusted proxies in front it is the N-th `x-forwarded-for` entry from the right,
 * the one the outermost trusted proxy appended; entries a browser put before it
 * are ignored (#444). That setting must equal the real proxy count, and this
 * server must be reachable only through those proxies: a direct request, or a
 * count above the real one, lets a browser choose the address it is throttled as.
 */

/** Shared bucket for requests whose peer is unknown; unlike omitting the header, it cannot be spoofed. */
export const UNKNOWN_CLIENT_IP = '0.0.0.0'

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

export function clientIpHeaders(clientIp: string | undefined): Record<string, string> {
  const address = clientIp || UNKNOWN_CLIENT_IP
  return { 'x-client-ip': address, 'x-forwarded-for': address }
}
