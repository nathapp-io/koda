/**
 * Client IP headers for every upstream API call made on a browser's behalf.
 * Kept free of Nitro auto-import globals so unit tests can import it directly.
 *
 * Browser-safe: `composables/useApi.ts` imports this module, so it ships in the
 * client bundle and must not import Node built-ins. How the address is resolved
 * (socket peer, trusted proxy hops) lives in the server-only `./client-ip-resolve`.
 *
 * This server is the single authority for the client address it reports. The
 * API trusts it as a proxy and reads `x-forwarded-for` before `x-client-ip`
 * (@nathapp/nestjs-common getClientIp), so every upstream call sends the one
 * resolved address in BOTH headers, replacing anything the browser sent (#445).
 */

/** Shared bucket for requests whose peer is unknown; unlike omitting the header, it cannot be spoofed. */
export const UNKNOWN_CLIENT_IP = '0.0.0.0'

export function clientIpHeaders(clientIp: string | undefined): Record<string, string> {
  const address = clientIp || UNKNOWN_CLIENT_IP
  return { 'x-client-ip': address, 'x-forwarded-for': address }
}
