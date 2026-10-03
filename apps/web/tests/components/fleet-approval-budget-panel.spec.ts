import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const panel = webFile('components', 'fleet', 'ApprovalBudgetPanel.vue')

const approval = (over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1',
  payload: { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null,
  requeueCandidates: [
    { jobId: 'j1', projectId: 'p1', feature: 'feat-a', queuedAt: '2026-10-03T09:00:00.000Z' },
    { jobId: 'j2', projectId: 'p1', feature: 'feat-b', queuedAt: '2026-10-03T09:01:00.000Z' },
  ],
  requeueCandidatesTruncated: false,
  ...over,
})

function mount(props: Record<string, unknown> = {}) {
  const decided: unknown[] = []
  const app = mountSfc(panel, {
    components: uiStubs,
    props: { approval: approval(), canDecide: true, busy: false, jobLink: (_p: string, j: string) => `/koda/fleet/jobs/${j}`, onDecide: (b: unknown) => decided.push(b), ...props },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const typeAmount = async (value: string) => {
    (byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)(value)
    await Vue.nextTick()
  }
  const click = async (id: string) => {
    (byId(id)[0].props.onClick as () => void)()
    await Vue.nextTick()
  }
  return { app, decided, byId, typeAmount, click }
}

describe('FleetApprovalBudgetPanel', () => {
  test('shows the stop and ticks every candidate (A4)', () => {
    const m = mount()
    expect(m.app.textOf(m.byId('fleet-approval-budget-summary')[0])).toBe('$0.60 spent of a $0.50 limit (Calendar month (UTC)).')
    expect(m.byId('fleet-approval-candidate-j1')[0].props.checked).toBe(true)
    expect(m.byId('fleet-approval-candidate-j2')[0].props.checked).toBe(true)
  })

  test('raise sends the new amount and the ticked ids', async () => {
    const m = mount()
    await m.typeAmount('2')
    ;(m.byId('fleet-approval-candidate-j2')[0].props.onChange as () => void)()
    await Vue.nextTick()
    await m.click('fleet-approval-raise')
    expect(m.decided).toEqual([{ decision: 'raise_budget_and_resume', amountUsd: 2, requeueJobIds: ['j1'] }])
  })

  test('an amount not above the spend shows an error and sends nothing', async () => {
    const m = mount()
    expect(m.byId('fleet-approval-amount-error')).toHaveLength(0)
    await m.typeAmount('0.6')
    await m.click('fleet-approval-raise')
    expect(m.decided).toEqual([])
    expect(m.app.textOf(m.byId('fleet-approval-amount-error')[0])).toBe('The new limit must be above $0.60.')
  })

  test('keep paused sends the decision with the comment', async () => {
    const m = mount()
    ;(m.byId('fleet-approval-comment')[0].props['onUpdate:modelValue'] as (v: string) => void)(' not now ')
    await Vue.nextTick()
    await m.click('fleet-approval-keep')
    expect(m.decided).toEqual([{ decision: 'keep_paused', comment: 'not now' }])
  })

  test('a comment over 1000 characters blocks both buttons', async () => {
    const m = mount()
    await m.typeAmount('2')
    ;(m.byId('fleet-approval-comment')[0].props['onUpdate:modelValue'] as (v: string) => void)('x'.repeat(1001))
    await Vue.nextTick()
    await m.click('fleet-approval-keep')
    await m.click('fleet-approval-raise')
    expect(m.decided).toEqual([])
    expect(m.byId('fleet-approval-comment-error')).toHaveLength(1)
  })

  test('no candidates and truncated candidates each say so', () => {
    expect(mount({ approval: approval({ requeueCandidates: [] }) }).app.text()).toContain('No cancelled jobs to re-queue.')
    expect(mount({ approval: approval({ requeueCandidatesTruncated: true }) }).byId('fleet-approval-candidates-truncated')).toHaveLength(1)
  })

  test('candidates link to their job when a link is known', () => {
    const m = mount({ jobLink: (_p: string, j: string) => (j === 'j1' ? '/koda/fleet/jobs/j1' : null) })
    const links = m.app.find('[data-stub="nuxt-link"]')
    expect(links.map((l) => l.props.to)).toEqual(['/koda/fleet/jobs/j1'])
  })

  test('a reader without the right sees the read-only line and no controls (Review Focus 5)', () => {
    const m = mount({ canDecide: false })
    expect(m.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(m.byId('fleet-approval-raise')).toHaveLength(0)
    expect(m.byId('fleet-approval-keep')).toHaveLength(0)
    expect(m.byId('fleet-approval-amount')).toHaveLength(0)
  })

  test('busy disables both buttons', () => {
    const m = mount({ busy: true })
    expect(m.byId('fleet-approval-raise')[0].props.disabled).toBe(true)
    expect(m.byId('fleet-approval-keep')[0].props.disabled).toBe(true)
  })

  test('a malformed payload still renders the controls with the raw spend unknown', () => {
    const m = mount({ approval: approval({ payload: {} }) })
    expect(m.byId('fleet-approval-budget-summary')).toHaveLength(0)
    expect(m.byId('fleet-approval-raise')).toHaveLength(1)
  })
})
