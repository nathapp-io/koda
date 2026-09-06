export default defineEventHandler(async (event) => {
  const body = await readBody<{ name: string; email: string; password: string }>(event)
  const { status, body: responseBody } = await forwardToApi(event, '/auth/register', {
    method: 'POST',
    body,
  })

  if (status >= 400) {
    throw createError({
      statusCode: status,
      statusMessage: typeof responseBody === 'object' && responseBody && 'message' in responseBody
        ? String((responseBody as { message?: unknown }).message)
        : 'Registration failed',
      data: responseBody,
    })
  }

  const data = unwrapAuth(responseBody as { ret?: number; data?: { accessToken?: string; refreshToken?: string; user?: Record<string, unknown> } })
  setAuthCookies(event, { accessToken: data.accessToken, refreshToken: data.refreshToken })

  return { user: data.user }
})
