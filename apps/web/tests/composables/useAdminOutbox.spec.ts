import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useAdminOutbox.ts')
const row = { id: 'row-1', type: 'ticket.updated', eventId: 'evt-1', payload: { secret: 's3' }, headers: {}, status: 'dead', attempts: 2, lastError: 'delivery failed' }

function withApi(get: jest.Mock): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
}

describe('useAdminOutbox', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('AC-1: initial load requests dead events explicitly', async () => {
    const get = jest.fn(async () => ({ items: [], total: 0 }))
    withApi(get)
    const { useAdminOutbox } = await import(composablePath)
    await useAdminOutbox().load()
    expect(get).toHaveBeenCalledWith('/admin/outbox', { query: { status: 'dead' } })
  })

  test('AC-2: load stores returned rows', async () => {
    const get = jest.fn(async () => ({ items: [row], total: 7 }))
    withApi(get)
    const { useAdminOutbox } = await import(composablePath)
    const outbox = useAdminOutbox()
    await outbox.load()
    expect(outbox.items.value).toEqual([row])
  })

  test('AC-3: load stores server total', async () => {
    const get = jest.fn(async () => ({ items: [row], total: 7 }))
    withApi(get)
    const { useAdminOutbox } = await import(composablePath)
    const outbox = useAdminOutbox()
    await outbox.load()
    expect(outbox.total.value).toBe(7)
  })
})
