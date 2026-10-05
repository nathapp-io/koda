import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import type { PollingDeps } from '~/composables/useVisiblePolling'
import { hhmm } from '~/lib/fleet-dashboard'
import type { FleetDashboard } from '~/lib/fleet-dashboard-types'

const g = globalThis as Record<string, unknown>
const GEN = '2026-10-05T12:00:00.000Z'

const snapshot = (over: Partial<FleetDashboard> = {}): FleetDashboard => ({
  generatedAt: GEN,
  counts: { runnersOnline: 1, runnersTotal: 1, queued: 0, running: 0, attention: 0 },
  runners: [], activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false, attention: [],
  ...over,
})

/** Records every interval the composable asks for; `fire(ms)` runs that poller's task. */
function fakePolling() {
  const intervals = new Map<number, () => void>()
  const cleared: number[] = []
  const deps: PollingDeps = {
    isHidden: () => false,
    setInterval: (fn, ms) => { intervals.set(ms, fn); return ms },
    clearInterval: (handle) => { cleared.push(handle as number); intervals.delete(handle as number) },
    onVisible: () => () => undefined,
  }
  return { deps, intervals, cleared }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

async function load(get: jest.Mock) {
  g.useApi = () => ({ $api: { get } })
  const { useFleetDashboard, dashboardPath } = await import('~/composables/useFleetDashboard')
  return { useFleetDashboard, dashboardPath }
}

describe('useFleetDashboard (spec §4.1, D420, D421)', () => {
  afterEach(() => { delete g.useApi })

  test('the admin route is plain, the project route encodes the slug', async () => {
    const { dashboardPath } = await load(jest.fn())
    expect(dashboardPath({ kind: 'global' })).toBe('/fleet/dashboard')
    expect(dashboardPath({ kind: 'project', slug: 'my proj' })).toBe('/projects/my%20proj/fleet/dashboard')
  })

  test('start loads at once and polls every 10 s, with a 1 s clock', async () => {
    const get = jest.fn(async () => snapshot())
    const { useFleetDashboard } = await load(get)
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => 1_000 })

    dash.start()
    await settle()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/fleet/dashboard')
    expect([...poll.intervals.keys()].sort((a, b) => a - b)).toEqual([1_000, 10_000])
    expect(dash.data.value?.generatedAt).toBe(GEN)

    poll.intervals.get(10_000)?.()
    await settle()
    expect(get).toHaveBeenCalledTimes(2)

    dash.stop()
    expect(poll.intervals.size).toBe(0)
  })

  test('now is server time: generatedAt plus client time since arrival, advanced by the clock tick (D416)', async () => {
    let clock = 50_000
    const { useFleetDashboard } = await load(jest.fn(async () => snapshot()))
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => clock })

    dash.start()
    await settle()
    expect(dash.now.value.toISOString()).toBe(GEN)

    clock += 7_000
    poll.intervals.get(1_000)?.()
    await settle()
    expect(dash.now.value.toISOString()).toBe('2026-10-05T12:00:07.000Z')
  })

  test('a failed poll keeps the last snapshot and its success time; the next success clears the error (Review Focus 3)', async () => {
    const get = jest.fn<() => Promise<FleetDashboard>>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new ApiError(50000, 'bad gateway'))
      .mockResolvedValueOnce(snapshot({ generatedAt: '2026-10-05T12:00:20.000Z' }))
    let clock = 1_000
    const { useFleetDashboard } = await load(get)
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'project', slug: 'koda' }, { polling: poll.deps, clock: () => clock })

    dash.start()
    await settle()
    expect(dash.lastSuccessAt.value).toBe(1_000)

    clock = 11_000
    await dash.refresh()
    expect(dash.data.value?.generatedAt).toBe(GEN)
    expect(dash.error.value).toBeInstanceOf(ApiError)
    expect(dash.lastSuccessAt.value).toBe(1_000)
    expect(dash.staleSince.value).toBe(hhmm(1_000))
    expect(dash.failed.value).toBe(false)
    expect(poll.intervals.has(10_000)).toBe(true)

    clock = 21_000
    await dash.refresh()
    expect(dash.error.value).toBeNull()
    expect(dash.staleSince.value).toBeNull()
    expect(dash.lastSuccessAt.value).toBe(21_000)
    expect(dash.data.value?.generatedAt).toBe('2026-10-05T12:00:20.000Z')
  })

  test.each([40003, 403])('a 403 (code %s) sets forbidden, stops both pollers and never asks again', async (code) => {
    const get = jest.fn(async () => { throw new ApiError(code, 'forbidden') })
    const { useFleetDashboard } = await load(get)
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => 0 })

    dash.start()
    await settle()
    expect(dash.forbidden.value).toBe(true)
    expect(poll.intervals.size).toBe(0)

    await dash.refresh()
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('the first load failing leaves data null and the error set, and keeps polling', async () => {
    const { useFleetDashboard } = await load(jest.fn(async () => { throw new Error('API down') }))
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => 0 })

    dash.start()
    await settle()
    expect(dash.data.value).toBeNull()
    expect(dash.error.value).toBeInstanceOf(Error)
    expect(dash.forbidden.value).toBe(false)
    expect(dash.failed.value).toBe(true)
    expect(dash.staleSince.value).toBeNull()
    expect(poll.intervals.has(10_000)).toBe(true)
  })
})
