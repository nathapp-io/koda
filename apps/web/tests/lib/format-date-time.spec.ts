import { describe, expect, test } from '@jest/globals'
import { formatDateTime } from '../../lib/format-date-time'

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
