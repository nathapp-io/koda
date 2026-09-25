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
    | { ret?: number; data?: Record<string, unknown> | null }
    | Record<string, unknown>
    | undefined
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    // The upstream API (JsonResponse.Ok(validatedUser)) returns the user
    // object directly in `data`; support the nested `data.user` shape too.
    const data = (envelope as { data?: Record<string, unknown> | null }).data
    if (data && typeof data === 'object') {
      const user = ((data as { user?: Record<string, unknown> }).user ?? data) as
        | Record<string, unknown>
        | null
      if (user && typeof user.email === 'string') {
        return { user }
      }
    }
  }
  return { user: null }
})
