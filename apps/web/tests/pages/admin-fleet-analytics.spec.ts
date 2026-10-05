import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'

const page = webFile('pages', 'admin', 'fleet', 'analytics.vue')
const W = { from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }
const SPEND = (group: string) => ({
  window: W, bucket: 'day', groupBy: group,
  totals: { costUsd: '4.2500', tokens: 10, cacheShare: 0.25, jobs: 2, medianJobCostUsd: '2.1250' },
  series: [{ key: `${group}-a`, label: `${group}-a`, folded: false, costUsd: '4.2500', tokens: 10, points: [{ t: W.from, costUsd: '4.2500', tokens: 10 }] }],
})
const ROW = { id: 'i1', jobId: 'job-1', leaseEpoch: 1, projectId: 'proj-1', status: 'failed', attempts: 5, parserVersion: 1, files: {}, error: 'corrupt gzip', ingestedAt: null, updatedAt: W.to }
const PAGE = (over: Record<string, unknown> = {}) => ({ records: [ROW], total: 21, current: 1, size: 20, hasNext: true, hasPrev: false, ...over })

type Query = Record<string, string>
type Get = jest.Mock<(path: string, opts?: { query?: Query }) => Promise<unknown>>
type Post = jest.Mock<(path: string) => Promise<unknown>>

const chartStub = { name: 'StubSpendChart', props: ['rows', 'series', 'bucket', 'label'], setup() { return () => h('x-stub-stub', { 'data-stub': 'spend-chart' }) } }
const REAL: FleetComponentName[] = [
  'FleetAnalyticsPanel', 'FleetAnalyticsBarList', 'FleetAnalyticsSeriesLegend', 'FleetAnalyticsChartDataTable', 'FleetAnalyticsSummaryTiles',
  'FleetAnalyticsRangePicker', 'FleetAnalyticsIngestTable', 'FleetNativeSelect',
]

function makeGet(ingest: () => unknown): Get {
  return jest.fn(async (path: string, opts?: { query?: Query }) => {
    if (path === '/fleet/analytics/spend') return SPEND(opts?.query?.groupBy ?? '')
    if (path === '/fleet/ingest') return ingest()
    throw new Error(`unexpected ${path}`)
  }) as Get
}

/** The real FleetNativeSelect is mounted (fleetComponents), so drop its stub. */
const { FleetNativeSelect: _nativeSelectStub, ...stubs } = uiStubs

function mountAdmin(get: Get, confirmAnswer = true) {
  const route = reactive({ params: {}, query: {} as Query })
  const replace = jest.fn(async (to: { query: Query }) => { route.query = { ...to.query } })
  const post = jest.fn(async () => ({ queued: 1 })) as Post
  const toasts = toastRecorder()
  globalThis.window = { confirm: () => confirmAnswer } as never
  const app = mountSfc(page, {
    components: { ...stubs, FleetAnalyticsSpendAreaChart: chartStub },
    fleetComponents: REAL,
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useRefetchOnVisible': { useRefetchOnVisible: () => undefined, watchVisible: () => () => undefined },
    },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(), useAppToast: () => toasts, useApi: () => ({ $api: { get, post } }),
      useRoute: () => route, useRouter: () => ({ replace }), definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const ingestCalls = () => get.mock.calls.filter(([p]) => p === '/fleet/ingest').map(([, o]) => o?.query ?? {})
  return { app, settle, byId, post, toasts, ingestCalls, get }
}

describe('admin fleet Analytics page (spec §5.3, D395)', () => {
  afterEach(() => jest.clearAllMocks())

  test('loads cross-project spend grouped by project, stage and role spend, and the first ingest page', async () => {
    const m = mountAdmin(makeGet(() => PAGE()))
    await m.settle()
    const spend = m.get.mock.calls.filter(([p]) => p === '/fleet/analytics/spend').map(([, o]) => o?.query ?? {})
    expect(spend.map((q) => [q.groupBy, q.top])).toEqual([['project', '7'], ['stage', undefined], ['role', undefined]])
    expect(m.ingestCalls()).toEqual([{ size: '20' }])
    expect(m.app.textOf(m.byId('fleet-analytics-tile-spend')[0])).toContain('$4.2500')
    expect(m.app.textOf(m.byId('fleet-analytics-tile-median')[0])).toContain('$2.1250')
    expect(m.app.textOf(m.byId('fleet-analytics-tile-cacheShare')[0])).toContain('25.0%')
    expect(m.byId('fleet-ingest-row')).toHaveLength(1)
    expect(m.app.text()).toContain('21 rows')
    expect(m.get.mock.calls.some(([p]) => p.includes('/quality'))).toBe(false)
    m.app.unmount()
  })

  test('a non-admin sees only the admin-only note', async () => {
    const m = mountAdmin(makeGet(() => { throw new ApiError(40003, 'Forbidden') }))
    await m.settle()
    expect(m.byId('fleet-analytics-admin-only')).toHaveLength(1)
    expect(m.byId('fleet-analytics-tiles')).toHaveLength(0)
    expect(m.byId('fleet-ingest')).toHaveLength(0)
    m.app.unmount()
  })

  test('filters by status from page 1 and pages forward', async () => {
    const m = mountAdmin(makeGet(() => PAGE()))
    await m.settle()
    m.byId('fleet-ingest-next')[0].props.onClick()
    await m.settle()
    m.byId('fleet-ingest-status')[0].props.onChange({ target: { value: 'failed' } })
    await m.settle()
    expect(m.ingestCalls()).toEqual([{ size: '20' }, { size: '20', current: '2' }, { size: '20', status: 'failed' }])
    m.app.unmount()
  })

  test('re-runs one job, reports the queued count and refreshes the list', async () => {
    const m = mountAdmin(makeGet(() => PAGE()))
    await m.settle()
    m.byId('fleet-ingest-rerun')[0].props.onClick()
    await m.settle()
    expect(m.post).toHaveBeenCalledWith('/fleet/ingest/jobs/job-1/rerun')
    expect(m.toasts.successes).toEqual(['Queued 1 bundles.'])
    expect(m.ingestCalls()).toHaveLength(2)
    m.app.unmount()
  })

  test('backfill posts at once; re-run all asks first and does nothing when declined', async () => {
    const declined = mountAdmin(makeGet(() => PAGE()), false)
    await declined.settle()
    declined.byId('fleet-ingest-rerun-outdated')[0].props.onClick()
    await declined.settle()
    expect(declined.post).not.toHaveBeenCalled()
    declined.byId('fleet-ingest-backfill')[0].props.onClick()
    await declined.settle()
    expect(declined.post).toHaveBeenCalledWith('/fleet/ingest/backfill')
    declined.app.unmount()

    const confirmed = mountAdmin(makeGet(() => PAGE()), true)
    await confirmed.settle()
    confirmed.byId('fleet-ingest-rerun-outdated')[0].props.onClick()
    await confirmed.settle()
    expect(confirmed.post).toHaveBeenCalledWith('/fleet/ingest/rerun-outdated')
    confirmed.app.unmount()
  })

  test('an ingest list failure shows its own error while spend still renders', async () => {
    const m = mountAdmin(makeGet(() => { throw new ApiError(50000, 'boom') }))
    await m.settle()
    expect(m.app.find('[data-stub="error-state"]')).toHaveLength(1)
    expect(m.byId('fleet-analytics-spend')[0].props['data-status']).toBe('ready')
    m.app.unmount()
  })
})
