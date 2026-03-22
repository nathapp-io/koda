interface LoginCredentials {
  email: string
  password: string
}

interface AuthUser {
  id: number
  email: string
}

interface LoginResponse {
  accessToken: string
  user: AuthUser
}

export function useAuth() {
  const token = useCookie('koda_token')
  const user = useState('koda_user', (): AuthUser | null => null)

  const isAuthenticated = computed(() => !!token.value)

  async function login(credentials: LoginCredentials): Promise<void> {
    const response = await $fetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
    })
    token.value = response.accessToken
    user.value = response.user
  }

  function logout(): void {
    token.value = null
    user.value = null
  }

  return { token, user, isAuthenticated, login, logout }
}
