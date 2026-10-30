import { describe, expect, test } from '@jest/globals'
import { ref } from 'vue'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import type { ApprovalRequestDetail } from '../../lib/approval-requests'

const required = (node: FakeNode | undefined): FakeNode => {
  if (!node) throw new Error('expected panel control to be rendered')
  return node
}

const request = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => ({
  id: 'r1', permissionKey: 'label.create', projectId: 'p1', actorType: 'AGENT', actorId: 'agent-1',
  onBehalfOfType: null, onBehalfOfId: null, origin: 'rest', redeem: false, requiredMode: 'human', status: 'pending',
  satisfiedBy: null, approverType: null, approverId: null, expiresAt: null, decidedAt: null, settledAt: null,
  createdAt: '2026-01-01T00:00:00Z', input: { label: 'safe' }, result: null, details: null, decisions: [], ...over,
})

function mount(detail: ApprovalRequestDetail, userId: string | null = 'viewer') {
  return mountSfc(webFile('components', 'approvals', 'ApprovalRequestPanel.vue'), {
    props: { request: detail, userId, busy: false },
    components: uiStubs,
    globals: { ref, useI18n: () => enI18n() },
  })
}

describe('ApprovalRequestPanel', () => {
  test('AC-2, AC-3: renders escaped indented input and decision history as text', () => {
    const app = mount(request({
      input: { html: '<script>bad</script>' },
      decisions: [{ id: 'd1', deciderType: 'USER', deciderId: 'u1', decision: 'reject', comment: '<b>no</b>', params: null, decidedAt: '2026-01-01T00:00:00Z' }],
    }))
    const pre = app.one('[data-testid="approval-request-input"]')
    expect(required(pre).children[0]?.text).toContain('\n  "html"')
    expect(app.text()).toContain('u1')
    expect(app.text()).toContain('reject')
    expect(app.text()).toContain('<b>no</b>')
    expect(app.find('script')).toHaveLength(0)
    app.unmount()
  })

  test('AC-9, AC-10: requester in human mode sees Cancel, not decision controls', () => {
    const app = mount(request({ actorType: 'USER', actorId: 'viewer' }))
    expect(app.find('[data-testid="approval-request-approve"]')).toHaveLength(0)
    expect(app.find('[data-testid="approval-request-reject"]')).toHaveLength(0)
    const cancel = app.one('[data-testid="approval-request-cancel"]')
    ;(cancel?.props.onClick as () => void)()
    expect(app.emitted('cancel')).toHaveLength(1)
    app.unmount()
  })

  test('AC-11: settled rows show no mutation controls', () => {
    const app = mount(request({ status: 'approved' }))
    expect(app.find('[data-testid="approval-request-approve"]')).toHaveLength(0)
    expect(app.find('[data-testid="approval-request-reject"]')).toHaveLength(0)
    expect(app.find('[data-testid="approval-request-cancel"]')).toHaveLength(0)
    app.unmount()
  })

  test('AC-4, AC-5, AC-6: emits normalized bodies and refuses comments over 2000 chars', () => {
    const app = mount(request())
    const textarea = required(app.one('[data-testid="approval-request-comment"]'))
    const update = textarea.props['onUpdate:modelValue'] as (value: string) => void
    update('  ok  ')
    const form = required(app.one('form'))
    ;(form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined })
    expect(app.emitted('decide')).toEqual([[{ decision: 'approve', comment: 'ok' }]])
    update('   ')
    ;(required(app.one('[data-testid="approval-request-reject"]')).props.onClick as () => void)()
    expect(app.emitted('decide')).toEqual([[{ decision: 'approve', comment: 'ok' }], [{ decision: 'reject' }]])
    update('x'.repeat(2001))
    ;(form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined })
    expect(app.emitted('decide')).toHaveLength(2)
    app.unmount()
  })
})
