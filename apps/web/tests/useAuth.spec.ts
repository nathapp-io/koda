/**
 * Unit tests for useAuth composable — WEB-02: httpOnly cookie + server route auth
 *
 * These tests verify that:
 *   AC-1: login() POSTs to /api/auth/login and stores the user in user.value
 *   AC-2: register() POSTs to /api/auth/register and stores the user in user.value
 *   AC-3: logout() POSTs to /api/auth/logout, clears user.value, and navigates to /login
 *   AC-4: logout() clears user state even when the server call fails
 *   AC-5: fetchUser() reads from /api/auth/me and sets user.value when a user is returned
 *   AC-6: fetchUser() returns false and clears user.value when no user is returned
 *   AC-7: refresh() POSTs to /api/auth/refresh and returns true on success
 *   AC-8: refresh() clears user.value when the server rejects the refresh token
 *
 * The token material never enters JS — these tests intentionally do not assert
 * that any "token" cookie or Authorization header is set on the client. The
 * server routes under /server/api/auth/* are responsible for httpOnly cookies.
 */

import { describe, test, expect, jest } from '@jest/globals'
import { ref, computed } from 'vue'

interface CookieCall {
  name: string
  opts: unknown
}

function makeFakeEnv() {
  const userRef = ref<unknown>(null)
  const navigateToMock = jest.fn()
  const cookieCalls: CookieCall[] = []
  const stateCalls: Array<{ key: string }> = []

  const fakeCookie = (name: string, opts?: unknown) => {
    cookieCalls.push({ name, opts })
    return ref<string | null>(null)
  }

  const fakeState = <T>(key: string, init?: () => T): { value: T } => {
    stateCalls.push({ key })
    if (key === 'koda_user') return userRef as { value: T }
    return ref(typeof init === 'function' ? init() : null) as { value: T }
  }

  const fakeRuntimeConfig = () => ({
    public: { apiBaseUrl: 'http://localhost:3000' },
    apiInternalUrl: 'http://localhost:3100',
  })

  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ user: { id: '1', email: 'a@b.com' } })
  )

  return {
    userRef,
    fetchMock,
    fakeCookie,
    fakeState,
    fakeRuntimeConfig,
    navigateToMock,
    cookieCalls,
    stateCalls,
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

function loadAuth() {
  // Use a dynamic import string so each call can be intercepted with a fresh
  // globalThis setup. Modules are cached after the first import, so we
  // intentionally re-evaluate by clearing require.cache when available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const authPath = require('path').join(__dirname, '../composables/useAuth.ts')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(authPath) as typeof import('../composables/useAuth')
}

// ── AC-1: login POSTs to /api/auth/login and stores user ─────────────────────

describe('AC-1: login() proxies to /api/auth/login and stores user.value', () => {
  test('login calls $fetch against /api/auth/login with POST and the credentials body', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = loadAuth()
    await mod.useAuth().login({ email: 'a@b.com', password: 'hunter2' })
    expect(env.fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({ method: 'POST', body: { email: 'a@b.com', password: 'hunter2' } }),
    )
  })

  test('login stores the server-resolved user profile on user.value', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockResolvedValueOnce({ user: { id: '42', email: 'k@koda.dev' } })
    applyNuxtGlobals(env)
    const mod = loadAuth()
    const auth = mod.useAuth()
    await auth.login({ email: 'k@koda.dev', password: 'secret' })
    expect(env.userRef.value).toMatchObject({ id: '42', email: 'k@koda.dev' })
  })
})

// ── AC-2: register POSTs to /api/auth/register and stores user ──────────────

describe('AC-2: register() proxies to /api/auth/register and stores user.value', () => {
  test('register calls $fetch against /api/auth/register with POST and the credentials body', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = loadAuth()
    await mod.useAuth().register({ name: 'New', email: 'n@n.com', password: 'hunter2' })
    expect(env.fetchMock).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({ method: 'POST', body: { name: 'New', email: 'n@n.com', password: 'hunter2' } }),
    )
  })
})

// ── AC-3: logout POSTs to /api/auth/logout, clears state, and navigates ─────

describe('AC-3: logout() proxies to /api/auth/logout, clears user.value, and navigates to /login', () => {
  test('logout calls /api/auth/logout and clears user.value', async () => {
    const env = makeFakeEnv()
    env.userRef.value = { id: '1', email: 'a@b.com' }
    applyNuxtGlobals(env)
    const mod = loadAuth()
    await mod.useAuth().logout()
    expect(env.fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
    expect(env.userRef.value).toBeNull()
    expect(env.navigateToMock).toHaveBeenCalledWith('/login')
  })

  test('logout clears user.value even when the server call rejects', async () => {
    const env = makeFakeEnv()
    env.userRef.value = { id: '1', email: 'a@b.com' }
    env.fetchMock.mockRejectedValueOnce(new Error('Network down'))
    applyNuxtGlobals(env)
    const mod = loadAuth()
    await mod.useAuth().logout()
    expect(env.userRef.value).toBeNull()
    expect(env.navigateToMock).toHaveBeenCalledWith('/login')
  })
})

// ── AC-5: fetchUser reads /api/auth/me ──────────────────────────────────────

describe('AC-5: fetchUser() reads /api/auth/me and sets user.value on success', () => {
  test('fetchUser returns true and sets user.value to the /me user payload', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockResolvedValueOnce({ user: { id: '42', email: 'user@koda.test' } })
    applyNuxtGlobals(env)
    const mod = loadAuth()
    const result = await mod.useAuth().fetchUser()
    expect(env.fetchMock).toHaveBeenCalledWith('/api/auth/me')
    expect(result).toBe(true)
    expect(env.userRef.value).toMatchObject({ id: '42', email: 'user@koda.test' })
  })
})

// ── AC-6: fetchUser clears state when /me returns no user ───────────────────

describe('AC-6: fetchUser() returns false when /api/auth/me returns no user', () => {
  test('fetchUser returns false and leaves user.value as null', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockResolvedValueOnce({ user: null })
    applyNuxtGlobals(env)
    const mod = loadAuth()
    const result = await mod.useAuth().fetchUser()
    expect(result).toBe(false)
    expect(env.userRef.value).toBeNull()
  })

  test('fetchUser returns false when the server call rejects', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(new Error('Server down'))
    applyNuxtGlobals(env)
    const mod = loadAuth()
    const result = await mod.useAuth().fetchUser()
    expect(result).toBe(false)
    expect(env.userRef.value).toBeNull()
  })
})

// ── AC-7: refresh POSTs to /api/auth/refresh ────────────────────────────────

describe('AC-7: refresh() POSTs to /api/auth/refresh and returns true on success', () => {
  test('refresh returns true after the server confirms the rotation', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = loadAuth()
    const result = await mod.useAuth().refresh()
    expect(env.fetchMock).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }))
    expect(result).toBe(true)
  })
})

// ── AC-8: refresh failure clears user.value ─────────────────────────────────

describe('AC-8: refresh() clears user.value when the refresh token is rejected', () => {
  test('refresh returns false and clears user.value on server rejection', async () => {
    const env = makeFakeEnv()
    env.userRef.value = { id: '1', email: 'a@b.com' }
    env.fetchMock.mockRejectedValueOnce(new Error('Refresh expired'))
    applyNuxtGlobals(env)
    const mod = loadAuth()
    const result = await mod.useAuth().refresh()
    expect(result).toBe(false)
    expect(env.userRef.value).toBeNull()
  })
})

// ── WEB-02: token must never be accessible to client-side JS ────────────────

describe('WEB-02: token material is never stored on the client', () => {
  test('useAuth does not create a koda_token cookie on the client', () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = loadAuth()
    mod.useAuth()
    const tokenCookieCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCookieCall).toBeUndefined()
  })

  test('login() never sets a client-side koda_token cookie', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = loadAuth()
    await mod.useAuth().login({ email: 'a@b.com', password: 'hunter2' })
    const tokenCookieCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCookieCall).toBeUndefined()
  })
})
