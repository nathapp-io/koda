/**
 * US-007: anonymous invite acceptance proxy. Forwards the visitor's name and
 * password to the public `/invites/:token/accept` API route, then mirrors the
 * register/login proxy: httpOnly cookies for the issued session, `{ user }` to
 * the browser. No raw token is stored here — it rides the path exactly once.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  const body = await readBody<{ name: string; password: string }>(event)
  const { status, body: responseBody } = await forwardToApi(event, `/invites/${token}/accept`, {
    method: 'POST',
    body,
  })

  if (status >= 400) {
    throw createError({
      statusCode: status,
      statusMessage: typeof responseBody === 'object' && responseBody && 'message' in responseBody
        ? String((responseBody as { message?: unknown }).message)
        : 'Invite acceptance failed',
      data: responseBody,
    })
  }

  const data = unwrapAuth(responseBody as { ret?: number; data?: { accessToken?: string; refreshToken?: string; user?: Record<string, unknown> } })
  setAuthCookies(event, { accessToken: data.accessToken, refreshToken: data.refreshToken })

  return { user: data.user }
})
