import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ApprovalRequestDetail, ApprovalRequestSummary } from '../../lib/approval-requests'
import type { ProjectEventHandlers } from '../../lib/project-event-stream'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

// P3b US-007: the banner reads the approval engine (GET /approvals) for its budget-override links.
const banner = webFile('components', 'fleet', 'BudgetBanner.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const request = (id: string, over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id,
  permissionKey: 'fleet.budget.override',
  projectId: 'p1',
  actorType: 'AGENT',
  actorId: 'runner-1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'fleet',
  redeem: false,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-10-03T10:10:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-03T10:00:00.000Z',
  ...over,
})

/** The frozen stop `GET /approvals/:id` answers; `details.policyId` names the paused policy. */
const detail = (summary: ApprovalRequestSummary, policyId: string | null): ApprovalRequestDetail => ({
  ...summary,
  input: {
    scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc',
    windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '6.0000', amountUsd: '5.0000',
  },
  result: null,
  details: policyId === null ? null : { policyId },
  decisions: [],
})

const page = (records: ApprovalRequestSummary[]) => ({
  total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records,
})

interface Routes {
  policies?: unknown
  project?: unknown
  /** The listed stops: request id -> the policy its detail names, in list order. */
  stops?: Record<string, string | null>
  /** Request ids whose detail read fails. */
  failing?: readonly string[]
  /** The whole list read fails. */
  listFails?: boolean
}

/**
 * A `$api.get` that answers each surface the banner touches. The banner runs the real
 * `useFleetBudgets`, `useProjectRef` and `useApprovalInbox`, so the engine query is the one under test.
 */
const routed = (routes: Routes, slug = 'koda') =>
  jest.fn(async (path: string) => {
    if (path === `/projects/${slug}/fleet/budgets`) return routes.policies ?? []
    if (path === `/projects/${slug}`) return routes.project ?? { id: 'p1' }
    if (path === '/approvals') {
      if (routes.listFails === true) throw new Error('down')
      return page(Object.keys(routes.stops ?? {}).map((id) => request(id)))
    }
    const id = path.slice('/approvals/'.length)
    if (routes.failing?.includes(id) === true) throw new Error('down')
    return detail(request(id), routes.stops?.[id] ?? null)
  })

const NuxtLink = {
  name: 'StubNuxtLink',
  props: ['to'],
  setup(props: { to?: string }, { slots, attrs }: { slots: { default?: () => unknown }; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': 'nuxt-link', to: props.to }, slots.default?.() as never)
  },
}

function mountBanner(get: jest.Mock, props: Record<string, unknown> = {}, toast = toastRecorder()) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
  let task: () => Promise<void> = async () => undefined
  let live: ProjectEventHandlers | null = null
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  const app = mountSfc(banner, {
    components: { ...uiStubs, NuxtLink },
    props: { slug: 'koda', ...props },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: { get } }),
      useVisiblePolling: (fn: () => Promise<void>) => {
        task = fn
        return polling
      },
      useProjectEvents: (_slug: string, handlers: ProjectEventHandlers) => { live = handlers },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, polling, toast, settle, live: () => live, lines: () => app.find('[data-testid="fleet-budget-banner-line"]') }
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetBanner', () => {
  test('loads the project list and shows paused before warning, each with scope, spend and amount', async () => {
    const get = routed({
      policies: [
        policy('w', { scopeType: 'repo', scopeId: 'r1', warnReached: true, spentUsd: '4.2500' }),
        policy('p', { paused: true, spentUsd: '6.0000', warnReached: true }),
      ],
    })
    const m = mountBanner(get, { repoName: (id: string) => (id === 'r1' ? 'acme/app' : id) })
    await m.settle()

    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/budgets')
    expect(m.lines().map((l) => [l.props['data-policy'], l.props['data-status']])).toEqual([['p', 'paused'], ['w', 'warning']])
    expect(m.app.textOf(m.lines()[0])).toBe('Fleet budget paused for the whole fleet: $6.00 of $5.00 spent. New jobs are refused until it is resumed.')
    expect(m.app.textOf(m.lines()[1])).toBe('Fleet budget for repo acme/app is at 85% ($4.25 of $5.00).')
    m.app.unmount()
  })

  test('AC-8: the override list is the engine list of this project\'s pending budget stops', async () => {
    const get = routed({ policies: [policy('p', { paused: true })] })
    const m = mountBanner(get)
    await m.settle()

    expect(get).toHaveBeenCalledWith('/projects/koda')
    expect(get).toHaveBeenCalledWith('/approvals', {
      query: { status: 'pending', permissionKey: 'fleet.budget.override', projectId: 'p1', size: '100' },
    })
    m.app.unmount()
  })

  test('links to the project budgets page', async () => {
    const m = mountBanner(routed({ policies: [policy('p', { paused: true })] }))
    await m.settle()
    const link = m.app.find('[data-testid="fleet-budget-banner-link"]')
    expect(link).toHaveLength(1)
    expect(link[0].props.to).toBe('/koda/fleet/budgets')
    expect(m.app.textOf(link[0])).toBe('View budgets')
    m.app.unmount()
  })

  test('nothing flagged renders nothing (Review Focus 5)', async () => {
    const m = mountBanner(routed({ policies: [policy('ok'), policy('ok2', { scopeId: 'x', scopeType: 'project' })] }))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('a failed load renders nothing and does not throw', async () => {
    const m = mountBanner(jest.fn(async () => { throw new Error('down') }))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('more than three flagged policies show three lines and a count of the rest', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => policy(id, { scopeType: 'repo', scopeId: `r${i}`, paused: i < 2, warnReached: true }))
    const m = mountBanner(routed({ policies: rows }))
    await m.settle()

    expect(m.lines()).toHaveLength(3)
    const more = m.app.find('[data-testid="fleet-budget-banner-more"]')
    expect(m.app.textOf(more[0])).toBe('and 2 more')
    m.app.unmount()
  })

  test('a paused policy that is also past its warn threshold is one line', async () => {
    const m = mountBanner(routed({ policies: [policy('p', { paused: true, warnReached: true })] }))
    await m.settle()
    expect(m.lines()).toHaveLength(1)
    m.app.unmount()
  })

  test('a repo the page does not know shows its raw id', async () => {
    const m = mountBanner(routed({ policies: [policy('p', { scopeType: 'repo', scopeId: 'gone', paused: true })] }))
    await m.settle()
    expect(m.app.textOf(m.lines()[0])).toContain('repo gone')
    m.app.unmount()
  })

  test('polls on its own every 30 seconds', async () => {
    const m = mountBanner(routed({}))
    await m.settle()
    expect(m.polling.start).toHaveBeenCalled()
    m.app.unmount()
    expect(m.polling.stop).toHaveBeenCalled()
  })

  test('an approval_request live event reloads the links (P3b US-007)', async () => {
    const get = routed({})
    const m = mountBanner(get)
    await m.settle()
    const before = get.mock.calls.length

    m.live()?.onApprovalRequest?.({
      id: 'e1', type: 'approval_request', projectId: 'p1', requestId: 'a1', status: 'pending', at: '2026-10-03T10:00:00.000Z',
    })
    await m.settle()

    expect(get.mock.calls.length).toBeGreaterThan(before)
    m.app.unmount()
  })

  test('AC-9: a paused policy whose id matches a listed stop\'s detail links to that request', async () => {
    const m = mountBanner(
      routed({ policies: [policy('p', { scopeType: 'project', scopeId: 'p1', paused: true })], stops: { a1: 'p' } }, 'sandbox'),
      { slug: 'sandbox' },
    )
    await m.settle()

    const review = m.app.find('[data-testid="fleet-budget-banner-review"]')
    expect(review).toHaveLength(1)
    expect(review[0].props.to).toBe('/sandbox/approvals?id=a1')
    expect(m.app.textOf(review[0])).toBe('Review override')
    m.app.unmount()
  })

  test('no link for a warning line or a paused policy without a matching pending stop', async () => {
    const m = mountBanner(routed({
      policies: [policy('w', { scopeType: 'repo', scopeId: 'r1', warnReached: true }), policy('p', { paused: true })],
      stops: { a1: 'w' },
    }))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner-review"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('a failed stop list keeps the lines without links', async () => {
    const m = mountBanner(routed({ policies: [policy('p', { paused: true })], listFails: true }))
    await m.settle()
    expect(m.lines()).toHaveLength(1)
    expect(m.app.find('[data-testid="fleet-budget-banner-review"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-10: a failed request raises no toast', async () => {
    const m = mountBanner(jest.fn(async () => { throw new Error('down') }))
    await m.settle()
    expect(m.toast.calls).toEqual([])
    m.app.unmount()
  })

  test('AC-14: a failed refresh after a good one keeps the review links that were shown', async () => {
    let failing = false
    const good = routed({ policies: [policy('p', { paused: true })], stops: { a1: 'p' } })
    const get = jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
      if (failing) throw new Error('down')
      return good(path, options)
    })
    const m = mountBanner(get)
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner-review"]')).toHaveLength(1)

    failing = true
    await m.polling.runNow()
    await m.settle()

    const review = m.app.find('[data-testid="fleet-budget-banner-review"]')
    expect(review).toHaveLength(1)
    expect(review[0].props.to).toBe('/koda/approvals?id=a1')
    m.app.unmount()
  })

  test('AC-15: one failed stop detail leaves the other request\'s review link in place', async () => {
    const m = mountBanner(routed({
      policies: [
        policy('p1', { scopeType: 'project', scopeId: 'p1', paused: true }),
        policy('p2', { scopeType: 'project', scopeId: 'p1', paused: true }),
      ],
      stops: { a1: 'p1', a2: 'p2' },
      failing: ['a1'],
    }))
    await m.settle()

    const review = m.app.find('[data-testid="fleet-budget-banner-review"]')
    expect(review.map((n) => [n.props['data-policy'], n.props.to])).toEqual([['p2', '/koda/approvals?id=a2']])
    m.app.unmount()
  })

  test('only the first 20 stops get their detail read, in list order', async () => {
    const stops: Record<string, string> = {}
    for (let i = 0; i < 22; i += 1) stops[`a${String(i).padStart(2, '0')}`] = 'p'
    const get = routed({ policies: [policy('p', { paused: true })], stops })
    const m = mountBanner(get)
    await m.settle()

    const details = get.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/approvals/'))
    expect(details).toHaveLength(20)
    expect(details[0]).toBe('/approvals/a00')
    expect(details[19]).toBe('/approvals/a19')
    m.app.unmount()
  })

  test('a paused policy whose stop detail could not be read gets no link', async () => {
    const m = mountBanner(routed({ policies: [policy('p', { paused: true })], stops: { a1: 'p' }, failing: ['a1'] }))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner-review"]')).toHaveLength(0)
    m.app.unmount()
  })
})
