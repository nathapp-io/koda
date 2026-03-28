import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useAuth.ts')

// beforeEach hook removed - Bun test runner doesn't support jest.resetModules()

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to build a controllable fake Nuxt cookie/state environment
// ──────────────────────────────────────────────────────────────────────────────

function makeFakeEnv() {
  const tokenRef = ref<string | null>(null)
  const userRef = ref<unknown>(null)
  const navigateToMock = jest.fn()
  const fakeRuntimeConfig = () => ({
    public: {
      apiBaseUrl: 'http://localhost:3000',
    },
  })
  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ accessToken: 'mock-jwt', user: { id: 1, email: 'a@b.com' } })
  )

  const fakeCookie = (name: string, _opts?: unknown) => {
    if (name === 'koda_token') return tokenRef
    return ref<string | null>(null)
  }

  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }

  return {
    tokenRef,
    userRef,
    fetchMock,
    fakeCookie,
    fakeState,
    fakeRuntimeConfig,
    navigateToMock,
  }
}

function applyNuxtGlobals(env: ReturnType<typeof makeFakeEnv>) {
  (globalThis as Record<string, unknown>).useCookie = env.fakeCookie
  ;(globalThis as Record<string, unknown>).useState = env.fakeState
  ;(globalThis as Record<string, unknown>).computed = computed
  ;(globalThis as Record<string, unknown>).$fetch = env.fetchMock
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = env.fakeRuntimeConfig
  ;(globalThis as Record<string, unknown>).navigateTo = env.navigateToMock
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1: composables/useAuth.ts exists', () => {
  test('file is present at composables/useAuth.ts', () => {
    expect(existsSync(composablePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Token stored exclusively via useCookie('koda_token')
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: token stored via useCookie("koda_token")', () => {
  test('source calls useCookie with "koda_token"', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain("useCookie('koda_token'")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — User stored via useState
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: user state managed via useState', () => {
  test('source calls useState for the current user', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('useState')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — login() calls POST /auth/login and stores accessToken
// ──────────────────────────────────────────────────────────────────────────────

describe('AC4: login() calls POST /auth/login and stores accessToken', () => {
  test('source references /auth/login endpoint', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('/auth/login')
  })

  test('source specifies POST method for the login call', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toMatch(/POST/)
  })

  test('source references accessToken from the response', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('accessToken')
  })

  test('login() stores the returned accessToken into the cookie ref', async () => {
    const env = makeFakeEnv()
    const { tokenRef, fetchMock } = env

    // Inject Nuxt globals before importing the composable
    applyNuxtGlobals(env)

    // Fresh import to pick up global mocks
    const mod = await import(`${composablePath}`)
    const { useAuth } = mod

    const auth = useAuth()
    expect(tokenRef.value).toBeNull()

    await auth.login({ email: 'test@example.com', password: 'secret' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0]
    expect(calledUrl).toContain('/auth/login')
    expect(calledOpts).toMatchObject({ method: 'POST' })
    expect(tokenRef.value).toBe('mock-jwt')
  })

  test('login() sets user state from the response', async () => {
    const env = makeFakeEnv()
    const { userRef } = env

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.login({ email: 'test@example.com', password: 'secret' })

    expect(userRef.value).toMatchObject({ id: 1, email: 'a@b.com' })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — logout() clears token cookie and user state
// ──────────────────────────────────────────────────────────────────────────────

describe('AC5: logout() clears token and user state', () => {
  test('source defines a logout function', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('logout')
  })

  test('logout() sets token ref to null', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    auth.logout()

    expect(tokenRef.value).toBeNull()
  })

  test('logout() sets user ref to null', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    auth.logout()

    expect(userRef.value).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — isAuthenticated is a computed ref derived from token existence
// ──────────────────────────────────────────────────────────────────────────────

describe('AC6: isAuthenticated is a computed ref', () => {
  test('source calls computed() for isAuthenticated', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('isAuthenticated')
    expect(source).toContain('computed')
  })

  test('isAuthenticated is false when token is null', async () => {
    const env = makeFakeEnv()
    const { tokenRef } = env

    tokenRef.value = null

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(false)
  })

  test('isAuthenticated is true when token has a value', async () => {
    const env = makeFakeEnv()
    const { tokenRef } = env

    tokenRef.value = 'some-jwt'

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(true)
  })

  test('isAuthenticated updates reactively after login()', async () => {
    const env = makeFakeEnv()

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(false)
    await auth.login({ email: 'test@example.com', password: 'secret' })
    expect(auth.isAuthenticated.value).toBe(true)
  })

  test('isAuthenticated updates reactively after logout()', async () => {
    const env = makeFakeEnv()
    const { tokenRef } = env

    tokenRef.value = 'some-jwt'

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(true)
    auth.logout()
    expect(auth.isAuthenticated.value).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — fetchUser() validates token and clears on failure
// ──────────────────────────────────────────────────────────────────────────────

describe('AC7: fetchUser validates token', () => {
  test('source defines a fetchUser function', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('fetchUser')
    expect(source).toContain('/auth/me')
  })

  test('fetchUser returns true and sets user on success', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'valid-jwt'
    env.fetchMock.mockResolvedValueOnce({
      ret: 0,
      data: { id: '1', email: 'admin@koda.test', name: 'Admin' },
    })

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = await auth.fetchUser()

    expect(result).toBe(true)
    expect(userRef.value).toMatchObject({ id: '1', email: 'admin@koda.test' })
  })

  test('fetchUser returns false and clears token on failure', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'expired-jwt'
    env.fetchMock.mockRejectedValueOnce(new Error('Unauthorized'))

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = await auth.fetchUser()

    expect(result).toBe(false)
    expect(tokenRef.value).toBeNull()
    expect(userRef.value).toBeNull()
  })

  test('fetchUser returns false when no token exists', async () => {
    const env = makeFakeEnv()

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = await auth.fetchUser()

    expect(result).toBe(false)
    expect(env.fetchMock).not.toHaveBeenCalled()
  })
})
