import { describe, expect, test, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DecideApprovalBody, FleetApprovalDto } from '../../lib/fleet-types'

const panel = webFile('components', 'fleet', 'ApprovalActionPanel.vue')
const NOW = new Date('2026-10-03T10:00:00.000Z')

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  actionId: 'act1', tool: 'run_command', threadId: 't1', threadPath: '/koda/threads/t1', requestedById: 'u1', ...over,
})
const action = (over: Partial<FleetApprovalDto> = {}, p: Record<string, unknown> = {}): FleetApprovalDto => ({
  id: 'a1', type: 'assistant_action', status: 'pending', projectId: 'p1', jobId: null, policyId: null, payload: payload(p),
  outcome: null, requestedAt: '2026-10-03T09:55:00.000Z', expiresAt: '2026-10-03T10:05:00.000Z', decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

/** Lets every queued promise and the render queue drain, like the inbox spec's own settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

function mount(approval: FleetApprovalDto, opts: { canDecide?: boolean; busy?: boolean; load?: jest.Mock } = {}) {
  const decided: DecideApprovalBody[] = []
  const load = opts.load ?? jest.fn(async () => 'Run the export')
  const app = mountSfc(panel, {
    components: uiStubs,
    props: {
      approval,
      canDecide: opts.canDecide ?? true,
      busy: opts.busy ?? false,
      now: NOW,
      onDecide: (b: DecideApprovalBody) => { decided.push(b) },
    },
    globals: { ref, computed, watch, useI18n: () => enI18n(), useActionPreview: () => ({ load }) },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const click = (id: string) => (byId(id)[0].props.onClick as () => void)()
  const disabled = (id: string): unknown => byId(id)[0]?.props.disabled
  return { app, decided, load, byId, click, disabled, settle }
}

describe('FleetApprovalActionPanel (S5b 2aw-D9)', () => {
  test('always names the tool, links the thread and counts down', async () => {
    const m = mount(action())
    await m.settle()
    expect(m.app.textOf(m.byId('fleet-approval-action-tool')[0])).toContain('run_command')
    expect(m.byId('fleet-approval-action-thread')[0].props.to).toBe('/koda/threads/t1')
    expect(m.app.textOf(m.byId('fleet-approval-action-countdown')[0])).toContain('5:00')
    m.app.unmount()
  })

  test('a viewer who cannot decide is told so and the preview is never fetched (AC-3)', async () => {
    const m = mount(action(), { canDecide: false })
    await m.settle()
    expect(m.load).not.toHaveBeenCalled()
    expect(m.app.textOf(m.byId('fleet-approval-action-requester-only')[0]))
      .toBe('Only the person who asked can decide this action.')
    expect(m.byId('fleet-approval-action-approve')).toHaveLength(0)
    expect(m.byId('fleet-approval-action-reject')).toHaveLength(0)
    m.app.unmount()
  })

  test('a decider loads the preview of the payload\'s thread and action (AC-4)', async () => {
    const m = mount(action())
    await m.settle()
    expect(m.load).toHaveBeenCalledWith('/koda/threads/t1', 'act1')
    m.app.unmount()
  })

  test('the preview the thread answered is rendered as text (AC-5)', async () => {
    const m = mount(action(), { load: jest.fn(async () => 'Delete 3 merged branches') })
    await m.settle()
    expect(m.app.textOf(m.byId('fleet-approval-action-preview')[0])).toBe('Delete 3 merged branches')
    expect(String(m.byId('fleet-approval-action-preview')[0].props.class)).toContain('whitespace-pre-wrap')
    m.app.unmount()
  })

  test('Approve is disabled until the preview answers, then enabled (AC-6)', async () => {
    let answer: (preview: string | null) => void = () => undefined
    const load = jest.fn(() => new Promise<string | null>((resolve) => { answer = resolve }))
    const m = mount(action(), { load })
    expect(m.disabled('fleet-approval-action-approve')).toBe(true)
    expect(m.byId('fleet-approval-action-loading')).toHaveLength(1)
    answer('Run the export')
    await m.settle()
    expect(m.disabled('fleet-approval-action-approve')).toBe(false)
    expect(m.byId('fleet-approval-action-loading')).toHaveLength(0)
    m.app.unmount()
  })

  test('an action the thread no longer lists shows previewGone and keeps Approve disabled (AC-7, AC-16)', async () => {
    const m = mount(action(), { load: jest.fn(async () => null) })
    await m.settle()
    expect(m.app.textOf(m.byId('fleet-approval-action-gone')[0]))
      .toBe('This action is no longer waiting for a decision.')
    expect(m.byId('fleet-approval-action-preview')).toHaveLength(0)
    expect(m.disabled('fleet-approval-action-approve')).toBe(true)
    m.app.unmount()
  })

  test('a failed read shows previewFailed and keeps Approve disabled (AC-8, AC-9)', async () => {
    const m = mount(action(), { load: jest.fn(async () => { throw new Error('403') }) })
    await m.settle()
    expect(m.app.textOf(m.byId('fleet-approval-action-failed')[0]))
      .toBe('The preview could not be loaded. Reject it, or decide in the thread.')
    expect(m.disabled('fleet-approval-action-approve')).toBe(true)
    m.app.unmount()
  })

  test('a preview containing markup renders as that literal text, with no element (AC-10)', async () => {
    const m = mount(action(), { load: jest.fn(async () => '<b>x</b>') })
    await m.settle()
    expect(m.app.textOf(m.byId('fleet-approval-action-preview')[0])).toBe('<b>x</b>')
    expect(m.app.find('b')).toHaveLength(0)
    m.app.unmount()
  })

  test('Reject emits the reject body even before a preview answered (AC-12)', async () => {
    const m = mount(action(), { load: jest.fn(async () => { throw new Error('boom') }) })
    await m.settle()
    m.click('fleet-approval-action-reject')
    expect(m.decided).toEqual([{ decision: 'reject' }])
    m.app.unmount()
  })

  test('Approve emits the approve body once the preview answered (2aw-D9)', async () => {
    const m = mount(action())
    await m.settle()
    m.click('fleet-approval-action-approve')
    expect(m.decided).toEqual([{ decision: 'approve' }])
    m.app.unmount()
  })

  test('an unreadable payload shows previewFailed and offers no decision at all (2aw-D9)', async () => {
    const m = mount(action({ payload: { actionId: 42 } }))
    await m.settle()
    expect(m.load).not.toHaveBeenCalled()
    expect(m.app.textOf(m.byId('fleet-approval-action-failed')[0]))
      .toBe('The preview could not be loaded. Reject it, or decide in the thread.')
    expect(m.byId('fleet-approval-action-approve')).toHaveLength(0)
    expect(m.byId('fleet-approval-action-thread')).toHaveLength(0)
    m.app.unmount()
  })

  test('busy disables both buttons', async () => {
    const m = mount(action(), { busy: true })
    await m.settle()
    expect(m.disabled('fleet-approval-action-approve')).toBe(true)
    expect(m.disabled('fleet-approval-action-reject')).toBe(true)
    m.app.unmount()
  })
})
