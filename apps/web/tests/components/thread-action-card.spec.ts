import { describe, expect, test, jest } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { extractApiError } from '../../composables/useApi'
import { countdownText, secondsLeft } from '../../lib/fleet-approvals'
import type { PendingActionDto } from '../../lib/thread-types'

/**
 * US-005 (S5b §2aw-D11): the thread's pending-action card. The card is the only place a requester decides an action from
 * the transcript, so these tests pin decisions to the action's ApprovalRequest id and pin the preview to interpolation.
 *
 * The card's own clock comes from its `now` prop (the timeline passes `useApprovalCountdown().now`), so every countdown
 * assertion here is a fixed instant.
 */

const card = webFile('components', 'fleet', 'threads', 'ThreadActionCard.vue')
const NOW = new Date('2026-10-14T10:00:00.000Z')
const EXPIRES_AT = '2026-10-14T10:10:00.000Z'

const action = (over: Partial<PendingActionDto> = {}): PendingActionDto => ({
  id: 'a1',
  approvalId: 'ap1',
  tool: 'write_doc',
  preview: 'Write docs/plan.md',
  projectSlug: 'acme',
  expiresAt: EXPIRES_AT,
  createdAt: '2026-10-14T09:59:00.000Z',
  ...over,
})

/** Lets the queued decide promise and the render queue drain. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

function mount(
  value: PendingActionDto,
  opts: { canDecide?: boolean; now?: Date; decide?: jest.Mock } = {},
) {
  const decide = opts.decide ?? jest.fn(async () => ({}))
  const useApprovalRequests = jest.fn(() => ({ decide }))
  const toast = toastRecorder()
  const app = mountSfc(card, {
    components: uiStubs,
    props: { action: value, canDecide: opts.canDecide ?? true, now: opts.now ?? NOW },
    alias: {
      '~/composables/useApprovalRequests': { useApprovalRequests },
    },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const textOf = (id: string): string => {
    const found = byId(id)[0]
    return found === undefined ? '' : app.textOf(found)
  }
  const click = (id: string): void => { (byId(id)[0].props.onClick as () => void)() }
  const disabled = (id: string): unknown => byId(id)[0]?.props.disabled
  return { app, decide, useApprovalRequests, toast, byId, textOf, click, disabled, settle }
}

describe('ThreadActionCard (S5b 2aw-D11, US-005)', () => {
  test('names the tool, shows the preview as text and counts the expiry down (AC-13, AC-14)', async () => {
    const m = mount(action())
    await m.settle()

    expect(m.textOf('thread-action-title')).toBe('The assistant asks to run write_doc')
    expect(m.textOf('thread-action-preview')).toBe('Write docs/plan.md')
    expect(String(m.byId('thread-action-preview')[0].props.class)).toContain('whitespace-pre-wrap')
    // AC-14: the very text `countdownText(secondsLeft(expiresAt, now))` describes — 600s before the expiry.
    const expected = enI18n().t('fleet.threads.action.expiresIn', { time: countdownText(secondsLeft(EXPIRES_AT, NOW) ?? 0) })
    expect(expected).toBe('Expires in 10:00 unless decided.')
    expect(m.textOf('thread-action-expires')).toBe(expected)
    m.app.unmount()
  })

  test('a preview containing <img src=x> renders as literal text, with no img element (AC-13)', async () => {
    const m = mount(action({ preview: 'Delete <img src=x> now' }))
    await m.settle()

    expect(m.textOf('thread-action-preview')).toBe('Delete <img src=x> now')
    expect(m.app.find('img')).toHaveLength(0)
    m.app.unmount()
  })

  test('an action with no linked approval shows the awaiting text and no Approve, even for its creator (AC-6)', async () => {
    const m = mount(action({ approvalId: null }), { canDecide: true })
    await m.settle()

    expect(m.textOf('thread-action-awaiting')).toBe(enI18n().t('fleet.threads.action.awaiting'))
    expect(m.byId('thread-action-approve')).toHaveLength(0)
    expect(m.byId('thread-action-reject')).toHaveLength(0)
    m.app.unmount()
  })

  test('Approve decides the action id, not its legacy approvalId (AC-4)', async () => {
    const m = mount(action())
    await m.settle()

    m.click('thread-action-approve')
    await m.settle()

    expect(m.useApprovalRequests).toHaveBeenCalledTimes(1)
    expect(m.decide).toHaveBeenCalledWith('a1', 'approve')
    m.app.unmount()
  })

  test('Reject decides the action id, not its legacy approvalId (AC-5)', async () => {
    const m = mount(action({ projectSlug: 'other' }))
    await m.settle()

    m.click('thread-action-reject')
    await m.settle()

    expect(m.decide).toHaveBeenCalledWith('a1', 'reject')
    m.app.unmount()
  })

  test('both buttons are disabled while the decide is in flight (AC-9)', async () => {
    let answer: (value: unknown) => void = () => undefined
    const decide = jest.fn(() => new Promise((resolve) => { answer = resolve }))
    const m = mount(action(), { decide })
    await m.settle()

    expect(m.disabled('thread-action-approve')).toBe(false)
    m.click('thread-action-approve')
    await m.settle()

    expect(m.decide).toHaveBeenCalledTimes(1)
    expect(m.disabled('thread-action-approve')).toBe(true)
    expect(m.disabled('thread-action-reject')).toBe(true)

    answer({})
    await m.settle()
    m.app.unmount()
  })

  test('a resolved decide hides the card (AC-10)', async () => {
    const m = mount(action())
    await m.settle()

    m.click('thread-action-approve')
    await m.settle()

    expect(m.byId('thread-action')).toHaveLength(0)
    expect(m.byId('thread-action-approve')).toHaveLength(0)
    expect(m.app.text()).not.toContain('Write docs/plan.md')
    m.app.unmount()
  })

  test('a rejected decide toasts extractApiError and keeps the card with Approve enabled (AC-11, AC-12)', async () => {
    const err = { data: { message: 'This action is no longer pending.' } }
    const decide = jest.fn(async () => { throw err })
    const m = mount(action(), { decide })
    await m.settle()

    m.click('thread-action-approve')
    await m.settle()

    expect(m.toast.errors).toEqual([extractApiError(err)])
    expect(m.toast.errors).toEqual(['This action is no longer pending.'])
    expect(m.byId('thread-action')).toHaveLength(1)
    expect(m.disabled('thread-action-approve')).toBe(false)
    expect(m.disabled('thread-action-reject')).toBe(false)
    m.app.unmount()
  })

  test('a failed decide can be retried: the second click decides again (2aw-D11)', async () => {
    const decide = jest.fn()
      .mockRejectedValueOnce({ data: { message: 'boom' } })
      .mockResolvedValueOnce({})
    const m = mount(action(), { decide })
    await m.settle()

    m.click('thread-action-approve')
    await m.settle()
    m.click('thread-action-approve')
    await m.settle()

    expect(m.decide).toHaveBeenCalledTimes(2)
    expect(m.decide).toHaveBeenLastCalledWith('a1', 'approve')
    expect(m.byId('thread-action')).toHaveLength(0)
    m.app.unmount()
  })
})
