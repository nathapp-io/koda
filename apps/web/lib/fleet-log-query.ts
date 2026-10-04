import { isLogLevel, isLogStream, type LogLevel, type LogStream } from '~/lib/fleet-log-types'

/** Run-stream filters (spec §3.3); stdout/stderr use `q` only. An empty string is "not set". */
export interface LogFilters {
  level: LogLevel | null
  storyId: string
  stage: string
  role: string
  q: string
}

/** Everything the viewer URL carries (spec §4.1: filters live in the URL query). */
export interface LogViewParams {
  stream: LogStream
  /** null: the latest attempt (the list's first, else the job's current epoch). */
  epoch: number | null
  filters: LogFilters
}

export const EMPTY_LOG_FILTERS: LogFilters = { level: null, storyId: '', stage: '', role: '', q: '' }
/** The API caps these at 128 (story, stage, role) and 256 (q) characters (1c `LogEntriesQuery`). */
const MAX_FIELD = 128
const MAX_Q = 256

type QueryValue = string | null | undefined | ReadonlyArray<string | null>

/** A route query value: the first string of an array, trimmed; anything else is ''. */
function first(value: QueryValue): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair (encodeURIComponent throws on one). */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

function epochOf(value: QueryValue): number | null {
  const raw = first(value)
  if (!/^\d{1,9}$/.test(raw)) return null
  return Number(raw)
}

/** Lenient: an unknown stream or level, or a bad epoch, falls back to the default instead of failing the page. */
export function parseLogViewQuery(query: Record<string, QueryValue>): LogViewParams {
  const stream = first(query.stream)
  const level = first(query.level)
  return {
    stream: isLogStream(stream) ? stream : 'run',
    epoch: epochOf(query.epoch),
    filters: {
      level: isLogLevel(level) ? level : null,
      storyId: cut(first(query.story), MAX_FIELD),
      stage: cut(first(query.stage), MAX_FIELD),
      role: cut(first(query.role), MAX_FIELD),
      q: cut(first(query.q), MAX_Q),
    },
  }
}

/** The URL query for the params: only set values; the default stream is omitted. */
export function logViewQuery(p: LogViewParams): Record<string, string> {
  const pairs: Array<[string, string]> = [
    ['stream', p.stream === 'run' ? '' : p.stream],
    ['epoch', p.epoch === null ? '' : String(p.epoch)],
    ['level', p.filters.level ?? ''],
    ['story', p.filters.storyId],
    ['stage', p.filters.stage],
    ['role', p.filters.role],
    ['q', p.filters.q],
  ]
  return Object.fromEntries(pairs.filter(([, value]) => value.length > 0))
}

/** stdout/stderr ignore the run-only filters (spec §3.3), so they never reach the API or count as active. */
export function effectiveFilters(stream: LogStream, filters: LogFilters): LogFilters {
  return stream === 'run' ? filters : { ...EMPTY_LOG_FILTERS, q: filters.q }
}

export function hasActiveFilter(stream: LogStream, filters: LogFilters): boolean {
  const f = effectiveFilters(stream, filters)
  return f.level !== null || f.storyId !== '' || f.stage !== '' || f.role !== '' || f.q !== ''
}

export interface EntriesPageRequest {
  direction: 'forward' | 'backward'
  /** Omitted: forward from 0, backward from the visible end. */
  cursor?: number
  limit: number
}

/** The entries route query (spec §3.3). The epoch is always sent once known, so a requeue never switches attempts. */
export function entriesQuery(p: LogViewParams, epoch: number | null, page: EntriesPageRequest): Record<string, string> {
  const f = effectiveFilters(p.stream, p.filters)
  const pairs: Array<[string, string]> = [
    ['direction', page.direction],
    ['limit', String(page.limit)],
    ['cursor', page.cursor === undefined ? '' : String(page.cursor)],
    ['leaseEpoch', epoch === null ? '' : String(epoch)],
    ['level', f.level ?? ''],
    ['storyId', f.storyId],
    ['stage', f.stage],
    ['role', f.role],
    ['q', f.q],
  ]
  return Object.fromEntries(pairs.filter(([, value]) => value.length > 0))
}
