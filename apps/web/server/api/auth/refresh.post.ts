/**
 * POST /api/auth/refresh
 *
 * Uses the refresh-token cookie (also accepted by the upstream API's
 * /auth/refresh route) to mint a new access/refresh pair. Stores the
 * rotated cookies on the response.
 */
export default defineEventHandler(async (event) => {
  const { status, body: responseBody } = await forwardToApi(event, '/auth/refresh', {
    method: 'POST',
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
