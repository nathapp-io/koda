import { ref } from 'vue'
import { PREFERENCES_PATH } from '~/lib/notification-types'
import type { NotificationCategory, PreferencesView } from '~/lib/notification-types'

/** Fleet S4a §3: notification channel preferences. */
export function useNotificationPreferences() {
  const { $api } = useApi()
  const view = ref<PreferencesView>({ emailAvailable: false, emailEnabled: false, items: [] })
  const pending = ref(false)
  let updateQueue: Promise<void> = Promise.resolve()

  async function load(): Promise<void> {
    pending.value = true
    try {
      view.value = await $api.get<PreferencesView>(PREFERENCES_PATH)
    } finally {
      pending.value = false
    }
  }

  /** Queue writes so each full-view response includes all preceding preference updates. */
  function update(body: Record<string, unknown>): Promise<void> {
    const request = updateQueue.then(async () => {
      view.value = await $api.put<PreferencesView>(PREFERENCES_PATH, body)
    })
    updateQueue = request.then(() => undefined, () => undefined)
    return request
  }

  /** Rethrows on failure; the page reports it and keeps the previous view. */
  function setInApp(category: NotificationCategory, inApp: boolean): Promise<void> {
    return update({ items: [{ category, inApp }] })
  }

  function setEmail(category: NotificationCategory, email: boolean): Promise<void> {
    return update({ items: [{ category, email }] })
  }

  function setEmailEnabled(emailEnabled: boolean): Promise<void> {
    return update({ emailEnabled })
  }

  return { view, pending, load, setInApp, setEmail, setEmailEnabled }
}
