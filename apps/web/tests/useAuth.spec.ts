/**
 * Unit tests for useAuth composable — US-001: Harden koda_token cookie security attributes
 *
 * These tests verify that:
 *   AC-1: useCookie is called with { secure: true }
 *   AC-2: useCookie is called with { sameSite: 'strict' }
 *   AC-3: useCookie is called with { maxAge: 604800 }
 *   AC-4: login() stores accessToken in token.value
 *   AC-5: logout() sets token.value to null
 *   AC-6: fetchUser() with non-null token sets user.value and returns true
 *   AC-7: fetchUser() with null token returns false without any network request
 */

import { describe, test, expect, beforeEach } from '@jest/globals'
import { join } from 'path'
import { ref, computed } from 'vue'

const authPath = join(__dirname, '../composables/useAuth.ts')

interface CookieCall {
  name: string
  opts: unknown
}

function makeFakeEnv() {
  const tokenRef = ref<string | null>(null)
  const userRef = ref<unknown>(null)
  const navigateToMock = jest.fn()
  const cookieCalls: CookieCall[] = []

  const fakeCookie = (name: string, opts?: unknown) => {
    cookieCalls.push({ name, opts })
    if (name === 'koda_token') return tokenRef
    return ref<string | null>(null)
  }

  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }

  const fakeRuntimeConfig = () => ({
    public: { apiBaseUrl: 'http://localhost:3000' },
  })

  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ accessToken: 'mock-jwt', user: { id: '1', email: 'a@b.com' } })
  )

  return {
    tokenRef,
    userRef,
    fetchMock,
    fakeCookie,
    fakeState,
    fakeRuntimeConfig,
    navigateToMock,
    cookieCalls,
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

beforeEach(() => {
  jest.resetModules()
})

// ── AC-1: useCookie called with secure: true ──────────────────────────────────

describe('AC-1: useCookie called with secure: true for koda_token', () => {
  test('useCookie receives { secure: true } as second argument when initializing the token cookie', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    mod.useAuth()
    const tokenCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.opts).toEqual(expect.objectContaining({ secure: true }))
  })
})

// ── AC-2: useCookie called with sameSite: 'strict' ───────────────────────────

describe("AC-2: useCookie called with sameSite: 'strict' for koda_token", () => {
  test("useCookie receives { sameSite: 'strict' } as second argument when initializing the token cookie", async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    mod.useAuth()
    const tokenCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.opts).toEqual(expect.objectContaining({ sameSite: 'strict' }))
  })
})

// ── AC-3: useCookie called with maxAge: 604800 ───────────────────────────────

describe('AC-3: useCookie called with maxAge: 604800 for koda_token', () => {
  test('useCookie receives { maxAge: 604800 } as second argument when initializing the token cookie', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    mod.useAuth()
    const tokenCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.opts).toEqual(expect.objectContaining({ maxAge: 604800 }))
  })
})

// ── AC-4: login() stores the accessToken ─────────────────────────────────────

describe('AC-4: login() stores the accessToken from the API response', () => {
  test('token.value equals the accessToken string returned by the API after login() resolves', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockResolvedValueOnce({
      accessToken: 'jwt-abc-123',
      user: { id: '1', email: 'a@b.com' },
    })
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    await auth.login({ email: 'test@example.com', password: 'secret' })
    expect(env.tokenRef.value).toBe('jwt-abc-123')
  })
})

// ── AC-5: logout() sets token.value to null ──────────────────────────────────

describe('AC-5: logout() sets token.value to null', () => {
  test('token.value is null after logout() is called', async () => {
    const env = makeFakeEnv()
    env.tokenRef.value = 'existing-token'
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    auth.logout()
    expect(env.tokenRef.value).toBeNull()
  })
})

// ── AC-6: fetchUser() with non-null token sets user.value and returns true ────

describe('AC-6: fetchUser() with non-null token sets user.value and returns true on success', () => {
  test('fetchUser returns true and sets user.value to the AuthUser from the API response', async () => {
    const env = makeFakeEnv()
    env.tokenRef.value = 'valid-jwt'
    env.fetchMock.mockResolvedValueOnce({
      ret: 0,
      data: { id: '42', email: 'user@koda.test', name: 'Koda User' },
    })
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    const result = await auth.fetchUser()
    expect(result).toBe(true)
    expect(env.userRef.value).toMatchObject({ id: '42', email: 'user@koda.test' })
  })
})

// ── AC-7: fetchUser() with null token returns false without fetch ─────────────

describe('AC-7: fetchUser() returns false without making any network request when token is null', () => {
  test('fetchUser returns false and does not call $fetch when token.value is null', async () => {
    const env = makeFakeEnv()
    // tokenRef.value is null by default in makeFakeEnv
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    const result = await auth.fetchUser()
    expect(result).toBe(false)
    expect(env.fetchMock).not.toHaveBeenCalled()
  })
})
