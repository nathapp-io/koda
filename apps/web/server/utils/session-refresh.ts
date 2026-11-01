import { ACCESS_COOKIE, REFRESH_COOKIE } from './api'

interface SessionRefreshRequest {
  node: {
    req: {
      method?: string
      url?: string
      headers: {
        accept?: string | string[]
        cookie?: string
      }
    }
  }
}

function cookieValues(header: string | undefined): Map<string, string> {
  const values = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    if (!name || values.has(name)) continue
    values.set(name, part.slice(separator + 1).trim())
  }
  return values
}

/** Whether this HTML page request can be refreshed from its refresh cookie. */
export function shouldRefreshSession(event: SessionRefreshRequest): boolean {
  const { req } = event.node
  const path = req.url?.split('?')[0] ?? ''
  if (req.method !== 'GET') return false
  if (path.startsWith('/api/') || path.startsWith('/_nuxt/') || path.startsWith('/__nuxt')) return false

  const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(',') : req.headers.accept ?? ''
  if (!accept.toLowerCase().includes('text/html')) return false

  const cookies = cookieValues(req.headers.cookie)
  return !cookies.has(ACCESS_COOKIE) && cookies.has(REFRESH_COOKIE)
}

/** Replace auth cookies in a request header while keeping every other cookie value. */
export function withAuthCookies(
  cookieHeader: string | undefined,
  tokens: { accessToken: string; refreshToken: string },
): string {
  const cookies = cookieValues(cookieHeader)
  cookies.set(ACCESS_COOKIE, tokens.accessToken)
  cookies.set(REFRESH_COOKIE, tokens.refreshToken)
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}
