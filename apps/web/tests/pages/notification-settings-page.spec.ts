import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationCategory, NotificationPreferenceDto } from '~/lib/notification-types'

const page = webFile('pages', 'settings', 'notifications.vue')
const ALL: NotificationPreferenceDto[] = [
  { category: 'ASSIGNED', inApp: true, email: true }, { category: 'MENTIONED', inApp: true, email: false }, { category: 'WATCHED_ACTIVITY', inApp: false, email: true },
  { category: 'FLEET_NEEDS_YOU', inApp: true, email: true }, { category: 'FLEET_HEALTH', inApp: true, email: false },
]

function mountPage(setInApp: jest.Mock, load: jest.Mock = jest.fn(async () => undefined), options: { emailAvailable?: boolean; emailEnabled?: boolean; setEmail?: jest.Mock; setEmailEnabled?: jest.Mock; supported?: boolean; enabled?: boolean; permissionDenied?: boolean } = {}) {
  const view = ref({ emailAvailable: options.emailAvailable ?? true, emailEnabled: options.emailEnabled ?? true, items: [] as NotificationPreferenceDto[] })
  const fake = {
    view, pending: ref(false), setInApp,
    setEmail: options.setEmail ?? jest.fn(async (_category: NotificationCategory, _email: boolean) => undefined),
    setEmailEnabled: options.setEmailEnabled ?? jest.fn(async (_enabled: boolean) => undefined),
    load: jest.fn(async () => { await load(); view.value.items = ALL }),
  }
  // US-004: the page reads the tab's browser-approval preference, which has no Nuxt/browser globals here.
  const browser = { supported: ref(options.supported ?? true), enabled: ref(options.enabled ?? false), permissionDenied: ref(options.permissionDenied ?? false), toggle: jest.fn(async () => undefined) }
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: {
      '~/composables/useNotificationPreferences': { useNotificationPreferences: () => fake },
      '~/composables/useBrowserApprovalNotificationPreference': { useBrowserApprovalNotificationPreference: () => browser },
    },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast, definePageMeta: () => undefined },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const box = (c: string) => app.find(`[data-testid="notification-pref-${c}"]`)[0]
  const emailBox = (c: string) => app.find(`[data-testid="notification-pref-email-${c}"]`)[0]
  /** The US-004 browser-notification section, and the controls inside it. */
  const browserSection = () => app.one('[data-testid="settings-browser-approval-notifications"]')
  const browserBox = () => {
    const section = browserSection()
    return section === undefined ? undefined : app.one('[id="settings-browser-approvals"]', section)
  }
  return { app, fake, toast, settle, box, emailBox, browser, browserSection, browserBox }
}

describe('/settings/notifications (US-003)', () => {
  test('renders master and all category email preferences from the loaded view', async () => {
    const p = mountPage(jest.fn())
    await p.settle()
    expect(p.app.find('[data-testid="notification-email-master"]')[0].props.checked).toBe(true)
    for (const item of ALL) expect(p.emailBox(item.category).props.checked).toBe(item.email)
  })

  test('disables email controls and explains unavailable email', async () => {
    const p = mountPage(jest.fn(), jest.fn(async () => undefined), { emailAvailable: false })
    await p.settle()
    expect(p.app.find('[data-testid="notification-email-master"]')[0].props.disabled).toBe(true)
    for (const item of ALL) expect(p.emailBox(item.category).props.disabled).toBe(true)
    expect(p.app.text()).toContain('Email notifications are unavailable')
  })

  test('disables categories while the email master is off', async () => {
    const p = mountPage(jest.fn(), jest.fn(async () => undefined), { emailEnabled: false })
    await p.settle()
    for (const item of ALL) expect(p.emailBox(item.category).props.disabled).toBe(true)
  })

  test('master and category email changes call their setters', async () => {
    const setEmailEnabled = jest.fn(async () => undefined)
    const setEmail = jest.fn(async () => undefined)
    const p = mountPage(jest.fn(), jest.fn(async () => undefined), { setEmailEnabled, setEmail })
    await p.settle()
    ;(p.app.find('[data-testid="notification-email-master"]')[0].props.onChange as (e: unknown) => void)({ target: { checked: false } })
    ;(p.emailBox('MENTIONED').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await p.settle()
    expect(setEmailEnabled).toHaveBeenCalledWith(false)
    expect(setEmail).toHaveBeenCalledWith('MENTIONED', false)
  })

  test('failed email save restores checked state and reports the error', async () => {
    const setEmail = jest.fn(async () => { throw new Error('nope') })
    const p = mountPage(jest.fn(), jest.fn(async () => undefined), { setEmail })
    await p.settle()
    const target = { checked: false }
    ;(p.emailBox('ASSIGNED').props.onChange as (e: unknown) => void)({ target })
    await p.settle()
    expect(target.checked).toBe(true)
    expect(p.toast.errors).toContain('nope')
  })

  test('lists the five categories with their labels and current state', async () => {
    const p = mountPage(jest.fn())
    await p.settle()
    expect(p.app.text()).toContain('Assigned to me')
    expect(p.app.text()).toContain('Fleet health')
    expect(p.box('ASSIGNED').props.checked).toBe(true)
    expect(p.box('WATCHED_ACTIVITY').props.checked).toBe(false)
  })

  test('toggling saves that one category and confirms', async () => {
    const setInApp = jest.fn(async () => undefined)
    const p = mountPage(setInApp)
    await p.settle()
    ;(p.box('ASSIGNED').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await p.settle()
    expect(setInApp).toHaveBeenCalledWith('ASSIGNED', false)
    expect(p.toast.successes).toEqual(['Notification settings saved'])
  })

  test('a failed save reports the error and puts the checkbox back without a reload (review fix)', async () => {
    const p = mountPage(jest.fn(async () => { throw new Error('nope') }))
    await p.settle()
    const target = { checked: false }
    ;(p.box('MENTIONED').props.onChange as (e: unknown) => void)({ target })
    await p.settle()
    expect(p.toast.errors).toEqual(['nope'])
    expect(target.checked).toBe(true)
    expect(p.fake.load).toHaveBeenCalledTimes(1)
  })

  test('a failed first load shows an error state, never all-on toggles (review fix)', async () => {
    const p = mountPage(jest.fn(), jest.fn(async () => { throw new Error('down') }))
    await p.settle()
    expect(p.app.find('[data-stub="error-state"]').length).toBe(1)
    expect(p.box('ASSIGNED')).toBeUndefined()
  })
})

describe('/settings/notifications browser approvals (US-004)', () => {
  test('AC-11: renders the labeled browser-approval checkbox in its own section', async () => {
    const p = mountPage(jest.fn())
    await p.settle()

    const section = p.browserSection()
    expect(section).toBeDefined()
    expect(p.app.textOf(section as NonNullable<typeof section>)).toContain('Browser notifications')
    expect(p.browserBox()).toBeDefined()
    const labels = p.app.find('label', section).filter((node) => node.props.for === 'settings-browser-approvals')
    expect(labels).toHaveLength(1)
    expect(p.app.textOf(labels[0])).toBe('Show a browser notification when an approval is waiting for me')
    p.app.unmount()
  })

  test('AC-12: a change event asks the shared preference to toggle once', async () => {
    const p = mountPage(jest.fn())
    await p.settle()

    const checkbox = p.browserBox()
    if (!checkbox) throw new Error('missing the browser-approval checkbox')
    ;(checkbox.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    await p.settle()

    expect(p.browser.toggle).toHaveBeenCalledTimes(1)
    p.app.unmount()
  })

  test('AC-12 (edge): a refused permission puts the checkbox back to the shared value', async () => {
    const p = mountPage(jest.fn())
    await p.settle()
    // The shared preference refuses: it stays off, so the box must not stay ticked.
    p.browser.toggle.mockImplementation(async () => { p.browser.enabled.value = false })

    const target = { checked: true }
    const checkbox = p.browserBox()
    if (!checkbox) throw new Error('missing the browser-approval checkbox')
    ;(checkbox.props.onChange as (e: unknown) => void)({ target })
    await p.settle()

    expect(target.checked).toBe(false)
    p.app.unmount()
  })

  test('AC-13: an unsupported browser shows the copy and no checkbox', async () => {
    const p = mountPage(jest.fn(), jest.fn(async () => undefined), { supported: false })
    await p.settle()

    const section = p.browserSection()
    expect(p.app.textOf(section as NonNullable<typeof section>)).toContain('This browser does not support notifications.')
    expect(p.browserBox()).toBeUndefined()
    p.app.unmount()
  })

  test('AC-14: a blocked permission explains itself under the section', async () => {
    const p = mountPage(jest.fn(), jest.fn(async () => undefined), { permissionDenied: true })
    await p.settle()

    const section = p.browserSection()
    expect(p.app.textOf(section as NonNullable<typeof section>))
      .toContain("Notifications are blocked for this site. Allow them in your browser's site settings.")
    p.app.unmount()
  })

  test('the browser section renders even when the preferences failed to load (it is local state)', async () => {
    const p = mountPage(jest.fn(), jest.fn(async () => { throw new Error('down') }))
    await p.settle()

    expect(p.browserSection()).toBeDefined()
    expect(p.browserBox()).toBeDefined()
    p.app.unmount()
  })
})
