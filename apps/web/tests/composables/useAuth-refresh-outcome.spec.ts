/**
 * US-007 (E/BUG-3) — refreshSession() distinguishes an expired/rejected session from an outage.
 *
 *   AC-1: 'ok' when POST /api/auth/refresh resolves
 *   AC-2: 'unauthorized' + user cleared on a 401 rejection (statusCode)
 *   AC-3: 'unauthorized' + user cleared on a 403 rejection (status)
 *   AC-4: 'unavailable' + user kept on a 502 rejection
 *   AC-5: 'unavailable' + user kept when the error carries no status
 *   AC-6: refresh() answers false and keeps the user on a 500 rejection
 *
 * The composable reads Nuxt's auto-imports at call time, so each test installs fresh
 * globals and then calls useAuth() — no module cache priming is needed.
 */
import { describe, expect, jest, test } from '@jest/globals'
import { computed, ref } from 'vue'

const USER = { id: '1', email: 'a@b.com' }

function makeFakeEnv() {
  const userRef = ref<unknown>({ ...USER })
  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) => Promise.resolve({ refreshed: true }))

  const fakeCookie = (_name: string, _opts?: unknown) => ref<string | null>(null)
  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }
  const fakeRuntimeConfig = () => ({
    public: { apiBaseUrl: 'http://localhost:3000' },
    apiInternalUrl: 'http://localhost:3100',
  })

  return { userRef, fetchMock, fakeCookie, fakeState, fakeRuntimeConfig }
}

function applyNuxtGlobals(env: ReturnType<typeof makeFakeEnv>): void {
  (globalThis as Record<string, unknown>).useCookie = env.fakeCookie
  ;(globalThis as Record<string, unknown>).useState = env.fakeState
  ;(globalThis as Record<string, unknown>).computed = computed
  ;(globalThis as Record<string, unknown>).$fetch = env.fetchMock
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = env.fakeRuntimeConfig
  ;(globalThis as Record<string, unknown>).navigateTo = jest.fn()
}

function loadAuth(): typeof import('../../composables/useAuth') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(require('path').join(__dirname, '../../composables/useAuth.ts')) as typeof import('../../composables/useAuth')
}

const rejection = (fields: Record<string, unknown>): Error => Object.assign(new Error('refresh failed'), fields)

describe('US-007 AC-1: refreshSession() answers ok when the refresh resolves', () => {
  test('AC-1: it POSTs /api/auth/refresh and returns ok', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(env.fetchMock).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }))
    expect(outcome).toBe('ok')
  })

  test('AC-1 (edge): a resolved refresh keeps the signed-in user', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)

    await loadAuth().useAuth().refreshSession()

    expect(env.userRef.value).toMatchObject(USER)
  })
})

describe('US-007 AC-2: a 401 rejection is unauthorized', () => {
  test('AC-2: statusCode 401 answers unauthorized and clears the user', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(rejection({ statusCode: 401 }))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unauthorized')
    expect(env.userRef.value).toBeNull()
  })
})

describe('US-007 AC-3: a 403 rejection is unauthorized', () => {
  test('AC-3: status 403 answers unauthorized and clears the user', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(rejection({ status: 403 }))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unauthorized')
    expect(env.userRef.value).toBeNull()
  })

  test('AC-3 (edge): response.status 403 is read too', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(rejection({ response: { status: 403 } }))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unauthorized')
    expect(env.userRef.value).toBeNull()
  })
})

describe('US-007 AC-4: a 502 rejection is an outage', () => {
  test('AC-4: statusCode 502 answers unavailable and keeps the user', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(rejection({ statusCode: 502 }))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unavailable')
    expect(env.userRef.value).toMatchObject(USER)
  })

  test('AC-4 (edge): statusCode wins over a lower-precedence status', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(rejection({ statusCode: 502, status: 401 }))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unavailable')
    expect(env.userRef.value).toMatchObject(USER)
  })
})

describe('US-007 AC-5: an error with no status is an outage', () => {
  test('AC-5: a plain Error answers unavailable and keeps the user', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(new Error('Network down'))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unavailable')
    expect(env.userRef.value).toMatchObject(USER)
  })

  test('AC-5 (edge): a rejection that is not an Error object keeps the user', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce('boom')
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refreshSession()

    expect(outcome).toBe('unavailable')
    expect(env.userRef.value).toMatchObject(USER)
  })
})

describe('US-007 AC-6: refresh() still answers a boolean', () => {
  test('AC-6: a 500 rejection answers false and keeps the user', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockRejectedValueOnce(rejection({ statusCode: 500 }))
    applyNuxtGlobals(env)

    const outcome = await loadAuth().useAuth().refresh()

    expect(outcome).toBe(false)
    expect(env.userRef.value).toMatchObject(USER)
  })

  test('AC-6 (edge): refresh() answers true on a resolved refresh', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)

    expect(await loadAuth().useAuth().refresh()).toBe(true)
  })

  test('AC-6 (edge): useAuth() exposes both methods', () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)

    const auth = loadAuth().useAuth()

    expect(typeof auth.refresh).toBe('function')
    expect(typeof auth.refreshSession).toBe('function')
  })
})
