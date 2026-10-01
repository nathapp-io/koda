import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetEnrollmentCreated, FleetPage, FleetRunner, FleetRunnerPatch } from '~/lib/fleet-types'

/** Admin Runners page data: one page of FLEET_LIST_SIZE runners (plan D125). */
export function useFleetRunners() {
  const { $api } = useApi()
  const runners = ref<FleetRunner[]>([])
  const hasMore = ref(false)
  const pending = ref(false)
  // Bumped by every successful mutation. A load (a poll) that started before one would carry
  // older rows, so it drops its result; the next poll brings fresh ones.
  let mutations = 0

  async function load(): Promise<void> {
    const started = mutations
    pending.value = true
    try {
      const res = await $api.get<FleetPage<FleetRunner>>('/fleet/runners', { query: { size: String(FLEET_LIST_SIZE) } })
      if (started !== mutations) return
      runners.value = res.records ?? []
      hasMore.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  /** A row saved here or elsewhere (the edit dialog's own instance) replaces the listed one. */
  function apply(updated: FleetRunner): void {
    mutations += 1
    runners.value = runners.value.map((r) => (r.id === updated.id ? updated : r))
  }

  async function update(id: string, patch: FleetRunnerPatch): Promise<FleetRunner> {
    const updated = await $api.patch<FleetRunner>(apiPath`/fleet/runners/${id}`, { ...patch })
    apply(updated)
    return updated
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/fleet/runners/${id}`)
    mutations += 1
    runners.value = runners.value.filter((r) => r.id !== id)
  }

  async function createEnrollment(labels: readonly string[]): Promise<FleetEnrollmentCreated> {
    return $api.post<FleetEnrollmentCreated>('/fleet/enrollments', { labels: [...labels] })
  }

  return { runners, hasMore, pending, load, apply, update, remove, createEnrollment }
}
