import { describe, expect, it } from '@jest/globals'
import { LABEL_PATTERN, MAX_LABELS, REPO_NAME_PATTERN, REPO_OWNER_PATTERN, parseLabels } from '~/lib/fleet-validation'

describe('parseLabels', () => {
  it('splits on commas and whitespace, trims, de-duplicates and sorts', () => {
    expect(parseLabels(' linux, gpu  mac,linux ')).toEqual({ ok: true, labels: ['gpu', 'linux', 'mac'] })
  })

  it('reads an empty or blank input as no labels', () => {
    expect(parseLabels('')).toEqual({ ok: true, labels: [] })
    expect(parseLabels(' ,  ')).toEqual({ ok: true, labels: [] })
  })

  it('reports the first label the API would reject, without changing its case', () => {
    expect(parseLabels('linux, GPU')).toEqual({ ok: false, error: 'invalid', label: 'GPU' })
    expect(parseLabels('-lead')).toEqual({ ok: false, error: 'invalid', label: '-lead' })
    expect(parseLabels('a'.repeat(33))).toEqual({ ok: false, error: 'invalid', label: 'a'.repeat(33) })
  })

  it('accepts the documented characters and the 32-character maximum', () => {
    expect(parseLabels('a.b_c-1 ' + 'z'.repeat(32))).toEqual({ ok: true, labels: ['a.b_c-1', 'z'.repeat(32)] })
  })

  it('refuses more than MAX_LABELS distinct labels', () => {
    const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`).join(',')
    expect(parseLabels(many)).toEqual({ ok: false, error: 'tooMany' })
    const max = Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`).join(',')
    expect(parseLabels(max).ok).toBe(true)
  })
})

describe('fleet patterns mirror the API DTOs', () => {
  it('LABEL_PATTERN', () => {
    expect(LABEL_PATTERN.test('gpu')).toBe(true)
    expect(LABEL_PATTERN.test('Gpu')).toBe(false)
  })

  it('REPO_OWNER_PATTERN allows GitLab subgroups, REPO_NAME_PATTERN does not allow slashes', () => {
    expect(REPO_OWNER_PATTERN.test('group/sub')).toBe(true)
    expect(REPO_OWNER_PATTERN.test('/group')).toBe(false)
    expect(REPO_NAME_PATTERN.test('koda.web')).toBe(true)
    expect(REPO_NAME_PATTERN.test('a/b')).toBe(false)
    expect(REPO_NAME_PATTERN.test('')).toBe(false)
  })
})
