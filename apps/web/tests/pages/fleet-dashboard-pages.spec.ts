import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { FleetDashboard } from '~/lib/fleet-dashboard-types'

const adminPage = webFile('pages', 'admin', 'fleet', 'index.vue')
const projectPage = webFile('pages', '[project]', 'fleet', 'overview.vue')
const REAL: FleetComponentName[] = [
  'FleetAge', 'FleetDashboardOverview', 'FleetDashboardTiles', 'FleetDashboardAttentionList', 'FleetDashboardActiveRunsTable',
  'FleetDashboardRecentRunsList', 'FleetDashboardRunnerHealthList', 'FleetDashboardCredentialDigestChips',
]
const { FleetAge: _ageStub, ...stubs } = uiStubs

const runnerItem = {
  key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity: 'warning', subjectType: 'runner' as const, subjectId: 'r1',
  subjectName: 'wk-mac', projectSlug: null, since: null, conditions: [{ type: 'configuration' }],
}

const snapshot = (scope: 'global' | 'project'): FleetDashboard => ({
  generatedAt: new Date().toISOString(),
  counts: { runnersOnline: 1, runnersTotal: 1, queued: 0, running: 0, attention: 1 },
  runners: [{
    id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, online: true, lastSeenAt: new Date().toISOString(),
    capacity: 2, activeJobs: 0,
    naxVersion: scope === 'global' ? '0.83.3' : null,
    daemonVersion: scope === 'global' ? '0.1.0' : null,
    credentials: scope === 'global' ? [{ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false }] : [],
  }],
  activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false,
  attention: [runnerItem],
})

/** The page's composable gets this instead of the browser poller: tasks by interval, and start/stop calls. */
function fakePolling() {
  const tasks = new Map<number, () => Promise<void>>()
  const started: number[] = []
  const stopped: number[] = []
  const module = {
    useVisiblePolling: (task: () => Promise<void>, ms: number) => {
      tasks.set(ms, task)
      return { start: () => { started.push(ms) }, stop: () => { stopped.push(ms) }, runNow: () => task(), isActive: () => true }
    },
  }
  return { module, started, stopped, poll: async (): Promise<void> => { await tasks.get(10_000)?.() } }
}

type Get = jest.Mock<(path: string) => Promise<unknown>>

function mountPage(file: string, get: Get) {
  const polling = fakePolling()
  const app = mountSfc(file, {
    components: stubs,
    fleetComponents: REAL,
    alias: { '~/composables/useApi': apiModule, '~/composables/useVisiblePolling': polling.module },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useRoute: () => ({ params: { project: 'koda' } }),
      definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, polling, settle, byId }
}

describe('admin fleet overview page (spec §4.1)', () => {
  test('loads the admin snapshot on mount, polls every 10 s with a 1 s clock, and stops on unmount', async () => {
    const get: Get = jest.fn(async () => snapshot('global'))
    const p = mountPage(adminPage, get)
    await p.settle()
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/fleet/dashboard'])
    expect([...p.polling.started].sort((a, b) => a - b)).toEqual([1_000, 10_000])
    expect(p.app.find('[data-stub="page-header"]')[0].props.title).toBe('Fleet overview')
    expect(p.byId('fleet-dashboard-attention-link').map((n) => n.props.to)).toEqual(['/admin/fleet/runners'])
    expect(p.byId('fleet-dashboard-credential')).toHaveLength(1)
    expect(p.byId('fleet-dashboard-analytics-link')[0].props.to).toBe('/admin/fleet/analytics')
    expect(p.byId('fleet-dashboard-credentials-link').map((n) => n.props.to)).toEqual(['/admin/fleet/credentials'])
    p.app.unmount()
    expect([...p.polling.stopped].sort((a, b) => a - b)).toEqual([1_000, 10_000])
  })

  test.each([40003, 403])('a 403 (%s) shows the admin-only note, no overview, and stops polling', async (code) => {
    const p = mountPage(adminPage, jest.fn(async () => { throw new ApiError(code, 'forbidden') }) as Get)
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-dashboard-forbidden')[0])).toBe('Only global administrators can manage the fleet.')
    expect(p.byId('fleet-dashboard')).toHaveLength(0)
    expect([...p.polling.stopped].sort((a, b) => a - b)).toEqual([1_000, 10_000])
  })

  test('a failed poll keeps the snapshot with the stale note; the next success clears it (Review Focus 3)', async () => {
    const get = jest.fn<(path: string) => Promise<unknown>>()
      .mockResolvedValueOnce(snapshot('global'))
      .mockRejectedValueOnce(new ApiError(50000, 'bad gateway'))
      .mockResolvedValueOnce(snapshot('global'))
    const p = mountPage(adminPage, get)
    await p.settle()

    await p.polling.poll()
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-dashboard-stale')[0])).toMatch(/^Could not refresh\. Showing data from \d\d:\d\d\.$/)
    expect(p.byId('fleet-dashboard-attention-item')).toHaveLength(1)

    await p.polling.poll()
    await p.settle()
    expect(p.byId('fleet-dashboard-stale')).toHaveLength(0)
  })

  test('the first load failing shows the error state; Retry asks again', async () => {
    const get = jest.fn<(path: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('API down'))
      .mockResolvedValueOnce(snapshot('global'))
    const p = mountPage(adminPage, get)
    await p.settle()
    expect(p.byId('fleet-dashboard-error')).toHaveLength(1)

    ;(p.app.find('[data-stub="error-state"]')[0].props.onRetry as () => void)()
    await p.settle()
    expect(get).toHaveBeenCalledTimes(2)
    expect(p.byId('fleet-dashboard-tiles')).toHaveLength(1)
  })
})

describe('project fleet overview page (spec §4.1, B5)', () => {
  test('loads the project snapshot; runner items are plain text and no credential chip shows', async () => {
    const get: Get = jest.fn(async () => snapshot('project'))
    const p = mountPage(projectPage, get)
    await p.settle()
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/projects/koda/fleet/dashboard'])
    expect(p.byId('fleet-dashboard-attention-item')).toHaveLength(1)
    expect(p.byId('fleet-dashboard-attention-link')).toHaveLength(0)
    expect(p.byId('fleet-dashboard-credentials')).toHaveLength(0)
    expect(p.byId('fleet-dashboard-runner-versions')).toHaveLength(0)
    expect(p.byId('fleet-dashboard-analytics-link')[0].props.to).toBe('/koda/fleet/analytics')
    expect(p.byId('fleet-dashboard-credentials-link')).toHaveLength(0)
  })

  test('a 403 shows the no-access text and stops polling', async () => {
    const p = mountPage(projectPage, jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) as Get)
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-dashboard-forbidden')[0])).toBe('You do not have access to this project.')
    expect(p.polling.stopped).toContain(10_000)
  })
})
