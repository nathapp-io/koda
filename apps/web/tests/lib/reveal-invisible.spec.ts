import { describe, expect, test } from '@jest/globals'
import { revealInvisible } from '../../lib/reveal-invisible'

describe('revealInvisible', () => {
  test('AC-1: reveals a right-to-left override', () => {
    expect(revealInvisible('rm -rf /tmp/\u202Ex')).toEqual({ text: 'rm -rf /tmp/<U+202E>x', count: 1 })
  })

  test('AC-2: reveals zero-width, word-joiner, isolate and BOM characters', () => {
    expect(revealInvisible('a\u200Bb\u200Dc\u2060d\u2066e\uFEFF')).toEqual({
      text: 'a<U+200B>b<U+200D>c<U+2060>d<U+2066>e<U+FEFF>', count: 5,
    })
  })

  test('AC-3: reveals control characters and DEL', () => {
    expect(revealInvisible('a\u0007b\u007Fc')).toEqual({ text: 'a<U+0007>b<U+007F>c', count: 2 })
  })

  test('AC-4: preserves tab and line feed', () => {
    expect(revealInvisible('a\tb\nc')).toEqual({ text: 'a\tb\nc', count: 0 })
  })

  test('AC-5: reveals Arabic letter mark, directional marks and carriage return', () => {
    expect(revealInvisible('\u061C\u200E\u200F\r')).toEqual({ text: '<U+061C><U+200E><U+200F><U+000D>', count: 4 })
  })
})
