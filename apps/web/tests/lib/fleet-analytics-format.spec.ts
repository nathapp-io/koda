import { describe, expect, it } from '@jest/globals'
import { axisUsd, bucketLabel, ingestVariant, pct, skippedFiles, timeText, tokenText, usd } from '~/lib/fleet-analytics-format'

describe('usd (A7, D391)', () => {
  it('prefixes the API string unchanged and dashes a missing value', () => {
    expect(usd('0.0044')).toBe('$0.0044')
    expect(usd('12.3400')).toBe('$12.3400')
    expect(usd(null)).toBe('-')
    expect(usd(undefined)).toBe('-')
    expect(usd('')).toBe('-')
  })
})

describe('pct', () => {
  it('shows a rate with one decimal and dashes null or non-finite', () => {
    expect(pct(0.4567)).toBe('45.7%')
    expect(pct(1)).toBe('100.0%')
    expect(pct(0)).toBe('0.0%')
    expect(pct(null)).toBe('-')
    expect(pct(Number.NaN)).toBe('-')
  })
})

describe('tokenText', () => {
  it('groups thousands', () => {
    expect(tokenText(1234567)).toBe('1,234,567')
    expect(tokenText(0)).toBe('0')
  })
})

describe('bucketLabel', () => {
  it('labels day and week buckets MM-DD and month buckets YYYY-MM, in UTC', () => {
    expect(bucketLabel('2026-10-05T00:00:00.000Z', 'day')).toBe('10-05')
    expect(bucketLabel(Date.parse('2026-09-28T00:00:00.000Z'), 'week')).toBe('09-28')
    expect(bucketLabel('2026-10-01T00:00:00.000Z', 'month')).toBe('2026-10')
  })
})

describe('axisUsd', () => {
  it('uses 2 places from a dollar up and 4 below', () => {
    expect(axisUsd(0)).toBe('$0')
    expect(axisUsd(2.5)).toBe('$2.50')
    expect(axisUsd(0.0044)).toBe('$0.0044')
  })
})

describe('ingest helpers', () => {
  it('maps ingest statuses to badge variants, unknown to outline', () => {
    expect(ingestVariant('done')).toBe('secondary')
    expect(ingestVariant('failed')).toBe('destructive')
    expect(ingestVariant('partial')).toBe('outline')
    expect(ingestVariant('constructor')).toBe('outline')
  })

  it('lists only the files that were not done or absent, never the delete marker', () => {
    expect(skippedFiles({ cost: 'done', metrics: 'absent', review: 'skipped:v3', finish: 'capped', deleted: '2026-10-01T00:00:00.000Z' }))
      .toBe('review (skipped:v3), finish (capped)')
    expect(skippedFiles({ cost: 'done' })).toBe('')
  })

  it('dashes a missing time', () => {
    expect(timeText(null)).toBe('-')
    expect(timeText(undefined)).toBe('-')
    expect(timeText('2026-10-05T12:00:00.000Z')).not.toBe('-')
  })
})
