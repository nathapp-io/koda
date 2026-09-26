import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { createDebouncer } from '~/lib/debounce'

describe('createDebouncer', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('runs once after the quiet period, however many triggers', () => {
    const fn = jest.fn()
    const d = createDebouncer(fn, 300)
    d.trigger()
    jest.advanceTimersByTime(200)
    d.trigger()
    jest.advanceTimersByTime(299)
    expect(fn).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('cancel drops a pending run', () => {
    const fn = jest.fn()
    const d = createDebouncer(fn, 300)
    d.trigger()
    d.cancel()
    jest.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})
