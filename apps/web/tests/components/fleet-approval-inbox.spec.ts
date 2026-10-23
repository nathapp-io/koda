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
  jest.restoreAllMocks()
})

/** The browser moment an open ask is first seen waiting for delivery; decidedAt in these fixtures is deliberately not this clock. */
const DELIVERY_T0 = Date.parse('2026-10-03T10:05:00.000Z')
/** D295 window (DELIVERY_WATCH_MS in ApprovalInbox.vue). */
const WINDOW_MS = 600_000

/** GET :id calls for one approval; collection polls (`/approvals`) are not counted. */
const detailGets = (get: jest.Mock, id: string): number => get.mock.calls.filter(([p]) => String(p).endsWith(`/${id}`)).length

function mount(opts: {
  get: jest.Mock
  post?: jest.Mock
  query?: Record<string, string>
  props?: Record<string, unknown>
  now?: Date
  /** The browser clock the D295 delivery watch reads (Date.now); unset keeps the real clock. */
  wallNow?: number
  /** The `useActionPreview().load` the assistant-action panel reads its exact preview through (US-004). */
  preview?: jest.Mock
}) {
  const api = { get: opts.get, post: opts.post ?? jest.fn() }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const preview = opts.preview ?? jest.fn(async () => 'Run the export')
  const toast = toastRecorder()
  const replace = jest.fn()
  let pollTask: () => Promise<void> = async () => undefined
  let live: Handlers | null = null
  const forbidden: unknown[] = []
  const clock = Vue.ref(opts.now ?? new Date('2026-10-03T10:05:00.000Z'))
  // Independent of the countdown ref above: only the delivery watch reads Date.now().
  const wall = { ms: opts.wallNow ?? 0 }
  if (opts.wallNow !== undefined) jest.spyOn(Date, 'now').mockImplementation(() => wall.ms)
  const setWall = (ms: number): void => { wall.ms = ms }
  const app = mountSfc(inbox, {
    components: uiStubs,
    fleetComponents: ['FleetApprovalBudgetPanel', 'FleetApprovalBashPanel', 'FleetApprovalActionPanel', 'FleetApprovalOutcome', 'FleetNativeSelect', 'FleetAge'],
    alias: {
      '~/composables/useApi': apiModule,
      // D292: a fixed clock; the real one ticks with setInterval.
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: clock }) },
    },
    props: {
      base: { kind: 'project', slug: 'koda' },
      viewer: { kind: 'project', canDecideBudget: true, canDecideBash: true, userId: 'u1' },
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
      useActionPreview: () => ({ load: preview }),
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
  return { app, api, toast, replace, forbidden, settle, byId, rowEl, toggle, preview, poll: () => pollTask(), live: () => live, setWall }
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
    const m = mount({ get, props: { viewer: { kind: 'project', canDecideBudget: false, canDecideBash: false, userId: 'u1' } } })
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
    const m = mount({ get, post, props: { viewer: { kind: 'project', canDecideBudget: false, canDecideBash: true, userId: 'u1' } } })
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

  test('a decided ask whose decidedAt is ahead of the clock is re-fetched only inside the browser window (D295 clock guard, US-004 R2)', async () => {
    const decidedFuture = bashRow('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: 'u1', decidedAt: '2099-01-01T00:00:00.000Z', outcome: null })
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? decidedFuture : page([])))
    const m = mount({ get, query: { id: 'b1' }, wallNow: DELIVERY_T0 })
    await m.settle()
    const loaded = detailGets(get, 'b1')
    // decidedAt is ignored: the far-future ask is re-fetched while the browser watch is open.
    await m.poll()
    await m.settle()
    expect(detailGets(get, 'b1')).toBe(loaded + 1)
    // Once 10 minutes have passed since the browser first saw it waiting, the watch stops.
    m.setWall(DELIVERY_T0 + 600_000)
    await m.poll()
    await m.settle()
    expect(detailGets(get, 'b1')).toBe(loaded + 1)
    m.app.unmount()
  })

  describe('delivery watch on the browser clock (US-004 R2)', () => {
    const waiting = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto =>
      bashRow(id, { status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: 'u1', outcome: null, ...over })

    test('a decided ask waiting for delivery with decidedAt in 2099 is fetched again on the next poll (AC-10)', async () => {
      const ask = waiting('b1', { decidedAt: '2099-01-01T00:00:00.000Z' })
      const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? ask : page([])))
      const m = mount({ get, query: { id: 'b1' }, wallNow: DELIVERY_T0 })
      await m.settle()
      const loaded = detailGets(get, 'b1')
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loaded + 1)
      m.app.unmount()
    })

    test('a decided ask waiting for delivery with decidedAt one year ago is fetched again on the next poll (AC-11)', async () => {
      const ask = waiting('b1', { decidedAt: '2025-10-03T10:05:00.000Z' })
      const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? ask : page([])))
      const m = mount({ get, query: { id: 'b1' }, wallNow: DELIVERY_T0 })
      await m.settle()
      const loaded = detailGets(get, 'b1')
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loaded + 1)
      m.app.unmount()
    })

    test('once the browser clock is 600000 ms past the first waiting load, the next poll stops fetching it (AC-12)', async () => {
      const ask = waiting('b1', { decidedAt: '2026-10-03T10:00:00.000Z' })
      const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? ask : page([])))
      const m = mount({ get, query: { id: 'b1' }, wallNow: DELIVERY_T0 })
      await m.settle()
      const loaded = detailGets(get, 'b1')
      m.setWall(DELIVERY_T0 + WINDOW_MS - 1)
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loaded + 1)
      m.setWall(DELIVERY_T0 + WINDOW_MS)
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loaded + 1)
      m.app.unmount()
    })

    test('after ask A\'s window has passed, opening ask B that is waiting starts B\'s window (AC-13)', async () => {
      const a = waiting('a1', { decidedAt: '2026-10-03T10:00:00.000Z' })
      const b = waiting('b1', { decidedAt: '2026-10-03T10:00:00.000Z' })
      const get = jest.fn(async (path: string) => {
        if (path.endsWith('/a1')) return a
        if (path.endsWith('/b1')) return b
        return page([a, b])
      })
      const m = mount({ get, wallNow: DELIVERY_T0 })
      await m.settle()
      await m.toggle('a1')
      m.setWall(DELIVERY_T0 + WINDOW_MS)
      await m.toggle('a1')
      await m.toggle('b1')
      const loadedB = detailGets(get, 'b1')
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loadedB + 1)
      m.app.unmount()
    })

    test('closing and reopening the same ask keeps its window: the reopen does not renew it', async () => {
      const a = waiting('a1', { decidedAt: '2026-10-03T10:00:00.000Z' })
      const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? a : page([a])))
      const m = mount({ get, wallNow: DELIVERY_T0 })
      await m.settle()
      await m.toggle('a1')
      m.setWall(DELIVERY_T0 + WINDOW_MS)
      await m.toggle('a1')
      await m.toggle('a1')
      const loaded = detailGets(get, 'a1')
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'a1')).toBe(loaded)
      m.app.unmount()
    })

    test('after the user allows an ask, the decided detail waiting for delivery is fetched again on the next poll (AC-14)', async () => {
      const pending = bashRow('b1')
      const decided = waiting('b1', { decidedAt: '2026-10-03T10:05:00.000Z' })
      let stored: FleetApprovalDto = pending
      const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? stored : page(stored.status === 'pending' ? [stored] : [])))
      const post = jest.fn(async () => { stored = decided; return decided })
      const m = mount({ get, post, wallNow: Date.parse('2026-10-04T12:00:00.000Z'), props: { viewer: { kind: 'project', canDecideBudget: false, canDecideBash: true, userId: 'u1' } } })
      await m.settle()
      await m.toggle('b1')
      ;(m.byId('fleet-approval-bash-allow')[0].props.onClick as () => void)()
      await m.settle()
      expect(m.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('waiting')
      const loaded = detailGets(get, 'b1')
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loaded + 1)
      m.app.unmount()
    })

    test('a delivered ask (outcome.delivery.result ok) is not fetched again on the next poll (AC-15)', async () => {
      const delivered = waiting('b1', { decidedAt: '2026-10-03T10:00:00.000Z', outcome: { delivery: { result: 'ok', detail: null, at: '2026-10-03T10:00:10.000Z' } } })
      const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? delivered : page([])))
      const m = mount({ get, query: { id: 'b1' }, wallNow: DELIVERY_T0 })
      await m.settle()
      const loaded = detailGets(get, 'b1')
      await m.poll()
      await m.settle()
      expect(detailGets(get, 'b1')).toBe(loaded)
      m.app.unmount()
    })
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
    const viewerOnly = mount({ get, props: { viewer: { kind: 'project', canDecideBudget: false, canDecideBash: false, userId: 'u1' } } })
    await viewerOnly.settle()
    await viewerOnly.toggle('b1')
    expect(viewerOnly.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(viewerOnly.byId('fleet-approval-bash-deny')).toHaveLength(0)
    viewerOnly.app.unmount()
    const developer = mount({ get, props: { viewer: { kind: 'project', canDecideBudget: false, canDecideBash: true, userId: 'u1' } } })
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
    const m = mount({ get, props: { base: { kind: 'admin' }, viewer: { kind: 'admin', canDecideBudget: true, canDecideBash: true, userId: null } } })
    await m.settle()
    expect(m.forbidden).toEqual([true])
    expect(m.toast.errors).toEqual([])
    m.app.unmount()
  })

  test('the admin inbox shows each row\'s project', async () => {
    const get = jest.fn(async () => page([row('a1'), row('g1', { projectId: null })]))
    const m = mount({ get, props: { base: { kind: 'admin' }, viewer: { kind: 'admin', canDecideBudget: true, canDecideBash: true, userId: null }, projectName: (id: string | null) => (id === null ? 'Fleet-wide' : 'koda') } })
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
    const admin = mount({ get: jest.fn(async () => page([])), props: { base: { kind: 'admin' }, viewer: { kind: 'admin', canDecideBudget: true, canDecideBash: true, userId: null } } })
    await admin.settle()
    expect(admin.live()).toBeNull()
    admin.app.unmount()
  })
})

describe('FleetApprovalInbox assistant actions (US-004)', () => {
  const actionPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    actionId: 'act1', tool: 'run_command', threadId: 't1', threadPath: '/koda/threads/t1', requestedById: 'u1', ...over,
  })
  const actionRow = (id: string, over: Partial<FleetApprovalDto> = {}, payload: Record<string, unknown> = {}): FleetApprovalDto =>
    row(id, { type: 'assistant_action', policyId: null, jobId: null, payload: actionPayload(payload), expiresAt: '2026-10-03T10:10:00.000Z', ...over })

  test('the requester\'s pending action opens the action panel with Approve (AC-1)', async () => {
    const action = actionRow('a1')
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? action : page([action])))
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    expect(m.byId('fleet-approval-action-panel')).toHaveLength(1)
    expect(m.byId('fleet-approval-action-approve')).toHaveLength(1)
    expect(m.byId('fleet-approval-action-approve')[0].props.disabled).toBe(false)
    expect(m.app.textOf(m.byId('fleet-approval-action-preview')[0])).toBe('Run the export')
    expect(m.preview).toHaveBeenCalledWith('/koda/threads/t1', 'act1')
    m.app.unmount()
  })

  test('someone else\'s pending action opens the panel without an Approve button (AC-2)', async () => {
    const action = actionRow('a1', {}, { requestedById: 'u2' })
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? action : page([action])))
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    expect(m.byId('fleet-approval-action-panel')).toHaveLength(1)
    expect(m.byId('fleet-approval-action-approve')).toHaveLength(0)
    expect(m.byId('fleet-approval-action-reject')).toHaveLength(0)
    expect(m.byId('fleet-approval-action-requester-only')).toHaveLength(1)
    // 2aw-D9: a viewer who cannot decide fetches nothing.
    expect(m.preview).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('Approve after the preview loaded decides the approval through useFleetApprovals (AC-11)', async () => {
    const action = actionRow('a1')
    const approved = actionRow('a1', { status: 'approved', decision: 'approve', resolvedBy: 'user', decidedById: 'u1', decidedAt: '2026-10-03T10:06:00.000Z' })
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? action : page([action])))
    const post = jest.fn(async () => approved)
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('a1')
    ;(m.byId('fleet-approval-action-approve')[0].props.onClick as () => void)()
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a1/decide', { decision: 'approve' })
    expect(m.toast.successes).toEqual(['Approved. The runner runs the action.'])
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    m.app.unmount()
  })

  test('a pending bash row still opens the bash panel, and a pending budget row the budget panel (AC-17, AC-18)', async () => {
    const bash = row('b1', {
      type: 'nax_bash_escalate', policyId: null, jobId: 'j1', expiresAt: '2026-10-03T10:10:00.000Z',
      payload: {
        command: 'rm -rf build', commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
        storyId: null, featureName: 'login', reason: 'outside the grants', options: ['allow', 'deny'],
      },
    })
    const budgetRow = row('c1', { requeueCandidates: [] })
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/b1')) return bash
      if (path.endsWith('/c1')) return budgetRow
      return page([bash, budgetRow])
    })
    const m = mount({ get })
    await m.settle()
    await m.toggle('b1')
    expect(m.byId('fleet-approval-bash-panel')).toHaveLength(1)
    expect(m.byId('fleet-approval-action-panel')).toHaveLength(0)
    await m.toggle('c1')
    expect(m.byId('fleet-approval-budget-panel')).toHaveLength(1)
    expect(m.byId('fleet-approval-action-panel')).toHaveLength(0)
    m.app.unmount()
  })
})

describe('FleetApprovalInbox keyboard (slice 4)', () => {
  const bashRow = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto =>
    row(id, {
      type: 'nax_bash_escalate', policyId: null,
      // Complete payload: keyboardDecision validates through bashPayload, like the bash panel.
      payload: {
        command: 'rm -rf node_modules', commandTruncated: false, maskedCount: 0, root: '/', stage: 'exec',
        featureName: 'f', reason: 'asked by nax', storyId: null, rawDetail: null, options: ['allow', 'deny'],
      },
      ...over,
    })

  /** The inbox registers its keydown handler on `document`; the node harness has none, so tests install a fake. */
  function withFakeDocument() {
    const listeners: Array<(e: unknown) => void> = []
    ;(globalThis as Record<string, unknown>).document = {
      addEventListener: (_kind: string, fn: (e: unknown) => void) => { listeners.push(fn) },
      removeEventListener: (_kind: string, fn: (e: unknown) => void) => {
        const at = listeners.indexOf(fn)
        if (at >= 0) listeners.splice(at, 1)
      },
    }
    const press = (key: string, over: Record<string, unknown> = {}) => {
      for (const fn of [...listeners]) {
        fn({ key, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, target: null, preventDefault: jest.fn(), ...over })
      }
    }
    return { press, count: () => listeners.length }
  }

  async function mountKeyboard(rows: FleetApprovalDto[], opts: { viewer?: Record<string, unknown>; post?: jest.Mock } = {}) {
    const fake = withFakeDocument()
    const detailIds = new Set(rows.map((r) => r.id))
    const get = jest.fn(async (path: string) => {
      // Detail reads are `/projects/koda/fleet/approvals/:id`; the list is the collection path.
      const id = path.split('/').pop()
      return id && detailIds.has(id) ? rows.find((r) => r.id === id) : page(rows)
    })
    const post = opts.post ?? jest.fn(async () => bashRow(rows[0]?.id ?? 'a1', { status: 'approved' }))
    const m = mount({
      get: get as unknown as jest.Mock,
      post,
      props: { viewer: opts.viewer ?? { kind: 'project', canDecideBudget: true, canDecideBash: true, userId: 'u1' } },
    })
    await m.settle()
    return { ...m, post, press: fake.press, listenerCount: fake.count }
  }

  const cursorOn = (m: ReturnType<typeof mount>, id: string) => m.rowEl(id)?.props['data-cursor'] === 'true'
  const expandedOn = (m: ReturnType<typeof mount>, id: string) => {
    const button = m.app.find('[data-testid="fleet-approval-toggle"]', m.rowEl(id))[0]
    return button?.props['aria-expanded'] === true
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document
  })

  test('j/k and arrows move the cursor; it starts on the first row and never leaves the list', async () => {
    const m = await mountKeyboard([bashRow('b1'), bashRow('b2')])
    expect(cursorOn(m, 'b1')).toBe(true)
    m.press('j')
    await m.settle()
    expect(cursorOn(m, 'b2')).toBe(true)
    m.press('j')
    await m.settle()
    expect(cursorOn(m, 'b2')).toBe(true)
    m.press('ArrowUp')
    await m.settle()
    expect(cursorOn(m, 'b1')).toBe(true)
    m.press('k')
    await m.settle()
    expect(cursorOn(m, 'b1')).toBe(true)
    m.app.unmount()
  })

  test('Enter opens the cursor row without a mouse', async () => {
    const m = await mountKeyboard([bashRow('b1'), bashRow('b2')])
    m.press('j')
    await m.settle()
    m.press('Enter')
    await m.settle()
    expect(expandedOn(m, 'b2')).toBe(true)
    m.app.unmount()
  })

  test('A approves the expanded bash ask, D denies it — through the same decide path', async () => {
    const post = jest.fn(async () => bashRow('b1', { status: 'approved' }))
    const m = await mountKeyboard([bashRow('b1')], { post })
    m.press('Enter')
    await m.settle()
    m.press('a')
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/b1/decide', expect.objectContaining({ decision: 'allow' }))
    m.press('Escape')
    m.press('Enter')
    await m.settle()
    m.press('d')
    await m.settle()
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals/b1/decide', expect.objectContaining({ decision: 'deny' }))
    m.app.unmount()
  })

  test('a budget ask: A does nothing (needs a typed amount), D keeps the policy paused', async () => {
    const post = jest.fn(async () => row('a1', { status: 'rejected', decision: 'keep_paused' }))
    const m = await mountKeyboard([row('a1')], { post })
    m.press('Enter')
    await m.settle()
    m.press('a')
    await m.settle()
    expect(post).not.toHaveBeenCalled()
    m.press('d')
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a1/decide', expect.objectContaining({ decision: 'keep_paused' }))
    m.app.unmount()
  })

  test('keys ignore typing targets and a viewer without rights; A/D do nothing without an open ask', async () => {
    const post = jest.fn(async () => bashRow('b1', { status: 'approved' }))
    const m = await mountKeyboard([bashRow('b1')], { post, viewer: { kind: 'project', canDecideBudget: false, canDecideBash: false, userId: 'u1' } })
    m.press('Enter')
    await m.settle()
    m.press('a', { target: { tagName: 'INPUT' } })
    m.press('a')
    expect(post).not.toHaveBeenCalled()
    m.app.unmount()

    const closed = await mountKeyboard([bashRow('b1')], { post: jest.fn(async () => bashRow('b1', { status: 'approved' })) })
    closed.press('d')
    expect(closed.post).not.toHaveBeenCalled()
    closed.app.unmount()
  })
})
