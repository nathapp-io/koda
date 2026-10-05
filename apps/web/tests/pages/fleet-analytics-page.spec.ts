import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const page = webFile('pages', '[project]', 'fleet', 'analytics.vue')
const DAY = 86_400_000
const W = { from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }
const point = (costUsd: string) => ({ t: W.from, costUsd, tokens: 1 })

const spendFor = (group: string, empty = false) => ({
  window: W, bucket: 'day', groupBy: group,
  totals: empty
    ? { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0, medianJobCostUsd: null }
    : { costUsd: '0.1334', tokens: 330, cacheShare: 0, jobs: 2, medianJobCostUsd: '0.0667' },
  series: empty ? [] : [
    { key: `${group}-a`, label: `${group}-a`, folded: false, costUsd: '0.1200', tokens: 200, points: [point('0.1200')] },
    { key: 'other', label: 'other', folded: true, costUsd: '0.0134', tokens: 130, points: [point('0.0134')] },
  ],
})
const QUALITY = {
  window: W, bucket: 'day', stories: 4, firstPassRate: 0.75, avgAttempts: 1.5,
  reviewByReviewer: [{ reviewer: 'semantic', runs: 4, passRate: 0.5, findingsBySeverity: { error: 2 } }],
  finishOutcomes: { opened: 1, promoted: 2, escalated: 1, skipped: 0, other: 0 },
  topEscalationReasons: [{ reason: 'review omitted WALK', count: 1 }], firstPassSeries: [{ t: W.from, rate: 0.75 }],
}
const EMPTY_QUALITY = {
  ...QUALITY, stories: 0, firstPassRate: null, avgAttempts: null, reviewByReviewer: [], topEscalationReasons: [],
  finishOutcomes: { opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 }, firstPassSeries: [{ t: W.from, rate: null }],
}
const STORY = { jobId: 'j1', leaseEpoch: 1, featureName: 'multiply', storyId: 'US-001', attempts: 3, firstPassSuccess: false, success: true, costUsd: '0.1395', completedAt: null }
const JOB = { jobId: 'j1', command: 'RUN', featureName: 'multiply', state: 'COMPLETED', costUsd: '0.1395', ledgerCostUsd: '0.1582', driftUsd: '0.0187', finishedAt: null }

interface Data {
  spend: (group: string) => unknown
  quality: () => unknown
  stories: unknown
  jobs: unknown
  ingest: unknown
}
const FULL: Data = { spend: (g) => spendFor(g), quality: () => QUALITY, stories: { window: W, rows: [STORY] }, jobs: { window: W, rows: [JOB] }, ingest: { window: W, pending: 2, failed: 1 } }
const EMPTY: Data = { spend: (g) => spendFor(g, true), quality: () => EMPTY_QUALITY, stories: { window: W, rows: [] }, jobs: { window: W, rows: [] }, ingest: { window: W, pending: 0, failed: 0 } }

type Query = Record<string, string>
type Get = jest.Mock<(path: string, opts?: { query?: Query }) => Promise<unknown>>

function makeGet(data: Data): Get {
  return jest.fn(async (path: string, opts?: { query?: Query }) => {
    if (path.endsWith('/analytics/spend')) return data.spend(opts?.query?.groupBy ?? '')
    if (path.endsWith('/analytics/quality')) return data.quality()
    if (path.endsWith('/analytics/stories')) return data.stories
    if (path.endsWith('/analytics/jobs')) return data.jobs
    if (path.endsWith('/analytics/ingest')) return data.ingest
    throw new Error(`unexpected ${path}`)
  }) as Get
}

/** unovis needs a DOM; the page is tested with chart stubs that expose what they were given. */
const chartStub = (stub: string) => ({
  name: `Stub-${stub}`,
  props: ['rows', 'series', 'bucket', 'label', 'seriesLabel'],
  setup(props: { rows?: unknown[]; series?: unknown[]; label?: string }) {
    return () => h('x-stub-stub', { 'data-stub': stub, 'data-series': props.series?.length ?? 0, 'data-rows': props.rows?.length ?? 0, 'aria-label': props.label })
  },
})

const REAL: FleetComponentName[] = [
  'FleetAnalyticsPanel', 'FleetAnalyticsBarList', 'FleetAnalyticsSeriesLegend', 'FleetAnalyticsChartDataTable', 'FleetAnalyticsSummaryTiles',
  'FleetAnalyticsRangePicker', 'FleetAnalyticsStoryTable', 'FleetAnalyticsJobTable', 'FleetAnalyticsIngestNotice', 'FleetNativeSelect',
]

/** The real FleetNativeSelect is mounted (fleetComponents), so drop its stub. */
const { FleetNativeSelect: _nativeSelectStub, ...stubs } = uiStubs

function mountPage(get: Get, query: Record<string, unknown> = {}, role = 'MEMBER') {
  const route = reactive({ params: { project: 'koda' }, query: { ...query } })
  const replace = jest.fn(async (to: { query: Query }) => { route.query = { ...to.query } })
  const hook: { visible?: () => void } = {}
  const app = mountSfc(page, {
    components: { ...stubs, FleetAnalyticsSpendAreaChart: chartStub('spend-chart'), FleetAnalyticsRateLineChart: chartStub('rate-chart') },
    fleetComponents: REAL,
    alias: {
      '~/composables/useRefetchOnVisible': { useRefetchOnVisible: (fn: () => void) => { hook.visible = fn }, watchVisible: () => () => undefined },
    },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useRoute: () => route,
      useRouter: () => ({ replace }),
      useAuth: () => ({ user: ref({ role }) }),
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
  const text = (id: string): string => app.textOf(byId(id)[0])
  const status = (id: string): unknown => byId(id)[0]?.props['data-status']
  const calls = (suffix: string) => get.mock.calls.filter(([path]) => path.endsWith(suffix)).map(([, opts]) => opts?.query ?? {})
  return { app, route, replace, settle, byId, text, status, calls, visible: () => hook.visible?.() }
}

describe('project Analytics page (spec §5.2)', () => {
  afterEach(() => jest.clearAllMocks())

  test('loads every panel once for the last 30 days, the main spend with top=7 and no bucket (D388, D392)', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    const [main, stage, role] = p.calls('/analytics/spend')
    expect(main).toMatchObject({ groupBy: 'model', top: '7' })
    expect(Date.parse(main.to) - Date.parse(main.from)).toBe(30 * DAY)
    expect(main).not.toHaveProperty('bucket')
    expect(stage).toMatchObject({ groupBy: 'stage' })
    expect(stage).not.toHaveProperty('top')
    expect(role).toMatchObject({ groupBy: 'role' })
    expect(p.calls('/analytics/stories').map((q) => [q.sort, q.limit])).toEqual([['cost', '10'], ['attempts', '10']])
    expect(p.calls('/analytics/quality')).toHaveLength(1)
    expect(p.calls('/analytics/jobs')).toEqual([expect.objectContaining({ sort: 'cost', limit: '10' })])
    expect(p.calls('/analytics/ingest')).toHaveLength(1)
    p.app.unmount()
  })

  test('shows the API values unchanged in tiles, chart summary, legend, bars and tables (A7)', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    expect(p.text('fleet-analytics-tile-spend')).toContain('$0.1334')
    expect(p.text('fleet-analytics-tile-jobs')).toContain('2')
    expect(p.text('fleet-analytics-tile-median')).toContain('$0.0667')
    expect(p.text('fleet-analytics-tile-firstPass')).toContain('75.0%')
    expect(p.text('fleet-analytics-tile-escalations')).toContain('1')
    const chart = p.app.find('[data-stub="spend-chart"]')[0]
    expect(chart.props['data-series']).toBe(2)
    expect(String(chart.props['aria-label'])).toContain('$0.1334')
    expect(p.byId('fleet-analytics-legend-row').map((r) => r.props['data-key'])).toEqual(['model-a', 'other'])
    expect(p.text('fleet-analytics-legend')).toContain('Other')
    expect(p.byId('fleet-analytics-stage-bars-row').map((r) => r.props['data-key'])).toEqual(['stage-a', 'other'])
    expect(p.text('fleet-analytics-reviewers')).toContain('50.0% of 4 runs')
    expect(p.text('fleet-analytics-reasons')).toContain('review omitted WALK')
    expect(p.text('fleet-analytics-costly-stories')).toContain('US-001')
    expect(p.text('fleet-analytics-costly-jobs')).toContain('$0.1582')
    expect(p.text('fleet-analytics-ingest-notice')).toContain('2 runs not yet analysed, 1 failed.')
    expect(p.byId('fleet-analytics-ingest-link')).toHaveLength(0)
    p.app.unmount()
  })

  test('an empty project shows empty panels, zero money, dashes and no chart (Review Focus 2)', async () => {
    const p = mountPage(makeGet(EMPTY))
    await p.settle()
    expect(p.status('fleet-analytics-spend')).toBe('empty')
    expect(p.text('fleet-analytics-spend-empty')).toBe('No fleet spend in this window.')
    expect(p.status('fleet-analytics-stage')).toBe('empty')
    expect(p.status('fleet-analytics-quality')).toBe('empty')
    expect(p.status('fleet-analytics-costly-jobs')).toBe('empty')
    expect(p.app.find('[data-stub="spend-chart"]')).toHaveLength(0)
    expect(p.text('fleet-analytics-tile-spend')).toContain('$0.0000')
    expect(p.text('fleet-analytics-tile-median-value')).toBe('-')
    expect(p.text('fleet-analytics-tile-firstPass-value')).toBe('-')
    expect(p.text('fleet-analytics-tile-escalations-value')).toBe('0')
    expect(p.byId('fleet-analytics-ingest-notice')).toHaveLength(0)
    p.app.unmount()
  })

  test('one failing query blanks only its panel and tiles; Retry refetches that panel alone (Review Focus 3)', async () => {
    const state = { failQuality: true }
    const get = makeGet({ ...FULL, quality: () => { if (state.failQuality) throw new Error('500'); return QUALITY } })
    const p = mountPage(get)
    await p.settle()
    expect(p.status('fleet-analytics-quality')).toBe('error')
    expect(p.status('fleet-analytics-spend')).toBe('ready')
    expect(p.text('fleet-analytics-tile-spend')).toContain('$0.1334')
    expect(p.text('fleet-analytics-tile-firstPass-value')).toBe('-')
    expect(p.text('fleet-analytics-tile-escalations-value')).toBe('-')
    const spendCalls = p.calls('/analytics/spend').length
    state.failQuality = false
    p.byId('fleet-analytics-quality-retry')[0].props.onClick()
    await p.settle()
    expect(p.status('fleet-analytics-quality')).toBe('ready')
    expect(p.calls('/analytics/quality')).toHaveLength(2)
    expect(p.calls('/analytics/spend')).toHaveLength(spendCalls)
    p.app.unmount()
  })

  test('a hand-edited URL never reaches the API with a bad window (Review Focus 4)', async () => {
    const reversedGet = makeGet(FULL)
    const reversed = mountPage(reversedGet, { from: '2026-10-02', to: '2026-10-01' })
    await reversed.settle()
    expect(reversed.byId('fleet-analytics-range-invalid')).toHaveLength(1)
    expect(reversed.byId('fleet-analytics-tiles')).toHaveLength(0)
    expect(reversedGet).not.toHaveBeenCalled()
    reversed.app.unmount()

    const longGet = makeGet(FULL)
    const long = mountPage(longGet, { from: '2024-01-01', to: '2026-01-01' })
    await long.settle()
    expect(longGet).not.toHaveBeenCalled()
    long.app.unmount()

    const junk = mountPage(makeGet(FULL), { range: 'abc', group: 'project', from: '2026-13-40', to: '2026-01-01' })
    await junk.settle()
    const [main] = junk.calls('/analytics/spend')
    expect(main.groupBy).toBe('model')
    expect(Date.parse(main.to) - Date.parse(main.from)).toBe(30 * DAY)
    junk.app.unmount()
  })

  test('a custom range is sent with its end date exclusive', async () => {
    const p = mountPage(makeGet(FULL), { from: '2026-09-01', to: '2026-09-30' })
    await p.settle()
    expect(p.calls('/analytics/quality')).toEqual([{ from: '2026-09-01', to: '2026-10-01' }])
    p.app.unmount()
  })

  test('changing the group rewrites the URL and refetches only the main spend', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    const before = p.calls('/analytics/spend').length
    p.byId('fleet-analytics-group')[0].props.onChange({ target: { value: 'stage' } })
    expect(p.replace).toHaveBeenCalledWith({ query: { group: 'stage' } })
    await p.settle()
    const after = p.calls('/analytics/spend')
    expect(after).toHaveLength(before + 1)
    expect(after[after.length - 1]).toMatchObject({ groupBy: 'stage', top: '7' })
    expect(p.calls('/analytics/quality')).toHaveLength(1)
    p.app.unmount()
  })

  test('picking a range refetches every panel; the tab becoming visible refetches too (no polling)', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    p.byId('fleet-analytics-range-7')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { range: '7' } })
    await p.settle()
    expect(p.calls('/analytics/quality')).toHaveLength(2)
    const last = p.calls('/analytics/quality')[1]
    expect(Date.parse(last.to) - Date.parse(last.from)).toBe(7 * DAY)
    p.visible()
    await p.settle()
    expect(p.calls('/analytics/quality')).toHaveLength(3)
    p.app.unmount()
  })

  test('admins get a link from the ingest notice to ingest health (D401)', async () => {
    const p = mountPage(makeGet(FULL), {}, 'ADMIN')
    await p.settle()
    expect(p.byId('fleet-analytics-ingest-link')[0].props.to).toBe('/admin/fleet/analytics')
    p.app.unmount()
  })
})
