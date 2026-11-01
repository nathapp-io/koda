import { shouldRefreshSession, withAuthCookies } from '../utils/session-refresh'

export default defineEventHandler(async (event) => {
  if (!shouldRefreshSession(event)) return

  try {
    const { status, body } = await forwardToApi(event, '/auth/refresh', {
      method: 'POST',
      cookieName: 'refresh',
    })

    if (status === 401 || status === 403) {
      clearAuthCookies(event)
      return
    }
    if (status < 200 || status >= 300) return

    let tokens: { accessToken?: string; refreshToken?: string }
    try {
      tokens = unwrapAuth(body as { ret?: number; data?: { accessToken?: string; refreshToken?: string } })
    } catch {
      clearAuthCookies(event)
      return
    }

    if (tokens.accessToken && tokens.refreshToken) {
      setAuthCookies(event, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken })
      event.node.req.headers.cookie = withAuthCookies(event.node.req.headers.cookie, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })
    }
  } catch {
    // Refresh is best-effort: transient API errors must not invalidate the session.
  }
})
