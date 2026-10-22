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
 * Read and status actions for one project's agent roster.
 */
export function useProjectAgents(slug: string) {
  const { $api } = useApi()
  const items = ref<ProjectAgent[]>([])
  const scoping = ref(true)
  const pending = ref(false)
  const error = ref<unknown>(null)

  async function load(): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<ProjectAgentListDto>(apiPath`/projects/${slug}/agents`)
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

  async function changeStatus(agentSlug: string, status: string): Promise<void> {
    await $api.patch(apiPath`/projects/${slug}/agents/${agentSlug}`, { status })
  }

  return { items, scoping, pending, error, load, refresh, changeStatus }
}
