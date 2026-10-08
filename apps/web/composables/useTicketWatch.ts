import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { WatchStateDto } from '~/lib/notification-types'

/** Fleet S4a §3: the caller's watch state on one ticket. Unwatch is a sticky mute on the API side (D502). */
export function useTicketWatch(slug: string, ticketRef: string) {
  const { $api } = useApi()
  const state = ref<WatchStateDto | null>(null)
  const busy = ref(false)

  async function load(): Promise<void> {
    state.value = await $api.get<WatchStateDto>(apiPath`/projects/${slug}/tickets/${ticketRef}/watchers`)
  }

  async function toggle(): Promise<void> {
    if (!state.value || busy.value) return
    busy.value = true
    try {
      const path = apiPath`/projects/${slug}/tickets/${ticketRef}/watch`
      state.value = state.value.watching
        ? await $api.delete<WatchStateDto>(path)
        : await $api.put<WatchStateDto>(path)
    } finally {
      busy.value = false
    }
  }

  return { state, busy, load, toggle }
}
