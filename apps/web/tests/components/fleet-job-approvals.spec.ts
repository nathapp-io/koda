import { describe, expect, test } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { ApprovalDecisionRecord, ApprovalRequestDetail, ApprovalRequestSummary } from '../../lib/approval-requests'
import type { JobApprovalRow } from '../../composables/useApprovalInbox'

// P3b US-007: the job page's approvals section reads the approval engine's rows, not the fleet DTO.
const section = webFile('components', 'fleet', 'JobApprovals.vue')
const NOW = new Date('2026-10-03T10:05:00.000Z')
const COMMAND = 'git push --force origin HEAD'

const request = (id: string, over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id,
  permissionKey: 'fleet.job.shell.escalate',
  projectId: 'p1',
  actorType: 'AGENT',
  actorId: 'runner-1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'fleet',
  redeem: false,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-10-03T10:10:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-03T10:00:00.000Z',
  ...over,
})

/** The frozen bash payload `GET /approvals/:id` answers for a `fleet.job.shell.escalate` request. */
const bashInput = (command = COMMAND): unknown => ({
  payload: {
    command, commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
    storyId: null, featureName: 'login', reason: 'r', options: ['allow', 'deny'],
  },
})

const decision = (over: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord => ({
  id: 'd1', deciderType: 'USER', deciderId: 'u1', decision: 'approve', comment: null, params: null,
  decidedAt: '2026-10-03T10:02:00.000Z', ...over,
})

const detail = (summary: ApprovalRequestSummary, over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => ({
  ...summary,
  input: bashInput(),
  result: null,
  details: { jobId: 'j1' },
  decisions: [],
  ...over,
})

const row = (summary: ApprovalRequestSummary, fetched: ApprovalRequestDetail | null): JobApprovalRow =>
  ({ request: summary, detail: fetched })

function mount(approvals: JobApprovalRow[]) {
  const app = mountSfc(section, {
    components: uiStubs,
    props: { slug: 'koda', approvals, now: NOW },
    globals: { computed, useI18n: () => enI18n() },
  })
  return { app, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('FleetJobApprovals (D297, P3b US-007)', () => {
  test('AC-3: a row whose detail holds a bash payload shows that payload\'s commandPreview', () => {
    const m = mount([row(request('b1'), detail(request('b1')))])
    expect(m.app.textOf(m.byId('fleet-job-approval-b1')[0])).toContain(COMMAND)
    m.app.unmount()
  })

  test('AC-6: a row without a detail shows its raw permissionKey, even where a label exists', () => {
    // `approvals.keys.fleet_budget_override` translates this key; the row must not use it.
    const m = mount([row(request('b1', { permissionKey: 'fleet.budget.override' }), null)])
    const text = m.app.textOf(m.byId('fleet-job-approval-b1')[0])
    expect(text).toContain('fleet.budget.override')
    expect(text).not.toContain('Fleet budget override')
    m.app.unmount()
  })

  test('AC-5: every row links to its engine inbox row, detailed or not', () => {
    const m = mount([
      row(request('b1'), detail(request('b1'))),
      row(request('b2'), null),
    ])
    expect(m.byId('fleet-job-approval-open-b1')[0].props.to).toBe('/koda/approvals?id=b1')
    expect(m.byId('fleet-job-approval-open-b2')[0].props.to).toBe('/koda/approvals?id=b2')
    m.app.unmount()
  })

  test('one row per request: status label, decision, countdown only while pending', () => {
    const settled = request('b1', { status: 'approved', decidedAt: '2026-10-03T10:02:00.000Z', settledAt: '2026-10-03T10:02:00.000Z' })
    const m = mount([
      row(request('b2'), detail(request('b2'))),
      row(settled, detail(settled, { decisions: [decision()] })),
    ])

    const pending = m.byId('fleet-job-approval-b2')[0]
    expect(pending.props['data-status']).toBe('pending')
    expect(m.app.textOf(pending)).toContain('Pending')
    expect(m.app.textOf(m.app.find('[data-testid="fleet-job-approval-countdown"]', pending)[0])).toBe('5:00')

    const done = m.byId('fleet-job-approval-b1')[0]
    expect(done.props['data-status']).toBe('approved')
    expect(m.app.textOf(done)).toContain('Approved')
    expect(m.app.find('[data-testid="fleet-job-approval-countdown"]', done)).toHaveLength(0)
    m.app.unmount()
  })

  test('a resolution without a decision names who settled it (a timed-out ask)', () => {
    const expired = request('b3', { status: 'expired', expiresAt: '2026-10-03T10:01:00.000Z' })
    const m = mount([row(expired, detail(expired, { details: { jobId: 'j1', resolvedBy: 'timeout' } }))])
    expect(m.app.textOf(m.byId('fleet-job-approval-b3')[0])).toContain('Timed out')
    m.app.unmount()
  })

  test('a job with no asks says so; a payload that cannot be read falls back to the key label', () => {
    const empty = mount([])
    expect(empty.byId('fleet-job-approvals-empty')).toHaveLength(1)
    empty.app.unmount()

    const odd = request('b4', { status: 'expired' })
    const m = mount([row(odd, detail(odd, { input: { payload: {} } }))])
    expect(m.app.textOf(m.byId('fleet-job-approval-b4')[0])).toContain('Shell command in a fleet job')
    m.app.unmount()
  })

  test('a row past the detail limit still renders from its summary', () => {
    const m = mount([row(request('b9', { permissionKey: 'label.create' }), null)])
    expect(m.byId('fleet-job-approval-b9')[0].props['data-status']).toBe('pending')
    expect(m.app.textOf(m.byId('fleet-job-approval-b9')[0])).toContain('label.create')
    m.app.unmount()
  })
})
