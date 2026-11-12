/**
 * Resolves the browser's IP once per request (see server/utils/client-ip.ts);
 * API calls read it from event.context.clientIp. `trustedProxyHops`
 * (NUXT_TRUSTED_PROXY_HOPS) is the number of reverse proxies in front of this server.
 */
import type { ClientIpRequest } from '../utils/client-ip-resolve'
import { parseTrustedProxyHops, resolveClientIp } from '../utils/client-ip-resolve'

export default defineEventHandler((event) => {
  const hops = parseTrustedProxyHops(useRuntimeConfig(event).trustedProxyHops)
  event.context.clientIp = resolveClientIp(event.node.req as unknown as ClientIpRequest, hops)
})
