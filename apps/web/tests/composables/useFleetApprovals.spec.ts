import { describe, test, expect, jest, afterEach } from '@jest/globals'
import type { FleetApprovalDto } from '../../lib/fleet-types'

type Fn = (...args: unknown[]) => Promise<unknown>
function install(api: { get?: Fn; post?: Fn }) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}
afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

async function fresh() {
  jest.resetModules()
  return import('../../composables/useFleetApprovals')
}

const row = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol', payload: {},
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null,
  decidedAt: null, resolvedBy: null, comment: null, ...over,
})
const page = (records: FleetApprovalDto[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })

describe('useFleetApprovals', () => {
  test('paths for both bases, slug and id encoded', async () => {
    const { approvalRoot, approvalItem } = await fresh()
    expect(approvalRoot({ kind: 'admin' })).toBe('/fleet/approvals')
    expect(approvalRoot({ kind: 'project', slug: 'a b' })).toBe('/projects/a%20b/fleet/approvals')
    expect(approvalItem({ kind: 'admin' }, 'x/y')).toBe('/fleet/approvals/x%2Fy')
    expect(approvalItem({ kind: 'project', slug: 'k' }, 'i')).toBe('/projects/k/fleet/approvals/i')
  })

  test('load sends the tab query and sorts pending rows', async () => {
    const get = jest.fn(async () => page([row('b'), row('x', { expiresAt: '2026-10-03T10:05:00.000Z' })], { hasNext: true }))
    install({ get })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'project', slug: 'koda' })
    expect(await api.load({ tab: 'pending' })).toBe(true)
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { status: 'pending', size: '100' } })
    expect(api.approvals.value.map((a) => a.id)).toEqual(['x', 'b'])
    expect(api.hasNext.value).toBe(true)
  })

  test('the All tab keeps the server order', async () => {
    install({ get: jest.fn(async () => page([row('b'), row('x', { expiresAt: '2026-10-03T10:05:00.000Z' })])) })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'admin' })
    await api.load({ tab: 'all', page: 1 })
    expect(api.approvals.value.map((a) => a.id)).toEqual(['b', 'x'])
  })

  test('a load that started before a decide is dropped (D249)', async () => {
    let release: (value: unknown) => void = () => undefined
    const get = jest.fn(() => new Promise((resolve) => { release = resolve }))
    const post = jest.fn(async () => row('a', { status: 'approved' }))
    install({ get, post })
    const { useFleetApprovals, approvalsVersion } = await fresh()
    const api = useFleetApprovals({ kind: 'admin' })
    api.approvals.value = [row('a')]
    const loading = api.load({ tab: 'pending' })
    await api.decide('a', { decision: 'keep_paused' })
    release(page([row('a')]))
    expect(await loading).toBe(false)
    expect(api.approvals.value[0].status).toBe('approved')
    expect(approvalsVersion.value).toBe(1)
  })

  test('decide posts to the decide route with a copy of the body', async () => {
    const post = jest.fn(async () => row('a', { status: 'approved' }))
    install({ post })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'project', slug: 'koda' })
    const body = { decision: 'raise_budget_and_resume' as const, amountUsd: 2, requeueJobIds: ['j1'] }
    await api.decide('a', body)
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a/decide', body)
    expect(post.mock.calls[0][1]).not.toBe(body)
  })

  test('a failed decide changes nothing', async () => {
    install({ post: jest.fn(async () => { throw new Error('409') }) })
    const { useFleetApprovals, approvalsVersion } = await fresh()
    const api = useFleetApprovals({ kind: 'admin' })
    api.approvals.value = [row('a')]
    await expect(api.decide('a', { decision: 'keep_paused' })).rejects.toThrow('409')
    expect(api.approvals.value[0].status).toBe('pending')
    expect(approvalsVersion.value).toBe(0)
  })

  test('listForJob reads one job\'s approvals, one page of 100 (D297)', async () => {
    const get = jest.fn(async () => page([row('b1', { type: 'nax_bash_escalate', jobId: 'j1' })]))
    install({ get })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'project', slug: 'koda' })
    expect((await api.listForJob('j1')).map((a) => a.id)).toEqual(['b1'])
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { jobId: 'j1', size: '100' } })
  })
})

describe('useFleetApprovalCounts', () => {
  test('loads the counts; a stale answer is dropped', async () => {
    const answers: Array<(v: unknown) => void> = []
    install({ get: jest.fn(() => new Promise((resolve) => { answers.push(resolve) })) })
    const { useFleetApprovalCounts } = await fresh()
    const c = useFleetApprovalCounts()
    const first = c.load()
    const second = c.load()
    answers[1]({ total: 2, unscoped: 0, projects: [] })
    await second
    answers[0]({ total: 9, unscoped: 0, projects: [] })
    await first
    expect(c.counts.value?.total).toBe(2)
  })
})
