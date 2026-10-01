import { computed, ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE, type FleetPage, type FleetRepo, type FleetRunnerSummary } from '~/lib/fleet-types'

const sortedUnion = (lists: ReadonlyArray<readonly string[]>): string[] =>
  [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b))

/** Repos and runner summaries a project member may dispatch to (D118), and the pickers derived from them. */
export function useFleetDispatchOptions(slug: string) {
  const { $api } = useApi()
  const repos = ref<FleetRepo[]>([])
  const runners = ref<FleetRunnerSummary[]>([])
  const moreRepos = ref(false)
  const moreRunners = ref(false)

  async function load(): Promise<void> {
    // D125: fleets are small; one page of FLEET_LIST_SIZE, with a hint when there is more.
    const query = { size: String(FLEET_LIST_SIZE) }
    const [repoPage, runnerPage] = await Promise.all([
      $api.get<FleetPage<FleetRepo>>(apiPath`/projects/${slug}/fleet/repos`, { query }),
      $api.get<FleetPage<FleetRunnerSummary>>(apiPath`/projects/${slug}/fleet/runners`, { query }),
    ])
    repos.value = repoPage.records ?? []
    runners.value = runnerPage.records ?? []
    moreRepos.value = repoPage.hasNext === true
    moreRunners.value = runnerPage.hasNext === true
  }

  /** Machine profiles any runner reports; repo-provided names are typed in (S1 spec §2.1). */
  const profileOptions = computed(() => sortedUnion(runners.value.map(r => r.profiles)))
  const labelOptions = computed(() => sortedUnion(runners.value.map(r => r.labels)))

  const repoName = (id: string): string => {
    const repo = repos.value.find(r => r.id === id)
    return repo ? `${repo.owner}/${repo.name}` : id
  }
  const runnerName = (id: string | null): string | null =>
    id === null ? null : (runners.value.find(r => r.id === id)?.name ?? id)

  return { repos, runners, moreRepos, moreRunners, load, profileOptions, labelOptions, repoName, runnerName }
}
