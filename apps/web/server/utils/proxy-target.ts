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
