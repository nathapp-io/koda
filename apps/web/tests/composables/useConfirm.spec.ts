import { afterEach, describe, expect, test } from '@jest/globals'
import { useConfirm } from '../../composables/useConfirm'

afterEach(() => {
  useConfirm().settle(false)
})

describe('useConfirm', () => {
  test('AC-1: resolves true when confirmed', async () => {
    const result = useConfirm().confirm({ title: 'T' })
    useConfirm().settle(true)
    await expect(result).resolves.toBe(true)
  })

  test('AC-2: resolves false when cancelled', async () => {
    const result = useConfirm().confirm({ title: 'T' })
    useConfirm().settle(false)
    await expect(result).resolves.toBe(false)
  })

  test('AC-3: replacing a pending request cancels it and publishes the newer options', async () => {
    const first = useConfirm().confirm({ title: 'A' })
    const second = useConfirm().confirm({ title: 'B' })
    await expect(first).resolves.toBe(false)
    expect(useConfirm().current.value?.title).toBe('B')
    useConfirm().settle(false)
    await expect(second).resolves.toBe(false)
  })

  test('AC-4: settling without a pending request leaves current null', () => {
    useConfirm().settle(true)
    expect(useConfirm().current.value).toBeNull()
  })
})
