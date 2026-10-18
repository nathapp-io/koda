import { clientIpHeaders } from './client-ip'

/**
 * Pure target resolver for the runtime /api proxy (M23).
 * Kept free of Nitro auto-import globals so unit tests can import it directly.
 *
 * `path` is the request sub-path (everything after the `/api` prefix, including
 * any query string); `config.apiInternalUrl` is the runtime-configured upstream
 * base (NUXT_API_INTERNAL_URL), which may or may not already end in `/api`.
 */
export function resolveProxyTarget(path: string, config: { apiInternalUrl: string }): string {
  const internal = String(config.apiInternalUrl ?? '').replace(/\/+$/, '')
  const base = internal.endsWith('/api') ? internal : `${internal}/api`
  return `${base}${path}`
}

/**
 * Headers for the runtime /api proxy. h3 `proxyRequest` drops the client's
 * `accept` (its ignoredHeaders set), but content-negotiating routes need it:
 * POST /api/mcp answers 406 without `application/json, text/event-stream` (#304).
 * The client IP is applied last so a browser-sent x-client-ip is always overridden.
 */
export function proxyHeaders(clientIp: string | undefined, accept: string | undefined): Record<string, string> {
  return {
    ...(accept ? { accept } : {}),
    ...clientIpHeaders(clientIp),
  }
}
