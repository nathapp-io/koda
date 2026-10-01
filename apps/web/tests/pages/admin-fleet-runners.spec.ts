import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc } from '../helpers/mount-sfc'
import { runnersPage, uiStubs, enI18n, toastRecorder, ToastCall } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useFleetRunners } from '../../composables/useFleetRunners'
import type { FleetPage, FleetRunner } from '../../lib/fleet-types'
import type { Mounted } from '../helpers/mount-sfc'

const NOW = '2026-10-01T12:00:00.000Z'

const runner = (id: string, over: Partial<FleetRunner> = {}): FleetRunner => ({
  id, name: id, os: 'linux', arch: 'x64', labels: ['gpu'], capacity: 2, capabilities: {},
  daemonVersion: '0.1.0', protocolVersion: 1, enabled: true, lastSeenAt: NOW, createdAt: NOW,
  bootId: 'b1', bootedAt: NOW, online: true, ...over,
})

const pageOf = (records: unknown[], over: Record<string, unknown> = {}): FleetPage<never> =>
  ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over }) as FleetPage<never>

interface Api {
  get: jest.Mock
  patch: jest.Mock
  post: jest.Mock
  delete: jest.Mock
}

function makeApi(over: Partial<Api> = {}): Api {
  return {
    get: jest.fn(async () => pageOf([])),
    patch: jest.fn(async (_p: string, body: unknown) => runner('r1', body as Partial<FleetRunner>)),
    post: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({})),
    ...over,
  } as Api
}

interface MountedPage {
  app: Mounted
  api: Api
  toasts: ToastCall[]
  stop: jest.Mock
  /** Settles the page's own initial load plus the DOM updates it triggers. */
  settle: () => Promise<void>
  button: (label: string) => FakeButton
  unmount: () => void
}

interface FakeButton {
  text: string
  onClick: () => Promise<void> | void
}

/**
 * Mounts the page with a fake `$api`. The page's `useVisiblePolling` is stubbed so a test drives
 * refreshes explicitly instead of waiting on timers.
 */
function mountRunners(over: Partial<Api> = {}, confirmResult = true): MountedPage {
  const api = makeApi(over)
  const toasts = toastRecorder()
  const stop = jest.fn()
  const start = jest.fn()
  // The page calls `polling.runNow()` on mount and `polling.stop()` on unmount or a 403, so the
  // stub must actually run the page's task for the initial load to happen. The interval itself is
  // pinned by tests/composables/useVisiblePolling.spec.ts.
  const polling = {
    start,
    stop,
    runNow: async (): Promise<void> => { await task() },
    isActive: () => true,
  }
  let task: () => Promise<void> = async () => undefined
  globalThis.window = { location: { origin: 'https://koda.example.com' }, confirm: () => confirmResult } as never
  // The page's composable is the real one, imported through jest rather than the mount harness, so
  // its own `useApi` auto-import resolves against globalThis (the pattern composable specs use).
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(runnersPage, {
    components: uiStubs,
    // The page's 403 check is `err instanceof ApiError`. Aliasing the module hands the page the very
    // class object this spec throws, instead of a second copy the harness compiled separately.
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        task = pageTask
        return polling
      },
      useFleetRunners: () => useFleetRunners(),
    },
  })

  // The page loads on mount, so the fake promises must drain before the DOM can be asserted.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  // A button's label lives in its descendants, so match on the text under the node.
  const button = (label: string): FakeButton => {
    const match = app.find('[data-stub="button"]').find((b) => app.textOf(b) === label)
    if (!match) throw new Error(`no button "${label}" in: ${app.text()}`)
    return { text: label, onClick: () => (match.props.onClick as () => void | Promise<void>)() }
  }
  return { app, api, toasts, stop, settle, button, unmount: app.unmount }
}

describe('Fleet admin Runners page (behaviour)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  test('renders a row per runner with its online state, labels and capacity', async () => {
    const { app, settle, unmount } = mountRunners({
      get: jest.fn(async () => pageOf([runner('alpha'), runner('beta', { online: false, enabled: false })])),
    })
    await settle()

    const rows = app.find('[data-stub="tbody"] > [data-stub="tr"]')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.props['data-testid'])).toEqual(['fleet-runner-alpha', 'fleet-runner-beta'])
    expect(app.text()).toContain('alpha')
    expect(app.text()).toContain('Offline')
    expect(app.text()).toContain('Disabled')
    expect(app.text()).toContain('gpu')
    unmount()
  })

  test('a global-admin 403 (envelope ret 40003) shows the admin-only note and stops polling', async () => {
    const { app, stop, settle, unmount } = mountRunners({
      get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }),
    })
    await settle()

    expect(app.text()).toContain('Only global administrators can manage the fleet.')
    expect(stop).toHaveBeenCalled()
    unmount()
  })

  test('shows the admin-only note for an HTTP-shaped 403 too', async () => {
    const { app, settle, unmount } = mountRunners({
      get: jest.fn(async () => { throw new ApiError(403, 'forbidden') }),
    })
    await settle()

    expect(app.text()).toContain('Only global administrators can manage the fleet.')
    unmount()
  })

  test('the first load failing toasts the error', async () => {
    const { toasts, settle, unmount } = mountRunners({ get: jest.fn(async () => { throw new Error('API down') }) })
    await settle()

    expect(toasts.errors).toEqual(['API down'])
    unmount()
  })

  test('tells the admin when the list was capped', async () => {
    const { app, settle, unmount } = mountRunners({
      get: jest.fn(async () => pageOf([runner('alpha')], { hasNext: true, total: 101 })),
    })
    await settle()

    expect(app.text()).toContain('Showing the first 100')
    unmount()
  })

  test('shows an empty state when there are no runners', async () => {
    const { app, settle, unmount } = mountRunners({ get: jest.fn(async () => pageOf([])) })
    await settle()

    expect(app.find('[data-stub="empty-state"]')).toHaveLength(1)
    unmount()
  })

  test('the edit dialog is opened with the row the admin clicked', async () => {
    const { settle, button, app, unmount } = mountRunners({ get: jest.fn(async () => pageOf([runner('alpha')])) })
    await settle()

    await button('Edit').onClick()
    await settle()

    // The dialog opened with the clicked row, not another.
    const dialogs = app.find('[data-stub="fleet-runner-edit-dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(app.textOf(dialogs[0])).toBe('alpha')
    unmount()
  })

  test('the enrollment dialog is opened from the header action', async () => {
    const { settle, button, app, unmount } = mountRunners()
    await settle()

    expect(app.one('[data-stub="fleet-enrollment-token-dialog"]')?.props.open).toBe(false)
    await button('Enrollment token').onClick()
    await settle()

    expect(app.one('[data-stub="fleet-enrollment-token-dialog"]')?.props.open).toBe(true)
    unmount()
  })

  test('disabling a runner patches exactly that row and toasts success', async () => {
    const patch = jest.fn(async () => runner('alpha', { enabled: false }))
    const { toasts, settle, button, app, unmount } = mountRunners({
      patch,
      get: jest.fn(async () => pageOf([runner('alpha')])),
    })
    await settle()

    await button('Disable').onClick()
    await settle()

    expect(patch).toHaveBeenCalledWith('/fleet/runners/alpha', { enabled: false })
    expect(toasts.successes).toHaveLength(1)
    // The row now offers Enable, proving the patch reached the rendered list.
    expect(app.text()).toContain('Enable')
    unmount()
  })

  test('a failed disable toasts the API message and leaves the row enabled', async () => {
    const { toasts, settle, button, app, unmount } = mountRunners({
      patch: jest.fn(async () => { throw new Error('runner is busy') }),
      get: jest.fn(async () => pageOf([runner('alpha')])),
    })
    await settle()

    await button('Disable').onClick()
    await settle()

    expect(toasts.errors).toEqual(['runner is busy'])
    expect(app.text()).toContain('Disable')
    unmount()
  })

  test('deleting asks first and a cancelled confirm deletes nothing', async () => {
    const del = jest.fn(async () => ({}))
    const { settle, button, unmount } = mountRunners(
      { delete: del, get: jest.fn(async () => pageOf([runner('alpha')])) },
      false,
    )
    await settle()

    await button('Delete').onClick()
    await settle()

    expect(del).not.toHaveBeenCalled()
    unmount()
  })

  test('an accepted confirm deletes the row and toasts', async () => {
    const del = jest.fn(async () => ({}))
    const { toasts, settle, button, app, unmount } = mountRunners({
      delete: del,
      get: jest.fn(async () => pageOf([runner('alpha'), runner('beta')])),
    })
    await settle()

    await button('Delete').onClick()
    await settle()

    expect(del).toHaveBeenCalledWith('/fleet/runners/alpha')
    expect(toasts.successes).toHaveLength(1)
    expect(app.text()).not.toContain('alpha')
    unmount()
  })
})