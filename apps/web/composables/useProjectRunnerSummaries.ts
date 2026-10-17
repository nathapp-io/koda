import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE, type FleetPage, type FleetRunnerSummary } from '~/lib/fleet-types'

/**
 * The runner summaries of one project on their own: `GET /projects/:slug/fleet/runners`.
 *
 * The workspace thread page's header needs nothing but the summaries (the runner name and its online
 * dot), and it must not ask for a repo list it has no use for — `useFleetDispatchOptions.load()`
 * reads the repos and the runners together for the dispatch form (S5b 1d, 1d2-D12). `load(slug)` is
 * called per slug because the page only learns its thread's home project once the thread has loaded.
 */
export function useProjectRunnerSummaries() {
  const { $api } = useApi()
  const runners = ref<FleetRunnerSummary[]>([])

  async function load(slug: string): Promise<void> {
    // D125: fleets are small; one page of FLEET_LIST_SIZE, with a hint when there is more.
    const res = await $api.get<FleetPage<FleetRunnerSummary>>(apiPath`/projects/${slug}/fleet/runners`, {
      query: { size: String(FLEET_LIST_SIZE) },
    })
    runners.value = res.records ?? []
  }

  return { runners, load }
}
