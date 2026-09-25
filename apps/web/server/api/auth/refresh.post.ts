/**
 * POST /api/auth/refresh
 *
 * Uses the refresh-token cookie to mint a new access/refresh pair. The
 * refresh cookie value is forwarded as the Bearer token (M22) — the upstream
 * API's JwtRefreshGuard extracts the refresh token from the Authorization
 * header first. Stores the rotated cookies on the response.
 */
export default defineEventHandler(async (event) => {
  const { status, body: responseBody } = await forwardToApi(event, '/auth/refresh', {
    method: 'POST',
    cookieName: 'refresh',
  })

  if (status >= 400) {
    throw createError({
      statusCode: status,
      statusMessage: typeof responseBody === 'object' && responseBody && 'message' in responseBody
        ? String((responseBody as { message?: unknown }).message)
        : 'Token refresh failed',
      data: responseBody,
    })
  }

  const data = unwrapAuth(responseBody as { ret?: number; data?: { accessToken?: string; refreshToken?: string } })
  setAuthCookies(event, { accessToken: data.accessToken, refreshToken: data.refreshToken })

  return { refreshed: true }
})
