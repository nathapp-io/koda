import { describe, expect, it } from '@jest/globals'
import { DEFAULT_RANGE, parseGroup, parseRange, rangeWindow, routeQuery } from '~/lib/fleet-analytics-range'
import { ADMIN_GROUPS, PROJECT_GROUPS } from '~/lib/fleet-analytics-types'

const now = new Date('2026-10-05T12:00:00.000Z')

describe('parseRange (D392)', () => {
  it('reads a preset, defaulting to 30 days', () => {
    expect(parseRange({})).toEqual(DEFAULT_RANGE)
    expect(parseRange({ range: '7' })).toEqual({ kind: 'preset', days: 7 })
    expect(parseRange({ range: ['90'] })).toEqual({ kind: 'preset', days: 90 })
  })

  it('falls back to the default for anything else', () => {
    expect(parseRange({ range: 'abc' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ range: '14' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ range: null })).toEqual(DEFAULT_RANGE)
  })

  it('reads a custom range only when both dates are real calendar dates', () => {
    expect(parseRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' })
    expect(parseRange({ from: '2026-13-40', to: '2026-09-30' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ from: '2026-02-30', to: '2026-03-01' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ from: '2026-09-01', range: '7' })).toEqual({ kind: 'preset', days: 7 })
  })
})

describe('rangeWindow (D392)', () => {
  it('turns a preset into the N days ending now', () => {
    expect(rangeWindow({ kind: 'preset', days: 30 }, now)).toEqual({ ok: true, from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' })
  })

  it('sends a custom end date as the next day, exclusive', () => {
    expect(rangeWindow({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' }, now)).toEqual({ ok: true, from: '2026-09-01', to: '2026-10-01' })
    expect(rangeWindow({ kind: 'custom', from: '2026-09-30', to: '2026-09-30' }, now)).toEqual({ ok: true, from: '2026-09-30', to: '2026-10-01' })
  })

  it('refuses a reversed range and one longer than 366 days', () => {
    expect(rangeWindow({ kind: 'custom', from: '2026-10-02', to: '2026-10-01' }, now)).toEqual({ ok: false })
    expect(rangeWindow({ kind: 'custom', from: '2025-01-01', to: '2026-01-01' }, now).ok).toBe(true)
    expect(rangeWindow({ kind: 'custom', from: '2025-01-01', to: '2026-01-02' }, now)).toEqual({ ok: false })
  })
})

describe('parseGroup', () => {
  it('accepts only the allowed groups', () => {
    expect(parseGroup('stage', PROJECT_GROUPS, 'model')).toBe('stage')
    expect(parseGroup(['feature'], PROJECT_GROUPS, 'model')).toBe('feature')
    expect(parseGroup('project', PROJECT_GROUPS, 'model')).toBe('model')
    expect(parseGroup('project', ADMIN_GROUPS, 'project')).toBe('project')
    expect(parseGroup('bogus', PROJECT_GROUPS, 'model')).toBe('model')
    expect(parseGroup(undefined, PROJECT_GROUPS, 'model')).toBe('model')
  })
})

describe('routeQuery', () => {
  it('omits defaults so the plain URL stays plain', () => {
    expect(routeQuery(DEFAULT_RANGE, 'model', 'model')).toEqual({})
    expect(routeQuery({ kind: 'preset', days: 7 }, 'stage', 'model')).toEqual({ range: '7', group: 'stage' })
    expect(routeQuery({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' }, 'model', 'model')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })
})
