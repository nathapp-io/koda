import { describe, expect, test } from '@jest/globals'
import { isHttpUrl } from '../../lib/safe-url'

describe('isHttpUrl', () => {
  test('accepts HTTP(S) URLs with a dotted domain or IPv4 host', () => {
    expect(isHttpUrl('https://example.com/pull/1')).toBe(true)
    expect(isHttpUrl('http://10.0.0.5/x')).toBe(true)
  })

  test('rejects hosts without a top-level domain', () => {
    expect(isHttpUrl('http://localhost:8030/x')).toBe(false)
  })

  test('rejects non-HTTP schemes', () => {
    expect(isHttpUrl('ftp://example.com/a')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
  })

  test('rejects scheme-less and empty values', () => {
    expect(isHttpUrl('example.com/pull/1')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})
