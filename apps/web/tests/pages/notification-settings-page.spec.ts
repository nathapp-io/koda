import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationPreferenceDto } from '~/lib/notification-types'

const page = webFile('pages', 'settings', 'notifications.vue')
const ALL: NotificationPreferenceDto[] = [
  { category: 'ASSIGNED', inApp: true }, { category: 'MENTIONED', inApp: true }, { category: 'WATCHED_ACTIVITY', inApp: false },
  { category: 'FLEET_NEEDS_YOU', inApp: true }, { category: 'FLEET_HEALTH', inApp: true },
]

function mountPage(setInApp: jest.Mock, load: jest.Mock = jest.fn(async () => undefined)) {
  const items = ref<NotificationPreferenceDto[]>([])
  const fake = {
    items, pending: ref(false), setInApp,
    load: jest.fn(async () => { await load(); items.value = ALL }),
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
  return { app, fake, toast, settle, box }
}

describe('/settings/notifications (S4a §5)', () => {
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
