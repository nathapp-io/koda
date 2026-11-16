import { createHash } from 'node:crypto';
import { getClientIp } from '@nathapp/nestjs-common';

export interface RefreshClient {
  uaHash: string;
  ip: string | null;
}

/**
 * The little of a request this module reads.
 *
 * There is deliberately no `ip` field: Fastify's `req.ip` is the socket peer and never honours the
 * trusted-proxy list, because `createFastifyAdapter()` configures no `trustProxy` — behind the Nuxt
 * proxy it named the web container. The address comes from `getClientIp`, the resolver and list the
 * throttler already uses (and the peer it falls back to is `socket.remoteAddress`).
 */
export interface RefreshRequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/** The client a refresh presents: the User-Agent hash and the address the trusted-proxy resolver reports. */
export function refreshClientFrom(req: RefreshRequestLike): RefreshClient {
  const userAgent = req.headers['user-agent'];
  // A repeated header arrives as an array; the first value is the client's.
  return refreshClientOf(Array.isArray(userAgent) ? userAgent[0] : userAgent, getClientIp(req));
}

export function refreshClientOf(userAgent: string | undefined, ip: string | undefined): RefreshClient {
  return {
    uaHash: createHash('sha256').update(userAgent ?? '').digest('hex'),
    ip: ip || null,
  };
}
