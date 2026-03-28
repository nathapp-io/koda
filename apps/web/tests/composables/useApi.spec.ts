import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useApi.ts')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeFetchMock() {
  return jest.fn((_url: string, _opts?: Record<string, unknown>) =>
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

function fakeUseI18n() {
  return {
    locale: ref('en'),
  }
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

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — useApi baseURL computation based on import.meta.server
// ──────────────────────────────────────────────────────────────────────────────

describe('AC5: useApi baseURL uses import.meta.server for SSR', () => {
  test('source uses import.meta.server instead of process.server', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('import.meta.server')
    // Verify it's not using the old process.server pattern
    expect(source).not.toMatch(/process\.server\s*\?/)
  })

  test('source references apiInternalUrl config', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('apiInternalUrl')
  })

  test('source references public.apiBaseUrl config', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('public.apiBaseUrl')
  })

  test('source code has conditional baseURL assignment using import.meta.server', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toMatch(/import\.meta\.server\s*\?\s*config\.apiInternalUrl\s*:\s*config\.public\.apiBaseUrl/)
  })
})

describe('AC1b: Authorization header injected when token exists', () => {
  // beforeEach hook removed - Bun test runner doesn't support jest.resetModules()
  // Reset globals to a clean state before each test
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>
    g.useRuntimeConfig = undefined
    g.useAuth = undefined
    g.useI18n = undefined
    g.$fetch = undefined
    g.import = undefined
  })

  test('GET request includes Authorization: Bearer header when token is set', async () => {
    const fetchMock = makeFetchMock()
    const { tokenRef: _tokenRef, fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv('test-jwt-token')

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
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
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
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
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
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
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
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
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
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
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.post('/auth/login', { email: 'a@b.com', password: 'secret' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})
