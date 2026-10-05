import { bucketLabel, pct, usd } from '~/lib/fleet-analytics-format'
import type { AnalyticsBucket, SpendSeriesDto } from '~/lib/fleet-analytics-types'

/** D390: the dataviz reference palette has 8 categorical slots (`--chart-1`..`--chart-8`). */
export const SLOT_COUNT = 8
export const OTHER_COLOR = 'var(--chart-other)'

export function slotColor(slot: number): string {
  return `var(--chart-${slot + 1})`
}

/**
 * D390: color follows the entity. Keys still present keep their slot; keys that left free theirs; new keys take
 * the lowest free slot. More keys than slots leave the extra keys unassigned, and `chartSeries` would then reuse
 * the last slot for them: callers must keep at most 8 keys (the spend chart asks for top=7).
 */
export function assignSlots(prev: ReadonlyMap<string, number>, keys: readonly string[]): Map<string, number> {
  const present = new Set(keys)
  const kept = [...prev].filter(([key]) => present.has(key))
  const used = new Set(kept.map(([, slot]) => slot))
  const added: Array<[string, number]> = []
  for (const key of keys) {
    if (prev.has(key) || added.some(([k]) => k === key)) continue
    const free = Array.from({ length: SLOT_COUNT }, (_, i) => i).find((slot) => !used.has(slot))
    if (free === undefined) continue
    used.add(free)
    added.push([key, free])
  }
  return new Map([...kept, ...added])
}

export interface ChartSeries {
  key: string
  label: string
  folded: boolean
  color: string
  costUsd: string
  tokens: number
}

export function chartSeries(series: readonly SpendSeriesDto[], slots: ReadonlyMap<string, number>, otherLabel: string): ChartSeries[] {
  return series.map((s) => ({
    key: s.key,
    label: s.folded ? otherLabel : s.label,
    folded: s.folded,
    color: s.folded ? OTHER_COLOR : slotColor(slots.get(s.key) ?? SLOT_COUNT - 1),
    costUsd: s.costUsd,
    tokens: s.tokens,
  }))
}

/** One stacked-area row per bucket: numbers drive the geometry, the API strings are what text shows (A7). */
export interface AreaRow {
  t: number
  values: number[]
  texts: string[]
}

export function areaRows(series: readonly SpendSeriesDto[]): AreaRow[] {
  const first = series[0]
  if (!first) return []
  return first.points.map((p, i) => {
    const texts = series.map((s) => s.points[i]?.costUsd ?? '0.0000')
    return { t: Date.parse(p.t), values: texts.map((x) => Number(x)), texts }
  })
}

export interface RateRow {
  t: number
  /** undefined draws a gap */
  rate: number | undefined
  text: string
}

export function rateRows(points: ReadonlyArray<{ t: string; rate: number | null }>): RateRow[] {
  return points.map((p) => ({ t: Date.parse(p.t), rate: p.rate === null ? undefined : p.rate, text: pct(p.rate) }))
}

export interface BarRow {
  key: string
  label: string
  value: string
  /** 0..1 bar width */
  share: number
}

function relative(values: readonly number[]): number[] {
  const max = values.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0)
  return values.map((v) => (max > 0 && Number.isFinite(v) && v > 0 ? v / max : 0))
}

export function costBars(
  items: ReadonlyArray<{ key: string; label?: string; costUsd: string; folded?: boolean }>, otherLabel: string,
): BarRow[] {
  const shares = relative(items.map((i) => Number(i.costUsd)))
  return items.map((item, i) => ({
    key: item.key,
    label: item.folded ? otherLabel : (item.label ?? item.key),
    value: usd(item.costUsd),
    share: shares[i] ?? 0,
  }))
}

export function countBars(items: ReadonlyArray<{ key: string; label: string; count: number }>): BarRow[] {
  const shares = relative(items.map((i) => i.count))
  return items.map((item, i) => ({ key: item.key, label: item.label, value: String(item.count), share: shares[i] ?? 0 }))
}

export function rateBars(items: ReadonlyArray<{ key: string; label: string; rate: number | null; detail: string }>): BarRow[] {
  return items.map((item) => ({
    key: item.key,
    label: item.label,
    value: item.detail,
    share: item.rate !== null && Number.isFinite(item.rate) ? Math.min(Math.max(item.rate, 0), 1) : 0,
  }))
}

export interface TableRow {
  key: string
  label: string
  cells: string[]
}

export function spendTableRows(rows: readonly AreaRow[], bucket: AnalyticsBucket): TableRow[] {
  return rows.map((r) => ({ key: String(r.t), label: bucketLabel(r.t, bucket), cells: r.texts.map((x) => usd(x)) }))
}

export function rateTableRows(rows: readonly RateRow[], bucket: AnalyticsBucket): TableRow[] {
  return rows.map((r) => ({ key: String(r.t), label: bucketLabel(r.t, bucket), cells: [r.text] }))
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** D398: unovis inserts tooltip templates as HTML, and group keys come from uploaded bundles. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/** Colors are our own `var(--chart-N)` strings, never user text. */
export function crosshairHtml(row: AreaRow, series: readonly ChartSeries[], bucket: AnalyticsBucket): string {
  const lines = series.map((s, i) =>
    `<div><span style="color:${s.color}">&#9632;</span> ${escapeHtml(s.label)}: ${escapeHtml(usd(row.texts[i]))}</div>`)
  return `<div><strong>${escapeHtml(bucketLabel(row.t, bucket))}</strong>${lines.join('')}</div>`
}

export function rateHtml(row: RateRow, bucket: AnalyticsBucket, label: string): string {
  return `<div><strong>${escapeHtml(bucketLabel(row.t, bucket))}</strong><div>${escapeHtml(label)}: ${escapeHtml(row.text)}</div></div>`
}
