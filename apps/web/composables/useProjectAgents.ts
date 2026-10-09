import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

/** One row in the project agent roster (GET /projects/:slug/agents). */
export interface ProjectAgent {
  slug: string
  name: string
  status: string
  roles: string[]
  capabilities: string[]
  openTicketCount: number
  openTicketRefs: string[]
  addedAt: string
  addedBy: { id: string; name: string | null } | null
}

export interface ProjectAgentListDto {
  scoping: boolean
  items: ProjectAgent[]
}

/**
 * Roster read/add/remove for one project. The page never calls the endpoint
 * directly: this composable owns the roster state, exposes the add/remove
 * verbs the page and the AddProjectAgentDialog need, and reloads after a
 * mutation so stale counts (open tickets, status) refresh.
 *
 * `add` and `remove` re-throw API errors so the caller can show the
 * extracted message and decide whether to keep state open (dialog stays
 * open on add failure; 409 on remove reloads the roster to refresh stale
 * counts).
 */
export function useProjectAgents(slug: string) {
  const { $api } = useApi()
  const base = apiPath`/projects/${slug}/agents`

  const items = ref<ProjectAgent[]>([])
  const scoping = ref(true)
  const pending = ref(false)
  const error = ref<unknown>(null)

  async function load(): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<ProjectAgentListDto>(base)
      items.value = Array.isArray(res?.items) ? res.items : []
      scoping.value = res?.scoping !== false
      error.value = null
    } catch (caught) {
      error.value = caught
    } finally {
      pending.value = false
    }
  }

  async function refresh(): Promise<void> {
    await load()
  }

  async function add(agentSlug: string): Promise<void> {
    await $api.post(base, { agentSlug })
  }

  async function remove(agentSlug: string): Promise<void> {
    await $api.delete(apiPath`/projects/${slug}/agents/${agentSlug}`)
  }

  return { items, scoping, pending, error, load, refresh, add, remove }
}
