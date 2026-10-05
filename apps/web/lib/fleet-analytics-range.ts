/** D392: the analytics window and grouping live in the URL; malformed values fall back silently. */

export type RangePreset = 7 | 30 | 90
export type RangeState = { kind: 'preset'; days: RangePreset } | { kind: 'custom'; from: string; to: string }
export type RangeWindow = { ok: true; from: string; to: string } | { ok: false }

export const RANGE_PRESETS: readonly RangePreset[] = [7, 30, 90]
export const DEFAULT_RANGE: RangeState = { kind: 'preset', days: 30 }
export const MAX_WINDOW_DAYS = 366

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A vue-router query value: a string, null, or an array of them. */
function first(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not). */
function isDate(s: string): boolean {
  if (!DATE.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}

export function parseRange(query: Readonly<Record<string, unknown>>): RangeState {
  const from = first(query.from)
  const to = first(query.to)
  if (from !== undefined && to !== undefined && isDate(from) && isDate(to)) return { kind: 'custom', from, to }
  const days = Number(first(query.range))
  const preset = RANGE_PRESETS.find((p) => p === days)
  return preset === undefined ? DEFAULT_RANGE : { kind: 'preset', days: preset }
}

/** What the API gets: a preset is the N days ending now; a custom `to` is inclusive here, exclusive on the wire. */
export function rangeWindow(state: RangeState, now: Date): RangeWindow {
  if (state.kind === 'preset') {
    return { ok: true, from: new Date(now.getTime() - state.days * DAY_MS).toISOString(), to: now.toISOString() }
  }
  const from = Date.parse(`${state.from}T00:00:00Z`)
  const toExclusive = Date.parse(`${state.to}T00:00:00Z`) + DAY_MS
  const span = toExclusive - from
  if (!Number.isFinite(span) || span <= 0 || span > MAX_WINDOW_DAYS * DAY_MS) return { ok: false }
  return { ok: true, from: state.from, to: new Date(toExclusive).toISOString().slice(0, 10) }
}

export function parseGroup<G extends string>(value: unknown, allowed: readonly G[], fallback: G): G {
  const v = first(value)
  const match = allowed.find((g) => g === v)
  return match ?? fallback
}

/** The URL query for a state; defaults are omitted. */
export function routeQuery(state: RangeState, group: string, defaultGroup: string): Record<string, string> {
  const range: Record<string, string> = state.kind === 'custom'
    ? { from: state.from, to: state.to }
    : state.days === 30 ? {} : { range: String(state.days) }
  return group === defaultGroup ? range : { ...range, group }
}
