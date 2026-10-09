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

function mountPage(setInApp: jest.Mock, load: jest.Mock = jest.fn(async () => undefined), options: { emailAvailable?: boolean; emailEnabled?: boolean; setEmail?: jest.Mock; setEmailEnabled?: jest.Mock } = {}) {
  const view = ref({ emailAvailable: options.emailAvailable ?? true, emailEnabled: options.emailEnabled ?? true, items: [] as NotificationPreferenceDto[] })
  const fake = {
    view, pending: ref(false), setInApp,
    setEmail: options.setEmail ?? jest.fn(async (_category: NotificationCategory, _email: boolean) => undefined),
    setEmailEnabled: options.setEmailEnabled ?? jest.fn(async (_enabled: boolean) => undefined),
    load: jest.fn(async () => { await load(); view.value.items = ALL }),
  }
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '~/composables/useNotificationPreferences': { useNotificationPreferences: () => fake } },
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
  return { app, fake, toast, settle, box, emailBox }
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
