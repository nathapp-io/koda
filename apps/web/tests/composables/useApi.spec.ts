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

function makeAuthEnv() {
  // The API client no longer reads a token from JS. Auth state is only used
  // to know whether the user is signed in (for middleware / UI).
  const userRef = ref<unknown>(null)
  const isAuthenticated = computed(() => !!userRef.value)

  const fakeUseAuth = () => ({ user: userRef, isAuthenticated })
  const fakeRuntimeConfig = () => ({
    public: { apiBaseUrl: 'http://localhost:3100' },
    apiInternalUrl: 'http://localhost:3100',
  })

  return { userRef, fakeUseAuth, fakeRuntimeConfig }
}

function fakeUseI18n() {
  return {
    locale: ref('en'),
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — useApi.ts no longer reads tokens from JS state (WEB-02)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1: composables/useApi.ts does not depend on a client-side auth token', () => {
  test('source file does NOT read auth.token from JS state', () => {
    const source = readFileSync(composablePath, 'utf-8')
    // The Authorization header is no longer set from a JS-readable cookie;
    // the httpOnly cookie is forwarded by the browser instead.
    expect(source).not.toMatch(/auth\.token/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1b — Authorization header is NOT injected (cookies carry the auth now)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1b: no Authorization header is set in JS (httpOnly cookie carries auth)', () => {
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>
    g.useRuntimeConfig = undefined
    g.useAuth = undefined
    g.useI18n = undefined
    g.$fetch = undefined
    g.import = undefined
  })

  test('GET request does not include Authorization header (cookie carries auth)', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv()

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

  test('POST request does not include Authorization header (cookie carries auth)', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv()

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.post('/tickets', { title: 'test' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  test('PATCH request does not include Authorization header (cookie carries auth)', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv()

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.patch('/tickets/1', { status: 'VERIFIED' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  test('DELETE request does not include Authorization header (cookie carries auth)', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv()

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.delete('/tickets/1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — useApi baseURL computation based on import.meta.server
// ──────────────────────────────────────────────────────────────────────────────

describe('AC5: useApi baseURL uses import.meta.server for SSR', () => {
  test('source uses import.meta.server instead of process.server', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('import.meta.server')
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

  test('source code conditionally assigns baseURL using import.meta.server', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toMatch(/const\s+baseURL\s*=\s*import\.meta\.server\s*\?\s*[^:]+:\s*config\.public\.apiBaseUrl/)
  })
})
