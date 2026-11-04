import { ref } from 'vue'
import { useApprovalPolicies } from '~/composables/useApprovalPolicies'
import { apiPath } from '~/lib/api-path'
import type { ApprovalMode } from '~/lib/approval-policies'

export interface MemoryWriteMode {
  mode: 'direct' | 'proposal'
  policyId: string | null
  source: 'policy' | 'default' | 'not-approvable'
  agentPolicy: { id: string; mode: ApprovalMode } | null
}

const AGENT_MEMORY_POLICY = {
  permissionPattern: 'memory.create',
  appliesTo: { kind: 'type', principalType: 'AGENT' },
  mode: 'human',
}

export function useMemoryWriteMode(slug: string) {
  const { $api } = useApi()
  const policies = useApprovalPolicies({ kind: 'project', slug })
  const state = ref<MemoryWriteMode | null>(null)
  const loading = ref(true)

  async function load(): Promise<MemoryWriteMode> {
    loading.value = true
    try {
      const result = await $api.get(apiPath`/projects/${slug}/memory/write-mode`) as MemoryWriteMode
      state.value = result
      return result
    } finally {
      loading.value = false
    }
  }

  async function setProposal(): Promise<void> {
    const agentPolicy = state.value?.agentPolicy
    if (!agentPolicy) await policies.create(AGENT_MEMORY_POLICY)
    else if (agentPolicy.mode === 'none') await policies.update(agentPolicy.id, { mode: 'human' })
    else return
    await load()
  }

  async function setDirect(): Promise<void> {
    const agentPolicy = state.value?.agentPolicy
    if (!agentPolicy) return
    await policies.remove(agentPolicy.id)
    await load()
  }

  return { state, loading, load, setProposal, setDirect }
}
