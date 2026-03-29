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
}

interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

/**
 * Note: useAuth uses $fetch directly (not useApi) to avoid circular dependency
 * since useApi depends on useAuth for the Authorization header.
 * Responses are unwrapped from the JsonResponse { ret, data } envelope here.
 */
export function useAuth() {
  const config = useRuntimeConfig()
  // Server-side: ensure internal URL includes /api (E2E env provides host:port only)
  const internalBaseUrl = String(config.apiInternalUrl).replace(/\/+$/, '')
  const serverBaseUrl = internalBaseUrl.endsWith('/api')
    ? internalBaseUrl
    : `${internalBaseUrl}/api`
  const baseURL = import.meta.server ? serverBaseUrl : config.public.apiBaseUrl
  const normalizedBaseURL = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
  const authBaseURL = import.meta.server
    ? (normalizedBaseURL.endsWith('/api') ? normalizedBaseURL : `${normalizedBaseURL}/api`)
    : normalizedBaseURL
  const authUrl = (path: string) => `${authBaseURL}${path}`

  const token = useCookie('koda_token', { secure: true, sameSite: 'strict', maxAge: 604800 })
  const user = useState('koda_user', (): AuthUser | null => null)

  const isAuthenticated = computed(() => !!token.value)

  async function login(credentials: LoginCredentials): Promise<void> {
    const response = await $fetch<{ ret: number; data: AuthResponse }>(authUrl('/auth/login'), {
      method: 'POST',
      body: credentials,
    })
    const data = response.data ?? (response as unknown as AuthResponse)
    token.value = data.accessToken
    user.value = data.user
  }

  async function register(credentials: RegisterCredentials): Promise<void> {
    const response = await $fetch<{ ret: number; data: AuthResponse }>(authUrl('/auth/register'), {
      method: 'POST',
      body: credentials,
    })
    const data = response.data ?? (response as unknown as AuthResponse)
    token.value = data.accessToken
    user.value = data.user
  }

  async function logout(): Promise<void> {
    token.value = null
    user.value = null
    await navigateTo('/login')
  }

  /**
   * Validate the stored token by calling /auth/me.
   * If the token is expired or invalid, clear it and return false.
   * Called by the auth middleware on initial navigation when a cookie exists but user state is empty.
   */
  async function fetchUser(): Promise<boolean> {
    if (!token.value) return false
    try {
      const response = await $fetch<{ ret: number; data: AuthUser }>(authUrl('/auth/me'), {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      const data = response.data ?? (response as unknown as AuthUser)
      user.value = data
      return true
    } catch {
      // Token expired or invalid — clear auth state
      token.value = null
      user.value = null
      return false
    }
  }

  return { token, user, isAuthenticated, login, register, logout, fetchUser }
}
