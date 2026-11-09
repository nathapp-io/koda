import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import type { ApprovalRequestSummary } from '../../lib/approval-requests'

const composablePath = join(__dirname, '../..', 'composables', 'useThreadPreApproval.ts')
const request = { id: 'a1', permissionKey: 'fleet.thread.preapprove' } as ApprovalRequestSummary
function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useThreadPreApproval', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('set puts the cost cap on the encoded thread route', async () => {
    const put = jest.fn(async () => ({ userId: 'u1', at: '2026-01-01T00:00:00Z', costCapUsd: '3.0000' }))
    withApi({ put })
    const { useThreadPreApproval } = await import(composablePath)
    await useThreadPreApproval('web').set('t1', 3)
    expect(put).toHaveBeenCalledWith('/projects/web/threads/t1/preapproval', { costCapUsd: 3 })
  })

  test('set maps a tick response to done', async () => {
    const put = jest.fn(async () => ({ userId: 'u1', at: '2026-01-01T00:00:00Z', costCapUsd: '3.0000' }))
    withApi({ put })
    const { useThreadPreApproval } = await import(composablePath)
    expect(await useThreadPreApproval('web').set('t1', 3)).toEqual({ kind: 'done' })
  })

  test('clear deletes on the thread route', async () => {
    const delete_ = jest.fn(async () => ({ cleared: true }))
    withApi({ delete: delete_ })
    const { useThreadPreApproval } = await import(composablePath)
    await useThreadPreApproval('web').clear('t1')
    expect(delete_).toHaveBeenCalledWith('/projects/web/threads/t1/preapproval')
  })

  test('clear maps a cleared response to done', async () => {
    const delete_ = jest.fn(async () => ({ cleared: true }))
    withApi({ delete: delete_ })
    const { useThreadPreApproval } = await import(composablePath)
    expect(await useThreadPreApproval('web').clear('t1')).toEqual({ kind: 'done' })
  })

  test('set maps an approval answer to pending', async () => {
    const put = jest.fn(async () => request)
    withApi({ put })
    const { useThreadPreApproval } = await import(composablePath)
    expect(await useThreadPreApproval('web').set('t1', 3)).toEqual({ kind: 'pending', request })
  })

  test('clear maps an approval answer to pending', async () => {
    const delete_ = jest.fn(async () => request)
    withApi({ delete: delete_ })
    const { useThreadPreApproval } = await import(composablePath)
    expect(await useThreadPreApproval('web').clear('t1')).toEqual({ kind: 'pending', request })
  })

  test('set rejects with the identical API error object', async () => {
    const error = new Error('set failed')
    const put = jest.fn(async () => { throw error })
    withApi({ put })
    const { useThreadPreApproval } = await import(composablePath)
    await expect(useThreadPreApproval('web').set('t1', 3)).rejects.toBe(error)
  })

  test('clear rejects with the identical API error object', async () => {
    const error = new Error('clear failed')
    const delete_ = jest.fn(async () => { throw error })
    withApi({ delete: delete_ })
    const { useThreadPreApproval } = await import(composablePath)
    await expect(useThreadPreApproval('web').clear('t1')).rejects.toBe(error)
  })
})
