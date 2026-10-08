import { ref } from 'vue'
import { PREFERENCES_PATH } from '~/lib/notification-types'
import type { NotificationCategory, NotificationPreferenceDto } from '~/lib/notification-types'

interface PreferenceList {
  items?: NotificationPreferenceDto[]
}

/** Fleet S4a §3: the caller's per-category in-app toggles. */
export function useNotificationPreferences() {
  const { $api } = useApi()
  const items = ref<NotificationPreferenceDto[]>([])
  const pending = ref(false)

  async function load(): Promise<void> {
    pending.value = true
    try {
      items.value = (await $api.get<PreferenceList>(PREFERENCES_PATH)).items ?? []
    } finally {
      pending.value = false
    }
  }

  /** Rethrows on failure; the page reports it and keeps the previous list. */
  async function setInApp(category: NotificationCategory, inApp: boolean): Promise<void> {
    const res = await $api.put<PreferenceList>(PREFERENCES_PATH, { items: [{ category, inApp }] })
    items.value = res.items ?? items.value
  }

  return { items, pending, load, setInApp }
}
