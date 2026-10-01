import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { extractApiError } from '~/composables/useApi'
import { mapLimit } from '~/lib/map-limit'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetPage, FleetRepo, FleetRepoCheck, NewFleetRepo } from '~/lib/fleet-types'

export type RepoCheckState =
  | { status: 'checking' }
  | { status: 'done'; result: FleetRepoCheck }
  | { status: 'error'; message: string }

export interface ProjectOption {
  id: string
  slug: string
  name: string
}

/** Reachability checks in flight at once (each one calls the forge). */
export const CHECK_CONCURRENCY = 4

/** Admin Repos page data: the registry, its reachability checks, and project options. */
export function useFleetRepos() {
  const { $api } = useApi()
  const repos = ref<FleetRepo[]>([])
  const hasMore = ref(false)
  const pending = ref(false)
  const checks = ref<Record<string, RepoCheckState>>({})
  const projects = ref<ProjectOption[]>([])

  async function load(): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<FleetPage<FleetRepo>>('/fleet/repos', { query: { size: String(FLEET_LIST_SIZE) } })
      repos.value = res.records ?? []
      hasMore.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  async function loadProjects(): Promise<void> {
    const rows = await $api.get<ProjectOption[]>('/projects')
    projects.value = (rows ?? []).map(({ id, slug, name }) => ({ id, slug, name }))
  }

  // Repos removed while their check was in flight: a late result must not bring the row's state back.
  let removed: ReadonlySet<string> = new Set()

  function setCheck(id: string, state: RepoCheckState): void {
    if (removed.has(id)) return
    checks.value = { ...checks.value, [id]: state }
  }

  /** Never throws: a failed request is recorded as an `error` state for the row. */
  async function check(id: string): Promise<void> {
    setCheck(id, { status: 'checking' })
    try {
      setCheck(id, { status: 'done', result: await $api.post<FleetRepoCheck>(apiPath`/fleet/repos/${id}/check`, {}) })
    } catch (err: unknown) {
      setCheck(id, { status: 'error', message: extractApiError(err) })
    }
  }

  async function checkAll(): Promise<void> {
    await mapLimit(repos.value.map((r) => r.id), CHECK_CONCURRENCY, check)
  }

  async function create(input: NewFleetRepo): Promise<FleetRepo> {
    const created = await $api.post<FleetRepo>('/fleet/repos', { ...input })
    repos.value = [...repos.value, created]
    return created
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/fleet/repos/${id}`)
    removed = new Set([...removed, id])
    repos.value = repos.value.filter((r) => r.id !== id)
    checks.value = Object.fromEntries(Object.entries(checks.value).filter(([key]) => key !== id))
  }

  return { repos, hasMore, pending, checks, projects, load, loadProjects, check, checkAll, create, remove }
}
