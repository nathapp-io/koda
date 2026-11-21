import { clientIpHeaders } from './client-ip'

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

// httpOnly auth cookies set by the Nuxt server routes (WEB-02). These were
// referenced but never declared since the WEB-02 commit — restored so the
// Nuxt server build resolves them.
const ACCESS_COOKIE = 'koda_token'
const REFRESH_COOKIE = 'koda_refresh'

/** Read a JWT NumericDate expiry for cookie scheduling only; never use it as an identity check. */
export function readJwtExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!decoded || typeof decoded !== 'object' || !('exp' in decoded)) return undefined
    const expiry = (decoded as { exp?: unknown }).exp
    return typeof expiry === 'number' && Number.isFinite(expiry) ? expiry : undefined
  } catch {
    return undefined
  }
}

function cookieMaxAge(token: string, fallback: number): number {
  const expiry = readJwtExpiry(token)
  return expiry === undefined ? fallback : Math.max(0, Math.floor(expiry - Date.now() / 1000))
}

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
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: cookieMaxAge(data.accessToken, 60 * 15),
    })
  }
  if (data.refreshToken) {
    setCookie(event, REFRESH_COOKIE, data.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      path: '/',
      maxAge: cookieMaxAge(data.refreshToken, 60 * 60 * 24 * 7),
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
 *
 * `init.cookieName` selects which httpOnly auth cookie is forwarded as the
 * Bearer token (M22): 'access' (default) sends the 15-minute access token,
 * 'refresh' sends the 7-day refresh token (required by /auth/refresh, whose
 * JwtRefreshGuard extracts the refresh token from the Bearer header first).
 */
export function forwardToApi<T = unknown>(
  event: AuthEvent,
  path: string,
  init: { method?: string; body?: unknown; cookieName?: 'access' | 'refresh'; bearer?: string } = {},
): Promise<{ status: number; body: T }> {
  const config = useRuntimeConfig(event)
  const internal = String(config.apiInternalUrl ?? '').replace(/\/+$/, '')
  const baseUrl = internal.endsWith('/api') ? internal : `${internal}/api`
  const url = `${baseUrl}${path}`

  const cookieValue = init.bearer === undefined
    ? getCookie(event, init.cookieName === 'refresh' ? REFRESH_COOKIE : ACCESS_COOKIE)
    : undefined
  const bearer = init.bearer ?? cookieValue
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...clientIpHeaders(event.context.clientIp),
  }
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  const userAgent = getRequestHeader(event, 'user-agent')
  if (userAgent) headers['User-Agent'] = userAgent

  const contentType = getRequestHeader(event, 'content-type')
  if (contentType && typeof init.body !== 'undefined') {
    headers['Content-Type'] = contentType
  }

  return $fetch
    // This is an external API URL; do not infer a response from Nitro's local routes.
    .raw<unknown, string>(url, {
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
