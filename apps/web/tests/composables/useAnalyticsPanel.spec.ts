import { describe, expect, test } from '@jest/globals'
import { useAnalyticsPanel } from '~/composables/useAnalyticsPanel'

const deferred = <T>() => {
  let resolve: (v: T) => void = () => undefined
  let reject: (e: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useAnalyticsPanel (D393)', () => {
  test('goes loading -> ready, or empty when the data says so', async () => {
    let rows: number[] = [1]
    const panel = useAnalyticsPanel(async () => rows, (d) => d.length === 0)
    expect(panel.status.value).toBe('idle')
    const run = panel.run()
    expect(panel.status.value).toBe('loading')
    await run
    expect(panel.status.value).toBe('ready')
    expect(panel.data.value).toEqual([1])
    rows = []
    await panel.run()
    expect(panel.status.value).toBe('empty')
  })

  test('keeps the old data visible while a refetch loads', async () => {
    const next = deferred<number[]>()
    let calls = 0
    const panel = useAnalyticsPanel(async () => (calls++ === 0 ? [1] : next.promise), () => false)
    await panel.run()
    const again = panel.run()
    expect(panel.status.value).toBe('ready')
    expect(panel.data.value).toEqual([1])
    next.resolve([2])
    await again
    expect(panel.data.value).toEqual([2])
  })

  test('an error clears the data; a stale answer never overwrites a newer one', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    const queue = [slow.promise, fast.promise]
    const panel = useAnalyticsPanel(() => queue.shift() as Promise<string>, () => false)
    const first = panel.run()
    const second = panel.run()
    fast.resolve('new')
    await second
    slow.resolve('old')
    await first
    expect(panel.data.value).toBe('new')

    const failing = useAnalyticsPanel(async () => { throw new Error('500') }, () => false)
    await failing.run()
    expect(failing.status.value).toBe('error')
    expect(failing.data.value).toBeNull()
  })
})
