import { describe, expect, it } from '@jest/globals'
import { mapLimit } from '~/lib/map-limit'

describe('mapLimit', () => {
  it('visits every item once, with at most `limit` in flight', async () => {
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      seen.push(n)
      inFlight -= 1
    })
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
  })

  it('keeps going after a rejection', async () => {
    const seen: number[] = []
    await mapLimit([1, 2, 3], 1, async (n) => {
      seen.push(n)
      if (n === 1) throw new Error('x')
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('does nothing for no items, and treats a limit below 1 as 1', async () => {
    await expect(mapLimit([], 4, async () => undefined)).resolves.toBeUndefined()
    const seen: number[] = []
    await mapLimit([1, 2], 0, async (n) => { seen.push(n) })
    expect(seen).toEqual([1, 2])
  })
})
