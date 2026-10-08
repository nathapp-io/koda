import { ref } from 'vue'
import { PREFERENCES_PATH } from '~/lib/notification-types'
import type { NotificationCategory, PreferencesView } from '~/lib/notification-types'

/** Fleet S4a §3: notification channel preferences. */
export function useNotificationPreferences() {
  const { $api } = useApi()
  const view = ref<PreferencesView>({ emailAvailable: false, emailEnabled: false, items: [] })
  const pending = ref(false)

  async function load(): Promise<void> {
    pending.value = true
    try {
      view.value = await $api.get<PreferencesView>(PREFERENCES_PATH)
    } finally {
      pending.value = false
    }
  }

  /** Rethrows on failure; the page reports it and keeps the previous view. */
  async function setInApp(category: NotificationCategory, inApp: boolean): Promise<void> {
    view.value = await $api.put<PreferencesView>(PREFERENCES_PATH, { items: [{ category, inApp }] })
  }

  async function setEmail(category: NotificationCategory, email: boolean): Promise<void> {
    view.value = await $api.put<PreferencesView>(PREFERENCES_PATH, { items: [{ category, email }] })
  }

  async function setEmailEnabled(emailEnabled: boolean): Promise<void> {
    view.value = await $api.put<PreferencesView>(PREFERENCES_PATH, { emailEnabled })
  }

  return { view, pending, load, setInApp, setEmail, setEmailEnabled }
}
