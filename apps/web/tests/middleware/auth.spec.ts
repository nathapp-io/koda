import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const middlewarePath = join(webDir, 'middleware', 'auth.global.ts')

// beforeEach hook removed - Bun test runner doesn't support jest.resetModules()

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeRoute(path: string) {
  return { path, fullPath: path, query: {}, hash: '', params: {}, meta: {}, name: path }
}

function makeAuthEnv(token: string | null = null, user: object | null = null) {
  const tokenRef = ref<string | null>(token)
  const userRef = ref<object | null>(user)
  const isAuthenticated = computed(() => !!tokenRef.value)
  return { tokenRef, userRef, isAuthenticated }
}

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — middleware/auth.global.ts file exists
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: middleware/auth.global.ts exists', () => {
  test('file is present at middleware/auth.global.ts', () => {
    expect(existsSync(middlewarePath)).toBe(true)
  })

  test('file exports a default function (route middleware)', () => {
    const source = readFileSync(middlewarePath, 'utf-8')
    expect(source).toContain('export default')
  })

  test('file uses defineNuxtRouteMiddleware', () => {
    const source = readFileSync(middlewarePath, 'utf-8')
    expect(source).toContain('defineNuxtRouteMiddleware')
  })

  test('file calls useAuth', () => {
    const source = readFileSync(middlewarePath, 'utf-8')
    expect(source).toContain('useAuth')
  })

  test('file calls navigateTo', () => {
    const source = readFileSync(middlewarePath, 'utf-8')
    expect(source).toContain('navigateTo')
  })

  test('file calls fetchUser for token validation', () => {
    const source = readFileSync(middlewarePath, 'utf-8')
    expect(source).toContain('fetchUser')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Unauthenticated request to any protected route redirects to /login
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: unauthenticated request to protected route redirects to /login', () => {
  test('navigateTo("/login") is returned when token is null and route is /', async () => {
    const { tokenRef, userRef, isAuthenticated } = makeAuthEnv(null)
    const fetchUserMock = jest.fn(async () => false)
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/')
    const from = makeRoute('/login')
    const result = await middleware(to, from)

    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(result).toMatchObject({ redirect: '/login' })
  })

  test('navigateTo("/login") is returned when token is null and route is /projects', async () => {
    const { tokenRef, userRef, isAuthenticated } = makeAuthEnv(null)
    const fetchUserMock = jest.fn(async () => false)
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/projects')
    const from = makeRoute('/')
    const result = await middleware(to, from)

    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(result).toMatchObject({ redirect: '/login' })
  })

  test('no redirect when token is null and route is /login itself', async () => {
    const { tokenRef, userRef, isAuthenticated } = makeAuthEnv(null)
    const fetchUserMock = jest.fn(async () => false)
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/login')
    const from = makeRoute('/')
    await middleware(to, from)

    // navigateTo('/login') should NOT be called (already on /login)
    const loginRedirectCalls = navigateToMock.mock.calls.filter(
      ([path]: [string]) => path === '/login'
    )
    expect(loginRedirectCalls).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Authenticated request to /login redirects to /
// ──────────────────────────────────────────────────────────────────────────────

describe('AC4: authenticated request to /login redirects to /', () => {
  test('navigateTo("/") is returned when token is set and route is /login', async () => {
    const { tokenRef, userRef, isAuthenticated } = makeAuthEnv('valid-jwt', { id: '1', email: 'test@test.com' })
    const fetchUserMock = jest.fn(async () => true)
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/login')
    const from = makeRoute('/')
    const result = await middleware(to, from)

    expect(navigateToMock).toHaveBeenCalledWith('/')
    expect(result).toMatchObject({ redirect: '/' })
  })

  test('no redirect to / when token is set and route is /projects', async () => {
    const { tokenRef, userRef, isAuthenticated } = makeAuthEnv('valid-jwt', { id: '1', email: 'test@test.com' })
    const fetchUserMock = jest.fn(async () => true)
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/projects')
    const from = makeRoute('/')
    await middleware(to, from)

    // authenticated user accessing /projects — should not redirect anywhere
    expect(navigateToMock).not.toHaveBeenCalled()
  })

  test('navigateTo("/") is returned when token is set and route is /register', async () => {
    const { tokenRef, userRef, isAuthenticated } = makeAuthEnv('valid-jwt', { id: '1', email: 'test@test.com' })
    const fetchUserMock = jest.fn(async () => true)
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/register')
    const from = makeRoute('/')
    const result = await middleware(to, from)

    // /register is also a guest-only route — authenticated users should be redirected
    expect(navigateToMock).toHaveBeenCalledWith('/')
    expect(result).toMatchObject({ redirect: '/' })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Stale token is cleared and redirects to /login
// ──────────────────────────────────────────────────────────────────────────────

describe('AC5: stale token triggers fetchUser and redirects on failure', () => {
  test('redirects to /login when token exists but fetchUser fails (expired token)', async () => {
    const tokenRef = ref<string | null>('expired-jwt')
    const userRef = ref<object | null>(null)  // user not yet loaded
    const isAuthenticated = computed(() => !!tokenRef.value)

    const fetchUserMock = jest.fn(async () => {
      // Simulate fetchUser clearing the token on 401
      tokenRef.value = null
      return false
    })
    const navigateToMock = jest.fn((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({
      token: tokenRef, user: userRef, isAuthenticated, fetchUser: fetchUserMock,
    })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: (to: unknown, from: unknown) => unknown) => fn

    const mod = await import(`${middlewarePath}`)
    const middleware = mod.default

    const to = makeRoute('/projects')
    const from = makeRoute('/')
    const result = await middleware(to, from)

    expect(fetchUserMock).toHaveBeenCalled()
    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(result).toMatchObject({ redirect: '/login' })
  })
})
