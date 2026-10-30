import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import type { ApprovalRequestDetail, ApprovalRequestSummary } from '../../lib/approval-requests'
import type { LiveApprovalRequestEvent, ProjectEventHandlers } from '../../lib/project-event-stream'

// mountSfc re-instantiates `~/…` imports; aliasing useApi keeps `instanceof ApiError` true inside the component.
const { ApiError } = apiModule

const inboxFile = webFile('components', 'approvals', 'ApprovalRequestInbox.vue')
/** The browser moment the countdown is rendered at: 2026-11-01T00:00:00Z. */
const NOW = new Date('2026-11-01T00:00:00.000Z')

const T = enI18n()

const row = (id: string, over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id,
  permissionKey: 'fleet.budget.override',
  projectId: 'p1',
  actorType: 'USER',
  actorId: 'u1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'fleet',
  redeem: false,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-11-01T00:10:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-31T23:59:00.000Z',
  ...over,
})

const detailOf = (summary: ApprovalRequestSummary): ApprovalRequestDetail => ({
  ...summary,
  input: null,
  result: null,
  details: null,
  decisions: [],
})

const pageOf = (records: ApprovalRequestSummary[], over: Record<string, unknown> = {}) => ({
  total: records.length,
  current: 1,
  size: 100,
  hasNext: false,
  hasPrev: false,
  records,
  ...over,
})

const liveEvent = (id: string): LiveApprovalRequestEvent =>
  ({ id, type: 'approval_request', projectId: 'p1', requestId: 'r1', status: 'pending', at: '2026-11-01T00:00:00.000Z' })

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

interface MountOptions {
  get: jest.Mock
  base?: Record<string, unknown>
  query?: Record<string, string>
  nameOf?: (userId: string) => string | null
  projectName?: (projectId: string) => string
}

function mountInbox(options: MountOptions) {
  const api = { get: options.get, post: jest.fn() }
  const toast = toastRecorder()
  const replace = jest.fn()
  const start = jest.fn()
  const stop = jest.fn()
  let pollTask: () => Promise<void> = async () => undefined
  let live: ProjectEventHandlers | null = null
  const app = mountSfc(inboxFile, {
    components: uiStubs,
    alias: {
      '~/composables/useApi': apiModule,
      // A fixed clock: the real countdown ticks with setInterval.
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(NOW) }) },
    },
    props: {
      base: options.base ?? { kind: 'project', slug: 'sandbox', projectId: 'p1' },
      nameOf: options.nameOf ?? ((id: string) => (id === 'u1' ? 'Ann' : null)),
      projectName: options.projectName ?? ((id: string) => (id === 'p1' ? 'sandbox' : id)),
    },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ query: options.query ?? {} }),
      useRouter: () => ({ replace }),
      useVisiblePolling: (task: () => Promise<void>) => {
        pollTask = task
        return { start, stop, runNow: async () => { await task() }, isActive: () => true }
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
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const rowEl = (id: string) => byId(`approval-request-row-${id}`)[0]
  const toggle = async (id: string) => {
    const button = app.find('[data-testid="approval-request-toggle"]', rowEl(id))[0]
    ;(button.props.onClick as () => void)()
    await settle()
  }
  return { app, api, toast, replace, start, stop, settle, byId, rowEl, toggle, poll: () => pollTask(), live: () => live }
}

describe('ApprovalRequestInbox — tabs and rows', () => {
  test('AC-3: the All tab requests one page of 20 and no status', async () => {
    const get = jest.fn(async () => pageOf([]))
    const m = mountInbox({ get, base: { kind: 'all' } })
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/approvals', { query: { status: 'pending', size: '100' } })
    ;(m.byId('approvals-inbox-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/approvals', { query: { size: '20' } })
    m.app.unmount()
  })

  test('AC-3 (edge): back on Pending, the project filter rides along', async () => {
    const get = jest.fn(async () => pageOf([]))
    const m = mountInbox({ get })
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/approvals', { query: { status: 'pending', projectId: 'p1', size: '100' } })
    ;(m.byId('approvals-inbox-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/approvals', { query: { projectId: 'p1', size: '20' } })
    m.app.unmount()
  })

  test('AC-4: a fleet.budget.override row shows the approvals.keys label', async () => {
    const get = jest.fn(async () => pageOf([row('r1')]))
    const m = mountInbox({ get })
    await m.settle()
    expect(m.app.textOf(m.rowEl('r1'))).toContain(T.t('approvals.keys.fleet_budget_override'))
    expect(m.app.textOf(m.rowEl('r1'))).not.toContain('fleet.budget.override')
    m.app.unmount()
  })

  test('AC-4 (edge): a key the locale does not know reads as itself', async () => {
    const get = jest.fn(async () => pageOf([row('r1', { permissionKey: 'brand.new.key' })]))
    const m = mountInbox({ get })
    await m.settle()
    expect(m.app.textOf(m.rowEl('r1'))).toContain('brand.new.key')
    m.app.unmount()
  })

  test('a row shows the requester, the project and the countdown', async () => {
    const get = jest.fn(async () => pageOf([row('r1'), row('r2', { actorType: 'AGENT', actorId: 'a1' })]))
    const m = mountInbox({ get })
    await m.settle()
    expect(m.app.textOf(m.rowEl('r1'))).toContain('Ann')
    expect(m.app.textOf(m.rowEl('r1'))).toContain('sandbox')
    expect(m.app.textOf(m.byId('approval-request-countdown')[0])).toBe('10:00')
    // An agent requester has no name lookup: its id is what the row says.
    expect(m.app.textOf(m.rowEl('r2'))).toContain('a1')
    m.app.unmount()
  })

  test('a row without a project, and a lookup that misses, fall back to the documented labels', async () => {
    const get = jest.fn(async () => pageOf([row('r1', { projectId: null, actorId: 'u9', actorType: 'USER' })]))
    const m = mountInbox({ get, nameOf: () => null })
    await m.settle()
    expect(m.app.textOf(m.rowEl('r1'))).toContain(T.t('approvals.inbox.noProject'))
    expect(m.app.textOf(m.rowEl('r1'))).toContain('u9')
    m.app.unmount()
  })

  test('the project inbox labels rows with its own slug, and the pending tab sorts soonest expiry first', async () => {
    const get = jest.fn(async () => pageOf([
      row('late', { expiresAt: '2026-11-01T00:20:00.000Z' }),
      row('soon', { expiresAt: '2026-11-01T00:05:00.000Z' }),
    ]))
    const m = mountInbox({ get })
    await m.settle()
    const ids = m.app.find('li').map((n) => n.props['data-testid'])
    expect(ids).toEqual(['approval-request-row-soon', 'approval-request-row-late'])
    expect(m.app.textOf(m.rowEl('soon'))).toContain('sandbox')
    m.app.unmount()
  })

  test('the All tab labels every row with its status', async () => {
    const get = jest.fn(async () => pageOf([row('r1', { status: 'executed' })]))
    const m = mountInbox({ get, base: { kind: 'all' } })
    await m.settle()
    expect(m.byId('approval-request-status')).toHaveLength(0)
    ;(m.byId('approvals-inbox-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.app.textOf(m.byId('approval-request-status')[0])).toBe(T.t('approvals.inbox.status.executed'))
    m.app.unmount()
  })

  test('an empty list words the empty state for the open tab', async () => {
    const get = jest.fn(async () => pageOf([]))
    const m = mountInbox({ get, base: { kind: 'all' } })
    await m.settle()
    const empty = m.app.one('[data-stub="empty-state"]')
    // The stub forwards the copy as a prop (the real EmptyState renders it in a <p>).
    expect(empty?.props.message).toBe(T.t('approvals.inbox.empty.pending'))
    m.app.unmount()
  })
})

describe('ApprovalRequestInbox — opening a row', () => {
  test('AC-7: opening a row fetches its detail', async () => {
    const get = jest.fn(async (path: string) => (path === '/approvals' ? pageOf([row('r1')]) : detailOf(row('r1'))))
    const m = mountInbox({ get })
    await m.settle()
    await m.toggle('r1')
    expect(get).toHaveBeenCalledWith('/approvals/r1')
    expect(m.byId('approval-request-detail')).toHaveLength(1)
    m.app.unmount()
  })

  test('AC-8: opening a row replaces the query with id, keeping unrelated entries', async () => {
    const get = jest.fn(async (path: string) => (path === '/approvals' ? pageOf([row('r1')]) : detailOf(row('r1'))))
    const m = mountInbox({ get, query: { tab: 'all' } })
    await m.settle()
    await m.toggle('r1')
    expect(m.replace).toHaveBeenCalledWith({ query: { tab: 'all', id: 'r1' } })
    m.app.unmount()
  })

  test('AC-8 (edge): collapsing removes id again, and a route id opens that row on mount', async () => {
    const get = jest.fn(async (path: string) => (path === '/approvals' ? pageOf([row('r1')]) : detailOf(row('r1'))))
    const m = mountInbox({ get, query: { id: 'r1' } })
    await m.settle()
    expect(get).toHaveBeenCalledWith('/approvals/r1')
    expect(m.byId('approval-request-detail')).toHaveLength(1)
    await m.toggle('r1')
    expect(m.replace).toHaveBeenLastCalledWith({ query: {} })
    expect(m.byId('approval-request-detail')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-8 (edge): a route id that is not on the loaded page still shows its row and detail', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === '/approvals') return pageOf([row('other')])
      if (path === '/approvals/linked') return detailOf(row('linked', { permissionKey: 'fleet.job.shell.escalate' }))
      throw new Error(`unexpected GET ${path}`)
    })
    const m = mountInbox({ get, query: { id: 'linked' } })
    await m.settle()
    expect(get).toHaveBeenCalledWith('/approvals/linked')
    // The linked request is not in the page the list answered: it is rendered from its own detail.
    expect(m.byId('approval-request-row-linked')).toHaveLength(1)
    expect(m.rowEl('linked').props['data-linked']).toBe('true')
    expect(m.byId('approval-request-detail')).toHaveLength(1)
    expect(m.app.textOf(m.rowEl('linked'))).toContain(T.t('approvals.keys.fleet_job_shell_escalate'))
    expect(m.app.textOf(m.rowEl('linked'))).toContain(T.t('approvals.inbox.linked'))
    // Closing it leaves only the page the list answered.
    await m.toggle('linked')
    expect(m.byId('approval-request-row-linked')).toHaveLength(0)
    expect(m.byId('approval-request-row-other')).toHaveLength(1)
    m.app.unmount()
  })

  test('AC-10: a failed detail fetch closes the row, drops id and toasts', async () => {
    const get = jest.fn(async (path: string) => {
      if (path === '/approvals') return pageOf([row('r1')])
      throw new ApiError(500, 'boom')
    })
    const m = mountInbox({ get, query: { id: 'r1' } })
    await m.settle()
    expect(get).toHaveBeenCalledWith('/approvals/r1')
    expect(m.replace).toHaveBeenCalledWith({ query: {} })
    expect(m.byId('approval-request-detail')).toHaveLength(0)
    expect(m.toast.errors).toEqual(['boom'])
    m.app.unmount()
  })
})

describe('ApprovalRequestInbox — paging', () => {
  test('AC-9: Next asks for the next page on the All tab', async () => {
    const get = jest.fn(async () => pageOf([row('r1')], { hasNext: true, size: 20 }))
    const m = mountInbox({ get, base: { kind: 'all' } })
    await m.settle()
    ;(m.byId('approvals-inbox-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('approvals-inbox-next')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/approvals', { query: { size: '20', current: '2' } })
    m.app.unmount()
  })

  test('AC-9 (edge): Previous is disabled on the first page and there is no pager on Pending', async () => {
    const get = jest.fn(async () => pageOf([row('r1')], { hasNext: true, size: 20 }))
    const m = mountInbox({ get, base: { kind: 'all' } })
    await m.settle()
    expect(m.byId('approvals-inbox-next')).toHaveLength(0)
    ;(m.byId('approvals-inbox-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.byId('approvals-inbox-prev')[0].props.disabled).toBe(true)
    m.app.unmount()
  })
})

describe('ApprovalRequestInbox — live reload and polling', () => {
  test('AC-11: an approval_request event reloads the list once, after the 300 ms debounce', async () => {
    const get = jest.fn(async () => pageOf([row('r1')]))
    const m = mountInbox({ get })
    await m.settle()
    expect(get).toHaveBeenCalledTimes(1)
    expect(m.live()?.onApprovalRequest).toBeDefined()

    jest.useFakeTimers()
    m.live()?.onApprovalRequest?.(liveEvent('e1'))
    m.live()?.onApprovalRequest?.(liveEvent('e2'))
    jest.advanceTimersByTime(299)
    expect(get).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1)
    jest.useRealTimers()
    await m.settle()

    expect(get).toHaveBeenCalledTimes(2)
    m.app.unmount()
  })

  test('the inbox polls through the visible-tab poller, starting at once', async () => {
    const get = jest.fn(async () => pageOf([]))
    const m = mountInbox({ get })
    await m.settle()
    expect(m.start).toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(1)
    await m.poll()
    expect(get).toHaveBeenCalledTimes(2)
    m.app.unmount()
  })
})

describe('ApprovalRequestInbox — failures', () => {
  test('AC-12: a 403 shows approvals.inbox.forbidden and stops polling', async () => {
    const get = jest.fn(async () => { throw new ApiError(40003, 'nope') })
    const m = mountInbox({ get })
    await m.settle()
    expect(m.app.textOf(m.byId('approvals-inbox-forbidden')[0])).toBe(T.t('approvals.inbox.forbidden'))
    expect(m.stop).toHaveBeenCalled()
    expect(m.byId('approvals-inbox-list')).toHaveLength(0)
    expect(m.toast.errors).toEqual([])
    m.app.unmount()
  })

  test('AC-13: a first load that fails shows approvals.inbox.loadFailed and toasts', async () => {
    const get = jest.fn(async () => { throw new ApiError(500, 'boom') })
    const m = mountInbox({ get })
    await m.settle()
    expect(m.toast.errors).toEqual(['boom'])
    expect(m.app.find('[data-stub="error-state"]')).toHaveLength(0)
    expect(m.app.textOf(m.byId('approvals-inbox-load-failed')[0])).toContain(T.t('approvals.inbox.loadFailed'))
    m.app.unmount()
  })

  test('AC-14: a later failure keeps the rows and shows approvals.inbox.stale', async () => {
    let fail = false
    const get = jest.fn(async () => {
      if (fail) throw new ApiError(500, 'boom')
      return pageOf([row('r1')])
    })
    const m = mountInbox({ get })
    await m.settle()
    expect(m.byId('approval-request-row-r1')).toHaveLength(1)
    fail = true
    await m.poll()
    await m.settle()
    expect(m.byId('approval-request-row-r1')).toHaveLength(1)
    expect(m.app.textOf(m.rowEl('r1'))).toContain('Ann')
    expect(m.app.textOf(m.byId('approvals-inbox-stale')[0])).toBe(T.t('approvals.inbox.stale'))
    expect(m.toast.errors).toEqual([])
    m.app.unmount()
  })
})
