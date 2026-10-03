import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import * as approvalsModule from '../../composables/useFleetApprovals'

// mountSfc re-instantiates `~/…` imports; aliasing the module lets the test bump the badge's own approvalsVersion.
const { approvalsVersion } = approvalsModule

const badge = webFile('components', 'fleet', 'ApprovalBadge.vue')

type Handlers = { onFleetApproval?: () => void; onResync: () => void }

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
  jest.useRealTimers()
})

function mount(get: jest.Mock, opts: { slug?: string | null; role?: 'ADMIN' | 'MEMBER' } = {}) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
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
      useApi: () => ({ $api: { get } }),
      useAuth: () => ({ user: ref({ id: 'u1', role: opts.role ?? 'MEMBER' }) }),
      useVisiblePolling: (fn: () => Promise<void>) => { task = fn; return polling },
      useProjectEvents: (_s: string, h: Handlers) => { live = h },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const el = () => app.find('[data-testid="fleet-approval-badge"]')
  return { app, polling, settle, el, poll: () => task(), live: () => live }
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

  test('outside a project: the first project with pending for a member, the admin inbox for an admin', async () => {
    const member = mount(jest.fn(async () => counts(2)), { slug: null })
    await member.settle()
    expect(member.el()[0].props.to).toBe('/beta/fleet/approvals')
    member.app.unmount()
    const admin = mount(jest.fn(async () => counts(2)), { slug: null, role: 'ADMIN' })
    await admin.settle()
    expect(admin.el()[0].props.to).toBe('/admin/fleet/approvals')
    admin.app.unmount()
  })

  test('over 99 shows 99+', async () => {
    const m = mount(jest.fn(async () => counts(150)))
    await m.settle()
    expect(m.app.textOf(m.el()[0])).toContain('99+')
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
    const before = get.mock.calls.length
    m.live()?.onFleetApproval?.()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    expect(get.mock.calls.length).toBe(before + 1)
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
    const m = mount(get, { slug: null, role: 'ADMIN' })
    await m.settle()
    jest.useFakeTimers()
    const before = get.mock.calls.length
    approvalsVersion.value += 1
    await Vue.nextTick()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    expect(get.mock.calls.length).toBe(before + 1)
    m.app.unmount()
  })
})
