import { describe, expect, jest, test } from '@jest/globals'
import { startLogDownload } from '~/lib/fleet-log-download'

/** A promise the test settles by hand, so the probe's timing is the test's to control. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

describe('startLogDownload (K17)', () => {
  test('calls probe before open', async () => {
    const order: string[] = []
    const probeGate = gate()
    const done = startLogDownload('/api/dl/run/1', {
      probe: async () => {
        order.push('probe')
        await probeGate.promise
      },
      open: () => { order.push('open') },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(order).toEqual(['probe'])
    probeGate.resolve()
    await done
    expect(order).toEqual(['probe', 'open'])
  })

  test('a resolved probe opens the href once', async () => {
    const probe = jest.fn(async () => ({ attempts: [] }))
    const open = jest.fn()
    await startLogDownload('/api/dl/run/1?download=1&leaseEpoch=1', { probe, open })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('/api/dl/run/1?download=1&leaseEpoch=1')
  })

  test('a rejected probe rejects with the same error and never opens', async () => {
    const err = new Error('401 Unauthorized')
    const open = jest.fn()
    await expect(startLogDownload('/api/dl/run/1', { probe: async () => { throw err }, open })).rejects.toBe(err)
    expect(open).not.toHaveBeenCalled()
  })
})
