import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { sortPolicies } from '~/lib/fleet-budgets'
import type { BudgetPolicyDto, BudgetPolicyPatchBody, NewBudgetPolicyBody } from '~/lib/fleet-types'

/** Which route prefix a page talks to (2a D162): admin = global and runner policies, project = that project's. */
export type BudgetBase = { kind: 'admin' } | { kind: 'project'; slug: string }

export const budgetRoot = (base: BudgetBase): string =>
  base.kind === 'admin' ? '/fleet/budgets' : apiPath`/projects/${base.slug}/fleet/budgets`

export const budgetItem = (base: BudgetBase, id: string): string =>
  base.kind === 'admin' ? apiPath`/fleet/budgets/${id}` : apiPath`/projects/${base.slug}/fleet/budgets/${id}`

/**
 * Mutation epoch, shared by every instance on the page (the page and its dialogs each call this
 * composable): a poll that started before a successful mutation carries older rows and is dropped,
 * the next poll brings fresh ones. Same reasoning as useFleetRunners.
 */
let mutationEpoch = 0

/** Budget policies of one base: the list and the four mutations. Plain arrays, no paging (2a D163). */
export function useFleetBudgets(base: BudgetBase) {
  const { $api } = useApi()
  const policies = ref<BudgetPolicyDto[]>([])
  const pending = ref(false)
  let latestLoadId = 0

  async function load(): Promise<void> {
    const loadId = ++latestLoadId
    const epoch = mutationEpoch
    pending.value = true
    try {
      const rows = await $api.get<BudgetPolicyDto[]>(budgetRoot(base))
      if (loadId !== latestLoadId || epoch !== mutationEpoch) return
      policies.value = sortPolicies(rows ?? [])
    } finally {
      if (loadId === latestLoadId) pending.value = false
    }
  }

  /** Puts a saved row in the list (replacing the same id) and invalidates in-flight loads. */
  function apply(saved: BudgetPolicyDto): void {
    mutationEpoch += 1
    policies.value = sortPolicies([...policies.value.filter((p) => p.id !== saved.id), saved])
  }

  async function create(body: NewBudgetPolicyBody): Promise<BudgetPolicyDto> {
    const created = await $api.post<BudgetPolicyDto>(budgetRoot(base), { ...body })
    apply(created)
    return created
  }

  async function update(id: string, patch: BudgetPolicyPatchBody): Promise<BudgetPolicyDto> {
    const updated = await $api.patch<BudgetPolicyDto>(budgetItem(base, id), { ...patch })
    apply(updated)
    return updated
  }

  /** `amountUsd` omitted keeps the amount; the server refuses an amount not above the window spend. */
  async function resume(id: string, amountUsd?: number): Promise<BudgetPolicyDto> {
    const resumed = await $api.post<BudgetPolicyDto>(`${budgetItem(base, id)}/resume`, amountUsd === undefined ? {} : { amountUsd })
    apply(resumed)
    return resumed
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(budgetItem(base, id))
    mutationEpoch += 1
    policies.value = policies.value.filter((p) => p.id !== id)
  }

  return { policies, pending, load, apply, create, update, resume, remove }
}
