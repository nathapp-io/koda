import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ProjectAgent } from '~/composables/useProjectAgents'

/** Names for agents currently present in the project's roster. */
export function useProjectAgentNames(slug: string) {
  const { $api } = useApi()
  const agents = ref<ProjectAgent[]>([])

  async function load(): Promise<void> {
    const response = await $api.get<{ items?: ProjectAgent[] }>(apiPath`/projects/${slug}/agents`)
    agents.value = Array.isArray(response?.items) ? response.items : []
  }

  const nameOf = (agentId: string): string | null => agents.value.find(agent => agent.id === agentId)?.name ?? null
  return { agents, load, nameOf }
}
