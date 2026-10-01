import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetEnrollmentCreated, FleetPage, FleetRunner, FleetRunnerPatch } from '~/lib/fleet-types'

/**
 * Mutation epoch, shared by every instance of this composable on the page.
 *
 * It must not be per-instance: the Runners page and its edit dialog each call `useFleetRunners()`,
 * so a dialog-issued `update` would otherwise bump only its own counter and leave the page's
 * in-flight poll free to overwrite the saved row with pre-edit data.
 */
let mutationEpoch = 0

/** Admin Runners page data: one page of FLEET_LIST_SIZE runners (plan D125). */
export function useFleetRunners() {
  const { $api } = useApi()
  const runners = ref<FleetRunner[]>([])
  const hasMore = ref(false)
  const pending = ref(false)

  async function load(): Promise<void> {
    const started = mutationEpoch
    pending.value = true
    try {
      const res = await $api.get<FleetPage<FleetRunner>>('/fleet/runners', { query: { size: String(FLEET_LIST_SIZE) } })
      // A load (a poll) that started before a mutation would carry older rows: drop it, and let the
      // next poll bring fresh ones.
      if (started !== mutationEpoch) return
      runners.value = res.records ?? []
      hasMore.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  /** A row saved here or elsewhere (the edit dialog's own instance) replaces the listed one. */
  function apply(updated: FleetRunner): void {
    mutationEpoch += 1
    runners.value = runners.value.map((r) => (r.id === updated.id ? updated : r))
  }

  async function update(id: string, patch: FleetRunnerPatch): Promise<FleetRunner> {
    const updated = await $api.patch<FleetRunner>(apiPath`/fleet/runners/${id}`, { ...patch })
    apply(updated)
    return updated
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/fleet/runners/${id}`)
    mutationEpoch += 1
    runners.value = runners.value.filter((r) => r.id !== id)
  }

  async function createEnrollment(labels: readonly string[]): Promise<FleetEnrollmentCreated> {
    return $api.post<FleetEnrollmentCreated>('/fleet/enrollments', { labels: [...labels] })
  }

  return { runners, hasMore, pending, load, apply, update, remove, createEnrollment }
}
