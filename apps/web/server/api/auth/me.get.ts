/**
 * GET /api/auth/me
 *
 * Proxies the upstream /auth/me route using the access-token cookie.
 * Returns the user payload on success; returns { user: null } when no
 * cookie is present or the upstream call fails so the client can use it
 * as a soft authentication probe.
 */
export default defineEventHandler(async (event) => {
  const accessToken = getCookie(event, ACCESS_COOKIE)
  if (!accessToken) {
    return { user: null }
  }

  const { status, body: responseBody } = await forwardToApi(event, '/auth/me', {
    method: 'GET',
  })

  if (status >= 400) {
    return { user: null }
  }

  const envelope = responseBody as
    | { ret?: number; data?: { user?: Record<string, unknown> } }
    | Record<string, unknown>
    | undefined
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    return { user: (envelope as { data?: { user?: Record<string, unknown> } }).data?.user ?? null }
  }
  return { user: null }
})
