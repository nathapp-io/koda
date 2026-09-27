/**
 * Client IP for every upstream API call made on a browser's behalf.
 * Kept free of Nitro auto-import globals so unit tests can import it directly.
 *
 * The API trusts this server as a proxy and reads the client IP from
 * `x-client-ip` first, unfiltered (@nathapp/nestjs-common getClientIp). Setting
 * it on every call gives each browser its own rate-limit bucket (instead of all
 * sharing this container's IP) and overrides any IP header the browser sent.
 * Only the socket peer is used: a browser controls X-Forwarded-For. A reverse
 * proxy in front of this server would need this revisited.
 */

/** Shared bucket for requests whose peer is unknown; unlike omitting the header, it cannot be spoofed. */
export const UNKNOWN_CLIENT_IP = '0.0.0.0'

export interface ClientIpRequest {
  socket?: { remoteAddress?: string }
  /** Set by Nitro on in-process fetches: the calling request's event.context. */
  __unenv__?: { clientIp?: string }
}

/**
 * The browser's IP for this request. An in-process request (SSR useRequestFetch
 * to our own /api routes) has an empty socket, so it inherits the IP resolved for
 * the outer request; `__unenv__` cannot be set from the network.
 */
export function resolveClientIp(req: ClientIpRequest): string | undefined {
  if (req.__unenv__) return req.__unenv__.clientIp || undefined
  const peer = req.socket?.remoteAddress
  // The API rejects IPv6 zone ids (fe80::1%eth0) as invalid IPs.
  return peer ? peer.split('%')[0] : undefined
}

export function clientIpHeaders(clientIp: string | undefined): Record<string, string> {
  return { 'x-client-ip': clientIp || UNKNOWN_CLIENT_IP }
}
