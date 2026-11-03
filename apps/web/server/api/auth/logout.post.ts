/**
 * POST /api/auth/logout
 *
 * Revoke the current session even when its short-lived access cookie has
 * expired, then clear both local auth cookies regardless of the outcome.
 */
export default defineEventHandler(async (event) => {
  const accessToken = getCookie(event, ACCESS_COOKIE)
  const refreshToken = getCookie(event, REFRESH_COOKIE)
  let revoked = true

  try {
    if (accessToken) {
      const { status } = await forwardToApi(event, '/auth/logout', { method: 'POST' })
      revoked = status < 400
    } else if (refreshToken) {
      const refresh = await forwardToApi(event, '/auth/refresh', {
        method: 'POST',
        cookieName: 'refresh',
      })
      if (refresh.status === 401 || refresh.status === 403) {
        revoked = true
      } else if (refresh.status < 200 || refresh.status >= 300) {
        revoked = false
      } else {
        const data = unwrapAuth(refresh.body as { ret?: number; data?: { accessToken?: string } })
        if (!data.accessToken) {
          revoked = false
        } else {
          const logout = await forwardToApi(event, '/auth/logout', {
            method: 'POST',
            bearer: data.accessToken,
          })
          revoked = logout.status < 400
        }
      }
    }
  } catch {
    revoked = false
  }

  clearAuthCookies(event)
  if (!revoked) {
    event.node.res.statusCode = 502
    return { revoked: false }
  }
  event.node.res.statusCode = 204
  return null
})
