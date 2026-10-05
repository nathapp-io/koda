import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'node:fs'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { RANGE_PRESETS } from '~/lib/fleet-analytics-range'

const dir = webFile('components', 'fleet', 'analytics')
const file = (name: string): string => webFile('components', 'fleet', 'analytics', name)
const globals = { useI18n: () => enI18n() }
const mount = (name: string, props: Record<string, unknown>) => mountSfc(file(name), { props, components: uiStubs, globals })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

describe('analytics components never render HTML from data (D398)', () => {
  it('no component in components/fleet/analytics uses v-html', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.vue'))) {
      expect({ name, vHtml: readFileSync(file(name), 'utf-8').includes('v-html') }).toEqual({ name, vHtml: false })
    }
  })
})

describe('range preset labels (dynamic keys the used-keys guard cannot see)', () => {
  it('exist in en and zh for every preset', () => {
    const en = require('../../i18n/locales/en.json') as { fleet: { analytics: { range: Record<string, string> } } }
    const zh = require('../../i18n/locales/zh.json') as { fleet: { analytics: { range: Record<string, string> } } }
    for (const days of RANGE_PRESETS) {
      expect(en.fleet.analytics.range[`d${days}`]).toBeTruthy()
      expect(zh.fleet.analytics.range[`d${days}`]).toBeTruthy()
    }
  })
})

describe('FleetAnalyticsPanel', () => {
  it('shows loading, empty and error states, and asks for a retry', () => {
    expect(byId(mount('Panel.vue', { title: 'Spend', status: 'loading', testid: 'p' }), 'p-loading')).toHaveLength(1)
    const empty = mount('Panel.vue', { title: 'Spend', status: 'empty', testid: 'p', emptyText: 'No spend yet' })
    expect(empty.textOf(byId(empty, 'p-empty')[0])).toBe('No spend yet')
    const failed = mount('Panel.vue', { title: 'Spend', status: 'error', testid: 'p' })
    expect(failed.text()).toContain('Could not load this panel.')
    byId(failed, 'p-retry')[0].props.onClick()
    expect(failed.emitted('retry')).toHaveLength(1)
    const ready = mount('Panel.vue', { title: 'Spend', status: 'ready', testid: 'p' })
    expect(byId(ready, 'p')[0].props['data-status']).toBe('ready')
    expect(byId(ready, 'p-loading')).toHaveLength(0)
  })
})

describe('FleetAnalyticsBarList', () => {
  it('renders label, unchanged value text and width per row', () => {
    const app = mount('BarList.vue', {
      testid: 'bars', label: 'By stage',
      rows: [{ key: 'run', label: 'run', value: '$0.1200', share: 1 }, { key: 'review', label: 'review', value: '$0.0300', share: 0.25 }],
    })
    const rows = byId(app, 'bars-row')
    expect(rows.map((r) => [r.props['data-key'], r.props['data-share']])).toEqual([['run', 1], ['review', 0.25]])
    expect(byId(app, 'bars-value').map((n) => app.textOf(n))).toEqual(['$0.1200', '$0.0300'])
    expect(byId(app, 'bars')[0].props['aria-label']).toBe('By stage')
  })
})

describe('FleetAnalyticsSeriesLegend', () => {
  it('lists every series with money unchanged and shows a hostile label as text', () => {
    const app = mount('SeriesLegend.vue', {
      testid: 'legend',
      series: [
        { key: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>', folded: false, color: 'var(--chart-1)', costUsd: '0.0044', tokens: 1234 },
        { key: 'other', label: 'Other', folded: true, color: 'var(--chart-other)', costUsd: '0.0001', tokens: 5 },
      ],
    })
    const rows = byId(app, 'legend-row')
    expect(rows.map((r) => r.props['data-folded'])).toEqual(['false', 'true'])
    expect(app.text()).toContain('<img src=x onerror=alert(1)>')
    expect(app.text()).toContain('$0.0044')
    expect(app.text()).toContain('1,234')
  })
})

describe('FleetAnalyticsChartDataTable', () => {
  it('renders a captioned table with one row per bucket', () => {
    const app = mount('ChartDataTable.vue', {
      testid: 'data', caption: 'Spend over time', columns: ['m1', 'm1'],
      rows: [{ key: '1', label: '10-01', cells: ['$0.0044', '$0.0000'] }, { key: '2', label: '10-02', cells: ['$0.0000', '$0.0000'] }],
    })
    expect(byId(app, 'data-row')).toHaveLength(2)
    expect(app.text()).toContain('Show data')
    expect(app.text()).toContain('Spend over time')
  })
})

describe('FleetAnalyticsSummaryTiles', () => {
  it('shows each tile value as given', () => {
    const app = mount('SummaryTiles.vue', { tiles: [{ id: 'spend', label: 'Total spend', value: '$0.1334' }, { id: 'median', label: 'Median', value: '-' }] })
    expect(app.textOf(byId(app, 'fleet-analytics-tile-spend')[0])).toContain('$0.1334')
    expect(app.textOf(byId(app, 'fleet-analytics-tile-median-value')[0])).toBe('-')
  })
})

describe('FleetAnalyticsRangePicker (D392)', () => {
  it('emits a preset and marks the active one', () => {
    const app = mount('RangePicker.vue', { modelValue: { kind: 'preset', days: 30 } })
    expect(byId(app, 'fleet-analytics-range-30')[0].props['aria-pressed']).toBe(true)
    byId(app, 'fleet-analytics-range-7')[0].props.onClick()
    expect(app.emitted('update:modelValue')).toEqual([[{ kind: 'preset', days: 7 }]])
  })

  it('opens the custom inputs and emits both dates on apply', async () => {
    const app = mount('RangePicker.vue', { modelValue: { kind: 'preset', days: 30 } })
    expect(byId(app, 'fleet-analytics-range-from')).toHaveLength(0)
    byId(app, 'fleet-analytics-range-custom')[0].props.onClick()
    await nextTick()
    byId(app, 'fleet-analytics-range-from')[0].props.onInput({ target: { value: '2026-09-01' } })
    byId(app, 'fleet-analytics-range-to')[0].props.onInput({ target: { value: '2026-09-30' } })
    await nextTick()
    byId(app, 'fleet-analytics-range-apply')[0].props.onClick()
    expect(app.emitted('update:modelValue')).toEqual([[{ kind: 'custom', from: '2026-09-01', to: '2026-09-30' }]])
  })

  it('starts open on a custom range and shows the invalid message', () => {
    const app = mount('RangePicker.vue', { modelValue: { kind: 'custom', from: '2026-10-02', to: '2026-10-01' }, invalid: true })
    expect(byId(app, 'fleet-analytics-range-from')[0].props.value).toBe('2026-10-02')
    expect(byId(app, 'fleet-analytics-range-invalid')).toHaveLength(1)
  })
})
