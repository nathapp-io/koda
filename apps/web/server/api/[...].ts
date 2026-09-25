/**
 * M23: runtime /api proxy handler. Replaces the build-time-frozen routeRules
 * proxy so NUXT_API_INTERNAL_URL is honored at runtime instead of being baked
 * in at build time.
 *
 * Filesystem routes under server/api/auth/* are more specific than this
 * catch-all and take precedence in Nitro's router, so the httpOnly cookie
 * session endpoints are never shadowed.
 *
 * Note: SSR composable calls bypass /api entirely (they call
 * config.apiInternalUrl directly, see composables/useApi.ts) — this handler
 * serves browser traffic only.
 */
import { resolveProxyTarget } from '../utils/proxy-target'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  // Same String(... ?? '') access pattern as server/utils/api.ts: the Nitro
  // RuntimeConfig type does not statically declare apiInternalUrl.
  const target = resolveProxyTarget(event.path.replace(/^\/api/, ''), {
    apiInternalUrl: String(config.apiInternalUrl ?? ''),
  })
  return proxyRequest(event, target)
})
