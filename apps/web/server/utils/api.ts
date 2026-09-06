interface AuthEnvelope {
  ret?: number
  data?: {
    accessToken?: string
    refreshToken?: string
    user?: Record<string, unknown>
  }
  message?: string
}

interface UnwrappedAuth {
  accessToken?: string
  refreshToken?: string
  user?: Record<string, unknown>
}

type AuthEvent = Parameters<typeof getCookie>[0]

function unwrapAuth(envelope: AuthEnvelope | undefined): UnwrappedAuth {
  if (!envelope) return {}
  if (typeof envelope.ret === 'number' && envelope.ret !== 0) {
    throw createError({
      statusCode: 401,
      statusMessage: envelope.message ?? 'Authentication failed',
      data: envelope,
    })
  }
  return envelope.data ?? (envelope as unknown as UnwrappedAuth)
}

export function setAuthCookies(
  event: AuthEvent,
  data: { accessToken?: string; refreshToken?: string },
): void {
  if (data.accessToken) {
    setCookie(event, ACCESS_COOKIE, data.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      path: '/',
      maxAge: 60 * 15, // 15-minute access-token window
    })
  }
  if (data.refreshToken) {
    setCookie(event, REFRESH_COOKIE, data.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7-day refresh window
    })
  }
}

export function clearAuthCookies(event: AuthEvent): void {
  deleteCookie(event, ACCESS_COOKIE, { path: '/' })
  deleteCookie(event, REFRESH_COOKIE, { path: '/' })
}

/**
 * Build a FetchOptions payload that forwards the request body + cookies to the
 * upstream API. Used by the /server/api/auth/* server routes.
 */
export function forwardToApi<T = unknown>(
  event: AuthEvent,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const config = useRuntimeConfig(event)
  const internal = String(config.apiInternalUrl ?? '').replace(/\/+$/, '')
  const baseUrl = internal.endsWith('/api') ? internal : `${internal}/api`
  const url = `${baseUrl}${path}`

  const cookieValue = getCookie(event, ACCESS_COOKIE)
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (cookieValue) headers['Authorization'] = `Bearer ${cookieValue}`

  const contentType = getRequestHeader(event, 'content-type')
  if (contentType && typeof init.body !== 'undefined') {
    headers['Content-Type'] = contentType
  }

  return $fetch
    .raw<T>(url, {
      method: (init.method ?? 'POST') as 'POST',
      headers,
      body: init.body as Record<string, unknown>,
      ignoreResponseError: true,
    })
    .then((res) => ({
      status: res.status,
      body: res._data as T,
    }))
}

export { ACCESS_COOKIE, REFRESH_COOKIE, unwrapAuth }
