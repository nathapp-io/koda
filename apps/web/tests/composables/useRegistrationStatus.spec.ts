import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useRegistrationStatus.ts')

function withApi(get: jest.Mock) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
}

describe('useRegistrationStatus', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('reads { open } from /auth/registration-status', async () => {
    const get = jest.fn(async () => ({ open: true }))
    withApi(get)
    const { useRegistrationStatus } = await import(composablePath)
    const status = useRegistrationStatus()

    await status.load()

    expect(get).toHaveBeenCalledWith('/auth/registration-status')
    expect(status.open.value).toBe(true)
    expect(status.loaded.value).toBe(true)
  })

  test('a failed probe reads as closed', async () => {
    withApi(jest.fn(async () => { throw new Error('down') }))
    const { useRegistrationStatus } = await import(composablePath)
    const status = useRegistrationStatus()

    await status.load()

    expect(status.open.value).toBe(false)
    expect(status.loaded.value).toBe(true)
  })
})
