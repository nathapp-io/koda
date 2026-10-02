import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetJobs.ts')
const g = globalThis as Record<string, unknown>
const page = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over })
const job = (id: string, state: string) => ({ id, state, requestedById: 'u1' })

function withApi(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
}

function deferred<T>() {
  let resolve = (_value: T): void => undefined
  let reject = (_reason?: unknown): void => undefined
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('buildJobQuery', () => {
  test('sends only set filters, a page size, and current past page 1', async () => {
    const { buildJobQuery } = await import(composablePath)
    expect(buildJobQuery({})).toEqual({ size: '20' })
    expect(buildJobQuery({ state: 'RUNNING', repoId: '', runnerId: 'r1', page: 1 })).toEqual({ state: 'RUNNING', runnerId: 'r1', size: '20' })
    expect(buildJobQuery({ requestedById: 'u1', page: 3 })).toEqual({ requestedById: 'u1', size: '20', current: '3' })
  })

  test('buildJobQuery passes the schedule filter (S1b 3a D205)', async () => {
    const { buildJobQuery } = await import(join(__dirname, '../..', 'composables', 'useFleetJobs.ts'))
    expect(buildJobQuery({ scheduleId: 's1', page: 2 })).toEqual({ scheduleId: 's1', size: '20', current: '2' })
  })
})

describe('useFleetJobs', () => {
  beforeEach(() => { g.useApi = undefined })

  test('load reads the page into refs and encodes the slug', async () => {
    const get = jest.fn(async () => page([job('j1', 'RUNNING')], { total: 21, hasNext: true }))
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('my proj')

    await jobs.load({ state: 'RUNNING' })

    expect(get).toHaveBeenCalledWith('/projects/my%20proj/fleet/jobs', { query: { state: 'RUNNING', size: '20' } })
    expect(jobs.jobs.value).toHaveLength(1)
    expect(jobs.total.value).toBe(21)
    expect(jobs.hasNext.value).toBe(true)
  })

  test('keeps the newest page and its metadata when requests resolve out of order', async () => {
    const older = deferred<ReturnType<typeof page>>()
    const newer = deferred<ReturnType<typeof page>>()
    const get = jest.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('web')

    const olderLoad = jobs.load({ state: 'RUNNING', page: 1 })
    const newerLoad = jobs.load({ state: 'FAILED', page: 2 })
    newer.resolve(page([job('new', 'FAILED')], { total: 42, current: 2, hasNext: true }))
    await expect(newerLoad).resolves.toBe(true)
    older.resolve(page([job('old', 'RUNNING')], { total: 1, current: 1, hasNext: false }))
    await expect(olderLoad).resolves.toBe(false)

    expect(jobs.jobs.value.map(({ id }) => id)).toEqual(['new'])
    expect(jobs.total.value).toBe(42)
    expect(jobs.page.value).toBe(2)
    expect(jobs.hasNext.value).toBe(true)
  })

  test('does not propagate an obsolete request error after a newer request starts', async () => {
    const older = deferred<ReturnType<typeof page>>()
    const newer = deferred<ReturnType<typeof page>>()
    const get = jest.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('web')

    const olderLoad = jobs.load({ state: 'RUNNING' })
    const newerLoad = jobs.load({ state: 'COMPLETED' })
    newer.resolve(page([job('new', 'COMPLETED')], { total: 3, current: 1, hasNext: false }))
    await expect(newerLoad).resolves.toBe(true)
    older.reject(new Error('stale request failed'))

    await expect(olderLoad).resolves.toBe(false)
    expect(jobs.jobs.value.map(({ id }) => id)).toEqual(['new'])
    expect(jobs.total.value).toBe(3)
  })

  test('a failed newest load stays authoritative when an older load succeeds afterward', async () => {
    const older = deferred<ReturnType<typeof page>>()
    const newer = deferred<ReturnType<typeof page>>()
    const get = jest.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('web')

    const olderLoad = jobs.load({ state: 'RUNNING' })
    const newerLoad = jobs.load({ state: 'FAILED' })
    newer.reject(new Error('newest request failed'))
    await expect(newerLoad).rejects.toThrow('newest request failed')
    older.resolve(page([job('old', 'RUNNING')]))

    await expect(olderLoad).resolves.toBe(false)
  })

  test('get, events, cancel, requeue and dispatch hit their routes', async () => {
    const get = jest.fn(async () => page([]))
    const post = jest.fn(async () => ({}))
    withApi({ get, post })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('web')

    await jobs.get('j/1')
    await jobs.events('j1', 2)
    await jobs.cancel('j1')
    await jobs.requeue('j1')
    await jobs.dispatch({ repoId: 'r1', command: 'RUN', feature: 'f', maxCostUsd: 5 })

    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs/j%2F1')
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/events', { query: { current: '2', size: '50' } })
    expect(post).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/cancel')
    expect(post).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/requeue')
    expect(post).toHaveBeenCalledWith('/projects/web/fleet/jobs', { repoId: 'r1', command: 'RUN', feature: 'f', maxCostUsd: 5 })
  })

  test('findActiveJob filters by repo and feature and returns the active record', async () => {
    const get = jest.fn(async () => page([job('old', 'FAILED'), job('live', 'UPLOADING')]))
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)

    const found = await useFleetJobs('web').findActiveJob('r1', 'login-fix')

    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs', { query: { repoId: 'r1', feature: 'login-fix', size: '20' } })
    expect(found?.id).toBe('live')
  })

  test('findActiveJob returns null when the duplicate already finished', async () => {
    withApi({ get: jest.fn(async () => page([job('old', 'COMPLETED')])) })
    const { useFleetJobs } = await import(composablePath)
    expect(await useFleetJobs('web').findActiveJob('r1', 'f')).toBeNull()
  })

  test('downloadBundle saves the blob under koda-job-<id>.tar.gz', async () => {
    const blob = new Blob(['gz'])
    const download = jest.fn(async () => blob)
    withApi({ download })
    const link = { href: '', download: '', click: jest.fn(), remove: jest.fn() }
    g.document = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } }
    const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    jest.useFakeTimers()
    try {
      const { useFleetJobs } = await import(composablePath)
      await useFleetJobs('web').downloadBundle('j1')

      expect(download).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/bundle')
      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(link.download).toBe('koda-job-j1.tar.gz')
      expect(link.click).toHaveBeenCalled()
    }
    finally {
      jest.runOnlyPendingTimers()
      jest.useRealTimers()
      delete g.document
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
    }
  })

  test('downloadBundle propagates the API error and creates no link', async () => {
    withApi({ download: jest.fn(async () => { throw new Error('No bundle yet') }) })
    const createElement = jest.fn()
    g.document = { createElement, body: { appendChild: jest.fn() } }
    try {
      const { useFleetJobs } = await import(composablePath)
      await expect(useFleetJobs('web').downloadBundle('j1')).rejects.toThrow('No bundle yet')
    }
    finally {
      delete g.document
    }
    expect(createElement).not.toHaveBeenCalled()
  })
})
