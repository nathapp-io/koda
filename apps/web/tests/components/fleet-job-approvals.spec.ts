import { describe, expect, test } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const section = webFile('components', 'fleet', 'JobApprovals.vue')
const NOW = new Date('2026-10-03T10:05:00.000Z')
const ask = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', policyId: null,
  payload: { command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
    storyId: null, featureName: 'login', reason: 'r', options: ['allow', 'deny'] },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: '2026-10-03T10:10:00.000Z', decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

function mount(approvals: FleetApprovalDto[]) {
  const app = mountSfc(section, {
    components: uiStubs,
    props: { slug: 'koda', approvals, now: NOW },
    globals: { computed, useI18n: () => enI18n() },
  })
  return { app, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('FleetJobApprovals (D297)', () => {
  test('one row per approval: preview, status, decision, countdown only while pending, link to the inbox row', () => {
    const m = mount([ask('b2'), ask('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user' })])
    const pending = m.byId('fleet-job-approval-b2')[0]
    expect(pending.props['data-status']).toBe('pending')
    expect(m.app.textOf(pending)).toContain('git push --force origin HEAD')
    expect(m.app.textOf(m.app.find('[data-testid="fleet-job-approval-countdown"]', pending)[0])).toBe('5:00')
    const done = m.byId('fleet-job-approval-b1')[0]
    expect(m.app.textOf(done)).toContain('Allowed once')
    expect(m.app.find('[data-testid="fleet-job-approval-countdown"]', done)).toHaveLength(0)
    expect(m.byId('fleet-job-approval-open-b1')[0].props.to).toBe('/koda/fleet/approvals?id=b1')
    m.app.unmount()
  })

  test('a job with no asks says so; a malformed payload still renders', () => {
    const empty = mount([])
    expect(empty.byId('fleet-job-approvals-empty')).toHaveLength(1)
    empty.app.unmount()
    const odd = mount([ask('b3', { payload: {}, status: 'expired', resolvedBy: 'timeout' })])
    expect(odd.app.textOf(odd.byId('fleet-job-approval-b3')[0])).toContain('A job asks to run a shell command')
    expect(odd.app.textOf(odd.byId('fleet-job-approval-b3')[0])).toContain('Timed out')
    odd.app.unmount()
  })
})
