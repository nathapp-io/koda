/**
 * P3b US-008: the approval policies' client, for the global page and (US-009) the project page.
 *
 * One instance per base: `{ kind: 'global' }` talks to `/approval-policies`, `{ kind: 'project', slug }`
 * to `/projects/:slug/approval-policies`. The two routes answer the same page shape, so everything
 * below is base-agnostic.
 *
 * `list()` reads **every** page. The keys table counts how many policies override a key, and a count
 * that stopped at the first page of 20 would understate it — so the list asks for 100 at a time and
 * keeps going while the API says there is more.
 */
import { ref } from 'vue'
import { IncompletePolicyListError, policyItem, policyKeysPath, policyRoot } from '~/lib/approval-policies'
import type { ApprovalPolicy, ApprovalPolicyPage, ApprovableKey, PolicyBase } from '~/lib/approval-policies'

/** The page size the list asks for: the API's maximum, so the whole list is usually one request. */
const POLICY_PAGE_SIZE = 100

/** The records of one list answer, with a default for every field the API always sends. */
function toPage(answer: Partial<ApprovalPolicyPage> | null | undefined): ApprovalPolicyPage {
  return {
    total: answer?.total ?? 0,
    current: answer?.current ?? 1,
    size: answer?.size ?? 0,
    hasNext: answer?.hasNext === true,
    hasPrev: answer?.hasPrev === true,
    records: Array.isArray(answer?.records) ? answer.records : [],
  }
}

export function useApprovalPolicies(base: PolicyBase) {
  const { $api } = useApi()
  const policies = ref<ApprovalPolicy[]>([])
  const keys = ref<ApprovableKey[]>([])
  const pending = ref(false)

  /**
   * Every policy of this base, page after page: the walk ends only when the API says there is no
   * next page, so an override count is never computed over a truncated list.
   *
   * A page that claims `hasNext` and carries no records cannot be followed by another one, so the
   * list is known to be short: it throws `IncompletePolicyListError` rather than returning it, and
   * leaves the last complete list in place. A caller shows that state; it must not present counts
   * from a list it knows is partial.
   */
  async function list(): Promise<ApprovalPolicy[]> {
    pending.value = true
    try {
      const all: ApprovalPolicy[] = []
      let page = 1
      for (;;) {
        const answer = toPage(await $api.get<Partial<ApprovalPolicyPage>>(policyRoot(base), {
          query: page === 1 ? { size: String(POLICY_PAGE_SIZE) } : { current: String(page), size: String(POLICY_PAGE_SIZE) },
        }))
        all.push(...answer.records)
        if (!answer.hasNext) break
        if (answer.records.length === 0) throw new IncompletePolicyListError(page)
        page += 1
      }
      policies.value = all
      return all
    } finally {
      pending.value = false
    }
  }

  /** `GET <root>/keys`: the approvable keys with their floors and defaults. */
  async function loadKeys(): Promise<ApprovableKey[]> {
    const answer = await $api.get<{ keys?: ApprovableKey[] }>(policyKeysPath(base))
    keys.value = Array.isArray(answer?.keys) ? answer.keys : []
    return keys.value
  }

  /** Puts a saved policy in the list (replacing the same id), so a dialog need not reload the page. */
  function apply(saved: ApprovalPolicy): void {
    policies.value = [...policies.value.filter((policy) => policy.id !== saved.id), saved]
  }

  async function create(body: Record<string, unknown>): Promise<ApprovalPolicy> {
    const created = await $api.post<ApprovalPolicy>(policyRoot(base), { ...body })
    apply(created)
    return created
  }

  async function update(id: string, patch: Record<string, unknown>): Promise<ApprovalPolicy> {
    const updated = await $api.patch<ApprovalPolicy>(policyItem(base, id), { ...patch })
    apply(updated)
    return updated
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(policyItem(base, id))
    policies.value = policies.value.filter((policy) => policy.id !== id)
  }

  return { policies, keys, pending, list, loadKeys, create, update, remove }
}
