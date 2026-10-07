import { ref, shallowRef } from 'vue'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { BOARD_PATH } from '~/lib/fleet-credential-board'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

/** Fleet S3 §6: the admin credential board, loaded on demand (no polling; the page has a Refresh button). */
export function useFleetCredentialBoard() {
  const { $api } = useApi()
  const data = shallowRef<CredentialBoard | null>(null)
  const pending = ref(false)
  const forbidden = ref(false)
  const failed = ref(false)

  async function load(): Promise<void> {
    if (forbidden.value) return
    pending.value = true
    try {
      data.value = await $api.get<CredentialBoard>(BOARD_PATH)
      failed.value = false
    } catch (err: unknown) {
      if (isForbidden(err)) forbidden.value = true
      else failed.value = true
    } finally {
      pending.value = false
    }
  }

  return { data, pending, forbidden, failed, load }
}
