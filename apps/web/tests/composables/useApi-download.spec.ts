import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'
import { ref } from 'vue'

const composablePath = join(__dirname, '../..', 'composables', 'useApi.ts')
const g = globalThis as Record<string, unknown>

const jsonBlob = (body: unknown): Blob => new Blob([JSON.stringify(body)], { type: 'application/json' })
const fetchError = (status: number, data: unknown): Error => Object.assign(new Error(`HTTP ${status}`), { status, data })

describe('blobErrorToApiError', () => {
  test('turns a JSON error Blob into an ApiError with ret and message', async () => {
    const mod = await import(composablePath)
    const out = await mod.blobErrorToApiError(fetchError(404, jsonBlob({ ret: 404, message: 'No bundle yet' })))
    expect(out).toBeInstanceOf(mod.ApiError)
    expect(out).toMatchObject({ code: 404, message: 'No bundle yet' })
  })

  test('returns the original error for a non-JSON Blob, a non-Blob body or a non-object', async () => {
    const mod = await import(composablePath)
    const binary = fetchError(500, new Blob(['<html>']))
    expect(await mod.blobErrorToApiError(binary)).toBe(binary)
    const plain = fetchError(500, { message: 'x' })
    expect(await mod.blobErrorToApiError(plain)).toBe(plain)
    expect(await mod.blobErrorToApiError('boom')).toBe('boom')
  })

  test('passes an ApiError through untouched', async () => {
    const mod = await import(composablePath)
    const err = new mod.ApiError(409, 'busy')
    expect(await mod.blobErrorToApiError(err)).toBe(err)
  })
})

describe('useApi().$api.download', () => {
  beforeEach(() => {
    g.__JEST_IS_SERVER__ = false
    g.useRuntimeConfig = () => ({ public: { apiBaseUrl: '/api' }, apiInternalUrl: 'http://localhost:3100' })
    g.useI18n = () => ({ locale: ref('en') })
  })

  afterEach(() => {
    g.$fetch = undefined
    g.useAuth = undefined
  })

  test('asks for a Blob at the API base and returns it', async () => {
    const file = new Blob(['gz'], { type: 'application/gzip' })
    const fetchMock = jest.fn(async () => file)
    g.$fetch = fetchMock
    const mod = await import(composablePath)

    const out = await mod.useApi().$api.download('/projects/web/fleet/jobs/j1/bundle')

    expect(out).toBe(file)
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(url).toBe('/api/projects/web/fleet/jobs/j1/bundle')
    expect(opts.responseType).toBe('blob')
  })

  test('throws the API message as an ApiError on a 404', async () => {
    g.$fetch = jest.fn(async () => { throw fetchError(404, jsonBlob({ ret: 404, message: 'No bundle yet' })) })
    const mod = await import(composablePath)

    await expect(mod.useApi().$api.download('/x')).rejects.toMatchObject({ name: 'ApiError', code: 404, message: 'No bundle yet' })
  })

  test('refreshes once on a 401 and retries the download', async () => {
    const file = new Blob(['gz'])
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(fetchError(401, jsonBlob({ ret: 401, message: 'expired' })))
      .mockResolvedValueOnce(file)
    const refresh = jest.fn(async () => true)
    g.$fetch = fetchMock
    g.useAuth = () => ({ refresh })
    const mod = await import(composablePath)

    expect(await mod.useApi().$api.download('/x')).toBe(file)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('rejects a body that is not a file', async () => {
    g.$fetch = jest.fn(async () => ({ hello: 'json' }))
    const mod = await import(composablePath)

    await expect(mod.useApi().$api.download('/x')).rejects.toMatchObject({ name: 'ApiError', code: -1 })
  })
})
