import { describe, expect, test } from '@jest/globals'
import type { FleetJobLogEntriesDto, FleetJobLogEntryDto, FleetJobLogStreamDto } from '~/lib/fleet-log-types'
import { formatBytes, isNearBottom, levelVariant, logNotices, logRowView, logTime, MAX_LOG_ROWS, openedView, withEarlier, withLater } from '~/lib/fleet-log-view'

/** Lines of 10 bytes each: line i spans [10 i, 10 i + 10). */
const line = (i: number): FleetJobLogEntryDto => ({ offset: i * 10, length: 10, text: `line ${i}` })
const lines = (from: number, to: number): FleetJobLogEntryDto[] => Array.from({ length: to - from }, (_, k) => line(from + k))
const page = (over: Partial<FleetJobLogEntriesDto>): FleetJobLogEntriesDto => ({
  entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: false, size: 0, complete: false, truncated: false, ...over,
})

describe('openedView (spec §4.1 opening)', () => {
  test('backward from the end: head is the page cursor, tail the visible end', () => {
    const v = openedView(page({ entries: lines(5, 8), nextCursor: 50, scannedFrom: 50, scannedTo: 80, atEnd: false, size: 85 }))
    expect(v).toMatchObject({ head: 50, atStart: false, tail: 80, atEnd: true, size: 85, searching: null })
    expect(v.rows.map((r) => r.offset)).toEqual([50, 60, 70])
  })

  test('a filtered opening that matched nothing and is not at offset 0 offers backward searching', () => {
    const v = openedView(page({ entries: [], nextCursor: 40, scannedFrom: 40, scannedTo: 80, atEnd: false, size: 80 }))
    expect(v.searching).toEqual({ direction: 'backward', scannedFrom: 40, scannedTo: 80 })
  })
})

describe('withLater / withEarlier', () => {
  const opened = openedView(page({ entries: lines(5, 8), nextCursor: 50, scannedFrom: 50, scannedTo: 80, size: 80 }))

  test('a forward page appends, moves tail, takes the newest size/complete/truncated', () => {
    const v = withLater(opened, page({ entries: lines(8, 10), nextCursor: 100, scannedFrom: 80, scannedTo: 100, atEnd: true, size: 100, complete: true }))
    expect(v.rows.map((r) => r.offset)).toEqual([50, 60, 70, 80, 90])
    expect(v).toMatchObject({ tail: 100, atEnd: true, complete: true, size: 100, head: 50 })
  })

  test('a forward page never duplicates a row already shown (an overlapping refetch)', () => {
    const v = withLater(opened, page({ entries: lines(7, 9), nextCursor: 90, atEnd: true, size: 90 }))
    expect(v.rows.map((r) => r.offset)).toEqual([50, 60, 70, 80])
  })

  test('a forward page that matched nothing before the end offers forward searching from scannedTo', () => {
    const v = withLater(opened, page({ entries: [], nextCursor: 2_097_232, scannedFrom: 80, scannedTo: 2_097_232, atEnd: false, size: 9_000_000 }))
    expect(v.searching).toEqual({ direction: 'forward', scannedFrom: 80, scannedTo: 2_097_232 })
    expect(v.tail).toBe(2_097_232)
  })

  test('a backward page prepends and moves head; atStart follows the page', () => {
    const v = withEarlier(opened, page({ entries: lines(0, 5), nextCursor: 0, scannedFrom: 0, scannedTo: 50, atEnd: true, size: 80 }))
    expect(v.rows.map((r) => r.offset)).toEqual([0, 10, 20, 30, 40, 50, 60, 70])
    expect(v).toMatchObject({ head: 0, atStart: true, tail: 80, atEnd: true })
  })

  test(`past ${MAX_LOG_ROWS} rows a forward page evicts from the start and re-opens Load earlier`, () => {
    const full = { ...opened, rows: lines(0, MAX_LOG_ROWS), head: 0, atStart: true, tail: MAX_LOG_ROWS * 10 }
    const v = withLater(full, page({ entries: lines(MAX_LOG_ROWS, MAX_LOG_ROWS + 3), nextCursor: (MAX_LOG_ROWS + 3) * 10, atEnd: true }))
    expect(v.rows).toHaveLength(MAX_LOG_ROWS)
    expect(v.rows[0].offset).toBe(30)
    expect(v).toMatchObject({ head: 30, atStart: false })
  })

  test(`past ${MAX_LOG_ROWS} rows a backward page evicts from the end and re-opens Load more`, () => {
    const full = { ...opened, rows: lines(3, MAX_LOG_ROWS + 3), head: 30, atStart: false, tail: (MAX_LOG_ROWS + 3) * 10, atEnd: true }
    const v = withEarlier(full, page({ entries: lines(0, 3), nextCursor: 0, atEnd: true }))
    expect(v.rows).toHaveLength(MAX_LOG_ROWS)
    expect(v.rows[v.rows.length - 1].offset).toBe((MAX_LOG_ROWS - 1) * 10)
    expect(v).toMatchObject({ tail: MAX_LOG_ROWS * 10, atEnd: false, head: 0, atStart: true })
  })
})

describe('logNotices (spec §4.1)', () => {
  const summary = (over: Partial<FleetJobLogStreamDto> = {}): FleetJobLogStreamDto => ({
    stream: 'run', sizeBytes: 100, complete: true, truncated: false, source: 'stream', expired: false, updatedAt: 'x', ...over,
  })
  const base = { summary: summary(), legacySampled: false, view: null, jobTerminal: true, expired: false }

  test('a complete streamed log has no notice', () => {
    expect(logNotices(base)).toEqual([])
  })

  test('each notice on its own', () => {
    expect(logNotices({ ...base, summary: summary({ source: 'bundle' }) })).toEqual([{ key: 'bundle' }])
    expect(logNotices({ ...base, summary: summary({ truncated: true, complete: false }) })).toEqual([{ key: 'truncated' }])
    expect(logNotices({ ...base, summary: summary({ complete: false, sizeBytes: 42 }) })).toEqual([{ key: 'incomplete', size: 42 }])
    expect(logNotices({ ...base, summary: null, legacySampled: true })).toEqual([{ key: 'legacy' }])
  })

  test('expired (row or a 410) hides every other notice', () => {
    expect(logNotices({ ...base, summary: summary({ expired: true, source: 'bundle' }) })).toEqual([{ key: 'expired' }])
    expect(logNotices({ ...base, summary: null, expired: true })).toEqual([{ key: 'expired' }])
  })

  test('incomplete only once the job is terminal; the fresher page wins over the list', () => {
    expect(logNotices({ ...base, summary: summary({ complete: false }), jobTerminal: false })).toEqual([])
    expect(logNotices({ ...base, summary: summary({ complete: false }), view: { size: 7, complete: true, truncated: false } })).toEqual([])
    expect(logNotices({ ...base, summary: null, view: { size: 7, complete: false, truncated: false } })).toEqual([{ key: 'incomplete', size: 7 }])
  })
})

describe('formatBytes', () => {
  test.each([[0, '0 B'], [1023, '1023 B'], [1536, '1.5 KiB'], [268_435_456, '256.0 MiB']])('%d -> %s', (n, s) => {
    expect(formatBytes(n)).toBe(s)
  })
})

describe('row helpers (spec §4.1 rows)', () => {
  test('a parsed run entry keeps its fields as text; data becomes indented JSON', () => {
    const row = logRowView('run', { offset: 5, length: 9, timestamp: '2026-10-04T10:11:12.000Z', level: 'warn', stage: 's', storyId: 'US-1', sessionRole: 'r', message: 'm', data: { a: 1 } })
    const d = new Date('2026-10-04T10:11:12.000Z')
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(row).toEqual({
      kind: 'entry', offset: 5, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, timestamp: '2026-10-04T10:11:12.000Z',
      level: 'warn', stage: 's', storyId: 'US-1', role: 'r', message: 'm', data: '{\n  "a": 1\n}',
    })
  })

  test('an unparsed run line, a cut line and a stdout line are text rows', () => {
    expect(logRowView('run', { offset: 0, length: 4, unparsed: true, text: 'abc' })).toEqual({ kind: 'text', offset: 0, text: 'abc', unparsed: true, cut: false })
    expect(logRowView('run', { offset: 0, length: 4, unparsed: true, truncatedLine: true, text: 'abc' })).toMatchObject({ cut: true })
    expect(logRowView('stdout', { offset: 0, length: 4, text: 'abc' })).toEqual({ kind: 'text', offset: 0, text: 'abc', unparsed: false, cut: false })
  })

  test('logTime is empty for a missing or broken timestamp; no data is null, not "undefined"', () => {
    expect(logTime(undefined)).toBe('')
    expect(logTime('yesterday')).toBe('')
    expect(logRowView('run', { offset: 0, length: 1, level: 'info' })).toMatchObject({ data: null, time: '', message: '' })
  })

  test('levelVariant per level; isNearBottom within the slack', () => {
    expect(['error', 'warn', 'info', 'debug'].map(levelVariant)).toEqual(['destructive', 'default', 'secondary', 'outline'])
    expect(isNearBottom({ scrollTop: 880, clientHeight: 100, scrollHeight: 1000 })).toBe(true)
    expect(isNearBottom({ scrollTop: 800, clientHeight: 100, scrollHeight: 1000 })).toBe(false)
  })
})
