import { afterEach, describe, expect, jest, test } from '@jest/globals'

const globals = globalThis as Record<string, unknown>
afterEach(() => { delete globals.useApi })

describe('useApprovalRequests', () => {
  test('posts approve without a comment', async () => {
    const post = jest.fn(async () => ({}))
    globals.useApi = () => ({ $api: { post } })
    const { useApprovalRequests } = await import('../../composables/useApprovalRequests')

    await useApprovalRequests().decide('r1', 'approve')

    expect(post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'approve' })
  })

  test('posts a non-empty reject comment', async () => {
    const post = jest.fn(async () => ({}))
    globals.useApi = () => ({ $api: { post } })
    const { useApprovalRequests } = await import('../../composables/useApprovalRequests')

    await useApprovalRequests().decide('r1', 'reject', 'no')

    expect(post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'reject', comment: 'no' })
  })

  test('omits an empty reject comment', async () => {
    const post = jest.fn(async () => ({}))
    globals.useApi = () => ({ $api: { post } })
    const { useApprovalRequests } = await import('../../composables/useApprovalRequests')

    await useApprovalRequests().decide('r1', 'reject', '')

    expect(post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'reject' })
  })
})
