import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import { createI18n, useI18n as useRealI18n } from 'vue-i18n'
import * as apiModule from '../../composables/useApi'
import { loadSfc, webFile } from '../helpers/mount-sfc'

const middlewareFile = webFile('middleware', 'project.global.ts')

type RouteMiddleware = (to: { params: Record<string, unknown> }) => Promise<unknown> | unknown

function makeMiddleware(options: {
  authenticated?: boolean
  get?: jest.Mock<(path: string) => Promise<unknown>>
} = {}) {
  const get = options.get ?? jest.fn<(path: string) => Promise<unknown>>().mockResolvedValue({ id: 'p1' })
  const known = ref<string[]>([])
  const abortNavigation = jest.fn((error: unknown) => error)
  const middleware = loadSfc(middlewareFile, {
    defineNuxtRouteMiddleware: (fn: RouteMiddleware) => fn,
    createError: (error: unknown) => error,
    abortNavigation,
    useAuth: () => ({ isAuthenticated: { value: options.authenticated ?? true } }),
    useState: () => known,
    useApi: () => ({ $api: { get } }),
  }, { '~/composables/useApi': apiModule }) as unknown as RouteMiddleware
  return { middleware, get, abortNavigation, known }
}

describe('project global middleware', () => {
  test('AC-1: aborts navigation exactly once for an unknown project', async () => {
    const { middleware, abortNavigation } = makeMiddleware({
      get: jest.fn<(path: string) => Promise<unknown>>().mockRejectedValue(new apiModule.ApiError(40004, 'gone')),
    })
    await middleware({ params: { project: 'nope' } })
    expect(abortNavigation).toHaveBeenCalledTimes(1)
  })

  test('AC-2: aborts with a fatal 404 error', async () => {
    const { middleware, abortNavigation } = makeMiddleware({
      get: jest.fn<(path: string) => Promise<unknown>>().mockRejectedValue(new apiModule.ApiError(40004, 'gone')),
    })
    await middleware({ params: { project: 'nope' } })
    expect(abortNavigation.mock.calls[0]?.[0]).toMatchObject({ statusCode: 404, fatal: true })
  })

  test('AC-3: fetches a project once when it is not cached', async () => {
    const { middleware, get } = makeMiddleware()
    await middleware({ params: { project: 'web' } })
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('AC-4: fetches using the encoded project API path', async () => {
    const { middleware, get } = makeMiddleware()
    await middleware({ params: { project: 'web' } })
    expect(get).toHaveBeenCalledWith('/projects/web')
  })

  test('AC-5: caches a successfully verified project slug', async () => {
    const { middleware, get } = makeMiddleware()
    await middleware({ params: { project: 'web' } })
    await middleware({ params: { project: 'web' } })
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('AC-6: skips project lookup when unauthenticated', async () => {
    const { middleware, get } = makeMiddleware({ authenticated: false })
    await middleware({ params: { project: 'web' } })
    expect(get).not.toHaveBeenCalled()
  })

  test('AC-7: skips routes without a project parameter', async () => {
    const { middleware, get } = makeMiddleware()
    await middleware({ params: {} })
    expect(get).not.toHaveBeenCalled()
  })

  test('AC-8: does not abort navigation for an unverified project', async () => {
    const { middleware, abortNavigation } = makeMiddleware({
      get: jest.fn<(path: string) => Promise<unknown>>().mockRejectedValue(new apiModule.ApiError(50000, 'down')),
    })
    await middleware({ params: { project: 'web' } })
    expect(abortNavigation).not.toHaveBeenCalled()
  })

  test('AC-9: retries an unverified project on the next navigation', async () => {
    const get = jest.fn<(path: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new apiModule.ApiError(50000, 'down'))
      .mockResolvedValueOnce({ id: 'p1' })
    const { middleware } = makeMiddleware({ get })
    await middleware({ params: { project: 'web' } })
    await middleware({ params: { project: 'web' } })
    expect(get).toHaveBeenCalledTimes(2)
  })
})

/**
 * B1: a route middleware runs outside a component setup, and that is where Vue I18n's `useI18n()`
 * throws (`Must be called at the top of a setup function`). These tests drive the real middleware
 * with the real `useApi` and a real Vue I18n install, so the locale lookup cannot hide behind a stub.
 */
describe('project global middleware with the real API client (B1)', () => {
  const g = globalThis as Record<string, unknown>

  afterEach(() => {
    delete g.useRuntimeConfig
    delete g.$fetch
    delete g.useNuxtApp
    delete g.useI18n
    delete g.__JEST_IS_SERVER__
  })

  function makeRealClientMiddleware() {
    const i18n = createI18n({
      legacy: false,
      locale: 'zh',
      messages: { en: { greeting: 'hello' }, zh: { greeting: '你好' } },
      missingWarn: false,
      fallbackWarn: false,
    })
    const fetchMock = jest.fn<(url: string, options?: Record<string, unknown>) => Promise<unknown>>()
    g.useRuntimeConfig = () => ({ public: { apiBaseUrl: '/api' }, apiInternalUrl: 'http://localhost:3100' })
    g.$fetch = fetchMock
    // The real vue-i18n composable, the one that refuses to run outside a setup function.
    g.useI18n = useRealI18n
    // What the Nuxt app context offers a route middleware, which Nuxt runs in `runWithContext`.
    g.useNuxtApp = () => ({ $i18n: i18n.global })
    const known = ref<string[]>([])
    const abortNavigation = jest.fn((error: unknown) => error)
    const middleware = loadSfc(middlewareFile, {
      defineNuxtRouteMiddleware: (fn: RouteMiddleware) => fn,
      createError: (error: unknown) => error,
      abortNavigation,
      useAuth: () => ({ isAuthenticated: { value: true } }),
      useState: () => known,
      // The real composable, not a stub: this is what the finding reproduced.
      useApi: apiModule.useApi,
    }, { '~/composables/useApi': apiModule }) as unknown as RouteMiddleware
    return { middleware, fetchMock, abortNavigation }
  }

  test('B1 premise: the real useI18n refuses to run outside a component setup', () => {
    let thrown: unknown
    try {
      useRealI18n()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(SyntaxError)
    // vue-i18n error 26 is MUST_BE_CALL_SETUP_TOP: "Must be called at the top of a setup function".
    expect((thrown as { code?: number }).code).toBe(26)
  })

  test('B1: an unknown project still aborts, and the request carries the app locale', async () => {
    const { middleware, fetchMock, abortNavigation } = makeRealClientMiddleware()
    fetchMock.mockRejectedValue({ status: 404, data: { ret: 40004, message: 'gone' } })

    await middleware({ params: { project: 'nope' } })

    expect(abortNavigation).toHaveBeenCalledTimes(1)
    expect(abortNavigation.mock.calls[0]?.[0]).toMatchObject({ statusCode: 404, fatal: true })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/nope')
    expect((options?.headers as Record<string, string>)['Accept-Language']).toBe('zh')
  })

  test('B1: a known project is fetched once through the real client', async () => {
    const { middleware, fetchMock, abortNavigation } = makeRealClientMiddleware()
    fetchMock.mockResolvedValue({ ret: 0, data: { id: 'p1', slug: 'web' } })

    await middleware({ params: { project: 'web' } })
    await middleware({ params: { project: 'web' } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(abortNavigation).not.toHaveBeenCalled()
  })

  test('B1: a route without a project builds no API client', async () => {
    const { middleware, fetchMock } = makeRealClientMiddleware()

    await expect(middleware({ params: {} })).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('B1: the first navigation, before the i18n plugin, still classifies the route', async () => {
    // Nuxt runs the first navigation inside the pages router plugin (`enforce: 'pre'`), before the
    // i18n plugin installs `$i18n`, so there is no locale to name. The browser's own
    // Accept-Language has to survive that: request fetch forwards it on the server.
    const { middleware, fetchMock, abortNavigation } = makeRealClientMiddleware()
    g.useNuxtApp = () => ({})
    fetchMock.mockRejectedValue({ status: 404, data: { ret: 40004, message: 'gone' } })

    await middleware({ params: { project: 'nope' } })

    expect(abortNavigation).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0]
    expect((options?.headers ?? {}) as Record<string, string>).toEqual({})
  })
})
