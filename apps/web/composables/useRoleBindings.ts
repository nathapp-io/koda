/**
 * Permissions P1 US-011: the role-binding API the admin pages and the principal dialog share.
 *
 * Reads and writes only. The API owns every grant rule (escalation, self-binding, the owner lock,
 * which principal a role can serve), and the caller toasts whatever it refuses with
 * `extractApiError`, so no rule is restated here.
 *
 * `listGlobal` pages the whole "applies everywhere" listing (no project) for one principal type, so
 * an admin users page renders every row's chips from one pass instead of one request per row. A
 * failed page leaves the previously loaded list in place: a half-joined page would render chips the
 * caller cannot vouch for.
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

export type PrincipalType = 'USER' | 'AGENT'

/** `RoleBindingDto` as `GET /role-bindings` returns it; `projectId` null means a global binding. */
export interface RoleBinding {
  id: string
  principalType: PrincipalType
  principalId: string
  roleId: string
  roleKey: string
  projectId: string | null
  grantedByType: string
  grantedById: string
  createdAt: string
}

export interface RoleBindingPage {
  records?: RoleBinding[]
  total?: number
  current?: number
  size?: number
  hasNext?: boolean
  hasPrev?: boolean
}

/** `POST /role-bindings`: `projectId` null binds the role everywhere. */
export interface NewRoleBinding {
  principalType: PrincipalType
  principalId: string
  roleKey: string
  projectId: string | null
}

/** The list route's largest page; one page covers most installations, more pages are followed. */
export const BINDING_PAGE_SIZE = 200

export function useRoleBindings() {
  const { $api } = useApi()
  const bindings = ref<RoleBinding[]>([])
  const pending = ref(false)

  /**
   * The bindings that apply everywhere for one principal type, every page of them.
   *
   * Paging follows `hasNext` to the end: a cap would publish a truncated listing and hide bindings
   * that still exist. What stops a misbehaving server from spinning here is the progress check — a
   * page that claims another page but carries no records cannot advance the listing, so it rejects.
   */
  async function listGlobal(principalType: PrincipalType): Promise<RoleBinding[]> {
    pending.value = true
    try {
      const collected: RoleBinding[] = []
      for (let current = 1; ; current += 1) {
        const res = await $api.get<RoleBindingPage>('/role-bindings', {
          query: { principalType, scope: 'global', size: String(BINDING_PAGE_SIZE), current: String(current) },
        })
        const records = Array.isArray(res?.records) ? res.records : []
        if (res?.hasNext !== true) {
          collected.push(...records)
          break
        }
        if (records.length === 0) {
          throw new Error(`GET /role-bindings reported another page at current=${current} but returned no records`)
        }
        collected.push(...records)
      }
      // Assigned once, after the last page: a failed page throws and leaves the old list whole.
      bindings.value = collected
      return collected
    } finally {
      pending.value = false
    }
  }

  async function create(input: NewRoleBinding): Promise<RoleBinding> {
    return $api.post<RoleBinding>('/role-bindings', { ...input })
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/role-bindings/${id}`)
  }

  return { bindings, pending, listGlobal, create, remove }
}
