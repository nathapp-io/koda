import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { useVisiblePolling } from '~/composables/useVisiblePolling'
import type { PollingDeps } from '~/composables/useVisiblePolling'

function fakeBrowser(hidden: boolean) {
  const state = { hidden, onVisible: null as (() => void) | null }
  const deps: PollingDeps = {
    isHidden: () => state.hidden,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    onVisible: (fn) => {
      state.onVisible = fn
      return () => { state.onVisible = null }
    },
  }
  return { state, deps }
}

describe('useVisiblePolling', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  test('runs the task once per interval while the tab is visible', async () => {
    const task = jest.fn(async () => undefined)
    const polling = useVisiblePolling(task, 15_000, fakeBrowser(false).deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(45_000)

    expect(task).toHaveBeenCalledTimes(3)
  })

  test('skips ticks while hidden and runs at once when the tab becomes visible', async () => {
    const task = jest.fn(async () => undefined)
    const browser = fakeBrowser(true)
    const polling = useVisiblePolling(task, 15_000, browser.deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(45_000)
    expect(task).not.toHaveBeenCalled()

    browser.state.hidden = false
    browser.state.onVisible?.()
    await jest.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  test('stop halts the timer and drops the visibility listener', async () => {
    const task = jest.fn(async () => undefined)
    const browser = fakeBrowser(false)
    const polling = useVisiblePolling(task, 15_000, browser.deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(15_000)
    polling.stop()
    await jest.advanceTimersByTimeAsync(45_000)

    expect(task).toHaveBeenCalledTimes(1)
    expect(browser.state.onVisible).toBeNull()
    expect(polling.isActive()).toBe(false)
  })

  test('a rejected run does not stop the polling', async () => {
    const task = jest.fn(async () => { throw new Error('API down') })
    const polling = useVisiblePolling(task, 15_000, fakeBrowser(false).deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(30_000)

    expect(task).toHaveBeenCalledTimes(2)
  })

  test('never overlaps: ticks and runNow during a slow run are skipped', async () => {
    let release: () => void = () => undefined
    const task = jest.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const polling = useVisiblePolling(task, 15_000, fakeBrowser(false).deps)

    polling.start()
    polling.start() // idempotent: still one timer
    await jest.advanceTimersByTimeAsync(15_000)
    await polling.runNow()
    await jest.advanceTimersByTimeAsync(30_000)
    expect(task).toHaveBeenCalledTimes(1)

    release()
    await jest.advanceTimersByTimeAsync(15_000)
    expect(task).toHaveBeenCalledTimes(2)
  })
})
