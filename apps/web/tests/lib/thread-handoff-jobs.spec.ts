import { describe, expect, jest, test } from '@jest/globals'
import { createHandoffJobs } from '~/lib/thread-handoff-jobs'
import type { ThreadHandoff } from '~/lib/thread-types'

describe('createHandoffJobs', () => {
  const running: ThreadHandoff = { plan: { jobId: 'p1', state: 'RUNNING', stateReason: null }, run: null }
  const detail = { id: 'p1', state: 'RUNNING' }

  test('AC-1: fetches the current plan by its escaped project path', async () => {
    const get = jest.fn(async () => detail)
    const controller = createHandoffJobs({ slug: 'web', api: { get } })
    await controller.sync(running)
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs/p1')
  })
  test('AC-2: stores the fetched detail', async () => {
    const controller = createHandoffJobs({ slug: 'web', api: { get: async () => detail } })
    await controller.sync(running)
    expect(controller.jobs.value.plan).toBe(detail)
  })
  test('AC-3: matching id and state do not refetch', async () => {
    const get = jest.fn(async () => detail)
    const controller = createHandoffJobs({ slug: 'web', api: { get } })
    await controller.sync(running)
    await controller.sync(running)
    expect(get).toHaveBeenCalledTimes(1)
  })
  test('AC-4: a changed handoff state refetches same job', async () => {
    const get = jest.fn(async () => detail)
    const controller = createHandoffJobs({ slug: 'web', api: { get } })
    await controller.sync(running)
    await controller.sync({ plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null }, run: null })
    expect(get).toHaveBeenNthCalledWith(2, '/projects/web/fleet/jobs/p1')
  })
  test('AC-5: a null run clears cached detail', async () => {
    const controller = createHandoffJobs({ slug: 'web', api: { get: async () => ({ id: 'r1', state: 'RUNNING' }) } })
    await controller.sync({ plan: null, run: { jobId: 'r1', state: 'RUNNING', stateReason: null } })
    await controller.sync({ plan: null, run: null })
    expect(controller.jobs.value.run).toBeNull()
  })
  test('AC-6: failed fetch resolves and leaves the uncached slot null', async () => {
    const controller = createHandoffJobs({ slug: 'web', api: { get: async () => { throw new Error('offline') } } })
    await expect(controller.sync({ plan: { jobId: 'p9', state: 'QUEUED', stateReason: null }, run: null })).resolves.toBeUndefined()
    expect(controller.jobs.value.plan).toBeNull()
  })
  test('F2: an older response resolving after a newer one does not overwrite it', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    const get = jest.fn(() => new Promise<unknown>(resolve => { resolvers.push(resolve) }))
    const controller = createHandoffJobs({ slug: 'web', api: { get: get as never } })
    const first = controller.sync(running)
    const second = controller.refreshJob('p1')
    resolvers[1]?.({ id: 'p1', state: 'ESCALATED' })
    await second
    resolvers[0]?.({ id: 'p1', state: 'RUNNING' })
    await first
    expect(controller.jobs.value.plan).toEqual({ id: 'p1', state: 'ESCALATED' })
  })
  test('F2: a response for a job no longer in the handoff is dropped', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    const get = jest.fn(() => new Promise<unknown>(resolve => { resolvers.push(resolve) }))
    const controller = createHandoffJobs({ slug: 'web', api: { get: get as never } })
    const pending = controller.sync(running)
    void controller.sync({ plan: null, run: null })
    resolvers[0]?.(detail)
    await pending
    expect(controller.jobs.value.plan).toBeNull()
  })
  test('AC-7: identifies the last synced handoff job', async () => {
    const controller = createHandoffJobs({ slug: 'web', api: { get: async () => detail } })
    await controller.sync(running)
    expect(controller.isHandoffJob('p1')).toBe(true)
  })
  test('AC-8: does not identify unrelated jobs', async () => {
    const controller = createHandoffJobs({ slug: 'web', api: { get: async () => detail } })
    await controller.sync(running)
    expect(controller.isHandoffJob('other')).toBe(false)
  })
  test('AC-9: refreshes an identified job', async () => {
    const get = jest.fn(async () => detail)
    const controller = createHandoffJobs({ slug: 'web', api: { get } })
    await controller.sync(running)
    await controller.refreshJob('p1')
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenLastCalledWith('/projects/web/fleet/jobs/p1')
  })
  test('AC-10: does not refresh unrelated jobs', async () => {
    const get = jest.fn(async () => detail)
    const controller = createHandoffJobs({ slug: 'web', api: { get } })
    await controller.sync(running)
    await controller.refreshJob('other')
    expect(get).toHaveBeenCalledTimes(1)
  })
})
