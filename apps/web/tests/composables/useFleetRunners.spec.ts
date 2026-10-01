import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetRunners.ts')
const r = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, os: 'linux', arch: 'x64', labels: [], capacity: 1, capabilities: {}, daemonVersion: '0.1.0',
  protocolVersion: 1, enabled: true, lastSeenAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-30T00:00:00Z',
  bootId: 'b1', bootedAt: null, online: true, ...over,
})
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useFleetRunners', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load asks for one page of 100 and records hasMore', async () => {
    const get = jest.fn(async () => pageOf([r('a')], { total: 101, hasNext: true }))
    withApi({ get })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()

    await fleet.load()

    expect(get).toHaveBeenCalledWith('/fleet/runners', { query: { size: '100' } })
    expect(fleet.runners.value).toHaveLength(1)
    expect(fleet.hasMore.value).toBe(true)
    expect(fleet.pending.value).toBe(false)
  })

  test('load clears pending when the request fails', async () => {
    const get = jest.fn(async () => { throw new Error('boom') })
    withApi({ get })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()

    await expect(fleet.load()).rejects.toThrow('boom')
    expect(fleet.pending.value).toBe(false)
  })

  test('update patches and replaces the row without mutating the old array', async () => {
    const get = jest.fn(async () => pageOf([r('a'), r('b')]))
    const patch = jest.fn(async () => r('b', { enabled: false }))
    withApi({ get, patch })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()
    await fleet.load()
    const before = fleet.runners.value

    await fleet.update('b', { enabled: false })

    expect(patch).toHaveBeenCalledWith('/fleet/runners/b', { enabled: false })
    expect(fleet.runners.value[1].enabled).toBe(false)
    expect(before[1].enabled).toBe(true)
  })

  test('a load that started before a mutation does not overwrite it', async () => {
    let release: (value: unknown) => void = () => undefined
    const get = jest.fn()
      .mockImplementationOnce(async () => pageOf([r('a')]))
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const patch = jest.fn(async () => r('a', { enabled: false }))
    withApi({ get, patch })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()
    await fleet.load()

    const poll = fleet.load()
    await fleet.update('a', { enabled: false })
    release(pageOf([r('a', { enabled: true })]))
    await poll

    expect(fleet.runners.value[0].enabled).toBe(false)
    expect(fleet.pending.value).toBe(false)
  })

  test('update encodes the id as one path segment', async () => {
    const patch = jest.fn(async () => r('a/b'))
    withApi({ get: jest.fn(), patch })
    const { useFleetRunners } = await import(composablePath)

    await useFleetRunners().update('a/b', { capacity: 2 })

    expect(patch).toHaveBeenCalledWith('/fleet/runners/a%2Fb', { capacity: 2 })
  })

  test('remove deletes and drops the row', async () => {
    const get = jest.fn(async () => pageOf([r('a'), r('b')]))
    const del = jest.fn(async () => ({}))
    withApi({ get, delete: del })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()
    await fleet.load()

    await fleet.remove('a')

    expect(del).toHaveBeenCalledWith('/fleet/runners/a')
    expect(fleet.runners.value.map((x: { id: string }) => x.id)).toEqual(['b'])
  })

  test('createEnrollment posts the labels and returns the token row', async () => {
    const post = jest.fn(async () => ({ id: 'e1', labels: ['gpu'], token: 'ke_x', expiresAt: '2026-10-02T00:00:00Z' }))
    withApi({ get: jest.fn(), post })
    const { useFleetRunners } = await import(composablePath)

    const created = await useFleetRunners().createEnrollment(['gpu'])

    expect(post).toHaveBeenCalledWith('/fleet/enrollments', { labels: ['gpu'] })
    expect(created.token).toBe('ke_x')
  })
})
