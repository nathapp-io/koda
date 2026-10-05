import { describe, expect, jest, test } from '@jest/globals'
import { watchVisible } from '~/composables/useRefetchOnVisible'

describe('watchVisible', () => {
  test('calls back each time the tab becomes visible until unsubscribed', () => {
    const hook: { visible?: () => void } = {}
    const off = jest.fn()
    const onVisible = jest.fn((fn: () => void) => { hook.visible = fn; return off })
    const fn = jest.fn()
    const stop = watchVisible(fn, { onVisible })
    hook.visible?.()
    hook.visible?.()
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
