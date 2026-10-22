/**
 * Permissions P1 US-006: SSR-friendly fetches of the caller's effective permission keys.
 *
 * Gates read from these, never from a role name — roles are data, and a custom role has to work.
 * `useAsyncData` runs on the server during SSR and again during hydration, so the keys are known
 * before the first render and a gated control does not flash into view later (the same reason
 * `useProjectViewerRole` used it).
 *
 * Fail closed: a pending, failed or not-yet-requested fetch exposes `EMPTY_PERMISSIONS`, so every
 * gated control is hidden. A control that never renders is the safe direction; the API still
 * refuses anything the caller may not do, and the caller still surfaces its answer.
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { EMPTY_PERMISSIONS, permissionSet } from '~/lib/permissions'
import type { PermissionSet } from '~/lib/permissions'

/** One `/me/permissions` answer (US-001). `keys` is what the gates read. */
interface MePermissionsResponse {
  scope?: string
  projectSlug?: string | null
  keys?: string[]
}

export interface Permissions {
  /** The caller's keys, or `EMPTY_PERMISSIONS` until they are known. */
  permissions: ComputedRef<PermissionSet>
  /** True while a fetch is in flight. */
  pending: Ref<boolean>
  /** The last fetch failure, if any. */
  error: Ref<unknown>
  /** Ask the API again (after a role change, say). */
  refresh: () => Promise<void>
}

/**
 * Reads `/me/permissions` for one scope. `project` null means the global scope, which is the same
 * route without the query — the API answers global keys when no project is named.
 */
function usePermissionsFor(key: string, project: string | null): Permissions {
  const { data, pending, error, refresh } = useAsyncData<PermissionSet>(
    key,
    async () => {
      const { $api } = useApi()
      const response = project === null
        ? await $api.get<MePermissionsResponse>('/me/permissions')
        : await $api.get<MePermissionsResponse>('/me/permissions', { query: { project } })
      return permissionSet(response?.keys ?? [])
    },
    { default: () => EMPTY_PERMISSIONS },
  )

  return {
    // `data` keeps its default (the empty set) until the first success, so a pending or failed
    // fetch leaves every gate closed.
    permissions: computed(() => data.value ?? EMPTY_PERMISSIONS),
    pending,
    error,
    refresh: async () => { await refresh() },
  }
}

/** The keys the caller holds globally (no project): `GET /me/permissions`. */
export function useGlobalPermissions(): Permissions {
  return usePermissionsFor('permissions-global', null)
}

/** The keys the caller holds in one project: `GET /me/permissions?project=<slug>`. */
export function useProjectPermissions(slug: string): Permissions {
  return usePermissionsFor(`permissions-project-${slug}`, slug)
}
