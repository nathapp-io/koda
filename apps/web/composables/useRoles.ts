/**
 * Permissions P1 US-010: the roles API for the Admin -> Roles page and its editor.
 *
 * Reads and writes only: the API owns every rule (system and locked roles, escalation, the catalog),
 * and the caller toasts whatever it refuses. A failed read leaves the last loaded state in place.
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

export type RoleScope = 'GLOBAL' | 'PROJECT'

export interface Role {
  id: string
  key: string
  name: string
  description: string
  scope: RoleScope
  system: boolean
  locked: boolean
  /** The stored entry list: wildcards, exclusions and `X.own` forms included. */
  permissions: string[]
  /** The keys those entries stand for. */
  expandedKeys: string[]
}

export interface CatalogEntry {
  key: string
  scope: 'global' | 'project' | 'any'
  risk: 'low' | 'medium' | 'high' | 'critical'
  principals: string[]
  ownable: boolean
}

export interface NewRole {
  key: string
  name: string
  description?: string
  scope: RoleScope
  permissions: string[]
}

/** `key` and `scope` are fixed for the life of a role; `name` is rejected for a system role. */
export interface RolePatch {
  name?: string
  description?: string
  permissions?: string[]
}

export function useRoles() {
  const { $api } = useApi()
  const roles = ref<Role[]>([])
  const catalog = ref<CatalogEntry[]>([])
  const pending = ref(false)

  async function load(): Promise<Role[]> {
    pending.value = true
    try {
      const res = await $api.get<Role[]>('/roles')
      roles.value = Array.isArray(res) ? res : []
      return roles.value
    } finally {
      pending.value = false
    }
  }

  async function loadCatalog(): Promise<CatalogEntry[]> {
    const res = await $api.get<CatalogEntry[]>('/permissions/catalog')
    catalog.value = Array.isArray(res) ? res : []
    return catalog.value
  }

  async function create(input: NewRole): Promise<Role> {
    return $api.post<Role>('/roles', { ...input })
  }

  async function update(id: string, patch: RolePatch): Promise<Role> {
    return $api.patch<Role>(apiPath`/roles/${id}`, { ...patch })
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/roles/${id}`)
  }

  return { roles, catalog, pending, load, loadCatalog, create, update, remove }
}
