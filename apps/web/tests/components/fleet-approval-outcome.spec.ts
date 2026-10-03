import { describe, test, expect } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const outcome = webFile('components', 'fleet', 'ApprovalOutcome.vue')

const decided = (over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id: 'a1', type: 'budget_override_required', status: 'approved', projectId: 'p1', jobId: null, policyId: 'pol1', payload: {},
  outcome: { resumedAmountUsd: '2.0000', requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: JSON.stringify({ code: 'fleet.jobState', args: { state: 'QUEUED' } }) }] },
  requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: 'raise_budget_and_resume', decidedById: 'u1',
  decidedAt: '2026-10-03T10:05:00.000Z', resolvedBy: 'user', comment: 'go', ...over,
})

function mount(approval: FleetApprovalDto, nameOf: (id: string) => string | null = (id) => (id === 'u1' ? 'Ada' : null)) {
  const app = mountSfc(outcome, {
    components: uiStubs,
    props: { approval, nameOf, jobLink: (_p: string, j: string) => `/koda/fleet/jobs/${j}` },
    globals: { computed, useI18n: () => enI18n() },
  })
  return { app, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('FleetApprovalOutcome', () => {
  test('a raise decided in the inbox: decision, who, new limit, per-job results in words (Review Focus 4)', () => {
    const m = mount(decided())
    expect(m.app.textOf(m.byId('fleet-approval-outcome-decision')[0])).toContain('Raised and resumed')
    expect(m.app.textOf(m.byId('fleet-approval-outcome-by')[0])).toBe('By Ada')
    expect(m.app.textOf(m.byId('fleet-approval-outcome-raised')[0])).toBe('Limit raised to $2.00')
    expect(m.byId('fleet-approval-requeue-result-j1')[0].props['data-ok']).toBe('true')
    const failed = m.byId('fleet-approval-requeue-result-j2')[0]
    expect(failed.props['data-ok']).toBe('false')
    expect(m.app.textOf(failed)).toContain('Not re-queued: the job is no longer cancelled.')
    expect(m.app.text()).not.toContain('fleet.jobState')
    expect(m.app.text()).toContain('Comment: go')
  })

  test('a raise with nothing ticked says no jobs were selected', () => {
    const m = mount(decided({ outcome: { resumedAmountUsd: '2.0000', requeueResults: [] } }))
    expect(m.byId('fleet-approval-requeue-none')).toHaveLength(1)
  })

  test('a manual resume never claims nothing was selected (D245)', () => {
    const m = mount(decided({ resolvedBy: 'manual_resume', outcome: { resumedAmountUsd: '3.0000', requeueResults: [] }, comment: null }))
    expect(m.byId('fleet-approval-outcome-manual')).toHaveLength(1)
    expect(m.byId('fleet-approval-requeue-none')).toHaveLength(0)
    expect(m.app.textOf(m.byId('fleet-approval-outcome-raised')[0])).toBe('Limit raised to $3.00')
  })

  test('kept paused, and closed by the system with no decider', () => {
    const kept = mount(decided({ status: 'rejected', decision: 'keep_paused', outcome: null }))
    expect(kept.app.textOf(kept.byId('fleet-approval-outcome-decision')[0])).toContain('Kept paused')
    expect(kept.byId('fleet-approval-outcome-raised')).toHaveLength(0)

    const reset = mount(decided({ status: 'cancelled', decision: null, decidedById: null, resolvedBy: 'window_reset', outcome: null, comment: null }))
    expect(reset.app.text()).toContain('The budget window rolled over')
    expect(reset.byId('fleet-approval-outcome-by')).toHaveLength(0)
  })

  test('a decider the page cannot name gets the fallback name', () => {
    const m = mount(decided(), () => null)
    expect(m.app.textOf(m.byId('fleet-approval-outcome-by')[0])).toBe('By an unknown user')
  })
})
