import { describe, test, expect, mock } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const middlewarePath = join(webDir, 'middleware', 'auth.ts')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeRoute(path: string) {
  return { path, fullPath: path, query: {}, hash: '', params: {}, meta: {}, name: path }
}

function makeAuthEnv(token: string | null = null) {
  const tokenRef = ref<string | null>(token)
  const isAuthenticated = computed(() => !!tokenRef.value)
  return { tokenRef, isAuthenticated }
}

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — middleware/auth.ts file exists
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: middleware/auth.ts exists', () => {
  test('file is present at middleware/auth.ts', () => {
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
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Unauthenticated request to any protected route redirects to /login
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: unauthenticated request to protected route redirects to /login', () => {
  test('navigateTo("/login") is returned when token is null and route is /', async () => {
    const { tokenRef, isAuthenticated } = makeAuthEnv(null)
    const navigateToMock = mock((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({ token: tokenRef, isAuthenticated })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: Function) => fn

    const mod = await import(`${middlewarePath}?v=${Date.now()}`)
    const middleware = mod.default

    const to = makeRoute('/')
    const from = makeRoute('/login')
    const result = middleware(to, from)

    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(result).toMatchObject({ redirect: '/login' })
  })

  test('navigateTo("/login") is returned when token is null and route is /projects', async () => {
    const { tokenRef, isAuthenticated } = makeAuthEnv(null)
    const navigateToMock = mock((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({ token: tokenRef, isAuthenticated })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: Function) => fn

    const mod = await import(`${middlewarePath}?v=${Date.now()}`)
    const middleware = mod.default

    const to = makeRoute('/projects')
    const from = makeRoute('/')
    const result = middleware(to, from)

    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(result).toMatchObject({ redirect: '/login' })
  })

  test('no redirect when token is null and route is /login itself', async () => {
    const { tokenRef, isAuthenticated } = makeAuthEnv(null)
    const navigateToMock = mock((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({ token: tokenRef, isAuthenticated })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: Function) => fn

    const mod = await import(`${middlewarePath}?v=${Date.now()}`)
    const middleware = mod.default

    const to = makeRoute('/login')
    const from = makeRoute('/')
    middleware(to, from)

    // navigateTo('/login') should NOT be called (already on /login)
    const loginRedirectCalls = navigateToMock.mock.calls.filter(
      ([path]) => path === '/login'
    )
    expect(loginRedirectCalls).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Authenticated request to /login redirects to /
// ──────────────────────────────────────────────────────────────────────────────

describe('AC4: authenticated request to /login redirects to /', () => {
  test('navigateTo("/") is returned when token is set and route is /login', async () => {
    const { tokenRef, isAuthenticated } = makeAuthEnv('valid-jwt')
    const navigateToMock = mock((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({ token: tokenRef, isAuthenticated })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: Function) => fn

    const mod = await import(`${middlewarePath}?v=${Date.now()}`)
    const middleware = mod.default

    const to = makeRoute('/login')
    const from = makeRoute('/')
    const result = middleware(to, from)

    expect(navigateToMock).toHaveBeenCalledWith('/')
    expect(result).toMatchObject({ redirect: '/' })
  })

  test('no redirect to / when token is set and route is /projects', async () => {
    const { tokenRef, isAuthenticated } = makeAuthEnv('valid-jwt')
    const navigateToMock = mock((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({ token: tokenRef, isAuthenticated })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: Function) => fn

    const mod = await import(`${middlewarePath}?v=${Date.now()}`)
    const middleware = mod.default

    const to = makeRoute('/projects')
    const from = makeRoute('/')
    middleware(to, from)

    // authenticated user accessing /projects — should not redirect anywhere
    expect(navigateToMock).not.toHaveBeenCalled()
  })

  test('navigateTo("/") is returned when token is set and route is /register', async () => {
    const { tokenRef, isAuthenticated } = makeAuthEnv('valid-jwt')
    const navigateToMock = mock((path: string) => ({ redirect: path }))

    ;(globalThis as Record<string, unknown>).useAuth = () => ({ token: tokenRef, isAuthenticated })
    ;(globalThis as Record<string, unknown>).navigateTo = navigateToMock
    ;(globalThis as Record<string, unknown>).defineNuxtRouteMiddleware = (fn: Function) => fn

    const mod = await import(`${middlewarePath}?v=${Date.now()}`)
    const middleware = mod.default

    const to = makeRoute('/register')
    const from = makeRoute('/')
    const result = middleware(to, from)

    // /register is also a guest-only route — authenticated users should be redirected
    expect(navigateToMock).toHaveBeenCalledWith('/')
    expect(result).toMatchObject({ redirect: '/' })
  })
})
