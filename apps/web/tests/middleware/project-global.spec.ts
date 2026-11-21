import { describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
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
