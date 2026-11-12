import { describe, expect, test } from '@jest/globals'
import { formatDate, formatDateTime } from '../../lib/format-date-time'

describe('formatDate', () => {
  test('formats date-only values and preserves invalid input', () => {
    const value = formatDate('2026-11-10T14:07:45.657Z', 'en')
    expect(value).toContain('Nov')
    expect(value).toContain('2026')
    expect(value).not.toMatch(/14:07|02:07|T14/)
    expect(formatDate('not-a-date', 'en')).toBe('not-a-date')
  })
})

describe('formatDateTime', () => {
  test('formats valid dates for the requested locale', () => {
    const value = formatDateTime('2026-11-10T14:07:45.657Z', 'en')
    expect(value).toContain('Nov')
    expect(value).toContain('2026')
    expect(value).not.toContain('T14')
  })

  test('returns invalid date input unchanged', () => {
    expect(formatDateTime('now', 'en')).toBe('now')
  })
})
