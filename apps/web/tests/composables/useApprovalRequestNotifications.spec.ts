import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { mountSetup } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'
import { inboxHref } from '~/lib/approval-requests'
import type { ApprovalRequestCounts, ApprovalRequestSummary } from '~/lib/approval-requests'

type Notifications = ReturnType<typeof import('~/composables/useApprovalRequestNotifications')['useApprovalRequestNotifications']>

const g = globalThis as Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// Doubles: the toast, the storage and the browser's Notification
// ─────────────────────────────────────────────────────────────────────────────

interface ToastOptions {
  id?: string
  description?: string
  duration?: number
  action?: { label: string; onClick: () => void }
  onDismiss?: () => void
}

/** A callable toast that records what it showed and what was dismissed (`toast.dismiss(id)`). */
function toastRecorder() {
  const calls: Array<{ title: string; options?: ToastOptions }> = []
  const dismiss = jest.fn()
  const error = jest.fn()
  const toast = Object.assign(
    (title: string, options?: ToastOptions): string => { calls.push({ title, options }); return 'toast' },
    { dismiss, error, success: jest.fn() },
  )
  return { toast, calls, dismiss, error }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    getItem: jest.fn((key: string) => data.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => { data.set(key, value) }),
    data,
  }
}

type Permission = 'granted' | 'denied' | 'default'

/** The browser's `Notification` as the composable reads it: `permission` and `requestPermission()`. */
function fakeNotification(permission: Permission) {
  return { permission, requestPermission: jest.fn(async (): Promise<Permission> => permission) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** One pending engine request; an agent's ask is one this viewer may decide. */
const summary = (over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id: 'r1',
  permissionKey: 'label.create',
  projectId: 'p1',
  actorType: 'AGENT',
  actorId: 'agent-1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'api',
  redeem: true,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2099-11-01T00:00:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-30T00:00:00.000Z',
  ...over,
})

const page = (records: ApprovalRequestSummary[]) => ({
  total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records,
})

const countsOf = (total: number): ApprovalRequestCounts => ({ total, unscoped: 0, projects: [] })

interface HarnessOptions {
  /** `$api.get`; the harness itself records every call. */
  get: jest.Mock
  counts?: Ref<ApprovalRequestCounts | null>
  user?: Ref<{ id: string } | null>
  storage?: ReturnType<typeof fakeStorage>
  /** The browser permission the double reports (`default` = not asked yet). */
  permission?: Permission
  /** Leave `Notification` undefined, as a browser without it (or node during SSR). */
  withoutNotification?: boolean
}

/**
 * Mounts the composable in a real component instance (so `onMounted` runs) over stubbed Nuxt
 * auto-imports: the API, the account, i18n, the toast, the tab state and navigation.
 */
async function mountNotifications(options: HarnessOptions) {
  const counts = options.counts ?? ref<ApprovalRequestCounts | null>(countsOf(2))
  const user = options.user ?? ref<{ id: string } | null>({ id: 'u1' })
  const toasts = toastRecorder()
  const navigate = jest.fn(async () => undefined)
  const storage = options.storage ?? fakeStorage()
  const notification = fakeNotification(options.permission ?? 'default')
  const state = new Map<string, unknown>()

  g.useApi = () => ({ $api: { get: options.get } })
  g.useAuth = () => ({ user })
  g.useI18n = () => enI18n()
  g.useAppToast = () => toasts.toast
  g.useState = (key: string, init: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(init()))
    return state.get(key)
  }
  g.navigateTo = navigate
  g.localStorage = storage
  if (options.withoutNotification === true) delete g.Notification
  else g.Notification = notification

  const mod = await import('~/composables/useApprovalRequestNotifications')
  let api!: Notifications
  const host = mountSetup(() => { api = mod.useApprovalRequestNotifications(counts) })
  return { api, host, toasts, navigate, storage }
}

afterEach(() => {
  delete g.useApi
  delete g.useAuth
  delete g.useI18n
  delete g.useAppToast
  delete g.useState
  delete g.navigateTo
  delete g.localStorage
  delete g.Notification
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-1, AC-2 — the counts snapshot decides whether the list is even read
// ─────────────────────────────────────────────────────────────────────────────

describe('US-005 AC-1/AC-2: refresh reads the pending list only when the counts say so', () => {
  test('AC-1: counts total 0 makes no GET /approvals request', async () => {
    const get = jest.fn(async () => page([summary()]))
    const m = await mountNotifications({ get, counts: ref<ApprovalRequestCounts | null>(countsOf(0)) })

    await m.api.refresh()

    expect(get).not.toHaveBeenCalled()
    m.host.unmount()
  })

  test('AC-2: counts total 2 requests one pending page of 100', async () => {
    const get = jest.fn(async () => page([]))
    const m = await mountNotifications({ get })

    await m.api.refresh()

    expect(get).toHaveBeenCalledWith('/approvals', { query: { status: 'pending', size: '100' } })
    m.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 to AC-6 — which listed request raises a toast
// ─────────────────────────────────────────────────────────────────────────────

describe('US-005 AC-3: a decidable, unseen, unexpired request raises one toast into the engine inbox', () => {
  test('AC-3: the toast action leads to inboxHref(null, id)', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([summary({ id: 'r1' })])) })

    await m.api.refresh()

    expect(m.toasts.calls).toHaveLength(1)
    const action = m.toasts.calls[0].options?.action
    expect(typeof action?.onClick).toBe('function')
    action?.onClick()
    expect(m.navigate).toHaveBeenCalledWith(inboxHref(null, 'r1'))
    expect(m.navigate).toHaveBeenCalledWith('/approvals?id=r1')
    m.host.unmount()
  })
})

describe('US-005 AC-4: a repeated refresh does not re-toast', () => {
  test('AC-4: the same request listed twice raises one toast', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([summary({ id: 'r1' })])) })

    await m.api.refresh()
    await m.api.refresh()

    expect(m.toasts.calls).toHaveLength(1)
    m.host.unmount()
  })

  test('AC-4 (edge): a dismissed request stays announced, so a later refresh does not raise it again', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([summary({ id: 'r1' })])) })
    await m.api.refresh()
    // The viewer closed the toast themselves: the record of having announced it stays.
    m.toasts.calls[0].options?.onDismiss?.()

    await m.api.refresh()

    expect(m.toasts.calls).toHaveLength(1)
    m.host.unmount()
  })
})

describe('US-005 AC-5: a request this viewer may not decide raises no toast', () => {
  test('AC-5: a USER request in human mode viewed by its own requester (decide false, cancel true)', async () => {
    const row = summary({ id: 'r1', actorType: 'USER', actorId: 'u1', requiredMode: 'human' })
    const m = await mountNotifications({ get: jest.fn(async () => page([row])) })

    await m.api.refresh()

    expect(m.toasts.calls).toEqual([])
    m.host.unmount()
  })
})

describe('US-005 AC-6: an expired request raises no toast', () => {
  test('AC-6: an expiresAt in the past is not news', async () => {
    const m = await mountNotifications({
      get: jest.fn(async () => page([summary({ id: 'r1', expiresAt: '2020-01-01T00:00:00.000Z' })])),
    })

    await m.api.refresh()

    expect(m.toasts.calls).toEqual([])
    m.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-7, AC-8 — dismissal
// ─────────────────────────────────────────────────────────────────────────────

describe('US-005 AC-7: decided(id) dismisses that request\'s toast', () => {
  test('AC-7: decided("r1") closes the r1 toast and leaves another one alone', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([summary({ id: 'r1' }), summary({ id: 'r2' })])) })
    await m.api.refresh()
    expect(m.toasts.calls).toHaveLength(2)

    m.api.decided('r1')

    expect(m.toasts.dismiss).toHaveBeenCalledTimes(1)
    expect(m.toasts.dismiss).toHaveBeenCalledWith(m.toasts.calls[0].options?.id)
    m.host.unmount()
  })

  test('AC-7 (edge): decided on an id with no toast changes nothing', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([])) })

    m.api.decided('gone')

    expect(m.toasts.dismiss).not.toHaveBeenCalled()
    m.host.unmount()
  })
})

describe('US-005 AC-8: a successful refresh dismisses the toasts it no longer lists', () => {
  test('AC-8: a request gone from the next pending page closes its toast', async () => {
    let records: ApprovalRequestSummary[] = [summary({ id: 'r1' })]
    const m = await mountNotifications({ get: jest.fn(async () => page(records)) })
    await m.api.refresh()
    expect(m.toasts.calls).toHaveLength(1)

    records = []
    await m.api.refresh()

    expect(m.toasts.dismiss).toHaveBeenCalledWith(m.toasts.calls[0].options?.id)
    m.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — the browser notification preference
// ─────────────────────────────────────────────────────────────────────────────

describe('US-005 AC-9: the browser notification preference is per user', () => {
  test('AC-9: a granted toggle stores koda-approval-notifications-<userId> as true', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([])), permission: 'granted' })

    await m.api.toggleBrowserNotifications()

    expect(m.storage.setItem).toHaveBeenCalledWith('koda-approval-notifications-u1', 'true')
    expect(m.api.enabled.value).toBe(true)
    m.host.unmount()
  })

  test('AC-9 (edge): a stored preference plus a granted browser enables it on mount', async () => {
    const storage = fakeStorage({ 'koda-approval-notifications-u1': 'true' })
    const m = await mountNotifications({ get: jest.fn(async () => page([])), permission: 'granted', storage })

    expect(m.api.enabled.value).toBe(true)
    expect(m.api.supported.value).toBe(true)
    m.host.unmount()
  })

  test('AC-9 (edge): a denied permission stays off and records the opt-out', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([])), permission: 'denied' })

    await m.api.toggleBrowserNotifications()

    expect(m.storage.setItem).toHaveBeenCalledWith('koda-approval-notifications-u1', 'false')
    expect(m.api.enabled.value).toBe(false)
    m.host.unmount()
  })

  test('AC-9 (edge): a browser without Notification is unsupported and toggles nothing', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([])), withoutNotification: true })

    await m.api.toggleBrowserNotifications()

    expect(m.api.supported.value).toBe(false)
    expect(m.storage.setItem).not.toHaveBeenCalled()
    m.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-14 — a failed list keeps what is on screen
// ─────────────────────────────────────────────────────────────────────────────

describe('US-005 AC-14: a failed pending list leaves the active toasts untouched', () => {
  test('AC-14: a rejection keeps the toast and shows no error', async () => {
    let fail = false
    const get = jest.fn(async () => {
      if (fail) throw new Error('503')
      return page([summary({ id: 'r1' })])
    })
    const m = await mountNotifications({ get })
    await m.api.refresh()
    expect(m.toasts.calls).toHaveLength(1)

    fail = true
    await m.api.refresh()

    expect(m.toasts.dismiss).not.toHaveBeenCalled()
    expect(m.toasts.error).not.toHaveBeenCalled()
    expect(m.toasts.calls).toHaveLength(1)
    m.host.unmount()
  })

  test('AC-14: a refused list (403) also keeps them, and the next successful refresh still reconciles', async () => {
    let records: ApprovalRequestSummary[] = [summary({ id: 'r1' })]
    let fail = false
    const get = jest.fn(async () => {
      if (fail) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      return page(records)
    })
    const m = await mountNotifications({ get })
    await m.api.refresh()

    fail = true
    await m.api.refresh()
    expect(m.toasts.dismiss).not.toHaveBeenCalled()

    fail = false
    records = []
    await m.api.refresh()
    expect(m.toasts.dismiss).toHaveBeenCalledTimes(1)
    m.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Guards: no signed-in account, no counts snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('useApprovalRequestNotifications: the SSR and account guards', () => {
  test('a null counts snapshot reads nothing', async () => {
    const get = jest.fn(async () => page([summary()]))
    const m = await mountNotifications({ get, counts: ref<ApprovalRequestCounts | null>(null) })

    await m.api.refresh()

    expect(get).not.toHaveBeenCalled()
    m.host.unmount()
  })

  test('a signed-out caller reads nothing and toasts nothing', async () => {
    const get = jest.fn(async () => page([summary()]))
    const m = await mountNotifications({ get, user: ref<{ id: string } | null>(null) })

    await m.api.refresh()

    expect(get).not.toHaveBeenCalled()
    expect(m.toasts.calls).toEqual([])
    m.host.unmount()
  })

  test('a request settled by the time the list arrives is not toasted', async () => {
    const m = await mountNotifications({ get: jest.fn(async () => page([summary({ id: 'r1', status: 'executed' })])) })

    await m.api.refresh()

    expect(m.toasts.calls).toEqual([])
    m.host.unmount()
  })
})
