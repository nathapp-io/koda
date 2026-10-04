import { describe, expect, test } from '@jest/globals'
import {
  EMPTY_LOG_FILTERS, entriesQuery, hasActiveFilter, logViewQuery, parseLogViewQuery, type LogViewParams,
} from '~/lib/fleet-log-query'

const params = (over: Partial<LogViewParams> = {}): LogViewParams => ({ stream: 'run', epoch: null, filters: EMPTY_LOG_FILTERS, ...over })

describe('parseLogViewQuery (spec §4.1 URL filters)', () => {
  test('an empty query is the run stream, latest attempt, no filters', () => {
    expect(parseLogViewQuery({})).toEqual(params())
  })

  test('reads every field, taking the first value of an array and trimming', () => {
    expect(parseLogViewQuery({ stream: 'stderr', epoch: '2', level: 'warn', story: [' US-001 ', 'US-002'], stage: 'run', role: 'implementer', q: ' Boom ' }))
      .toEqual(params({ stream: 'stderr', epoch: 2, filters: { level: 'warn', storyId: 'US-001', stage: 'run', role: 'implementer', q: 'Boom' } }))
  })

  test('unknown stream or level and a bad epoch fall back to defaults instead of failing', () => {
    expect(parseLogViewQuery({ stream: 'plan', level: 'trace', epoch: '-1' })).toEqual(params())
    expect(parseLogViewQuery({ epoch: '1.5' }).epoch).toBeNull()
    expect(parseLogViewQuery({ epoch: '9999999999' }).epoch).toBeNull()
    expect(parseLogViewQuery({ epoch: null }).epoch).toBeNull()
  })

  test('over-long values are cut to the API limits, so a hand-edited URL never answers 400', () => {
    const p = parseLogViewQuery({ story: 'x'.repeat(300), q: 'y'.repeat(300) })
    expect(p.filters.storyId).toHaveLength(128)
    expect(p.filters.q).toHaveLength(256)
  })
})

describe('parseLogViewQuery cuts never split a character (final review #6)', () => {
  test('an emoji across the 256th position is dropped whole, so the value still URL-encodes', () => {
    const p = parseLogViewQuery({ q: `${'a'.repeat(255)}\u{1F600}`, story: `${'s'.repeat(127)}\u{1F600}` })
    expect(p.filters.q).toBe('a'.repeat(255))
    expect(p.filters.storyId).toBe('s'.repeat(127))
    expect(() => encodeURIComponent(p.filters.q)).not.toThrow()
  })
})

describe('logViewQuery', () => {
  test('round-trips through parseLogViewQuery, omitting defaults', () => {
    const p = params({ stream: 'stdout', epoch: 0, filters: { ...EMPTY_LOG_FILTERS, q: 'err' } })
    expect(logViewQuery(p)).toEqual({ stream: 'stdout', epoch: '0', q: 'err' })
    expect(parseLogViewQuery(logViewQuery(p))).toEqual(p)
    expect(logViewQuery(params())).toEqual({})
  })
})

describe('entriesQuery (spec §3.3)', () => {
  const run = params({ filters: { level: 'info', storyId: 'US-1', stage: 'verify', role: 'tester', q: 'x' } })

  test('the run stream sends every set filter, the epoch and the page', () => {
    expect(entriesQuery(run, 3, { direction: 'forward', cursor: 120, limit: 200 })).toEqual({
      direction: 'forward', limit: '200', cursor: '120', leaseEpoch: '3', level: 'info', storyId: 'US-1', stage: 'verify', role: 'tester', q: 'x',
    })
  })

  test('stdout/stderr send only q; no cursor and no epoch are omitted', () => {
    expect(entriesQuery({ ...run, stream: 'stderr' }, null, { direction: 'backward', limit: 200 }))
      .toEqual({ direction: 'backward', limit: '200', q: 'x' })
  })

  test('hasActiveFilter ignores run-only filters on stdout/stderr', () => {
    const levelOnly = { ...EMPTY_LOG_FILTERS, level: 'warn' as const }
    expect(hasActiveFilter('run', levelOnly)).toBe(true)
    expect(hasActiveFilter('stdout', levelOnly)).toBe(false)
    expect(hasActiveFilter('stdout', { ...EMPTY_LOG_FILTERS, q: 'a' })).toBe(true)
    expect(hasActiveFilter('run', EMPTY_LOG_FILTERS)).toBe(false)
  })
})
