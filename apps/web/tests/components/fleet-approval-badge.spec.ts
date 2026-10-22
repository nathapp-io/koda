import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { fakeAsyncData } from '../helpers/permission-nav'
import { useGlobalPermissions } from '~/composables/usePermissions'
import * as approvalsModule from '../../composables/useFleetApprovals'

// mountSfc re-instantiates `~/…` imports; aliasing the module lets the test bump the badge's own approvalsVersion.
const { approvalsVersion } = approvalsModule

const badge = webFile('components', 'fleet', 'ApprovalBadge.vue')

type Handlers = { onFleetApproval?: (event?: { approvalId: string; status: string }) => void; onResync: () => void }

/** Every mounted badge: the notification composable starts a real 1 s ticker, so a failure must not leak one. */
const mounted: Mounted[] = []

afterEach(() => {
  for (const app of mounted.splice(0)) {
    try { app.unmount() } catch { /* the test already unmounted it */ }
  }
  for (const key of ['useApi', 'useAsyncData', 'Notification', 'document', 'window', 'localStorage']) delete (globalThis as Record<string, unknown>)[key]
  jest.useRealTimers()
})

/** The keys a project answers unless a test says otherwise: that project can decide both ask kinds. */
const DEFAULT_PROJECT_KEYS: readonly string[] = ['fleet.approval.decide.bash', 'fleet.approval.decide.budget']

interface MountOpts {
  slug?: string | null
  /** The account's global key set, mutable so a test can take `fleet.approval.read` away. */
  globalKeys?: Vue.Ref<readonly string[]>
  /** Per-project key sets; a project not named answers `DEFAULT_PROJECT_KEYS`. */
  projectKeys?: Record<string, readonly string[]>
  /** Replaces the whole `/me/permissions` answer, for a failing or hanging read. */
  permissionRead?: (slug: string | null) => unknown
  state?: Map<string, Vue.Ref>
  user?: Vue.Ref<{ id: string; role: string } | null>
}

/**
 * Mounts the real badge. `get` answers the non-permission routes (`/fleet/approval-counts`, the inbox
 * pages); `/me/permissions` is answered here from the key maps, exactly as the API answers it.
 */
function mount(get: jest.Mock, opts: MountOpts = {}) {
  const globalKeys = opts.globalKeys ?? ref<readonly string[]>([])
  const apiGet = (url: string, options?: { query?: Record<string, string> }) => {
    if (url === '/me/permissions') {
      const slug = options?.query?.project
      if (opts.permissionRead) return opts.permissionRead(slug ?? null)
      return {
        scope: slug === undefined ? 'global' : 'project',
        projectSlug: slug ?? null,
        keys: [...(slug === undefined ? globalKeys.value : (opts.projectKeys?.[slug] ?? DEFAULT_PROJECT_KEYS))],
      }
    }
    return options === undefined ? get(url) : get(url, options)
  }
  // The real permissions composable resolves its Nuxt auto-imports off the global scope, because the spec
  // hands the badge that module itself (mount-sfc would otherwise re-instantiate it per mount).
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { get: apiGet } })
  ;(globalThis as Record<string, unknown>).useAsyncData = fakeAsyncData
  const state = opts.state ?? new Map<string, Vue.Ref>()
  const user = opts.user ?? ref({ id: 'u1', role: 'MEMBER' })
  const toast = Object.assign(jest.fn((_title: string, _options: unknown) => 'toast'), { dismiss: jest.fn() })
  const navigate = jest.fn()
  let head: { titleTemplate?: (title?: string) => string } = {}
  let pollDeps: { isHidden: () => boolean } | undefined
  let task: () => Promise<void> = async () => undefined
  let live: Handlers | null = null
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async () => { await task() }, isActive: () => true }
  const app = mountSfc(badge, {
    components: uiStubs,
    props: { slug: opts.slug === undefined ? 'koda' : opts.slug },
    alias: { '~/composables/useFleetApprovals': approvalsModule },
    globals: {
      ref, computed, watch,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get: apiGet } }),
      // US-009: the badge reads the global key set through the real composable.
      useAsyncData: fakeAsyncData,
      useGlobalPermissions,
      useState: (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) },
      useHead: (value: typeof head | (() => typeof head)) => { Vue.watchEffect(() => { head = typeof value === 'function' ? value() : value }) },
      navigateTo: navigate,
      useAppToast: () => toast,
      useAuth: () => ({ user }),
      useVisiblePolling: (fn: () => Promise<void>, _ms: number, deps?: typeof pollDeps) => { task = fn; pollDeps = deps; return polling },
      useProjectEvents: (_s: string, h: Handlers) => { live = h },
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
  return { app, polling, settle, el, poll: () => task(), live: () => live, toast, navigate, head: () => head, pollDeps: () => pollDeps }
}

const counts = (total: number) => ({ total, unscoped: 0, projects: total > 0 ? [{ projectId: 'p2', slug: 'beta', pending: total }] : [] })

describe('FleetApprovalBadge (D247)', () => {
  test('hidden while nothing is pending', async () => {
    const m = mount(jest.fn(async () => counts(0)))
    await m.settle()
    expect(m.el()).toHaveLength(0)
    m.app.unmount()
  })

  test('shows the total and links to the current project inbox', async () => {
    const get = jest.fn(async () => counts(3))
    const m = mount(get)
    await m.settle()
    expect(get).toHaveBeenCalledWith('/fleet/approval-counts')
    expect(m.el()[0].props['data-count']).toBe(3)
    expect(m.el()[0].props.to).toBe('/koda/fleet/approvals')
    expect(m.app.textOf(m.el()[0])).toContain('3')
    m.app.unmount()
  })

  test('outside a project: the first project with pending, the admin inbox for a holder of fleet.approval.read', async () => {
    const member = mount(jest.fn(async () => counts(2)), { slug: null })
    await member.settle()
    expect(member.el()[0].props.to).toBe('/beta/fleet/approvals')
    member.app.unmount()
    // US-009: reading the admin inbox is a key, not the account's ADMIN role.
    const reader = mount(jest.fn(async () => counts(2)), { slug: null, globalKeys: ref<readonly string[]>(['fleet.approval.read']), user: ref({ id: 'u1', role: 'MEMBER' }) })
    await reader.settle()
    expect(reader.el()[0].props.to).toBe('/admin/fleet/approvals')
    reader.app.unmount()
  })

  test('over 99 shows 99+', async () => {
    const m = mount(jest.fn(async () => counts(150)))
    await m.settle()
    expect(m.app.textOf(m.el()[0])).toContain('99+')
    m.app.unmount()
  })

  test('announces the pending count and pulses while an ask waits (#208)', async () => {
    const m = mount(jest.fn(async () => counts(2)))
    await m.settle()
    const badgeEl = m.el()[0]
    expect(badgeEl.props['aria-live']).toBe('polite')
    expect(String(badgeEl.props.class)).toContain('animate-pulse')
    m.app.unmount()
  })

  test('a failed refresh keeps the last count; a failed first load shows nothing', async () => {
    let fail = false
    const get = jest.fn(async () => {
      if (fail) throw new Error('down')
      return counts(4)
    })
    const m = mount(get)
    await m.settle()
    fail = true
    await m.poll()
    await m.settle()
    expect(m.el()[0].props['data-count']).toBe(4)
    m.app.unmount()

    const broken = mount(jest.fn(async () => { throw new Error('down') }))
    await broken.settle()
    expect(broken.el()).toHaveLength(0)
    broken.app.unmount()
  })

  test('a fleet_approval notice of the project refreshes after 300 ms', async () => {
    const get = jest.fn(async () => counts(1))
    const m = mount(get)
    await m.settle()
    jest.useFakeTimers()
    const before = countsCalls(get)
    m.live()?.onFleetApproval?.()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    expect(countsCalls(get)).toBe(before + 1)
    m.app.unmount()
  })

  test('outside a project it does not subscribe to a stream', async () => {
    const m = mount(jest.fn(async () => counts(1)), { slug: null })
    await m.settle()
    expect(m.live()).toBeNull()
    m.app.unmount()
  })

  test('starts and stops its 60 s poll', async () => {
    const m = mount(jest.fn(async () => counts(1)))
    await m.settle()
    expect(m.polling.start).toHaveBeenCalled()
    m.app.unmount()
    expect(m.polling.stop).toHaveBeenCalled()
  })

  test('a decide anywhere in the tab refreshes after 300 ms (approvalsVersion)', async () => {
    const get = jest.fn(async () => counts(2))
    const m = mount(get, { slug: null })
    await m.settle()
    jest.useFakeTimers()
    const before = countsCalls(get)
    approvalsVersion.value += 1
    await Vue.nextTick()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    expect(countsCalls(get)).toBe(before + 1)
    m.app.unmount()
  })
})

/** How often the badge asked for the counts — one per refresh, whatever the scan also requested. */
const countsCalls = (get: jest.Mock): number =>
  (get.mock.calls as unknown as [string][]).filter(([url]) => url === '/fleet/approval-counts').length

const approval = (id = 'a1', overrides: Record<string, unknown> = {}) => ({
  id, type: 'nax_bash_escalate', status: 'pending', projectId: 'p2', jobId: 'job-123', policyId: null,
  payload: { command: '<script>alert(1)</script>' + 'x'.repeat(100), commandTruncated: false, maskedCount: 0,
    root: '/work', stage: 'execute', featureName: 'ship', reason: 'permission', options: ['allow', 'deny'] },
  requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(),
  outcome: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...overrides,
})

/** Answers the counts, one approval's detail and the inbox pages; `/me/permissions` is the harness's job. */
const notificationApi = (rows: ReturnType<typeof approval>[]) => jest.fn(async (url: string) => {
  if (url === '/fleet/approval-counts') return counts(rows.length)
  if (url.endsWith('/a1')) return rows.find(row => row.id === 'a1')
  return { records: rows, total: rows.length, hasNext: false, current: 1, size: 100 }
}).mockName('notificationApi')

describe('Approval attention notifications (#208)', () => {
  test('shows waiting text, prefixes tab title, and creates a persistent safe command toast with a review link', async () => {
    const m = mount(notificationApi([approval()]))
    await m.settle()
    expect(m.app.text()).toContain('1 waiting')
    expect(m.head().titleTemplate?.('Jobs - Koda')).toBe('(1) Jobs - Koda')
    expect(m.toast).toHaveBeenCalledTimes(1)
    const [title, options] = m.toast.mock.calls[0] as unknown as [string, { duration: number; description: string; action: { onClick: () => void } }]
    expect(title).toContain('Approval')
    expect(options.duration).toBe(Infinity)
    expect(options.description).toContain('<script>alert(1)</script>')
    expect(options.description).toContain('...')
    expect(options.description).toContain('job-123')
    expect(options.description).toContain('2:00')
    options.action.onClick()
    expect(m.navigate).toHaveBeenCalledWith('/beta/fleet/approvals?id=a1')
    await m.poll()
    expect(m.toast).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })

  test('does not notify a project whose key set holds no decide key', async () => {
    // US-009: the project's keys, not a member role, decide whether its inbox is read at all.
    const m = mount(notificationApi([approval()]), { projectKeys: { beta: ['fleet.job.dispatch', 'fleet.approval.read'] } })
    await m.settle()
    expect(m.toast).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('a budget ask needs the budget key; a holder of fleet.approval.read sees it from the admin inbox', async () => {
    const budget = approval('a1', { type: 'budget_override_required', expiresAt: null })
    // The project can decide bash asks, but not a budget override.
    const bashOnly = mount(notificationApi([budget]), { projectKeys: { beta: ['fleet.approval.decide.bash'] } })
    await bashOnly.settle()
    expect(bashOnly.toast).not.toHaveBeenCalled()
    bashOnly.app.unmount()

    // The admin viewer's own decision rights come from the same global set: read plus the budget key.
    const reader = mount(notificationApi([budget]), {
      slug: null,
      globalKeys: ref<readonly string[]>(['fleet.approval.read', 'fleet.approval.decide.budget']),
    })
    await reader.settle()
    expect(reader.toast).toHaveBeenCalledTimes(1)
    const options = reader.toast.mock.calls[0][1] as unknown as { action: { onClick: () => void } }
    options.action.onClick()
    expect(reader.navigate).toHaveBeenCalledWith('/admin/fleet/approvals?id=a1')
    reader.app.unmount()
  })

  test('ignores expired and decided rows, dismisses an active toast on a decision event', async () => {
    const rows = [approval(), approval('a2', { expiresAt: new Date(Date.now() - 1).toISOString() }), approval('a3', { status: 'approved' })]
    const m = mount(notificationApi(rows))
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    m.live()?.onFleetApproval?.({ approvalId: 'a1', status: 'approved' })
    expect(m.toast.dismiss).toHaveBeenCalled()
    m.app.unmount()
  })

  test('polls while hidden', async () => {
    const m = mount(notificationApi([approval()]))
    await m.settle()
    expect(m.pollDeps()?.isHidden()).toBe(false)
    m.app.unmount()
  })

  test('restores active pending toasts across navigation using the same notification ID', async () => {
    const state = new Map<string, Vue.Ref>()
    const first = mount(notificationApi([approval()]), { state })
    await first.settle()
    expect(first.toast).toHaveBeenCalledTimes(1)
    first.app.unmount()
    const second = mount(notificationApi([approval()]), { state })
    await second.settle()
    expect(second.toast).toHaveBeenCalledTimes(1)
    expect((second.toast.mock.calls[0][1] as { id: string }).id).toBe((first.toast.mock.calls[0][1] as { id: string }).id)
    second.app.unmount()
  })

  test('drops a pending list that resolves after unmount', async () => {
    let finish: (value: unknown) => void = () => undefined
    const api = notificationApi([approval()])
    const m = mount(jest.fn((url: string) => url.endsWith('/approvals')
      ? new Promise(resolve => { finish = resolve }) : api(url)).mockName('notificationApi'))
    await m.settle()
    m.app.unmount()
    finish({ records: [approval()], hasNext: false })
    await m.settle()
    expect(m.toast).not.toHaveBeenCalled()
  })
})

function browserHarness(permission: NotificationPermission = 'granted', hidden = true) {
  const instances: { title: string; options: NotificationOptions; close: jest.Mock; onclick?: () => void }[] = []
  const storage = new Map<string, string>()
  const focus = jest.fn()
  class BrowserNotification {
    static permission = permission
    static requestPermission = jest.fn(async () => permission)
    close = jest.fn()
    onclick?: () => void
    constructor(public title: string, public options: NotificationOptions) { instances.push(this) }
  }
  Object.assign(globalThis, {
    Notification: BrowserNotification,
    document: { visibilityState: hidden ? 'hidden' : 'visible' },
    window: { focus },
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
  })
  return { instances, storage, focus, requestPermission: BrowserNotification.requestPermission }
}

describe('Opt-in background browser approval notifications', () => {
  test('requests permission only on explicit opt-in, persists it and delivers new hidden requests with a focus/review action', async () => {
    const browser = browserHarness()
    const rows: ReturnType<typeof approval>[] = []
    const m = mount(notificationApi(rows))
    await m.settle()
    expect(browser.requestPermission).not.toHaveBeenCalled()
    expect(browser.instances).toHaveLength(0)
    const button = m.app.one('[data-testid="fleet-approval-notifications"]')
    if (!button) throw new Error('Missing notification permission button')
    await (button.props.onClick as () => Promise<void>)()
    expect(browser.requestPermission).toHaveBeenCalledTimes(1)
    expect(browser.storage.get('koda-approval-notifications-u1')).toBe('true')
    rows.push(approval())
    await m.poll()
    expect(browser.instances).toHaveLength(1)
    expect(browser.instances[0].options.body).toContain('job-123')
    expect(browser.instances[0].options.body).toContain('2:00')
    await m.poll()
    expect(browser.instances).toHaveLength(1)
    browser.instances[0].onclick?.()
    expect(browser.focus).toHaveBeenCalledTimes(1)
    expect(m.navigate).toHaveBeenCalledWith('/beta/fleet/approvals?id=a1')
    expect(browser.instances[0].close).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })

  test.each([['denied', true], ['granted', false]] as const)('does not deliver with permission %s and hidden=%s', async (permission, hidden) => {
    const browser = browserHarness(permission, hidden)
    browser.storage.set('koda-approval-notifications-u1', 'true')
    const m = mount(notificationApi([approval()]))
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    expect(browser.instances).toHaveLength(0)
    expect(browser.requestPermission).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('unsupported browsers show no permission button while in-app notifications still work', async () => {
    const m = mount(notificationApi([approval()]))
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    expect(m.app.find('[data-testid="fleet-approval-notifications"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('reuses persisted opt-in on admin pages, then closes browser and toast when polling finds the request resolved', async () => {
    const browser = browserHarness()
    browser.storage.set('koda-approval-notifications-u1', 'true')
    const rows = [approval()]
    const m = mount(notificationApi(rows), {
      slug: null,
      globalKeys: ref<readonly string[]>(['fleet.approval.read', 'fleet.approval.decide.bash']),
    })
    await m.settle()
    expect(browser.instances).toHaveLength(1)
    expect(browser.requestPermission).not.toHaveBeenCalled()
    rows.length = 0
    await m.poll()
    expect(browser.instances[0].close).toHaveBeenCalledTimes(1)
    expect(m.toast.dismiss).toHaveBeenCalled()
    expect(m.head().titleTemplate?.('Jobs')).toBe('Jobs')
    m.app.unmount()
  })

  test('expires and dismisses notifications locally even before the next polling response', async () => {
    const browser = browserHarness()
    browser.storage.set('koda-approval-notifications-u1', 'true')
    jest.useFakeTimers()
    const m = mount(notificationApi([approval('a1', { expiresAt: new Date(Date.now() + 1500).toISOString() })]))
    await Vue.nextTick()
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    expect(browser.instances).toHaveLength(1)
    jest.advanceTimersByTime(2000)
    expect(browser.instances[0].close).toHaveBeenCalledTimes(1)
    expect(m.toast.dismiss).toHaveBeenCalled()
    m.app.unmount()
  })
})

describe('Notification authorization and asynchronous lifecycle', () => {
  test('dismisses the original owner notification on logout, then allows a different user to see their pending request', async () => {
    const user = ref<{ id: string; role: string } | null>({ id: 'u1', role: 'MEMBER' })
    const m = mount(notificationApi([approval()]), { user })
    await m.settle()
    const id = (m.toast.mock.calls[0][1] as { id: string }).id
    user.value = null
    await Vue.nextTick()
    expect(m.toast.dismiss).toHaveBeenCalledWith(id)
    user.value = { id: 'u2', role: 'MEMBER' }
    await m.poll()
    expect(m.toast).toHaveBeenCalledTimes(2)
    expect((m.toast.mock.calls[1][1] as { id: string }).id).not.toBe(id)
    m.app.unmount()
  })

  test('closes alerts when the project set loses its decide keys', async () => {
    const browser = browserHarness()
    browser.storage.set('koda-approval-notifications-u1', 'true')
    const projectKeys: Record<string, readonly string[]> = { beta: ['fleet.approval.decide.bash'] }
    const m = mount(notificationApi([approval()]), { projectKeys })
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    projectKeys.beta = []
    await m.poll()
    expect(m.toast.dismiss).toHaveBeenCalled()
    expect(browser.instances[0].close).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })

  test('closes alerts when the project permission read is refused', async () => {
    let refuse = false
    const m = mount(notificationApi([approval()]), {
      permissionRead: (slug) => {
        if (slug !== null && refuse) throw { statusCode: 403 }
        return { scope: slug === null ? 'global' : 'project', projectSlug: slug, keys: [...DEFAULT_PROJECT_KEYS] }
      },
    })
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    refuse = true
    await m.poll()
    expect(m.toast.dismiss).toHaveBeenCalled()
    m.app.unmount()
  })

  test('ignores pending data in flight when a terminal live event arrives', async () => {
    let finish: (value: unknown) => void = () => undefined
    const api = notificationApi([approval()])
    const m = mount(jest.fn((url: string) => url.endsWith('/approvals')
      ? new Promise(resolve => { finish = resolve }) : api(url)).mockName('notificationApi'))
    await m.settle()
    m.live()?.onFleetApproval?.({ approvalId: 'a1', status: 'approved' })
    finish({ records: [approval()], hasNext: false })
    await m.settle()
    expect(m.toast).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('discovers pending requests past the first page without duplicate toast or browser delivery', async () => {
    const api = notificationApi([approval()])
    const m = mount(jest.fn((url: string, options?: { query: { current?: string } }) => {
      if (url.endsWith('/approvals')) return Promise.resolve(options?.query.current === '2'
        ? { records: [approval()], hasNext: false } : { records: [], hasNext: true })
      return api(url)
    }).mockName('notificationApi'))
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    await m.poll()
    expect(m.toast).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })
})

describe('Notification refresh generations', () => {
  test('an older pending list cannot dismiss a notification discovered by a newer refresh in another project', async () => {
    let loadNumber = 0
    let finishOld: (value: unknown) => void = () => undefined
    const api = jest.fn(async (url: string) => {
      if (url === '/fleet/approval-counts') {
        loadNumber += 1
        return { total: 1, projects: [{ slug: loadNumber === 1 ? 'beta' : 'gamma', projectId: 'p2', pending: 1 }], unscoped: 0 }
      }
      if (url.includes('/beta/')) return new Promise(resolve => { finishOld = resolve })
      return { records: [approval('b1')], hasNext: false }
    }).mockName('notificationApi')
    const m = mount(api)
    await m.settle()
    await m.poll()
    expect(m.toast).toHaveBeenCalledTimes(1)
    finishOld({ records: [approval()], hasNext: false })
    await m.settle()
    expect(m.toast.dismiss).not.toHaveBeenCalled()
    m.app.unmount()
  })
})

describe('Global notification decision rights', () => {
  test('closes the admin inbox alerts when the account loses fleet.approval.read', async () => {
    const globalKeys = ref<readonly string[]>(['fleet.approval.read', 'fleet.approval.decide.budget'])
    // The project scan cannot re-notify it, so the assertion is only about the admin alert closing.
    const m = mount(notificationApi([approval('a1', { type: 'budget_override_required', expiresAt: null })]), {
      globalKeys,
      slug: null,
      projectKeys: { beta: ['fleet.approval.decide.bash'] },
    })
    await m.settle()
    expect(m.toast).toHaveBeenCalledTimes(1)
    const id = (m.toast.mock.calls[0][1] as { id: string }).id
    globalKeys.value = []
    await m.poll()
    expect(m.toast.dismiss).toHaveBeenCalledWith(id)
    expect(m.toast).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })
})
