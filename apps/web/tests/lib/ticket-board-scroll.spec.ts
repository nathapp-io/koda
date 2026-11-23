import { describe, expect, test } from '@jest/globals'
import { boardScrollHints } from '../../lib/ticket-board-scroll'

describe('boardScrollHints', () => {
  test('AC-1: shows only the right hint when content extends to the right', () => {
    expect(boardScrollHints({ scrollLeft: 0, clientWidth: 1168, scrollWidth: 1800 }))
      .toEqual({ left: false, right: true })
  })

  test('AC-2: shows only the left hint when scrolled to the right edge', () => {
    expect(boardScrollHints({ scrollLeft: 632, clientWidth: 1168, scrollWidth: 1800 }))
      .toEqual({ left: true, right: false })
  })

  test('AC-3: hides both hints when all content fits', () => {
    expect(boardScrollHints({ scrollLeft: 0, clientWidth: 1800, scrollWidth: 1800 }))
      .toEqual({ left: false, right: false })
  })

  test('non-finite measurements disable only the affected hint', () => {
    expect(boardScrollHints({ scrollLeft: Number.NaN, clientWidth: 100, scrollWidth: 200 }))
      .toEqual({ left: false, right: false })
    expect(boardScrollHints({ scrollLeft: 0, clientWidth: Number.POSITIVE_INFINITY, scrollWidth: 200 }))
      .toEqual({ left: false, right: false })
  })
})
