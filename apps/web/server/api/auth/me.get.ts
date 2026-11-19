/**
 * GET /api/auth/me
 *
 * Proxies the upstream /auth/me route using the access-token cookie.
 * Returns the user payload on success; definite unauthenticated outcomes
 * return { user: null }, while upstream outages are reported as 503.
 */
export default defineEventHandler(async (event) => {
  const accessToken = getCookie(event, ACCESS_COOKIE)
  if (!accessToken) {
    return { user: null }
  }

  let response: { status: number; body: unknown }
  try {
    response = await forwardToApi(event, '/auth/me', { method: 'GET' })
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' })
  }

  const { status, body: responseBody } = response
  if (status === 401 || status === 403) return { user: null }
  if (status >= 400) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' })
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
