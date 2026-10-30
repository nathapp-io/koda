import { afterEach, describe, expect, jest, test } from '@jest/globals'
import type { ApprovalRequestDetail, ApprovalRequestSummary } from '~/lib/approval-requests'

type Fn = (...args: unknown[]) => Promise<unknown>
function install(api: { get?: Fn; post?: Fn }) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}
afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

async function fresh() {
  jest.resetModules()
  return import('~/composables/useApprovalInbox')
}

const summary = (over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id: 'r1',
  permissionKey: 'label.create',
  projectId: 'p1',
  actorType: 'AGENT',
  actorId: 'a1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'api',
  redeem: true,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-11-01T00:00:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-30T00:00:00.000Z',
  ...over,
})

const detail = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => ({
  ...summary(over),
  input: null,
  result: null,
  details: null,
  decisions: [],
  ...over,
})

const page = (records: ApprovalRequestSummary[], over: Record<string, unknown> = {}) => ({
  total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records, ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-12 — the decide request
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-12: decide posts the engine decision body', () => {
  test('AC-12: approve with a comment goes to /approvals/r1/decisions with that body', async () => {
    const post = jest.fn(async () => detail({ status: 'executed' }))
    install({ post })
    const { useApprovalInbox } = await fresh()

    await useApprovalInbox().decide('r1', { decision: 'approve', comment: 'ok' })

    expect(post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'approve', comment: 'ok' })
  })

  test('AC-12 (edge): a blank comment is trimmed away, not sent', async () => {
    const post = jest.fn(async () => detail())
    install({ post })
    const { useApprovalInbox } = await fresh()

    await useApprovalInbox().decide('r1', { decision: 'reject', comment: '   ' })

    expect(post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'reject' })
  })

  test('AC-12 (edge): a comment is trimmed and the body is a copy, with params forwarded', async () => {
    const post = jest.fn(async () => detail())
    install({ post })
    const { useApprovalInbox } = await fresh()
    const body = { decision: 'approve' as const, comment: '  ok  ', params: { choice: 'allow' } }

    await useApprovalInbox().decide('r1', body)

    expect(post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'approve', comment: 'ok', params: { choice: 'allow' } })
    expect(post.mock.calls[0][1]).not.toBe(body)
  })

  test('AC-12 (edge): the request id is escaped and a success bumps approvalRequestsVersion', async () => {
    const post = jest.fn(async () => detail())
    install({ post })
    const { useApprovalInbox, approvalRequestsVersion } = await fresh()
    const before = approvalRequestsVersion.value

    await useApprovalInbox().decide('r/1', { decision: 'approve' })

    expect(post).toHaveBeenCalledWith('/approvals/r%2F1/decisions', { decision: 'approve' })
    expect(approvalRequestsVersion.value).toBe(before + 1)
  })

  test('AC-12 (edge): a refused decide changes nothing', async () => {
    install({ post: jest.fn(async () => { throw new Error('403') }) })
    const { useApprovalInbox, approvalRequestsVersion } = await fresh()
    const before = approvalRequestsVersion.value

    await expect(useApprovalInbox().decide('r1', { decision: 'reject' })).rejects.toThrow('403')
    expect(approvalRequestsVersion.value).toBe(before)
  })

  test('AC-12 (edge): cancel posts to the cancel route and bumps the version', async () => {
    const post = jest.fn(async () => detail({ status: 'cancelled' }))
    install({ post })
    const { useApprovalInbox, approvalRequestsVersion } = await fresh()
    const before = approvalRequestsVersion.value

    const cancelled = await useApprovalInbox().cancel('r1')

    expect(post).toHaveBeenCalledWith('/approvals/r1/cancel')
    expect(cancelled.status).toBe('cancelled')
    expect(approvalRequestsVersion.value).toBe(before + 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-13 — listDetailed details only the first rows
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-13: listDetailed fetches details for the first `limit` rows only', () => {
  test('AC-13: three records with limit 2 leave the third row without a detail', async () => {
    const records = [summary({ id: 'r1' }), summary({ id: 'r2' }), summary({ id: 'r3' })]
    const get = jest.fn(async (path: string) => (path === '/approvals' ? page(records) : detail({ id: path.split('/').pop() ?? '' })))
    install({ get })
    const { useApprovalInbox } = await fresh()

    const rows = await useApprovalInbox().listDetailed({ status: 'pending' }, 2)

    expect(rows.map((row) => row.request.id)).toEqual(['r1', 'r2', 'r3'])
    expect(rows.map((row) => row.detail?.id ?? null)).toEqual(['r1', 'r2', null])
    expect(get).toHaveBeenCalledWith('/approvals', { query: { status: 'pending', size: '100' } })
    expect(get.mock.calls.filter(([path]) => path !== '/approvals')).toHaveLength(2)
  })

  test('AC-13 (edge): a failed detail fetch leaves that row without a detail, the others render', async () => {
    const records = [summary({ id: 'r1' }), summary({ id: 'r2' })]
    const get = jest.fn(async (path: string) => {
      if (path === '/approvals') return page(records)
      if (path === '/approvals/r1') throw new Error('404')
      return detail({ id: 'r2' })
    })
    install({ get })
    const { useApprovalInbox } = await fresh()

    const rows = await useApprovalInbox().listDetailed({ status: 'pending' })

    expect(rows[0].detail).toBeNull()
    expect(rows[1].detail?.id).toBe('r2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The rest of the client: the list, its pager, counts and one job's rows
// ─────────────────────────────────────────────────────────────────────────────

describe('useApprovalInbox: the list', () => {
  test('list sends the built query and keeps the pager metadata', async () => {
    const get = jest.fn(async () => page([summary()], { total: 42, current: 2, size: 20, hasNext: true, hasPrev: true }))
    install({ get })
    const { useApprovalInbox } = await fresh()
    const inbox = useApprovalInbox()

    const answered = await inbox.list({ tab: 'all', page: 2, projectId: 'p1' })

    expect(get).toHaveBeenCalledWith('/approvals', { query: { size: '20', current: '2', projectId: 'p1' } })
    expect(answered.records.map((r) => r.id)).toEqual(['r1'])
    expect(inbox.total.value).toBe(42)
    expect(inbox.page.value).toBe(2)
    expect(inbox.size.value).toBe(20)
    expect(inbox.hasNext.value).toBe(true)
    expect(inbox.hasPrev.value).toBe(true)
    expect(inbox.requests.value.map((r) => r.id)).toEqual(['r1'])
  })

  test('list tolerates an answer without a pager, and a failure changes no state', async () => {
    const get = jest.fn(async () => ({ records: [summary()] }))
    install({ get })
    const { useApprovalInbox } = await fresh()
    const inbox = useApprovalInbox()
    await inbox.list({ tab: 'pending' })
    expect(inbox.page.value).toBe(1)
    expect(inbox.requests.value.map((r) => r.id)).toEqual(['r1'])
    expect(inbox.hasNext.value).toBe(false)

    const failing = jest.fn(async () => { throw new Error('500') })
    install({ get: failing })
    const other = useApprovalInbox()
    await expect(other.list({ tab: 'pending' })).rejects.toThrow('500')
    expect(other.requests.value).toEqual([])
  })

  test('get reads one request detail', async () => {
    const get = jest.fn(async () => detail())
    install({ get })
    const { useApprovalInbox } = await fresh()

    expect((await useApprovalInbox().get('r1')).id).toBe('r1')

    expect(get).toHaveBeenCalledWith('/approvals/r1')
  })
})

describe('useApprovalInbox: counts', () => {
  test('counts answers the totals and keeps the last one; a stale answer is not stored', async () => {
    const answers: Array<(value: unknown) => void> = []
    const get = jest.fn(() => new Promise((resolve) => { answers.push(resolve) }))
    install({ get })
    const { useApprovalInbox } = await fresh()
    const inbox = useApprovalInbox()

    const first = inbox.counts()
    const second = inbox.counts()
    answers[1]({ total: 2, unscoped: 0, projects: [] })
    await second
    answers[0]({ total: 9, unscoped: 0, projects: [] })
    await first

    expect(get).toHaveBeenCalledWith('/approvals/counts')
    expect(inbox.requestCounts.value?.total).toBe(2)
  })
})

describe('useApprovalInbox: listForJob', () => {
  test('AC-2: a settled row listed before a pending one comes back after it', async () => {
    const records = [
      summary({ id: 'settled', status: 'executed', expiresAt: null, createdAt: '2026-10-30T10:00:00.000Z' }),
      summary({ id: 'open', status: 'pending', expiresAt: '2026-11-01T00:00:00.000Z' }),
    ]
    const get = jest.fn(async (path: string) => (path === '/approvals' ? page(records) : detail({ id: path.split('/').pop() ?? '' })))
    install({ get })
    const { useApprovalInbox } = await fresh()

    const rows = await useApprovalInbox().listForJob('j1')

    expect(rows.map((row) => row.request.id)).toEqual(['open', 'settled'])
  })

  test('reads one job\'s requests in one page of 100, pending first by soonest expiry', async () => {
    const records = [
      summary({ id: 'settled', status: 'executed', expiresAt: null, createdAt: '2026-10-30T10:00:00.000Z' }),
      summary({ id: 'later', expiresAt: '2026-11-02T00:00:00.000Z' }),
      summary({ id: 'sooner', expiresAt: '2026-11-01T00:00:00.000Z' }),
    ]
    const get = jest.fn(async (path: string) => (path === '/approvals' ? page(records) : detail({ id: path.split('/').pop() ?? '' })))
    install({ get })
    const { useApprovalInbox } = await fresh()

    const rows = await useApprovalInbox().listForJob('j1')

    expect(get.mock.calls[0]).toEqual(['/approvals', { query: { jobId: 'j1', size: '100' } }])
    expect(rows.map((row) => row.request.id)).toEqual(['sooner', 'later', 'settled'])
    expect(rows.every((row) => row.detail !== null)).toBe(true)
  })

  test('details only the first 20 rows and keeps the rest as summaries', async () => {
    const records = Array.from({ length: 22 }, (_, index) => summary({ id: `r${index}`, createdAt: `2026-10-30T00:${String(index).padStart(2, '0')}:00.000Z` }))
    const get = jest.fn(async (path: string) => (path === '/approvals' ? page(records) : detail({ id: path.split('/').pop() ?? '' })))
    install({ get })
    const { useApprovalInbox } = await fresh()

    const rows = await useApprovalInbox().listForJob('j1')

    expect(rows).toHaveLength(22)
    expect(rows.filter((row) => row.detail === null)).toHaveLength(2)
    expect(get.mock.calls.filter(([path]) => path !== '/approvals')).toHaveLength(20)
  })
})
