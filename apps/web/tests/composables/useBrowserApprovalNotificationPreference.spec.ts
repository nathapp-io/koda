import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { mountSetup } from '../helpers/mount-sfc'

type Preference = ReturnType<
  typeof import('~/composables/useBrowserApprovalNotificationPreference')['useBrowserApprovalNotificationPreference']
>

const g = globalThis as Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// Doubles: the storage and the browser's Notification
// ─────────────────────────────────────────────────────────────────────────────

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    getItem: jest.fn((key: string) => data.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => { data.set(key, value) }),
    data,
  }
}

type Permission = 'granted' | 'denied' | 'default'

interface FakeNotification {
  NotificationDouble: { permission: Permission; requestPermission: jest.Mock }
  requestPermission: jest.Mock
  instances: Array<{ close: jest.Mock }>
}

/**
 * A browser Notification double. `permission` is what the browser reports today; `afterRequest` is
 * what it reports (and resolves) once the user has been asked, which is how a refusal looks.
 */
function fakeNotification(permission: Permission, afterRequest: Permission | null = null): FakeNotification {
  const instances: Array<{ close: jest.Mock }> = []
  const requestPermission = jest.fn(async (): Promise<Permission> => {
    const answer = afterRequest ?? permission
    NotificationDouble.permission = answer
    return answer
  })
  class NotificationDouble {
    static permission: Permission = permission
    static requestPermission = requestPermission
    close = jest.fn()

    constructor(_title: string, _options?: { tag?: string }) {
      instances.push(this)
    }
  }
  return { NotificationDouble, requestPermission, instances }
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

interface HarnessOptions {
  user?: Ref<{ id: string } | null>
  storage?: ReturnType<typeof fakeStorage>
  /** The permission the browser reports before the user is asked. */
  permission?: Permission
  /** The permission the browser reports (and resolves) after the user is asked. */
  afterRequest?: Permission
  /** Leave `Notification` undefined, as a browser without it (or node during SSR). */
  withoutNotification?: boolean
  /**
   * The tab's Nuxt state, so two callers in one test share it exactly as the browser's tab would.
   * Every `useState(key, init)` call in the tab resolves against this one map.
   */
  state?: Map<string, unknown>
}

/**
 * Mounts the composable in a real component instance (so `onMounted` runs) over the Nuxt
 * auto-imports it reads: the account, the tab state and the browser globals.
 */
async function mountPreference(options: HarnessOptions = {}) {
  const user = options.user ?? ref<{ id: string } | null>({ id: 'u1' })
  const storage = options.storage ?? fakeStorage()
  const notification = fakeNotification(options.permission ?? 'default', options.afterRequest ?? null)
  const state = options.state ?? new Map<string, unknown>()

  g.useAuth = () => ({ user })
  g.useState = (key: string, init: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(init()))
    return state.get(key)
  }
  g.localStorage = storage
  if (options.withoutNotification === true) delete g.Notification
  else g.Notification = notification.NotificationDouble

  const mod = await import('~/composables/useBrowserApprovalNotificationPreference')
  let preference!: Preference
  const host = mountSetup(() => { preference = mod.useBrowserApprovalNotificationPreference() })
  return {
    preference,
    host,
    user,
    storage,
    state,
    requestPermission: notification.requestPermission,
    browserNotifications: notification.instances,
  }
}

afterEach(() => {
  delete g.useAuth
  delete g.useState
  delete g.localStorage
  delete g.Notification
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 — the on-mount read
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC-1: the preference is read on mount', () => {
  test("AC-1: a stored 'true' plus a granted browser reports enabled true", async () => {
    const storage = fakeStorage({ 'koda-approval-notifications-u1': 'true' })
    const m = await mountPreference({ storage, permission: 'granted' })

    expect(m.preference.enabled.value).toBe(true)
    expect(m.preference.supported.value).toBe(true)
    expect(m.preference.permissionDenied.value).toBe(false)
    m.host.unmount()
  })

  test('AC-1 (edge): a browser without Notification is unsupported and stays opt-out', async () => {
    const storage = fakeStorage({ 'koda-approval-notifications-u1': 'true' })
    const m = await mountPreference({ storage, withoutNotification: true })

    expect(m.preference.supported.value).toBe(false)
    expect(m.preference.enabled.value).toBe(false)
    m.host.unmount()
  })

  test('AC-1 (edge): unreadable storage means the preference defaults to opt-out', async () => {
    const storage = fakeStorage({ 'koda-approval-notifications-u1': 'true' })
    storage.getItem.mockImplementation(() => { throw new Error('private mode') })
    const m = await mountPreference({ storage, permission: 'granted' })

    expect(m.preference.enabled.value).toBe(false)
    m.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 to AC-5 — toggle()
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC-2: a granted toggle enables and stores the choice', () => {
  test('AC-2: toggle() from disabled stores true under koda-approval-notifications-u1', async () => {
    const m = await mountPreference({ permission: 'default', afterRequest: 'granted' })

    await m.preference.toggle()

    expect(m.preference.enabled.value).toBe(true)
    expect(m.storage.setItem).toHaveBeenCalledWith('koda-approval-notifications-u1', 'true')
    m.host.unmount()
  })
})

describe('US-004 AC-3: a refused permission leaves the preference off', () => {
  test('AC-3: toggle() answered denied leaves enabled false', async () => {
    const m = await mountPreference({ permission: 'default', afterRequest: 'denied' })

    await m.preference.toggle()

    expect(m.preference.enabled.value).toBe(false)
    expect(m.storage.setItem).toHaveBeenCalledWith('koda-approval-notifications-u1', 'false')
    m.host.unmount()
  })
})

describe('US-004 AC-4: a refusal is reported as permissionDenied', () => {
  test('AC-4: the shared state records the blocked permission after the toggle', async () => {
    const m = await mountPreference({ permission: 'default', afterRequest: 'denied' })
    expect(m.preference.permissionDenied.value).toBe(false)

    await m.preference.toggle()

    expect(m.preference.permissionDenied.value).toBe(true)
    m.host.unmount()
  })

  test('AC-4 (edge): a browser already blocking notifications reports it on mount', async () => {
    const m = await mountPreference({ permission: 'denied' })

    expect(m.preference.permissionDenied.value).toBe(true)
    m.host.unmount()
  })
})

describe('US-004 AC-5: storage is optional', () => {
  test('AC-5: a throwing setItem still enables the preference for this tab', async () => {
    const storage = fakeStorage()
    storage.setItem.mockImplementation(() => { throw new Error('quota') })
    const m = await mountPreference({ storage, permission: 'granted' })

    await m.preference.toggle()

    expect(m.preference.enabled.value).toBe(true)
    m.host.unmount()
  })

  // Fix round 1 (F1): the storage read happens once per tab. A caller that mounts later must not
  // reread a storage that never accepted the choice and turn the tab's opt-in back off.
  test('AC-5 (fix round 1): a caller mounting later in the tab keeps the tab-only choice', async () => {
    const state = new Map<string, unknown>()
    const user = ref<{ id: string } | null>({ id: 'u1' })
    const storage = fakeStorage()
    storage.setItem.mockImplementation(() => { throw new Error('quota') })
    const first = await mountPreference({ state, user, storage, permission: 'granted' })
    await first.preference.toggle()
    expect(first.preference.enabled.value).toBe(true)

    // The badge mounts after the settings page, in the same tab, with nothing in storage.
    const second = await mountPreference({ state, user, storage, permission: 'granted' })

    expect(second.preference.enabled.value).toBe(true)
    expect(storage.getItem).toHaveBeenCalledTimes(1)
    second.host.unmount()
    first.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-6 — one preference per tab
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC-6: the tab shares one preference', () => {
  test('AC-6: a second caller reports enabled true after the first toggled, without remounting', async () => {
    const state = new Map<string, unknown>()
    const user = ref<{ id: string } | null>({ id: 'u1' })
    const first = await mountPreference({ state, user, permission: 'default', afterRequest: 'granted' })
    const second = await mountPreference({ state, user, permission: 'default', afterRequest: 'granted' })
    expect(second.preference.enabled.value).toBe(false)

    await first.preference.toggle()

    expect(first.preference.enabled.value).toBe(true)
    expect(second.preference.enabled.value).toBe(true)
    // Both callers hold the one Nuxt state key, so the settings page and the badge cannot disagree.
    expect([...state.keys()]).toEqual(['browser-approval-notification-preference'])
    second.host.unmount()
    first.host.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — the identity is the user id
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC-7: an account change forgets the preference', () => {
  test("AC-7: enabled becomes false when the auth user id changes from u1 to u2", async () => {
    const user = ref<{ id: string } | null>({ id: 'u1' })
    const storage = fakeStorage({ 'koda-approval-notifications-u1': 'true' })
    const m = await mountPreference({ user, storage, permission: 'granted' })
    expect(m.preference.enabled.value).toBe(true)

    user.value = { id: 'u2' }
    await nextTick()

    expect(m.preference.enabled.value).toBe(false)
    m.host.unmount()
  })
})
