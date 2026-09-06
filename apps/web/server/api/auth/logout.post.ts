/**
 * POST /api/auth/logout
 *
 * Calls the upstream API's /auth/logout to revoke the access token, then
 * clears both auth cookies regardless of the upstream outcome. Returns 204
 * so the client can clear local state without inspecting a body.
 */
export default defineEventHandler(async (event) => {
  const accessToken = getCookie(event, ACCESS_COOKIE)
  if (accessToken) {
    try {
      await forwardToApi(event, '/auth/logout', { method: 'POST' })
    } catch {
      // Upstream logout failure is not fatal — we still want to clear the cookies.
    }
  }
  clearAuthCookies(event)
  event.node.res.statusCode = 204
  return null
})
