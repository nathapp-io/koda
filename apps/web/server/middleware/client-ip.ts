/**
 * Resolves the browser's IP once per request (see server/utils/client-ip.ts);
 * API calls read it from event.context.clientIp.
 */
import type { ClientIpRequest } from '../utils/client-ip'
import { resolveClientIp } from '../utils/client-ip'

export default defineEventHandler((event) => {
  event.context.clientIp = resolveClientIp(event.node.req as unknown as ClientIpRequest)
})
