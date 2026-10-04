import type { FleetJobLogEntriesDto, FleetJobLogEntryDto, FleetJobLogStreamDto } from '~/lib/fleet-log-types'

/** Spec §4.1: at most this many rows in the DOM; loading past it evicts from the other end. */
export const MAX_LOG_ROWS = 5000

/** What the viewer has loaded of one stream of one attempt, and where its next pages start. */
export interface LogView {
  rows: readonly FleetJobLogEntryDto[]
  /** Backward cursor: the start of the earliest scanned line. */
  head: number
  /** No line before `head`. */
  atStart: boolean
  /** Forward cursor: the end of the last scanned complete line. */
  tail: number
  /** No complete line after `tail` (yet, while the stream grows). */
  atEnd: boolean
  size: number
  complete: boolean
  truncated: boolean
  /** The last page matched nothing and did not reach its boundary: offer "Keep searching" (spec §4.1, criterion 3). */
  searching: { direction: 'forward' | 'backward'; scannedFrom: number; scannedTo: number } | null
}

const endOf = (row: FleetJobLogEntryDto): number => row.offset + row.length

const searchingOf = (direction: 'forward' | 'backward', page: FleetJobLogEntriesDto): LogView['searching'] =>
  page.entries.length === 0 && !page.atEnd ? { direction, scannedFrom: page.scannedFrom, scannedTo: page.scannedTo } : null

/** The first page: backward from the visible end (spec §4.1 "Opening"). */
export function openedView(page: FleetJobLogEntriesDto): LogView {
  return {
    rows: page.entries,
    head: page.nextCursor,
    atStart: page.atEnd,
    tail: page.scannedTo,
    atEnd: true,
    size: page.size,
    complete: page.complete,
    truncated: page.truncated,
    searching: searchingOf('backward', page),
  }
}

/** A forward page: append after the last row; evict from the start past MAX_LOG_ROWS. */
export function withLater(view: LogView, page: FleetJobLogEntriesDto): LogView {
  const last = view.rows.length > 0 ? endOf(view.rows[view.rows.length - 1]) : -1
  const merged = [...view.rows, ...page.entries.filter((e) => e.offset >= last)]
  const kept = merged.length > MAX_LOG_ROWS ? merged.slice(merged.length - MAX_LOG_ROWS) : merged
  const evicted = kept.length < merged.length
  return {
    ...view,
    rows: kept,
    head: evicted ? kept[0].offset : view.head,
    atStart: evicted ? false : view.atStart,
    tail: Math.max(view.tail, page.nextCursor),
    atEnd: page.atEnd,
    size: page.size,
    complete: page.complete,
    truncated: page.truncated,
    searching: searchingOf('forward', page),
  }
}

/** A backward page: prepend before the first row; evict from the end past MAX_LOG_ROWS (follow is then off). */
export function withEarlier(view: LogView, page: FleetJobLogEntriesDto): LogView {
  const first = view.rows.length > 0 ? view.rows[0].offset : Number.POSITIVE_INFINITY
  const merged = [...page.entries.filter((e) => endOf(e) <= first), ...view.rows]
  const kept = merged.length > MAX_LOG_ROWS ? merged.slice(0, MAX_LOG_ROWS) : merged
  const evicted = kept.length < merged.length
  return {
    ...view,
    rows: kept,
    head: Math.min(view.head, page.nextCursor),
    atStart: page.atEnd,
    tail: evicted ? endOf(kept[kept.length - 1]) : view.tail,
    atEnd: evicted ? false : view.atEnd,
    size: page.size,
    complete: page.complete,
    truncated: page.truncated,
    searching: searchingOf('backward', page),
  }
}

export type LogNoticeKey = 'expired' | 'legacy' | 'bundle' | 'truncated' | 'incomplete'

export interface LogNotice {
  key: LogNoticeKey
  size?: number
}

export interface LogNoticeInput {
  /** The list route's row for this attempt and stream, when it has one. */
  summary: FleetJobLogStreamDto | null
  legacySampled: boolean
  /** The latest entries page (fresher than the list), when one loaded. */
  view: Pick<LogView, 'size' | 'complete' | 'truncated'> | null
  jobTerminal: boolean
  /** A read answered 410. */
  expired: boolean
}

/** Spec §4.1 notices, in display order. An expired stream shows only that. */
export function logNotices(input: LogNoticeInput): LogNotice[] {
  if (input.expired || input.summary?.expired === true) return [{ key: 'expired' }]
  const complete = input.view?.complete ?? input.summary?.complete ?? false
  const truncated = input.view?.truncated ?? input.summary?.truncated ?? false
  const size = input.view?.size ?? input.summary?.sizeBytes ?? 0
  const notices: LogNotice[] = []
  if (input.legacySampled) notices.push({ key: 'legacy' })
  if (input.summary?.source === 'bundle') notices.push({ key: 'bundle' })
  if (truncated) notices.push({ key: 'truncated' })
  else if (input.jobTerminal && !complete && !input.legacySampled) notices.push({ key: 'incomplete', size })
  return notices
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const

/** 1536 -> "1.5 KiB"; bytes stay whole. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} ${UNITS[0]}` : `${value.toFixed(1)} ${UNITS[unit]}`
}

/** One rendered row: a parsed nax LogEntry, or a text line (stdout/stderr, or an unparsed run line). */
export type LogRowView =
  | { kind: 'entry'; offset: number; time: string; timestamp: string; level: string; stage: string; storyId: string; role: string; message: string; data: string | null }
  | { kind: 'text'; offset: number; text: string; unparsed: boolean; cut: boolean }

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local HH:MM:SS of an ISO timestamp; '' when it does not parse. */
export function logTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `data` as indented JSON, for the expand panel; null when the entry has none. */
function dataText(data: unknown): string | null {
  if (data === undefined) return null
  try {
    return JSON.stringify(data, null, 2) ?? String(data)
  }
  catch {
    return String(data)
  }
}

/** Spec §4.1 rows. Every value is plain text; the template renders it with `{{ }}` only (never v-html). */
export function logRowView(stream: string, e: FleetJobLogEntryDto): LogRowView {
  if (stream !== 'run' || e.unparsed === true || e.level === undefined) {
    return { kind: 'text', offset: e.offset, text: e.text ?? '', unparsed: stream === 'run', cut: e.truncatedLine === true }
  }
  return {
    kind: 'entry', offset: e.offset, time: logTime(e.timestamp), timestamp: e.timestamp ?? '', level: e.level,
    stage: e.stage ?? '', storyId: e.storyId ?? '', role: e.sessionRole ?? '', message: e.message ?? '', data: dataText(e.data),
  }
}

/** Badge variant per level. */
export function levelVariant(level: string): 'destructive' | 'default' | 'secondary' | 'outline' {
  if (level === 'error') return 'destructive'
  if (level === 'warn') return 'default'
  if (level === 'info') return 'secondary'
  return 'outline'
}

/** Spec §4.1: scrolling away from the bottom turns follow off; within `slack` px counts as the bottom. */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}
