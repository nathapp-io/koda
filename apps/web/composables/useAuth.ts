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
  const baseURL = config.public.apiBaseUrl

  const token = useCookie('koda_token')
  const user = useState('koda_user', (): AuthUser | null => null)

  const isAuthenticated = computed(() => !!token.value)

  async function login(credentials: LoginCredentials): Promise<void> {
    const response = await $fetch<{ ret: number; data: AuthResponse }>(`${baseURL}/auth/login`, {
      method: 'POST',
      body: credentials,
    })
    const data = response.data ?? (response as unknown as AuthResponse)
    token.value = data.accessToken
    user.value = data.user
  }

  async function register(credentials: RegisterCredentials): Promise<void> {
    const response = await $fetch<{ ret: number; data: AuthResponse }>(`${baseURL}/auth/register`, {
      method: 'POST',
      body: credentials,
    })
    const data = response.data ?? (response as unknown as AuthResponse)
    token.value = data.accessToken
    user.value = data.user
  }

  function logout(): void {
    token.value = null
    user.value = null
    navigateTo('/login')
  }

  return { token, user, isAuthenticated, login, register, logout }
}
