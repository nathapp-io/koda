import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'
// mountSfc re-instantiates `~/…` imports. Aliasing useApi keeps `instanceof ApiError` true inside the
// component (the 403 branch), and aliasing useApprovalInbox shares the module's own
// `approvalRequestsVersion`, which is what a decide anywhere in the tab bumps.
import * as inboxModule from '../../composables/useApprovalInbox'
import type { LiveApprovalRequestEvent, ProjectEventHandlers } from '../../lib/project-event-stream'

const { ApiError } = apiModule
const { approvalRequestsVersion } = inboxModule

const badge = webFile('components', 'fleet', 'ApprovalBadge.vue')

/** Every mounted badge, so a failed assertion cannot leave a real 60 s poller behind. */
const mounted: Mounted[] = []

afterEach(() => {
  for (const app of mounted.splice(0)) {
    try { app.unmount() } catch { /* the test already unmounted it */ }
  }
  delete (globalThis as Record<string, unknown>).useApi
  jest.useRealTimers()
})

/** `GET /approvals/counts`: every visible pending request, the caller's own included. */
const counts = (total: number, projects: { projectId: string; slug: string; pending: number }[] = []) =>
  ({ total, unscoped: 0, projects })

/** One `approval_request` live event of the project stream: the request, and its new status. */
const liveEvent = (requestId: string, status: string): LiveApprovalRequestEvent =>
  ({ id: `${requestId}:${status}`, type: 'approval_request', projectId: 'p1', requestId, status, at: '2026-11-01T00:00:00.000Z' })

interface MountOpts {
  slug?: string | null
  /** The account's global key set: `mayDecide()` decides the off-project target. */
  globalKeys?: readonly string[]
  /** Whether the browser exposes Notification (the badge's opt-in toggle). */
  notificationsSupported?: boolean
}

/**
 * Mounts the real badge over a `$api.get` double. The real `useApprovalInbox` runs (aliased only so the
 * spec can bump its `approvalRequestsVersion`); `useApprovalRequestNotifications` is doubled, because
 * US-006's contract with it is exactly "one `refresh()` per successful counts load".
 */
function mount(get: jest.Mock, opts: MountOpts = {}) {
  // The aliased useApprovalInbox module resolves its `useApi` auto-import off the global scope.
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
  const notifications = {
    refresh: jest.fn(async (): Promise<void> => undefined),
    decided: jest.fn(),
    enabled: ref(false),
    supported: ref(opts.notificationsSupported === true),
    toggleBrowserNotifications: jest.fn(async (): Promise<void> => undefined),
  }
  let head: { titleTemplate?: (title?: string) => string } = {}
  const state = new Map<string, Vue.Ref>()
  const toast = Object.assign(jest.fn((_title: string, _options: unknown) => 'toast'), { dismiss: jest.fn() })
  let task: () => Promise<void> = async () => undefined
  let live: ProjectEventHandlers | null = null
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async () => { await task() }, isActive: () => true }
  const app = mountSfc(badge, {
    components: uiStubs,
    props: { slug: opts.slug === undefined ? 'sandbox' : opts.slug },
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useApprovalInbox': inboxModule,
      '~/composables/useApprovalRequestNotifications': { useApprovalRequestNotifications: () => notifications },
    },
    globals: {
      ref, computed, watch,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useAuth: () => ({ user: ref({ id: 'u1', role: 'MEMBER' }) }),
      useState: (key: string, init: () => unknown) => {
        if (!state.has(key)) state.set(key, ref(init()))
        return state.get(key)
      },
      useAppToast: () => toast,
      navigateTo: jest.fn(async () => undefined),
      useGlobalPermissions: () => globalPermissionsStub(opts.globalKeys ?? []),
      useVisiblePolling: (fn: () => Promise<void>) => { task = fn; return polling },
      useProjectEvents: (_slug: string, handlers: ProjectEventHandlers) => { live = handlers },
      useHead: (value: typeof head | (() => typeof head)) => {
        Vue.watchEffect(() => { head = typeof value === 'function' ? value() : value })
      },
    },
  })
  mounted.push(app)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const el = () => app.find('[data-testid="fleet-approval-badge"]')
  return {
    app, polling, notifications, settle, el, head: () => head,
    live: () => live,
    poll: () => task(),
    countsCalls: (): number => (get.mock.calls as unknown as [string][])
      .filter(([url]) => url === '/approvals/counts').length,
  }
}

describe('us-006 AC-1: the badge shows the engine count, capped at 99+', () => {
  test('AC-1: GET /approvals/counts answering total 120 renders 99+', async () => {
    const get = jest.fn(async () => counts(120))
    const m = mount(get)
    await m.settle()

    expect(get).toHaveBeenCalledWith('/approvals/counts')
    expect(m.el()).toHaveLength(1)
    expect(m.app.textOf(m.el()[0])).toContain('99+')
    expect(m.el()[0].props['data-count']).toBe(120)
    m.app.unmount()
  })
})

describe('us-006 AC-2: nothing waits, nothing renders', () => {
  test('AC-2: total 0 renders no badge', async () => {
    const m = mount(jest.fn(async () => counts(0)))
    await m.settle()

    expect(m.el()).toHaveLength(0)
    m.app.unmount()
  })
})

describe('us-006 AC-3: on a project page the badge opens that project inbox', () => {
  test('AC-3: slug sandbox links to /sandbox/approvals', async () => {
    const m = mount(jest.fn(async () => counts(3)), { slug: 'sandbox' })
    await m.settle()

    expect(m.el()[0].props.to).toBe('/sandbox/approvals')
    m.app.unmount()
  })
})

describe('us-006 AC-4/AC-12: off a project page the badge picks the inbox the caller can use', () => {
  test('AC-4: a caller who may decide something gets the global inbox', async () => {
    const m = mount(jest.fn(async () => counts(2)), {
      slug: null,
      // A narrowed decide key is a decide key: `has('approval.decide')` would answer false here.
      globalKeys: ['approval.decide@label.create'],
    })
    await m.settle()

    expect(m.el()[0].props.to).toBe('/approvals')
    m.app.unmount()
  })

  test('AC-12: a caller who may not decide falls back to the first project row of the counts', async () => {
    const get = jest.fn(async () => counts(2, [
      { projectId: 'p2', slug: 'beta', pending: 1 },
      { projectId: 'p3', slug: 'gamma', pending: 1 },
    ]))
    const m = mount(get, { slug: null, globalKeys: ['user.read'] })
    await m.settle()

    expect(m.el()[0].props.to).toBe('/beta/approvals')
    m.app.unmount()
  })

  test('AC-12 (edge): no project row leaves the badge with no target, so it renders nothing', async () => {
    const m = mount(jest.fn(async () => counts(1, [])), { slug: null, globalKeys: [] })
    await m.settle()

    expect(m.el()).toHaveLength(0)
    m.app.unmount()
  })
})

describe('us-006 AC-5/AC-14: the badge reloads on live events and decides', () => {
  test('AC-5: an approval_request event reloads the counts once after the 300 ms debounce', async () => {
    const get = jest.fn(async () => counts(1))
    const m = mount(get)
    await m.settle()
    expect(m.live()?.onApprovalRequest).toBeDefined()

    jest.useFakeTimers()
    const before = m.countsCalls()
    m.live()?.onApprovalRequest?.(liveEvent('r1', 'pending'))
    expect(m.countsCalls()).toBe(before)
    jest.advanceTimersByTime(299)
    expect(m.countsCalls()).toBe(before)
    jest.advanceTimersByTime(1)
    jest.useRealTimers()
    await m.settle()

    expect(m.countsCalls()).toBe(before + 1)
    m.app.unmount()
  })

  test('AC-5 (edge): a burst of events inside the window is one reload', async () => {
    const get = jest.fn(async () => counts(1))
    const m = mount(get)
    await m.settle()

    jest.useFakeTimers()
    const before = m.countsCalls()
    m.live()?.onApprovalRequest?.(liveEvent('r1', 'pending'))
    jest.advanceTimersByTime(200)
    m.live()?.onApprovalRequest?.(liveEvent('r2', 'pending'))
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()

    expect(m.countsCalls()).toBe(before + 1)
    m.app.unmount()
  })

  test('AC-14: a bump of approvalRequestsVersion reloads the counts once', async () => {
    const get = jest.fn(async () => counts(2))
    const m = mount(get, { slug: null })
    await m.settle()

    jest.useFakeTimers()
    const before = m.countsCalls()
    approvalRequestsVersion.value += 1
    await Vue.nextTick()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()

    expect(m.countsCalls()).toBe(before + 1)
    m.app.unmount()
  })

  test('outside a project the badge subscribes to no stream', async () => {
    const m = mount(jest.fn(async () => counts(1)), { slug: null })
    await m.settle()

    expect(m.live()).toBeNull()
    m.app.unmount()
  })

  test('a settled approval_request event drops that request\'s notice at once', async () => {
    const m = mount(jest.fn(async () => counts(1)))
    await m.settle()

    m.live()?.onApprovalRequest?.(liveEvent('r1', 'approved'))
    expect(m.notifications.decided).toHaveBeenCalledWith('r1')
    m.app.unmount()
  })

  test('a pending approval_request event is news, not a settlement: nothing is dismissed', async () => {
    const m = mount(jest.fn(async () => counts(1)))
    await m.settle()

    m.live()?.onApprovalRequest?.(liveEvent('r1', 'pending'))
    expect(m.notifications.decided).not.toHaveBeenCalled()
    m.app.unmount()
  })
})

describe('us-006 AC-6: every successful counts load refreshes the notifications', () => {
  test('AC-6: one refresh per load, on mount and on every poll', async () => {
    const get = jest.fn(async () => counts(1))
    const m = mount(get)
    await m.settle()

    expect(m.countsCalls()).toBe(1)
    expect(m.notifications.refresh).toHaveBeenCalledTimes(1)

    await m.poll()
    await m.settle()

    expect(m.countsCalls()).toBe(2)
    expect(m.notifications.refresh).toHaveBeenCalledTimes(2)
    m.app.unmount()
  })

  test('AC-6 (edge): a refresh that answered nothing yet is not followed by another one', async () => {
    let answer: Promise<unknown> = new Promise(() => undefined)
    const get = jest.fn(() => answer)
    const m = mount(get)
    await m.settle()

    expect(m.notifications.refresh).not.toHaveBeenCalled()
    answer = Promise.resolve(counts(1))
    await m.poll()
    await m.settle()

    expect(m.notifications.refresh).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })
})

describe('us-006 AC-13: a refused counts read stops the badge', () => {
  test('AC-13: a 403 stops the poll and hides the whole badge', async () => {
    const m = mount(jest.fn(async () => { throw new ApiError(40003, 'forbidden') }), { notificationsSupported: true })
    await m.settle()

    expect(m.polling.stop).toHaveBeenCalled()
    expect(m.el()).toHaveLength(0)
    // The opt-in toggle goes with it: a caller with no decide key anywhere has nothing to approve.
    expect(m.app.find('[data-testid="fleet-approval-notifications"]')).toHaveLength(0)
    expect(m.notifications.refresh).not.toHaveBeenCalled()
    m.app.unmount()
  })
})

describe('us-006: lifecycle and failure handling', () => {
  test('a non-403 failure keeps the last count and the notifications, and retries on the next poll', async () => {
    let fail = false
    const get = jest.fn(async () => {
      if (fail) throw new Error('down')
      return counts(4)
    })
    const m = mount(get)
    await m.settle()
    expect(m.el()[0].props['data-count']).toBe(4)

    fail = true
    await m.poll()
    await m.settle()

    expect(m.el()[0].props['data-count']).toBe(4)
    expect(m.notifications.refresh).toHaveBeenCalledTimes(1)
    expect(m.polling.stop).not.toHaveBeenCalled()

    fail = false
    await m.poll()
    await m.settle()
    expect(m.countsCalls()).toBe(3)
    m.app.unmount()
  })

  test('a failed first load shows nothing, and the next poll still recovers', async () => {
    let fail = true
    const get = jest.fn(async () => {
      if (fail) throw new Error('down')
      return counts(2)
    })
    const m = mount(get)
    await m.settle()
    expect(m.el()).toHaveLength(0)

    fail = false
    await m.poll()
    await m.settle()
    expect(m.el()[0].props['data-count']).toBe(2)
    m.app.unmount()
  })

  test('starts its 60 s poll on mount and stops it on unmount', async () => {
    const m = mount(jest.fn(async () => counts(1)))
    await m.settle()
    expect(m.polling.start).toHaveBeenCalledTimes(1)

    m.app.unmount()
    expect(m.polling.stop).toHaveBeenCalled()
  })

  test('prefixes the tab title with the pending count', async () => {
    const m = mount(jest.fn(async () => counts(2)))
    await m.settle()

    expect(m.head().titleTemplate?.('Jobs - Koda')).toBe('(2) Jobs - Koda')
    m.app.unmount()
  })

  test('the opt-in toggle is offered when the browser supports notifications, and toggles them', async () => {
    const m = mount(jest.fn(async () => counts(1)), { notificationsSupported: true })
    await m.settle()

    const button = m.app.one('[data-testid="fleet-approval-notifications"]')
    if (!button) throw new Error('missing the notification opt-in toggle')
    expect(button.props['aria-pressed']).toBe(false)
    await (button.props.onClick as () => Promise<void>)()
    expect(m.notifications.toggleBrowserNotifications).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })

  test('announces the pending count and pulses while an ask waits', async () => {
    const m = mount(jest.fn(async () => counts(2)))
    await m.settle()

    const node = m.el()[0]
    expect(node.props['aria-live']).toBe('polite')
    expect(String(node.props.class)).toContain('animate-pulse')
    m.app.unmount()
  })
})
