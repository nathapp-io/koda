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
  role?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
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
      const response = await $fetch<{ user: AuthUser | null }>('/api/auth/me')
      user.value = response.user
      return !!response.user
    } catch {
      user.value = null
      return false
    }
  }

  /**
   * Refresh the access token using the server-stored refresh cookie. Returns
   * true when the refresh succeeded. The refresh cookie is rotated server-side.
   */
  async function refresh(): Promise<boolean> {
    try {
      await $fetch('/api/auth/refresh', { method: 'POST' })
      return true
    } catch {
      user.value = null
      return false
    }
  }

  return { user, isAuthenticated, login, register, logout, fetchUser, refresh }
}
