import { describe, test, expect, jest } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useAuth.ts')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to build a controllable fake Nuxt cookie/state environment
// ──────────────────────────────────────────────────────────────────────────────

function makeFakeEnv() {
  const userRef = ref<unknown>(null)
  const navigateToMock = jest.fn()
  const fakeRuntimeConfig = () => ({
    public: {
      apiBaseUrl: 'http://localhost:3000',
    },
    apiInternalUrl: 'http://localhost:3100',
  })
  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ user: { id: '1', email: 'a@b.com' } })
  )

  const fakeCookie = (_name: string, _opts?: unknown) => ref<string | null>(null)

  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }

  return {
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
// AC2 — User state managed via useState
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: user state managed via useState', () => {
  test('source calls useState for the current user', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('useState')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — login() proxies to /api/auth/login (server route handles httpOnly cookies)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: login() proxies to /api/auth/login and stores user', () => {
  test('source references /api/auth/login endpoint', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('/api/auth/login')
  })

  test('source specifies POST method for the login call', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toMatch(/POST/)
  })

  test('login() POSTs credentials to /api/auth/login', async () => {
    const env = makeFakeEnv()
    const { fetchMock } = env

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const { useAuth } = mod

    const auth = useAuth()
    await auth.login({ email: 'test@example.com', password: 'secret' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('/api/auth/login')
    expect(calledOpts).toMatchObject({ method: 'POST', body: { email: 'test@example.com', password: 'secret' } })
  })

  test('login() sets user state from the response', async () => {
    const env = makeFakeEnv()
    const { userRef } = env

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.login({ email: 'test@example.com', password: 'secret' })

    expect(userRef.value).toMatchObject({ id: '1', email: 'a@b.com' })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — logout() clears user state and proxies to /api/auth/logout
// ──────────────────────────────────────────────────────────────────────────────

describe('AC4: logout() proxies to /api/auth/logout and clears user state', () => {
  test('source defines a logout function', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('logout')
  })

  test('logout() sets user ref to null and calls /api/auth/logout', async () => {
    const env = makeFakeEnv()
    const { userRef, fetchMock } = env

    userRef.value = { id: '1', email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.logout()

    expect(userRef.value).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — isAuthenticated is a computed ref derived from user existence
// ──────────────────────────────────────────────────────────────────────────────

describe('AC5: isAuthenticated is a computed ref', () => {
  test('source calls computed() for isAuthenticated', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('isAuthenticated')
    expect(source).toContain('computed')
  })

  test('isAuthenticated is false when user is null', async () => {
    const env = makeFakeEnv()

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(false)
  })

  test('isAuthenticated is true when user has a value', async () => {
    const env = makeFakeEnv()
    const { userRef } = env

    userRef.value = { id: '1', email: 'a@b.com' }

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
    const { userRef } = env

    userRef.value = { id: '1', email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(true)
    await auth.logout()
    expect(auth.isAuthenticated.value).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — fetchUser reads /api/auth/me (httpOnly cookie is sent by the browser)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC6: fetchUser reads /api/auth/me and clears state on failure', () => {
  test('source defines a fetchUser function', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('fetchUser')
    expect(source).toContain('/api/auth/me')
  })

  test('fetchUser returns true and sets user on success', async () => {
    const env = makeFakeEnv()
    const { userRef } = env

    env.fetchMock.mockResolvedValueOnce({
      user: { id: '1', email: 'admin@koda.test', name: 'Admin' },
    })

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = await auth.fetchUser()

    expect(result).toBe(true)
    expect(userRef.value).toMatchObject({ id: '1', email: 'admin@koda.test' })
  })

  test('fetchUser returns false and clears user on failure', async () => {
    const env = makeFakeEnv()
    const { userRef } = env

    userRef.value = { id: '1', email: 'old@koda.test' }
    env.fetchMock.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = await auth.fetchUser()

    expect(result).toBe(false)
    expect(userRef.value).toBeNull()
  })

  test('fetchUser returns false when /me reports no user', async () => {
    const env = makeFakeEnv()

    env.fetchMock.mockResolvedValueOnce({ user: null })

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = await auth.fetchUser()

    expect(result).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// WEB-02 — Token never enters client-side JS
// ──────────────────────────────────────────────────────────────────────────────

describe('WEB-02: token material is never accessible to client JS', () => {
  test('useAuth does not declare a koda_token cookie ref', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).not.toMatch(/useCookie\(\s*['"]koda_token['"]/)
  })

  test('login() never stores an accessToken in JS state', () => {
    const source = readFileSync(composablePath, 'utf-8')
    // The composable should only consume `user` from the server response, not
    // the raw accessToken. Anything that assigns accessToken to client state
    // would defeat the httpOnly cookie storage.
    expect(source).not.toMatch(/accessToken\s*=/)
  })
})
