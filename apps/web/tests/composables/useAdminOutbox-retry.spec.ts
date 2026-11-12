import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useAdminOutbox.ts')
const pendingRequest = { id: 'approval-1', permissionKey: 'outbox.retry' }

describe('useAdminOutbox retry', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('AC-1: retry posts using the row id', async () => {
    const post = jest.fn(async () => undefined)
    const runtime = globalThis as Record<string, unknown>
    runtime.useApi = () => ({ $api: { get: jest.fn(), post } })
    const { useAdminOutbox } = await import(composablePath)
    await useAdminOutbox().retry('row-1')
    expect(post).toHaveBeenCalledWith('/admin/outbox/row-1/retry')
  })

  test('AC-2: empty retry answer is completed', async () => {
    const runtime = globalThis as Record<string, unknown>
    runtime.useApi = () => ({ $api: { get: jest.fn(), post: jest.fn(async () => undefined) } })
    const { useAdminOutbox } = await import(composablePath)
    await expect(useAdminOutbox().retry('row-1')).resolves.toEqual({ kind: 'retried' })
  })

  test('AC-3: permissionKey answer is preserved as a pending approval request', async () => {
    const runtime = globalThis as Record<string, unknown>
    runtime.useApi = () => ({ $api: { get: jest.fn(), post: jest.fn(async () => pendingRequest) } })
    const { useAdminOutbox } = await import(composablePath)
    await expect(useAdminOutbox().retry('row-1')).resolves.toEqual({ kind: 'pending', request: pendingRequest })
  })
})
