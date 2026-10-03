import { describe, expect, jest, test } from '@jest/globals'
import { createCountdownClock } from '../../composables/useApprovalCountdown'

describe('createCountdownClock (D292)', () => {
  test('ticks once a second after start and stops cleanly', () => {
    jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00.000Z') })
    const clock = createCountdownClock()
    clock.start()
    jest.advanceTimersByTime(3000)
    expect(clock.now.value.toISOString()).toBe('2026-10-03T10:00:03.000Z')
    clock.stop()
    jest.advanceTimersByTime(5000)
    expect(clock.now.value.toISOString()).toBe('2026-10-03T10:00:03.000Z')
    jest.useRealTimers()
  })

  test('start twice keeps one timer; stop before start is harmless', () => {
    const set = jest.fn(() => 1)
    const clear = jest.fn()
    const clock = createCountdownClock({ set, clear })
    clock.stop()
    clock.start()
    clock.start()
    clock.stop()
    expect(set).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
