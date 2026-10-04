import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import type { FleetApprovalDto } from '../../lib/fleet-types'

// mountSfc re-instantiates `~/…` imports; aliasing useApi keeps `instanceof ApiError` true inside the component.
const { ApiError } = apiModule

const inbox = webFile('components', 'fleet', 'ApprovalInbox.vue')

const budget = { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' }
const row = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1', payload: { ...budget },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null, ...over,
})
const page = (records: FleetApprovalDto[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })

type Handlers = { onFleetApproval?: () => void; onResync: () => void }

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
  jest.useRealTimers()
})

function mount(opts: {
  get: jest.Mock
  post?: jest.Mock
  query?: Record<string, string>
  props?: Record<string, unknown>
  now?: Date
}) {
  const api = { get: opts.get, post: opts.post ?? jest.fn() }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const toast = toastRecorder()
  const replace = jest.fn()
  let pollTask: () => Promise<void> = async () => undefined
  let live: Handlers | null = null
  const forbidden: unknown[] = []
  const clock = Vue.ref(opts.now ?? new Date('2026-10-03T10:05:00.000Z'))
  const app = mountSfc(inbox, {
    components: uiStubs,
    fleetComponents: ['FleetApprovalBudgetPanel', 'FleetApprovalBashPanel', 'FleetApprovalOutcome', 'FleetNativeSelect', 'FleetAge'],
    alias: {
      '~/composables/useApi': apiModule,
      // D292: a fixed clock; the real one ticks with setInterval.
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: clock }) },
    },
    props: {
      base: { kind: 'project', slug: 'koda' },
      viewer: { kind: 'project', canManage: true, canWork: true },
      scopeLabel: () => 'koda',
      nameOf: (id: string) => (id === 'u1' ? 'Ada' : null),
      jobLink: (_p: string, j: string) => `/koda/fleet/jobs/${j}`,
      onForbidden: () => forbidden.push(true),
      ...opts.props,
    },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ query: opts.query ?? {} }),
      useRouter: () => ({ replace }),
      useVisiblePolling: (fn: () => Promise<void>) => {
        pollTask = fn
        return { start: jest.fn(), stop: jest.fn(), runNow: async () => { await fn() }, isActive: () => true }
      },
      useProjectEvents: (_slug: string, handlers: Handlers) => { live = handlers },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const rowEl = (id: string) => byId(`fleet-approval-row-${id}`)[0]
  const toggle = async (id: string) => {
    const button = app.find('[data-testid="fleet-approval-toggle"]', rowEl(id))[0]
    ;(button.props.onClick as () => void)()
    await settle()
  }
  return { app, api, toast, replace, forbidden, settle, byId, rowEl, toggle, poll: () => pollTask(), live: () => live }
}

describe('FleetApprovalInbox', () => {
  test('loads pending first, one page of 100 (D240)', async () => {
    const get = jest.fn(async () => page([row('a1')]))
    const m = mount({ get })
    await m.settle()
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { status: 'pending', size: '100' } })
    expect(m.rowEl('a1').props['data-status']).toBe('pending')
    expect(m.app.textOf(m.rowEl('a1'))).toContain('Budget for project koda stopped at $0.60 of $0.50')
    m.app.unmount()
  })

  test('the All tab and the type filter change the query', async () => {
    const get = jest.fn(async () => page([]))
    const m = mount({ get })
    await m.settle()
    ;(m.byId('fleet-approvals-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals', { query: { size: '20' } })
    const select = m.byId('fleet-approvals-type')[0]
    ;(select.props.onChange as (e: unknown) => void)({ target: { value: 'budget_override_required' } })
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals', { query: { size: '20', type: 'budget_override_required' } })
    m.app.unmount()
  })

  test('expanding fetches the approval and writes ?id=; collapsing removes it (D241)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? row('a1', { requeueCandidates: [] }) : page([row('a1')])))
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a1')
    expect(m.replace).toHaveBeenLastCalledWith({ query: { id: 'a1' } })
    expect(m.byId('fleet-approval-budget-panel')).toHaveLength(1)
    await m.toggle('a1')
    expect(m.replace).toHaveBeenLastCalledWith({ query: {} })
    expect(m.byId('fleet-approval-panel')).toHaveLength(0)
    m.app.unmount()
  })

  test('?id= of an approval not in the list shows it first as a linked row (Review Focus 3)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/old') ? row('old', { status: 'approved', decision: 'keep_paused', resolvedBy: 'user' }) : page([row('a1')])))
    const m = mount({ get, query: { id: 'old' } })
    await m.settle()
    expect(m.rowEl('old').props['data-linked']).toBe('true')
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    m.app.unmount()
  })

  test('?id= that the server does not know toasts and expands nothing (Review Focus 3)', async () => {
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/nope')) throw new ApiError(40004, 'Approval not found')
      return page([row('a1')])
    })
    const m = mount({ get, query: { id: 'nope' } })
    await m.settle()
    expect(m.toast.errors).toEqual(['Approval not found'])
    expect(m.byId('fleet-approval-panel')).toHaveLength(0)
    expect(m.replace).toHaveBeenLastCalledWith({ query: {} })
    m.app.unmount()
  })

  test('a decide applies the result and toasts it', async () => {
    const detail = row('a1', { requeueCandidates: [{ jobId: 'j1', projectId: 'p1', feature: 'f', queuedAt: '2026-10-03T09:00:00.000Z' }] })
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? detail : page([row('a1')])))
    const post = jest.fn(async () => row('a1', {
      status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user', decidedById: 'u1', decidedAt: '2026-10-03T10:05:00.000Z',
      outcome: { resumedAmountUsd: '2.0000', requeueResults: [{ jobId: 'j1', ok: false, error: '{"code":"fleet.jobs","args":{}}' }] },
    }))
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('a1')
    ;(m.byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)('2')
    await m.settle()
    ;(m.byId('fleet-approval-raise')[0].props.onClick as () => void)()
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a1/decide', { decision: 'raise_budget_and_resume', amountUsd: 2, requeueJobIds: ['j1'] })
    expect(m.toast.successes).toEqual(['Budget raised and resumed.'])
    expect(m.toast.errors).toEqual(['1 job(s) could not be re-queued.'])
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    m.app.unmount()
  })

  test('a 409 toasts, re-fetches the approval and reloads the list (D250, Review Focus 2)', async () => {
    let decided = false
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/a1')) return decided ? row('a1', { status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', decidedById: 'u1' }) : row('a1', { requeueCandidates: [] })
      return page([row('a1', decided ? { status: 'rejected' } : {})])
    })
    const post = jest.fn(async () => {
      decided = true
      throw new ApiError(40009, 'This approval is no longer pending')
    })
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('a1')
    const listCalls = get.mock.calls.filter(([p]) => !String(p).endsWith('/a1')).length
    ;(m.byId('fleet-approval-keep')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['This approval is no longer pending'])
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    expect(m.byId('fleet-approval-keep')).toHaveLength(0)
    expect(get.mock.calls.filter(([p]) => !String(p).endsWith('/a1')).length).toBe(listCalls + 1)
    m.app.unmount()
  })

  test('a 400 re-fetches the approval so a stale candidate is dropped from the form (D250)', async () => {
    let refreshed = false
    const candidate = (jobId: string) => ({ jobId, projectId: 'p1', feature: jobId, queuedAt: '2026-10-03T09:00:00.000Z' })
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/a1')) return row('a1', { requeueCandidates: refreshed ? [candidate('j2')] : [candidate('j1'), candidate('j2')] })
      return page([row('a1')])
    })
    const post = jest.fn(async () => {
      refreshed = true
      throw new ApiError(400, 'Job j1 is not a re-queue candidate')
    })
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('a1')
    ;(m.byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)('2')
    await m.settle()
    ;(m.byId('fleet-approval-raise')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['Job j1 is not a re-queue candidate'])
    expect(m.byId('fleet-approval-candidate-j1')).toHaveLength(0)
    expect(m.byId('fleet-approval-candidate-j2')[0].props.checked).toBe(true)
    m.app.unmount()
  })

  test('a refresh with an unchanged status keeps the half-filled form (D242, Review Focus 1)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? row('a1', { requeueCandidates: [] }) : page([row('a1'), row('a2')])))
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    ;(m.byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)('7')
    await m.settle()
    const detailCalls = get.mock.calls.filter(([p]) => String(p).endsWith('/a1')).length
    await m.poll()
    m.live()?.onFleetApproval?.()
    await m.settle()
    expect(get.mock.calls.filter(([p]) => String(p).endsWith('/a1')).length).toBe(detailCalls)
    expect(m.byId('fleet-approval-amount')[0].props.modelValue).toBe('7')
    m.app.unmount()
  })

  test('a refresh that finds the open approval decided elsewhere re-fetches it (it leaves the Pending list)', async () => {
    let elsewhere = false
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/a1')) return elsewhere ? row('a1', { status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'manual_resume' }) : row('a1', { requeueCandidates: [] })
      return page(elsewhere ? [row('a2')] : [row('a1'), row('a2')])
    })
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    elsewhere = true
    await m.poll()
    await m.settle()
    expect(m.byId('fleet-approval-outcome-manual')).toHaveLength(1)
    m.app.unmount()
  })

  test('a reader without the right sees no decide buttons (Review Focus 5)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? row('a1', { requeueCandidates: [] }) : page([row('a1')])))
    const m = mount({ get, props: { viewer: { kind: 'project', canManage: false, canWork: false } } })
    await m.settle()
    await m.toggle('a1')
    expect(m.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(m.byId('fleet-approval-raise')).toHaveLength(0)
    m.app.unmount()
  })

  const bashPayloadFields = { command: 'rm -rf build', commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
    storyId: 'US-001', featureName: 'login', reason: 'outside the grants', options: ['allow', 'allow-remember', 'deny'] }
  const bashRow = (id: string, over: Partial<FleetApprovalDto> = {}) =>
    row(id, { type: 'nax_bash_escalate', policyId: null, jobId: 'j1', payload: { ...bashPayloadFields }, expiresAt: '2026-10-03T10:10:00.000Z', ...over })

  test('a pending bash ask shows its command and countdown in the row and opens the bash panel', async () => {
    const bash = bashRow('b1')
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? bash : page([bash])))
    const m = mount({ get })
    await m.settle()
    expect(m.app.textOf(m.rowEl('b1'))).toContain('Run rm -rf build (execution)')
    expect(m.app.textOf(m.app.find('[data-testid="fleet-approval-countdown"]', m.rowEl('b1'))[0])).toBe('5:00')
    await m.toggle('b1')
    expect(m.byId('fleet-approval-bash-panel')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(1)
    m.app.unmount()
  })

  test('a developer allows; the outcome waits for delivery and the next poll re-fetches it (D295, Review Focus 3)', async () => {
    const bash = bashRow('b1')
    const decided = bashRow('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: 'u1', outcome: null })
    const delivered = { ...decided, outcome: { delivery: { result: 'ok', detail: null, at: '2026-10-03T10:05:10.000Z' } } }
    let stored: FleetApprovalDto = bash
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? stored : page(stored.status === 'pending' ? [stored] : [])))
    const post = jest.fn(async () => { stored = decided; return decided })
    const m = mount({ get, post, props: { viewer: { kind: 'project', canManage: false, canWork: true } } })
    await m.settle()
    await m.toggle('b1')
    ;(m.byId('fleet-approval-bash-allow')[0].props.onClick as () => void)()
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/b1/decide', { decision: 'allow' })
    expect(m.toast.successes).toEqual(['Allowed. The runner passes the answer to nax.'])
    expect(m.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('waiting')
    stored = delivered
    await m.poll()
    await m.settle()
    expect(m.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('delivered')
    m.app.unmount()
  })

  test('a decided ask whose decidedAt is ahead of the clock is not re-fetched forever (D295 clock guard)', async () => {
    const decidedFuture = bashRow('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: 'u1', decidedAt: '2099-01-01T00:00:00.000Z', outcome: null })
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? decidedFuture : page([])))
    const m = mount({ get, query: { id: 'b1' } })
    await m.settle()
    const detailCalls = get.mock.calls.filter(([p]) => String(p).endsWith('/b1')).length
    await m.poll()
    await m.settle()
    expect(get.mock.calls.filter(([p]) => String(p).endsWith('/b1')).length).toBe(detailCalls)
    m.app.unmount()
  })

  test('a decided ask with a recent decidedAt is still re-fetched on the next reload (D295)', async () => {
    const decidedRecent = bashRow('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: 'u1', decidedAt: new Date(Date.now() - 1_000).toISOString(), outcome: null })
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? decidedRecent : page([])))
    const m = mount({ get, query: { id: 'b1' } })
    await m.settle()
    const detailCalls = get.mock.calls.filter(([p]) => String(p).endsWith('/b1')).length
    await m.poll()
    await m.settle()
    expect(get.mock.calls.filter(([p]) => String(p).endsWith('/b1')).length).toBe(detailCalls + 1)
    m.app.unmount()
  })

  test('a bash decide that races expiry gets 409: toast, and the row is re-fetched as expired (Review Focus 2)', async () => {
    const bash = bashRow('b1')
    const expired = bashRow('b1', { status: 'expired', resolvedBy: 'timeout' })
    let stored: FleetApprovalDto = bash
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? stored : page(stored.status === 'pending' ? [stored] : [])))
    const post = jest.fn(async () => { stored = expired; throw new ApiError(409, 'This approval is no longer pending') })
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('b1')
    ;(m.byId('fleet-approval-bash-deny')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['This approval is no longer pending'])
    expect(m.app.textOf(m.byId('fleet-approval-outcome-decision')[0])).toContain('Expired')
    m.app.unmount()
  })

  test('a viewer reads a bash ask; a developer gets bash buttons but no budget buttons (Review Focus 4)', async () => {
    const bash = bashRow('b1')
    const budgetRow = row('a1', { requeueCandidates: [] })
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? bash : path.endsWith('/a1') ? budgetRow : page([bash, row('a1')])))
    const viewerOnly = mount({ get, props: { viewer: { kind: 'project', canManage: false, canWork: false } } })
    await viewerOnly.settle()
    await viewerOnly.toggle('b1')
    expect(viewerOnly.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(viewerOnly.byId('fleet-approval-bash-deny')).toHaveLength(0)
    viewerOnly.app.unmount()
    const developer = mount({ get, props: { viewer: { kind: 'project', canManage: false, canWork: true } } })
    await developer.settle()
    await developer.toggle('b1')
    expect(developer.byId('fleet-approval-bash-deny')).toHaveLength(1)
    await developer.toggle('a1')
    expect(developer.byId('fleet-approval-raise')).toHaveLength(0)
    expect(developer.byId('fleet-approval-readonly')).toHaveLength(1)
    developer.app.unmount()
  })

  test('the admin inbox reports a 403 and stops (no rows, no toast)', async () => {
    const get = jest.fn(async () => { throw new ApiError(40003, 'Forbidden') })
    const m = mount({ get, props: { base: { kind: 'admin' }, viewer: { kind: 'admin' } } })
    await m.settle()
    expect(m.forbidden).toEqual([true])
    expect(m.toast.errors).toEqual([])
    m.app.unmount()
  })

  test('the admin inbox shows each row\'s project', async () => {
    const get = jest.fn(async () => page([row('a1'), row('g1', { projectId: null })]))
    const m = mount({ get, props: { base: { kind: 'admin' }, viewer: { kind: 'admin' }, projectName: (id: string | null) => (id === null ? 'Fleet-wide' : 'koda') } })
    await m.settle()
    expect(m.app.textOf(m.rowEl('a1'))).toContain('koda')
    expect(m.app.textOf(m.rowEl('g1'))).toContain('Fleet-wide')
    m.app.unmount()
  })

  test('pending with more than 100 says so; All pages', async () => {
    const get = jest.fn(async (_p: string, opts?: { query?: Record<string, string> }) =>
      page([row('a1')], { hasNext: true, current: Number(opts?.query?.current ?? '1') }))
    const m = mount({ get })
    await m.settle()
    expect(m.byId('fleet-approvals-more')).toHaveLength(1)
    ;(m.byId('fleet-approvals-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('fleet-approvals-next')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals', { query: { size: '20', current: '2' } })
    m.app.unmount()
  })

  test('the project inbox subscribes to fleet_approval notices; the admin inbox does not', async () => {
    const project = mount({ get: jest.fn(async () => page([])) })
    await project.settle()
    expect(project.live()?.onFleetApproval).toBeDefined()
    project.app.unmount()
    const admin = mount({ get: jest.fn(async () => page([])), props: { base: { kind: 'admin' }, viewer: { kind: 'admin' } } })
    await admin.settle()
    expect(admin.live()).toBeNull()
    admin.app.unmount()
  })
})
