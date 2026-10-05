import type { AnalyticsBucket } from '~/lib/fleet-analytics-types'

/** D391, A7: the API's 4-place money string, unchanged, with a dollar sign; `-` when missing. */
export function usd(s: string | null | undefined): string {
  return s === null || s === undefined || s === '' ? '-' : `$${s}`
}

/** A 0..1 rate as a percentage with one decimal; `-` when null or not a number. */
export function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? '-' : `${(rate * 100).toFixed(1)}%`
}

const TOKENS = new Intl.NumberFormat('en-US')

export function tokenText(n: number): string {
  return TOKENS.format(n)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Locale-neutral bucket text in UTC: `MM-DD` for day and week buckets, `YYYY-MM` for months. */
export function bucketLabel(t: string | number, bucket: AnalyticsBucket): string {
  const d = new Date(t)
  return bucket === 'month'
    ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
    : `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Axis ticks only (geometry, never a shown total): 2 places from a dollar up, 4 below. */
export function axisUsd(v: number): string {
  if (v === 0) return '$0'
  return `$${v.toFixed(Math.abs(v) >= 1 ? 2 : 4)}`
}

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

const INGEST_VARIANTS = new Map<string, BadgeVariant>([
  ['done', 'secondary'], ['partial', 'outline'], ['failed', 'destructive'], ['pending', 'outline'], ['running', 'outline'],
])

/** Ingest status -> Badge variant (a Map: an untrusted status such as `constructor` cannot hit the prototype). */
export function ingestVariant(status: string): BadgeVariant {
  return INGEST_VARIANTS.get(status) ?? 'outline'
}

export function timeText(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '-'
}

/** The bundle files ingest could not fully read (`deleted` is the delete-on-demand marker, D384). */
export function skippedFiles(files: Readonly<Record<string, string>>): string {
  return Object.entries(files)
    .filter(([name, outcome]) => name !== 'deleted' && outcome !== 'done' && outcome !== 'absent')
    .map(([name, outcome]) => `${name} (${outcome})`)
    .join(', ')
}
