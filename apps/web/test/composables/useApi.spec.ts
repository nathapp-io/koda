import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useApi.ts')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeFetchMock() {
  return mock((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ data: 'ok' })
  )
}

function makeAuthEnv(token: string | null = null) {
  const tokenRef = ref<string | null>(token)
  const isAuthenticated = computed(() => !!tokenRef.value)

  const fakeUseAuth = () => ({ token: tokenRef, isAuthenticated })
  const fakeRuntimeConfig = () => ({
    public: { apiBaseUrl: 'http://localhost:3100' },
  })

  return { tokenRef, fakeUseAuth, fakeRuntimeConfig }
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — useApi.ts imports useAuth
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1: composables/useApi.ts imports useAuth', () => {
  test('source file references useAuth', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('useAuth')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1b — Authorization header injected when token exists
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1b: Authorization header injected when token exists', () => {
  beforeEach(() => {
    // Reset globals to a clean state before each test
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = undefined
    ;(globalThis as Record<string, unknown>).useAuth = undefined
    ;(globalThis as Record<string, unknown>).$fetch = undefined
  })

  test('GET request includes Authorization: Bearer header when token is set', async () => {
    const fetchMock = makeFetchMock()
    const { tokenRef, fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv('test-jwt-token')

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const { $api } = mod.useApi()

    await $api.get('/projects')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    expect(calledOpts?.headers).toBeDefined()
    const headers = calledOpts?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-jwt-token')
  })

  test('POST request includes Authorization: Bearer header when token is set', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv('test-jwt-token')

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const { $api } = mod.useApi()

    await $api.post('/tickets', { title: 'test' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = calledOpts?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-jwt-token')
  })

  test('PATCH request includes Authorization: Bearer header when token is set', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv('test-jwt-token')

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const { $api } = mod.useApi()

    await $api.patch('/tickets/1', { status: 'VERIFIED' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = calledOpts?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-jwt-token')
  })

  test('DELETE request includes Authorization: Bearer header when token is set', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv('test-jwt-token')

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const { $api } = mod.useApi()

    await $api.delete('/tickets/1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = calledOpts?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-jwt-token')
  })

  test('GET request has no Authorization header when token is null', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv(null)

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const { $api } = mod.useApi()

    await $api.get('/projects')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  test('POST request has no Authorization header when token is null', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv(null)

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}?v=${Date.now()}`)
    const { $api } = mod.useApi()

    await $api.post('/auth/login', { email: 'a@b.com', password: 'secret' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})
