import { describe, expect, it } from '@jest/globals'
import {
  areaRows, assignSlots, chartSeries, costBars, countBars, crosshairHtml, escapeHtml, rateBars, rateHtml, rateRows,
  rateTableRows, slotColor, spendTableRows, OTHER_COLOR,
} from '~/lib/fleet-analytics-chart'
import type { SpendSeriesDto } from '~/lib/fleet-analytics-types'

const T1 = '2026-10-01T00:00:00.000Z'
const T2 = '2026-10-02T00:00:00.000Z'
const series = (key: string, costs: [string, string], over: Partial<SpendSeriesDto> = {}): SpendSeriesDto => ({
  key, label: key, folded: false, costUsd: costs[0], tokens: 10,
  points: [{ t: T1, costUsd: costs[0], tokens: 5 }, { t: T2, costUsd: costs[1], tokens: 5 }], ...over,
})

describe('assignSlots (D390)', () => {
  it('gives new keys the lowest free slots in order', () => {
    expect([...assignSlots(new Map(), ['a', 'b', 'c'])]).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })

  it('keeps a surviving key in its slot when the set changes, and frees the slots of keys that left', () => {
    const first = assignSlots(new Map(), ['a', 'b', 'c'])
    const next = assignSlots(first, ['c', 'd'])
    expect(next.get('c')).toBe(2)
    expect(next.get('d')).toBe(0)
    expect(next.has('a')).toBe(false)
  })

  it('never hands out more than 8 slots and does not mutate its input', () => {
    const prev = new Map([['a', 0]])
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`)
    const slots = assignSlots(prev, keys)
    expect(new Set(slots.values()).size).toBe(8)
    expect([...prev]).toEqual([['a', 0]])
  })
})

describe('chartSeries', () => {
  it('colors each series by its slot and the fold with the other color and label', () => {
    const slots = new Map([['m2', 3], ['m1', 0]])
    const out = chartSeries([series('m1', ['1.0000', '0']), series('m2', ['2', '0']), series('other', ['0.5000', '0'], { folded: true })], slots, 'Other')
    expect(out.map((s) => [s.key, s.label, s.color])).toEqual([['m1', 'm1', slotColor(0)], ['m2', 'm2', 'var(--chart-4)'], ['other', 'Other', OTHER_COLOR]])
  })
})

describe('areaRows and rateRows', () => {
  it('aligns every series on the bucket times, numbers for geometry and strings for text', () => {
    expect(areaRows([series('a', ['0.0044', '0.0000']), series('b', ['1.5000', '0.2500'])])).toEqual([
      { t: Date.parse(T1), values: [0.0044, 1.5], texts: ['0.0044', '1.5000'] },
      { t: Date.parse(T2), values: [0, 0.25], texts: ['0.0000', '0.2500'] },
    ])
  })

  it('returns no rows without series', () => {
    expect(areaRows([])).toEqual([])
  })

  it('keeps a null rate as a gap', () => {
    expect(rateRows([{ t: T1, rate: 0.5 }, { t: T2, rate: null }])).toEqual([
      { t: Date.parse(T1), rate: 0.5, text: '50.0%' },
      { t: Date.parse(T2), rate: undefined, text: '-' },
    ])
  })
})

describe('bars', () => {
  it('scales cost bars against the largest, labels the fold, keeps the money text unchanged', () => {
    expect(costBars([{ key: 'run', costUsd: '0.1200' }, { key: 'review', costUsd: '0.0300' }, { key: 'other', costUsd: '0.0000', folded: true }], 'Other')).toEqual([
      { key: 'run', label: 'run', value: '$0.1200', share: 1 },
      { key: 'review', label: 'review', value: '$0.0300', share: 0.25 },
      { key: 'other', label: 'Other', value: '$0.0000', share: 0 },
    ])
  })

  it('gives all-zero lists zero widths instead of NaN', () => {
    expect(countBars([{ key: 'opened', label: 'Opened', count: 0 }])).toEqual([{ key: 'opened', label: 'Opened', value: '0', share: 0 }])
  })

  it('uses the rate itself as the width for rate bars', () => {
    expect(rateBars([{ key: 'semantic', label: 'semantic', rate: 0.75, detail: '75.0% of 4' }, { key: 'x', label: 'x', rate: null, detail: '-' }])).toEqual([
      { key: 'semantic', label: 'semantic', value: '75.0% of 4', share: 0.75 },
      { key: 'x', label: 'x', value: '-', share: 0 },
    ])
  })
})

describe('tables', () => {
  it('lists one row per bucket with the money text of each series', () => {
    const rows = areaRows([series('a', ['0.0044', '0.0000'])])
    expect(spendTableRows(rows, 'day')).toEqual([
      { key: String(Date.parse(T1)), label: '10-01', cells: ['$0.0044'] },
      { key: String(Date.parse(T2)), label: '10-02', cells: ['$0.0000'] },
    ])
    expect(rateTableRows(rateRows([{ t: T1, rate: 0.5 }]), 'month')).toEqual([{ key: String(Date.parse(T1)), label: '2026-10', cells: ['50.0%'] }])
  })
})

describe('escaping (D398)', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')"> & co`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt; &amp; co')
  })

  it('never puts a raw label into the crosshair or rate tooltip', () => {
    const hostile = series('<img src=x onerror=alert(1)>', ['1.0000', '0'])
    const cs = chartSeries([hostile], new Map([[hostile.key, 0]]), 'Other')
    const html = crosshairHtml(areaRows([hostile])[0], cs, 'day')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('$1.0000')
    expect(html).toContain('10-01')
    expect(rateHtml(rateRows([{ t: T1, rate: 0.5 }])[0], 'day', '<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
