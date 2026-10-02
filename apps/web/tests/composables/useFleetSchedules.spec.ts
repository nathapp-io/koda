import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import type { ScheduleDto } from '../../lib/fleet-types'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetSchedules.ts')

const row = (id: string, name: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main', profiles: [],
  maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: '2026-10-05T09:00:00.000Z',
  lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null,
  totalCostUsd: '0.0000', createdById: 'u1', updatedById: 'u1', createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useFleetSchedules', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('paths encode the slug and the id', async () => {
    const { scheduleRoot, scheduleItem } = await import(composablePath)
    expect(scheduleRoot('a b')).toBe('/projects/a%20b/fleet/schedules')
    expect(scheduleItem('koda', 's/1')).toBe('/projects/koda/fleet/schedules/s%2F1')
  })

  test('load reads the plain array and sorts it by name', async () => {
    const get = jest.fn(async () => [row('b', 'zeta'), row('a', 'alpha')])
    withApi({ get })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')
    await s.load()
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/schedules')
    expect(s.schedules.value.map((x: ScheduleDto) => x.id)).toEqual(['a', 'b'])
  })

  test('create, update, enable, disable call their routes and put the answer in the list', async () => {
    const post = jest.fn(async (path: string) => row(path.endsWith('/disable') ? 'a' : 'n', path.endsWith('/disable') ? 'alpha' : 'new', { enabled: !path.endsWith('/disable') }))
    const patch = jest.fn(async () => row('n', 'renamed'))
    withApi({ get: jest.fn(async () => []), post, patch, delete: jest.fn(async () => undefined) })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')

    await s.create({ name: 'new', repoId: 'r1', feature: 'f', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 1, noProgressLimit: 3 })
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules', expect.objectContaining({ name: 'new' }))
    await s.update('n', { name: 'renamed' } as never)
    expect(patch).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules/n', { name: 'renamed' })
    expect(s.schedules.value.map((x: ScheduleDto) => x.name)).toEqual(['renamed'])
    await s.enable('n')
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules/n/enable')
    await s.disable('a')
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules/a/disable')
    expect(s.schedules.value.map((x: ScheduleDto) => [x.id, x.enabled])).toEqual([['a', false], ['n', true]])
  })

  test('remove deletes and drops the row', async () => {
    const del = jest.fn(async () => undefined)
    withApi({ get: jest.fn(async () => [row('a', 'alpha'), row('b', 'beta')]), delete: del })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')
    await s.load()
    await s.remove('a')
    expect(del).toHaveBeenCalledWith('/projects/koda/fleet/schedules/a')
    expect(s.schedules.value.map((x: ScheduleDto) => x.id)).toEqual(['b'])
  })

  test('a load that started before a mutation does not put the old row back (D224, Review Focus 4)', async () => {
    const slow = deferred<ScheduleDto[]>()
    const get = jest.fn(() => slow.promise)
    withApi({ get, post: jest.fn(async () => row('a', 'alpha', { enabled: false })) })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')

    const loading = s.load()
    await s.disable('a')
    slow.resolve([row('a', 'alpha', { enabled: true })])
    await loading
    expect(s.schedules.value.map((x: ScheduleDto) => x.enabled)).toEqual([false])
  })
})
