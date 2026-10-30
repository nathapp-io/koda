import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import type { ApprovalRequestDetail, ApprovalRequestSummary } from '../../lib/approval-requests'
import type { ProjectEventHandlers } from '../../lib/project-event-stream'

const T = enI18n()
/** The browser moment a countdown renders at: 2026-11-01T00:00:00Z. */
const NOW = new Date('2026-11-01T00:00:00.000Z')

const panelFile = webFile('components', 'approvals', 'ApprovalRequestPanel.vue')
const bashPanelFile = webFile('components', 'approvals', 'ApprovalRequestBashPanel.vue')
const budgetPanelFile = webFile('components', 'approvals', 'ApprovalRequestBudgetPanel.vue')
const outcomeFile = webFile('components', 'approvals', 'ApprovalRequestOutcome.vue')
const inboxFile = webFile('components', 'approvals', 'ApprovalRequestInbox.vue')

/**
 * The panel mounts its real children: US-004's ACs are about what the whole decide surface renders
 * and which body it sends, so a stubbed child would assert nothing about the code under test.
 */
function specializedChildren(): Record<string, unknown> {
  const globals = { useI18n: () => T }
  return {
    ApprovalRequestBashPanel: loadSfc(bashPanelFile, globals),
    ApprovalRequestBudgetPanel: loadSfc(budgetPanelFile, globals),
    ApprovalRequestOutcome: loadSfc(outcomeFile, globals),
  }
}

const BASH_PAYLOAD = {
  command: 'rm -rf build', commandTruncated: false, maskedCount: 1, root: '/repo', stage: 'run',
  storyId: 's1', featureName: 'fleet-ui', reason: 'destructive command', options: ['allow', 'allow-remember', 'deny'],
  rawDetail: null,
}

const BUDGET_INPUT = {
  policyId: 'pol1', scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc',
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '10.0000', amountUsd: '20.0000',
  requestedAt: '2026-10-03T10:00:00.000Z',
}

const detail = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => ({
  id: 'r1', permissionKey: 'label.create', projectId: 'p1', actorType: 'AGENT', actorId: 'agent-1',
  onBehalfOfType: null, onBehalfOfId: null, origin: 'fleet', redeem: false, requiredMode: 'human', status: 'pending',
  satisfiedBy: null, approverType: null, approverId: null, expiresAt: '2026-11-01T00:10:00.000Z', decidedAt: null,
  settledAt: null, createdAt: '2026-10-31T23:59:00.000Z', input: null, result: null, details: null, decisions: [],
  ...over,
})

const bashRequest = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => detail({
  permissionKey: 'fleet.job.shell.escalate',
  input: { jobId: 'j1', leaseEpoch: 3, naxAskId: 'ask-1', payload: BASH_PAYLOAD },
  details: { kind: 'bash', jobId: 'j1', resolvedBy: null, outcome: null },
  ...over,
})

const budgetRequest = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => detail({
  permissionKey: 'fleet.budget.override',
  input: BUDGET_INPUT,
  details: {
    kind: 'budget', policyId: 'pol1', resolvedBy: null, outcome: null,
    requeueCandidates: [
      { jobId: 'j1', projectId: 'p1', feature: 'feat-a', queuedAt: '2026-10-03T09:00:00.000Z' },
      { jobId: 'j2', projectId: 'p1', feature: 'feat-b', queuedAt: '2026-10-03T09:01:00.000Z' },
    ],
    requeueCandidatesTruncated: false,
  },
  ...over,
})

function mountPanel(request: ApprovalRequestDetail, props: Record<string, unknown> = {}) {
  const app = mountSfc(panelFile, {
    props: { request, userId: 'u2', busy: false, projectSlug: null, ...props },
    components: { ...uiStubs, ...specializedChildren() },
    // A fixed clock: the real countdown ticks with setInterval, and the panel owns no timer of its own.
    alias: { '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(NOW) }) } },
    globals: { ref, useI18n: () => T },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const one = (id: string) => {
    const found = byId(id)[0]
    if (!found) throw new Error(`expected ${id} to be rendered`)
    return found
  }
  const click = async (id: string) => {
    (one(id).props.onClick as () => void)()
    await Vue.nextTick()
  }
  const change = async (id: string, value = '') => {
    (one(id).props.onChange as (...args: unknown[]) => void)(value)
    await Vue.nextTick()
  }
  const type = async (id: string, value: string) => {
    (one(id).props['onUpdate:modelValue'] as (value: string) => void)(value)
    await Vue.nextTick()
  }
  const decided = () => app.emitted('decide').map(([body]) => body)
  return { app, byId, one, click, change, type, decided }
}

describe('ApprovalRequestPanel — fleet panel selection', () => {
  test('AC-1: an open pending fleet.job.shell.escalate request renders ApprovalRequestBashPanel', () => {
    const m = mountPanel(bashRequest())
    expect(m.byId('approval-request-bash-panel')).toHaveLength(1)
    expect(m.byId('approval-request-budget-panel')).toHaveLength(0)
    // The generic approve/reject form is US-003's, and a fleet key never shows it.
    expect(m.byId('approval-request-approve')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-2: an open pending fleet.budget.override request renders ApprovalRequestBudgetPanel', () => {
    const m = mountPanel(budgetRequest())
    expect(m.byId('approval-request-budget-panel')).toHaveLength(1)
    expect(m.byId('approval-request-bash-panel')).toHaveLength(0)
    expect(m.byId('approval-request-approve')).toHaveLength(0)
    m.app.unmount()
  })

  test('a generic key keeps the US-003 form and renders no fleet panel', () => {
    const m = mountPanel(detail({ input: { name: 'urgent' } }))
    expect(m.byId('approval-request-bash-panel')).toHaveLength(0)
    expect(m.byId('approval-request-budget-panel')).toHaveLength(0)
    expect(m.byId('approval-request-approve')).toHaveLength(1)
    m.app.unmount()
  })
})

describe('ApprovalRequestBashPanel', () => {
  test('AC-3: shows the command of the frozen input payload', () => {
    const m = mountPanel(bashRequest())
    expect(m.app.textOf(m.one('approval-request-bash-command'))).toBe('rm -rf build')
    m.app.unmount()
  })

  test('AC-4: links the job when the project slug is known, and never otherwise', () => {
    const linked = mountPanel(bashRequest(), { projectSlug: 'sandbox' })
    expect(linked.one('approval-request-bash-job').props.to).toBe('/sandbox/fleet/jobs/j1')
    linked.app.unmount()

    const unknown = mountPanel(bashRequest(), { projectSlug: null })
    expect(unknown.byId('approval-request-bash-job')).toHaveLength(0)
    unknown.app.unmount()
  })

  test('AC-5: a payload whose options are only deny offers the Deny button alone', () => {
    const m = mountPanel(bashRequest({
      input: { jobId: 'j1', leaseEpoch: 3, naxAskId: 'ask-1', payload: { ...BASH_PAYLOAD, options: ['deny'] } },
    }))
    expect(m.byId('approval-request-bash-deny')).toHaveLength(1)
    expect(m.byId('approval-request-bash-allow')).toHaveLength(0)
    expect(m.byId('approval-request-bash-allow_for_job')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-6: Allow posts the approve-with-allow body', async () => {
    const m = mountPanel(bashRequest())
    await m.click('approval-request-bash-allow')
    expect(m.decided()).toEqual([{ decision: 'approve', params: { choice: 'allow' } }])
    m.app.unmount()
  })

  test('AC-7: Allow for this job posts the allow_for_job body', async () => {
    const m = mountPanel(bashRequest())
    await m.click('approval-request-bash-allow_for_job')
    expect(m.decided()).toEqual([{ decision: 'approve', params: { choice: 'allow_for_job' } }])
    m.app.unmount()
  })

  test('AC-8: Deny posts the reject-with-deny body', async () => {
    const m = mountPanel(bashRequest())
    await m.click('approval-request-bash-deny')
    expect(m.decided()).toEqual([{ decision: 'reject', params: { choice: 'deny' } }])
    m.app.unmount()
  })

  test('a trimmed comment rides along, and a comment past the engine cap sends nothing', async () => {
    const m = mountPanel(bashRequest())
    await m.type('approval-request-bash-comment', '  looks safe  ')
    await m.click('approval-request-bash-allow')
    expect(m.decided()).toEqual([{ decision: 'approve', params: { choice: 'allow' }, comment: 'looks safe' }])

    await m.type('approval-request-bash-comment', 'x'.repeat(2001))
    await m.click('approval-request-bash-deny')
    expect(m.decided()).toHaveLength(1)
    expect(m.byId('approval-request-bash-comment-error')).toHaveLength(1)
    m.app.unmount()
  })

  test('an unreadable payload is deny-only, and a viewer without the right gets no control', async () => {
    const unreadable = mountPanel(bashRequest({ input: { jobId: 'j1', leaseEpoch: 3, naxAskId: 'ask-1', payload: {} } }))
    expect(unreadable.byId('approval-request-bash-unreadable')).toHaveLength(1)
    expect(unreadable.byId('approval-request-bash-allow')).toHaveLength(0)
    expect(unreadable.byId('approval-request-bash-deny')).toHaveLength(1)
    unreadable.app.unmount()

    // An own request in human mode: the API decides, so no button shows and the ask still reads.
    const readOnly = mountPanel(bashRequest({ actorType: 'USER', actorId: 'u2' }), { userId: 'u2' })
    expect(readOnly.byId('approval-request-bash-readonly')).toHaveLength(1)
    expect(readOnly.byId('approval-request-bash-deny')).toHaveLength(0)
    expect(readOnly.byId('approval-request-bash-command')).toHaveLength(1)
    readOnly.app.unmount()
  })

  test('busy disables every choice while the decision is in flight', () => {
    const m = mountPanel(bashRequest(), { busy: true })
    for (const id of ['approval-request-bash-allow', 'approval-request-bash-allow_for_job', 'approval-request-bash-deny']) {
      expect(m.one(id).props.disabled).toBe(true)
    }
    m.app.unmount()
  })
})

describe('ApprovalRequestBudgetPanel', () => {
  test('AC-9: every requeue candidate is ticked by default', () => {
    const m = mountPanel(budgetRequest())
    expect(m.one('approval-request-candidate-j1').props.checked).toBe(true)
    expect(m.one('approval-request-candidate-j2').props.checked).toBe(true)
    m.app.unmount()
  })

  test('AC-10: Raise sends the amount and the ticked candidates only', async () => {
    const m = mountPanel(budgetRequest())
    await m.type('approval-request-budget-amount', '50')
    await m.change('approval-request-candidate-j2')
    await m.click('approval-request-budget-raise')
    expect(m.decided()).toEqual([{ decision: 'approve', params: { amountUsd: 50, requeueJobIds: ['j1'] } }])
    m.app.unmount()
  })

  test('AC-10 (edge): nothing ticked still sends an empty requeueJobIds', async () => {
    const m = mountPanel(budgetRequest())
    await m.type('approval-request-budget-amount', '50')
    await m.change('approval-request-candidate-j1')
    await m.change('approval-request-candidate-j2')
    await m.click('approval-request-budget-raise')
    expect(m.decided()).toEqual([{ decision: 'approve', params: { amountUsd: 50, requeueJobIds: [] } }])
    m.app.unmount()
  })

  test('AC-11: an amount not above the frozen spend sends nothing and says why', async () => {
    const m = mountPanel(budgetRequest())
    await m.type('approval-request-budget-amount', '10')
    await m.click('approval-request-budget-raise')
    expect(m.decided()).toEqual([])
    expect(m.app.textOf(m.one('approval-request-budget-amount-error')))
      .toBe(T.t('approvals.fleet.budget.validation.notAbove', { spent: '$10.00' }))
    m.app.unmount()
  })

  test('AC-12: Keep paused posts the bare rejection, needing no amount', async () => {
    const m = mountPanel(budgetRequest())
    expect(m.byId('approval-request-budget-amount-error')).toHaveLength(0)
    await m.click('approval-request-budget-keep')
    expect(m.decided()).toEqual([{ decision: 'reject' }])
    m.app.unmount()
  })

  test('Keep paused still refuses a comment past the engine cap', async () => {
    const m = mountPanel(budgetRequest())
    await m.type('approval-request-budget-comment', 'x'.repeat(2001))
    await m.click('approval-request-budget-keep')
    expect(m.decided()).toEqual([])
    expect(m.byId('approval-request-budget-comment-error')).toHaveLength(1)
    m.app.unmount()
  })

  test('AC-13: a truncated candidate list says so', () => {
    const truncated = mountPanel(budgetRequest({
      details: { ...(budgetRequest().details as Record<string, unknown>), requeueCandidatesTruncated: true },
    }))
    expect(truncated.app.textOf(truncated.one('approval-request-budget-truncated')))
      .toBe(T.t('approvals.fleet.budget.truncated'))
    truncated.app.unmount()

    const whole = mountPanel(budgetRequest())
    expect(whole.byId('approval-request-budget-truncated')).toHaveLength(0)
    whole.app.unmount()
  })

  test('the frozen scope, window, spend and amount are shown', () => {
    const m = mountPanel(budgetRequest())
    const text = m.app.textOf(m.one('approval-request-budget-summary'))
    expect(text).toContain('p1')
    expect(text).toContain(T.t('fleet.budgets.window.calendar_month_utc'))
    expect(text).toContain('$10.00')
    expect(text).toContain('$20.00')
    m.app.unmount()
  })

  test('a viewer without the right reads the stop and gets no form', () => {
    const m = mountPanel(budgetRequest({ actorType: 'USER', actorId: 'u2' }), { userId: 'u2' })
    expect(m.byId('approval-request-budget-readonly')).toHaveLength(1)
    expect(m.byId('approval-request-budget-raise')).toHaveLength(0)
    expect(m.byId('approval-request-budget-amount')).toHaveLength(0)
    expect(m.byId('approval-request-budget-summary')).toHaveLength(1)
    m.app.unmount()
  })
})

describe('ApprovalRequestOutcome', () => {
  test('AC-14: a settled bash request shows the runner delivered the answer', () => {
    const m = mountPanel(bashRequest({
      status: 'approved',
      details: { kind: 'bash', jobId: 'j1', resolvedBy: 'user', outcome: { delivery: { result: 'ok' } } },
    }))
    expect(m.app.textOf(m.one('approval-request-outcome-delivery')))
      .toBe(T.t('approvals.fleet.delivery.delivered'))
    // Settled: nothing left to answer.
    expect(m.byId('approval-request-bash-allow')).toHaveLength(0)
    expect(m.byId('approval-request-bash-deny')).toHaveLength(0)
    m.app.unmount()
  })

  test('a failed delivery names what the runner said', () => {
    const m = mountPanel(bashRequest({
      status: 'approved',
      details: { kind: 'bash', jobId: 'j1', resolvedBy: 'user', outcome: { delivery: { result: 'rejected', detail: 'runner gone' } } },
    }))
    expect(m.app.textOf(m.one('approval-request-outcome-delivery')))
      .toBe(T.t('approvals.fleet.delivery.failed', { detail: 'runner gone' }))
    m.app.unmount()
  })

  test('AC-15: an executed budget request explains each re-queue result', () => {
    const m = mountPanel(budgetRequest({
      status: 'executed',
      details: {
        kind: 'budget', policyId: 'pol1', resolvedBy: 'user',
        outcome: { resumedAmountUsd: '50.0000', requeueResults: [{ jobId: 'j2', ok: false, error: '{"code":"fleet.jobState"}' }] },
      },
    }))
    const row = m.one('approval-request-requeue-j2')
    expect(row.props['data-ok']).toBe('false')
    expect(m.app.textOf(row)).toContain(T.t('approvals.fleet.requeueFailure.notCancelled'))
    expect(m.byId('approval-request-budget-raise')).toHaveLength(0)
    expect(m.byId('approval-request-budget-keep')).toHaveLength(0)
    m.app.unmount()
  })

  test('an executed budget request with nothing re-queued says so', () => {
    const m = mountPanel(budgetRequest({
      status: 'executed',
      details: { kind: 'budget', policyId: 'pol1', resolvedBy: 'user', outcome: { resumedAmountUsd: '50.0000', requeueResults: [] } },
    }))
    expect(m.app.textOf(m.one('approval-request-requeue-none'))).toBe(T.t('approvals.fleet.requeue.none'))
    m.app.unmount()
  })

  test('a settled generic request still shows no outcome block (US-003 behaviour)', () => {
    const m = mountPanel(detail({ status: 'approved' }))
    expect(m.byId('approval-request-outcome')).toHaveLength(0)
    expect(m.byId('approval-request-approve')).toHaveLength(0)
    m.app.unmount()
  })
})

/**
 * The end of the wire: the panel's body is what the inbox posts, so one hop through the real inbox
 * proves the fleet body reaches `POST /approvals/:id/decisions` unchanged.
 */
describe('ApprovalRequestInbox — the fleet body on the wire', () => {
  const pageOf = (records: ApprovalRequestSummary[]) =>
    ({ total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records })

  function mountInbox(request: ApprovalRequestDetail) {
    const api = { get: jest.fn(async (path: string) => (path === '/approvals' ? pageOf([request]) : request)), post: jest.fn(async () => request) }
    const app = mountSfc(inboxFile, {
      components: {
        ...uiStubs,
        ApprovalRequestPanel: loadSfc(panelFile, { useI18n: () => T }),
        ...specializedChildren(),
      },
      alias: {
        '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(NOW) }) },
      },
      props: { base: { kind: 'project', slug: 'sandbox', projectId: 'p1' } },
      globals: {
        ref, computed: Vue.computed, watch: Vue.watch, nextTick: Vue.nextTick,
        onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
        useI18n: () => T,
        useAuth: () => ({ user: ref({ id: 'u2' }) }),
        useAppToast: () => toastRecorder(),
        useApi: () => ({ $api: api }),
        useRoute: () => ({ query: {} }),
        useRouter: () => ({ replace: jest.fn() }),
        useVisiblePolling: (task: () => Promise<void>) => ({ start: () => undefined, stop: () => undefined, runNow: task, isActive: () => true }),
        useProjectEvents: (_slug: string, _handlers: ProjectEventHandlers) => undefined,
      },
    })
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => { setImmediate(resolve) })
        await Vue.nextTick()
      }
    }
    return { app, api, settle }
  }

  async function openRow(m: ReturnType<typeof mountInbox>): Promise<void> {
    await m.settle()
    const toggle = m.app.find('[data-testid="approval-request-toggle"]')[0]
    if (!toggle) throw new Error('the bash row was not listed')
    ;(toggle.props.onClick as () => void)()
    await m.settle()
    console.log('DEBUG TEXT:', m.app.text().slice(0, 1500))
    console.log('DEBUG PROPS:', Object.keys(toggle.props).join(','))
  }

  test('AC-6 (end to end): Allow posts the fleet approval body to the engine', async () => {
    const m = mountInbox(bashRequest() as ApprovalRequestDetail)
    await openRow(m)
    ;(m.app.find('[data-testid="approval-request-bash-allow"]')[0]?.props.onClick as () => void)()
    await m.settle()
    expect(m.api.post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'approve', params: { choice: 'allow' } })
    m.app.unmount()
  })

  test('AC-10 (end to end): Raise posts the raised amount and the ticked ids to the engine', async () => {
    const m = mountInbox(budgetRequest() as ApprovalRequestDetail)
    await openRow(m)
    ;(m.app.find('[data-testid="approval-request-budget-amount"]')[0]?.props['onUpdate:modelValue'] as (v: string) => void)('50')
    ;(m.app.find('[data-testid="approval-request-candidate-j2"]')[0]?.props.onChange as () => void)()
    await Vue.nextTick()
    ;(m.app.find('[data-testid="approval-request-budget-raise"]')[0]?.props.onClick as () => void)()
    await m.settle()
    expect(m.api.post).toHaveBeenCalledWith('/approvals/r1/decisions', { decision: 'approve', params: { amountUsd: 50, requeueJobIds: ['j1'] } })
    m.app.unmount()
  })

  test('AC-4 (end to end): the project inbox passes its slug, so the job link resolves', async () => {
    const m = mountInbox(bashRequest() as ApprovalRequestDetail)
    await openRow(m)
    expect(m.app.find('[data-testid="approval-request-bash-job"]')[0]?.props.to).toBe('/sandbox/fleet/jobs/j1')
    m.app.unmount()
  })
})
