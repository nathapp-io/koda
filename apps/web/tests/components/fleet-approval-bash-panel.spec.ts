import { describe, expect, test } from '@jest/globals'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DecideApprovalBody, FleetApprovalDto } from '../../lib/fleet-types'

const panel = webFile('components', 'fleet', 'ApprovalBashPanel.vue')
const NOW = new Date('2026-10-03T10:00:00.000Z')

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 2, root: '/work/app', stage: 'execution',
  storyId: 'US-001', featureName: 'login', reason: 'not covered by the stage grants', options: ['allow', 'allow-remember', 'deny'],
  ...over,
})
const ask = (over: Partial<FleetApprovalDto> = {}, p: Record<string, unknown> = {}): FleetApprovalDto => ({
  id: 'b1', type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', policyId: null, payload: payload(p),
  outcome: null, requestedAt: '2026-10-03T09:55:00.000Z', expiresAt: '2026-10-03T10:05:00.000Z', decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

function mount(approval: FleetApprovalDto, props: Record<string, unknown> = {}) {
  const decided: DecideApprovalBody[] = []
  const app = mountSfc(panel, {
    components: uiStubs,
    props: { approval, canDecide: true, busy: false, now: NOW, onDecide: (b: DecideApprovalBody) => decided.push(b), ...props },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const click = (id: string) => (byId(id)[0].props.onClick as () => void)()
  return { app, decided, byId, click }
}

describe('FleetApprovalBashPanel', () => {
  test('links to the job when the inbox knows its page (spec §5)', () => {
    const linked = mount(ask(), { jobHref: '/koda/fleet/jobs/j1' })
    expect(linked.byId('fleet-approval-bash-job')[0].props.to).toBe('/koda/fleet/jobs/j1')
    linked.app.unmount()
    const unlinked = mount(ask())
    expect(unlinked.byId('fleet-approval-bash-job')).toHaveLength(0)
    unlinked.app.unmount()
  })

  test('shows the masked command, the masked count and the facts', () => {
    const m = mount(ask())
    expect(m.app.textOf(m.byId('fleet-approval-bash-command')[0])).toBe('git push --force origin HEAD')
    expect(m.app.textOf(m.byId('fleet-approval-bash-masked')[0])).toContain('2 secret value(s) masked')
    const text = m.app.text()
    for (const fact of ['/work/app', 'execution', 'US-001', 'login', 'not covered by the stage grants']) expect(text).toContain(fact)
    m.app.unmount()
  })

  test('every offered choice, and the decide body carries only the decision and the comment (D293)', () => {
    const m = mount(ask())
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow_for_job')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(1)
    m.click('fleet-approval-bash-allow_for_job')
    expect(m.decided).toEqual([{ decision: 'allow_for_job' }])
    m.app.unmount()
  })

  test('allow-remember not offered hides "Allow for this job" (Review Focus 1)', () => {
    const m = mount(ask({}, { options: ['allow', 'deny'] }))
    expect(m.byId('fleet-approval-bash-allow_for_job')).toHaveLength(0)
    m.app.unmount()
  })

  test('a cut command shows the notice and only Deny (Review Focus 1)', () => {
    const m = mount(ask({}, { commandTruncated: true }))
    expect(m.byId('fleet-approval-bash-truncated')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(0)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(1)
    m.app.unmount()
  })

  test('an unparsed ask shows the raw text and the hint', () => {
    const m = mount(ask({}, { command: '', rawDetail: 'request: rm -rf build' }))
    expect(m.byId('fleet-approval-bash-command')).toHaveLength(0)
    expect(m.app.textOf(m.byId('fleet-approval-bash-raw')[0])).toBe('request: rm -rf build')
    expect(m.byId('fleet-approval-bash-raw-hint')).toHaveLength(1)
    m.app.unmount()
  })

  test('an unreadable payload says so and offers only Deny (D289)', () => {
    const m = mount(ask({ payload: { command: 42 } }))
    expect(m.byId('fleet-approval-bash-unreadable')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(0)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(1)
    m.app.unmount()
  })

  test('the countdown; at 0 the buttons are gone and the panel says nax denied it (Review Focus 2)', () => {
    const running = mount(ask())
    expect(running.app.textOf(running.byId('fleet-approval-bash-countdown')[0])).toContain('5:00')
    running.app.unmount()
    const over = mount(ask({ expiresAt: '2026-10-03T09:59:59.000Z' }))
    expect(over.app.textOf(over.byId('fleet-approval-bash-countdown')[0])).toContain('timed out')
    expect(over.byId('fleet-approval-bash-deny')).toHaveLength(0)
    expect(over.byId('fleet-approval-readonly')).toHaveLength(0)
    over.app.unmount()
  })

  test('a reader without the right sees the read-only line, never buttons (Review Focus 4)', () => {
    const m = mount(ask(), { canDecide: false })
    expect(m.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(0)
    m.app.unmount()
  })

  test('a comment over 1000 characters blocks the decide', () => {
    const m = mount(ask())
    const textarea = m.byId('fleet-approval-comment')[0]
    ;(textarea.props['onUpdate:modelValue'] as (v: string) => void)('x'.repeat(1001))
    m.click('fleet-approval-bash-deny')
    expect(m.decided).toEqual([])
    m.app.unmount()
  })

  test('busy disables the buttons', () => {
    const m = mount(ask(), { busy: true })
    expect(m.byId('fleet-approval-bash-deny')[0].props.disabled).toBe(true)
    m.app.unmount()
  })
})
