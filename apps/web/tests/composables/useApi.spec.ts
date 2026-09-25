import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals'
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

// ──────────────────────────────────────────────────────────────────────────────
// H9 — SSR cookie forwarding + caller header merging
// ──────────────────────────────────────────────────────────────────────────────

describe('H9: mergeHeaders merges caller headers over the locale base', () => {
  test('caller headers are added on top of base headers', async () => {
    const mod = await import(`${composablePath}`)
    const merged = mod.mergeHeaders({ 'X-Caller': '1' }, { 'Accept-Language': 'en' })
    expect(merged).toEqual({ 'X-Caller': '1', 'Accept-Language': 'en' })
  })

  test('caller headers win on key conflicts', async () => {
    const mod = await import(`${composablePath}`)
    const merged = mod.mergeHeaders(
      { 'Accept-Language': 'zh' },
      { 'Accept-Language': 'en', lang: 'en' },
    )
    expect(merged).toEqual({ 'Accept-Language': 'zh', lang: 'en' })
  })

  test('missing caller headers falls back to the base', async () => {
    const mod = await import(`${composablePath}`)
    const merged = mod.mergeHeaders(undefined, { 'Accept-Language': 'en' })
    expect(merged).toEqual({ 'Accept-Language': 'en' })
  })
})

describe('H9: useApi merges (not replaces) caller headers at request time', () => {
  const g = globalThis as Record<string, unknown>

  beforeEach(() => {
    g.useRuntimeConfig = () => ({
      public: { apiBaseUrl: '/api' },
      apiInternalUrl: 'http://localhost:3100',
    })
    g.useI18n = () => ({ locale: ref('en') })
  })

  afterEach(() => {
    g.__JEST_IS_SERVER__ = false
  })

  test('client-side request passes caller headers alongside locale headers', async () => {
    const fetchMock = makeFetchMock()
    g.$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.get('/projects', { headers: { 'X-Caller': '1' } })

    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['X-Caller']).toBe('1')
    expect(headers['Accept-Language']).toBe('en')
    expect(headers['lang']).toBe('en')
  })

  test('caller headers override the locale base on conflict', async () => {
    const fetchMock = makeFetchMock()
    g.$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.get('/projects', { headers: { 'Accept-Language': 'zh' } })

    const [, calledOpts] = fetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Accept-Language']).toBe('zh')
  })
})

describe('H9: useApi routes server-side calls through useRequestFetch', () => {
  const g = globalThis as Record<string, unknown>

  beforeEach(() => {
    g.useRuntimeConfig = () => ({
      public: { apiBaseUrl: '/api' },
      apiInternalUrl: 'http://localhost:3100',
    })
    g.useI18n = () => ({ locale: ref('en') })
  })

  afterEach(() => {
    g.__JEST_IS_SERVER__ = false
    g.useRequestFetch = undefined
  })

  test('source conditionally selects useRequestFetch on the server', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toMatch(/if \(import\.meta\.server\)/)
    expect(source).toContain('useRequestFetch()')
    // The fetch instance must feed the request call site
    expect(source).toMatch(/await requestFetch\(/)
  })

  test('server-side request goes through the useRequestFetch instance', async () => {
    const requestFetchMock = makeFetchMock()
    const clientFetchMock = makeFetchMock()
    g.__JEST_IS_SERVER__ = true
    g.useRequestFetch = () => requestFetchMock
    g.$fetch = clientFetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.get('/projects/1')

    expect(requestFetchMock).toHaveBeenCalledTimes(1)
    expect(clientFetchMock).not.toHaveBeenCalled()
    // SSR calls hit the internal upstream URL, not the client /api proxy
    const [calledUrl] = requestFetchMock.mock.calls[0]
    expect(calledUrl).toBe('http://localhost:3100/api/projects/1')
  })

  test('server-side request still merges caller headers', async () => {
    const requestFetchMock = makeFetchMock()
    g.__JEST_IS_SERVER__ = true
    g.useRequestFetch = () => requestFetchMock
    g.$fetch = makeFetchMock()

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.get('/projects/1', { headers: { 'X-Caller': '1' } })

    const [, calledOpts] = requestFetchMock.mock.calls[0]
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['X-Caller']).toBe('1')
    expect(headers['Accept-Language']).toBe('en')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// M22 — one silent refresh + retry on 401 (client only)
// ──────────────────────────────────────────────────────────────────────────────

describe('M22: shouldRetryAfter401 retry decision helper', () => {
  test('retries on 401 for a client-side call that has not been retried', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.shouldRetryAfter401(401, true, false)).toBe(true)
  })

  test('does not retry on other statuses', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.shouldRetryAfter401(403, true, false)).toBe(false)
    expect(mod.shouldRetryAfter401(500, true, false)).toBe(false)
  })

  test('does not retry when the status is unknown', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.shouldRetryAfter401(undefined, true, false)).toBe(false)
  })

  test('does not retry on the server (SSR must not silently refresh)', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.shouldRetryAfter401(401, false, false)).toBe(false)
  })

  test('does not retry when the request was already retried (loop guard)', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.shouldRetryAfter401(401, true, true)).toBe(false)
  })
})

describe('M22: extractErrorStatus helper', () => {
  test('reads err.status first', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.extractErrorStatus({ status: 401 })).toBe(401)
  })

  test('falls back to err.response.status', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.extractErrorStatus({ response: { status: 401 } })).toBe(401)
  })

  test('returns undefined for non-object errors and missing fields', async () => {
    const mod = await import(`${composablePath}`)
    expect(mod.extractErrorStatus('boom')).toBeUndefined()
    expect(mod.extractErrorStatus(null)).toBeUndefined()
    expect(mod.extractErrorStatus({})).toBeUndefined()
    expect(mod.extractErrorStatus({ status: '401' })).toBeUndefined()
  })
})

describe('M22: useApi client wrapper retries once through /api/auth/refresh on 401', () => {
  const g = globalThis as Record<string, unknown>

  beforeEach(() => {
    g.__JEST_IS_SERVER__ = false
    g.useRuntimeConfig = () => ({
      public: { apiBaseUrl: 'http://localhost:3100' },
      apiInternalUrl: 'http://localhost:3100',
    })
    g.useI18n = () => ({ locale: ref('en') })
  })

  afterEach(() => {
    g.__JEST_IS_SERVER__ = false
    g.useAuth = undefined
  })

  function make401FetchMock(successBody: unknown = { ret: 0, data: 'ok' }) {
    return jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
      .mockResolvedValueOnce(successBody)
  }

  test('calls refresh once then retries the original request on 401', async () => {
    const fetchMock = make401FetchMock()
    const refreshMock = jest.fn(() => Promise.resolve(true))
    g.$fetch = fetchMock
    g.useAuth = () => ({ refresh: refreshMock })

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    const result = await $api.get('/projects')

    expect(result).toBe('ok')
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0])
  })

  test('the retried request never leaks the __retried flag onto the wire', async () => {
    const fetchMock = make401FetchMock()
    g.$fetch = fetchMock
    g.useAuth = () => ({ refresh: jest.fn(() => Promise.resolve(true)) })

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.get('/projects')

    const [, retryOpts] = fetchMock.mock.calls[1] as [string, Record<string, unknown>]
    expect('__retried' in retryOpts).toBe(false)
  })

  test('does not retry when refresh fails — the original 401 surfaces', async () => {
    const fetchMock = make401FetchMock()
    g.$fetch = fetchMock
    g.useAuth = () => ({ refresh: jest.fn(() => Promise.resolve(false)) })

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await expect($api.get('/projects')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not retry on non-401 failures', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    g.$fetch = fetchMock
    const refreshMock = jest.fn(() => Promise.resolve(true))
    g.useAuth = () => ({ refresh: refreshMock })

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await expect($api.get('/projects')).rejects.toThrow()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not retry on the server (SSR errors surface immediately)', async () => {
    const requestFetchMock = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
    const refreshMock = jest.fn(() => Promise.resolve(true))
    g.__JEST_IS_SERVER__ = true
    g.useRequestFetch = () => requestFetchMock
    g.$fetch = makeFetchMock()
    g.useAuth = () => ({ refresh: refreshMock })

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await expect($api.get('/projects')).rejects.toThrow()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(requestFetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('M22: retry wiring source assertions', () => {
  test('useApi.ts wires the refresh retry inside request()', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('shouldRetryAfter401')
    expect(source).toMatch(/__retried/)
  })

  test('the refresh call is made through useAuth (shared state, no duplicate refresh logic)', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toMatch(/useAuth\(\)/)
  })
})
