import { ref } from 'vue'

/**
 * Whether self-registration is open (GET /auth/registration-status).
 * A failed probe reads as closed: the register link hides instead of
 * leading to a form the API would refuse.
 */
export function useRegistrationStatus() {
  const { $api } = useApi()
  const open = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    try {
      const res = await $api.get<{ open: boolean }>('/auth/registration-status')
      open.value = res?.open === true
    } catch {
      open.value = false
    } finally {
      loaded.value = true
    }
  }

  return { open, loaded, load }
}
