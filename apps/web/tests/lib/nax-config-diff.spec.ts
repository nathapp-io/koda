import { describe, expect, test } from '@jest/globals'
import { lineDiff } from '~/lib/nax-config-diff'

describe('lineDiff', () => {
  test('identical text is all same lines', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual({ lines: [{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }], approximate: false })
  })

  test('a changed middle line is one del and one add between same lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nX\nc').lines).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'X' }, { kind: 'same', text: 'c' },
    ])
  })

  test('a new file (empty before) is only adds; a deleted file (empty after) is only dels', () => {
    expect(lineDiff('', 'x\ny').lines).toEqual([{ kind: 'add', text: 'x' }, { kind: 'add', text: 'y' }])
    expect(lineDiff('x', '').lines).toEqual([{ kind: 'del', text: 'x' }])
  })

  test('an inserted line keeps the rest aligned', () => {
    expect(lineDiff('a\nc', 'a\nb\nc').lines.map((l) => l.kind)).toEqual(['same', 'add', 'same'])
  })

  test('a huge rewrite falls back to an approximate whole replacement', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n')
    const diff = lineDiff(before, after)
    expect(diff.approximate).toBe(true)
    expect(diff.lines.filter((l) => l.kind === 'del')).toHaveLength(2000)
    expect(diff.lines.filter((l) => l.kind === 'add')).toHaveLength(2000)
  })
})
