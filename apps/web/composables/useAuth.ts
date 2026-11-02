interface LoginCredentials {
  email: string
  password: string
}

interface RegisterCredentials {
  name: string
  email: string
  password: string
}

interface AuthUser {
  id: string
  email: string
  name?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

/**
 * US-007 (E/BUG-3): the three answers a session refresh can give.
 *
 * - `'ok'`: the cookies were rotated; the session is alive.
 * - `'unauthorized'`: the API refused the refresh (401/403). The session is really gone, so the
 *   user is cleared and a live stream stops instead of retrying.
 * - `'unavailable'`: anything else (a deploy, a proxy 502, a network drop). The session was not
 *   judged, so the user is kept and a live stream keeps retrying.
 *
 * A single boolean could not tell those apart, and treating an outage as a rejection logged the
 * user out and stopped every stream for the life of the page.
 */
export type RefreshOutcome = 'ok' | 'unauthorized' | 'unavailable'

/**
 * The status an API rejection reports. `$fetch` (ofetch) puts it on `statusCode` and `status` and
 * mirrors the response on `response.status`; the first numeric one wins, so an error that carries
 * both keeps the most specific answer.
 */
function errorStatus(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null
  const candidate = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } }
  for (const value of [candidate.statusCode, candidate.status, candidate.response?.status]) {
    if (typeof value === 'number') return value
  }
  return null
}

/**
 * Auth state lives entirely on the server. The access and refresh tokens are
 * stored as httpOnly cookies set by the Nuxt server routes under /server/api/auth/*,
 * which means JS — including any XSS payload — can never read the raw token.
 *
 * Client state is reduced to a small user profile so the auth middleware can
 * answer "is this user authenticated" without leaking the secret material.
 */
export function useAuth() {
  const user = useState<AuthUser | null>('koda_user', () => null)

  const isAuthenticated = computed(() => !!user.value)

  async function login(credentials: LoginCredentials): Promise<void> {
    const response = await $fetch<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: credentials,
    })
    user.value = response.user
  }

  async function register(credentials: RegisterCredentials): Promise<void> {
    const response = await $fetch<{ user: AuthUser }>('/api/auth/register', {
      method: 'POST',
      body: credentials,
    })
    user.value = response.user
  }

  /**
   * Redeem a public invite token: create the account and establish the session.
   * The Nitro route under /api/invites/<token>/accept mirrors register, setting
   * the httpOnly cookies and returning the new user so client state matches.
   */
  async function acceptInvite(token: string, body: { name: string; password: string }): Promise<void> {
    const response = await $fetch<{ user: AuthUser }>(`/api/invites/${token}/accept`, {
      method: 'POST',
      body,
    })
    user.value = response.user
  }

  async function logout(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Always clear local state, even if the server call fails.
    }
    user.value = null
    await navigateTo('/login')
  }

  /**
   * Probe the upstream session via the httpOnly cookie. Returns true when
   * the user is authenticated, false otherwise. Network failures resolve to
   * false so the caller can re-route to /login without crashing the page.
   */
  async function fetchUser(): Promise<boolean> {
    try {
      // H9: useRequestFetch() forwards the browser's cookie header on the
      // server, so SSR /auth/me probes (deep links, middleware) resolve the
      // session instead of silently hitting an unauthenticated request.
      // Minimal callable signature + per-branch casts: the raw union of
      // useRequestFetch()'s return type triggers "excessive stack depth" in
      // TS overload resolution.
      type AuthFetchFn = <T = unknown>(url: string, options?: Record<string, unknown>) => Promise<T>
      let requestFetch: AuthFetchFn
      if (import.meta.server) {
        requestFetch = useRequestFetch() as unknown as AuthFetchFn
      } else {
        requestFetch = $fetch as unknown as AuthFetchFn
      }
      const response = await requestFetch<{ user: AuthUser | null }>('/api/auth/me')
      user.value = response.user
      return !!response.user
    } catch {
      user.value = null
      return false
    }
  }

  /**
   * Refresh the access token using the server-stored refresh cookie. The refresh cookie is rotated
   * server-side.
   *
   * US-007 (E/BUG-3): an expired session and an outage are different answers. Only a 401/403 —
   * the API refusing the refresh token — clears `user`; any other rejection (a deploy, a proxy 502,
   * a dropped connection) leaves the session alone, so the user is not logged out mid-session.
   */
  async function refreshSession(): Promise<RefreshOutcome> {
    try {
      await $fetch('/api/auth/refresh', { method: 'POST' })
      return 'ok'
    } catch (error) {
      const status = errorStatus(error)
      if (status === 401 || status === 403) {
        user.value = null
        return 'unauthorized'
      }
      return 'unavailable'
    }
  }

  /**
   * Boolean wrapper kept for callers that only ask "did it work" (useApi's one 401 retry).
   * A failed refresh no longer implies a cleared user; see `refreshSession`.
   */
  async function refresh(): Promise<boolean> {
    return (await refreshSession()) === 'ok'
  }

  return { user, isAuthenticated, login, register, acceptInvite, logout, fetchUser, refresh, refreshSession }
}
