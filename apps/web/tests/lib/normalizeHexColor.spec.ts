import { describe, test, expect } from '@jest/globals'

const _webDir = '/Users/subrinaai/Desktop/workspace/subrina-coder/projects/koda/repos/koda/apps/web'

describe('normalizeHexColor', () => {
  test('normalizeHexColor function is exported from lib/utils', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    expect(typeof normalizeHexColor).toBe('function')
  })

  test('given user enters 6366f1, when normalizeHexColor runs, then output is #6366F1', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('6366f1')
    expect(result).toBe('#6366F1')
  })

  test('given user enters #abc, when normalizeHexColor runs, then output is #AABBCC', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('#abc')
    expect(result).toBe('#AABBCC')
  })

  test('given user enters #ABC, when normalizeHexColor runs, then output is #AABBCC (expands 3-char to 6-char)', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('#ABC')
    expect(result).toBe('#AABBCC')
  })

  test('given user enters #abcdef, when normalizeHexColor runs, then output is #ABCDEF', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('#abcdef')
    expect(result).toBe('#ABCDEF')
  })

  test('given user enters 123, when normalizeHexColor runs, then output is #123000 (pads to 6 chars)', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('123')
    expect(result).toBe('#123000')
  })

  test('given user enters #123, when normalizeHexColor runs, then output is #112233 (expands 3-char to 6-char)', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('#123')
    expect(result).toBe('#112233')
  })

  test('result always starts with #', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('ffffff')
    expect(result.startsWith('#')).toBe(true)
  })

  test('result is always uppercase', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('abcdef')
    expect(result).toBe(result.toUpperCase())
  })

  test('result always has exactly 7 characters (# followed by 6 hex digits)', async () => {
    const { normalizeHexColor } = await import('~/lib/utils')
    const result = normalizeHexColor('123456')
    expect(result.length).toBe(7)
    expect(/^#[0-9A-F]{6}$/.test(result)).toBe(true)
  })
})
