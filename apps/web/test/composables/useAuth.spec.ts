import { describe, test, expect, mock } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useAuth.ts')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to build a controllable fake Nuxt cookie/state environment
// ──────────────────────────────────────────────────────────────────────────────

function makeFakeEnv() {
  const tokenRef = ref<string | null>(null)
  const userRef = ref<unknown>(null)
  const fetchMock = mock((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ accessToken: 'mock-jwt', user: { id: 1, email: 'a@b.com' } })
  )

  const fakeCookie = (name: string) => {
    if (name === 'koda_token') return tokenRef
    return ref<string | null>(null)
  }

  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }

  return { tokenRef, userRef, fetchMock, fakeCookie, fakeState }
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
    expect(source).toContain("useCookie('koda_token')")
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
    const { tokenRef, userRef: _userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    // Inject Nuxt globals before importing the composable
    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    // Fresh import to pick up global mocks
    const mod = await import(`${composablePath}?v=${Date.now()}`)
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
    const { tokenRef: _tokenRef, userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
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
    const { tokenRef, userRef: _userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    tokenRef.value = 'existing-jwt'
    _userRef.value = { id: 1, email: 'a@b.com' }

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const auth = mod.useAuth()

    auth.logout()

    expect(tokenRef.value).toBeNull()
  })

  test('logout() sets user ref to null', async () => {
    const { tokenRef: _tokenRef, userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    _tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
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
    const { tokenRef, userRef: _userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    tokenRef.value = null

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(false)
  })

  test('isAuthenticated is true when token has a value', async () => {
    const { tokenRef, userRef: _userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    tokenRef.value = 'some-jwt'

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(true)
  })

  test('isAuthenticated updates reactively after login()', async () => {
    const { tokenRef: _tokenRef, userRef: _userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(false)
    await auth.login({ email: 'test@example.com', password: 'secret' })
    expect(auth.isAuthenticated.value).toBe(true)
  })

  test('isAuthenticated updates reactively after logout()', async () => {
    const { tokenRef, userRef: _userRef, fetchMock, fakeCookie, fakeState } = makeFakeEnv()

    tokenRef.value = 'some-jwt'

    ;(globalThis as Record<string, unknown>).useCookie = fakeCookie
    ;(globalThis as Record<string, unknown>).useState = fakeState
    ;(globalThis as Record<string, unknown>).computed = computed
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const auth = mod.useAuth()

    expect(auth.isAuthenticated.value).toBe(true)
    auth.logout()
    expect(auth.isAuthenticated.value).toBe(false)
  })
})
