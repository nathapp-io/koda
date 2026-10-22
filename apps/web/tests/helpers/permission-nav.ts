/**
 * Shared doubles for the layouts/permission specs (Permissions P1 US-006).
 *
 * Two shapes are needed:
 * - `globalPermissionsStub`: a `useGlobalPermissions` double for harnesses that run the real layout
 *   `<script setup>` and only need a fixed global key set.
 * - `adminNavFlags`: the template bindings `layouts/default.vue` derives from that set, for the older
 *   harnesses that render the template with a hand-written setup instead of running the real one.
 *
 * `adminNavFlags` mirrors the layout's mapping, so it is only a convenience for those synthetic
 * contexts: `tests/layouts/default-permission-nav.spec.ts` runs the real setup and is the spec that
 * pins the layout itself.
 */
import { computed, ref } from 'vue'
import { permissionSet } from '~/lib/permissions'

/** Every admin nav entry's global key, in sidebar order. */
export const ADMIN_NAV_KEYS = [
  'user.read',
  'fleet.dashboard.read',
  'fleet.runner.read',
  'fleet.repo.read',
  'fleet.budget.read',
  'fleet.approval.read',
  'fleet.analytics.read',
  'skill.source.read',
] as const

/** A `useGlobalPermissions` double whose set is fixed at mount. `pending` keeps every gate closed. */
export function globalPermissionsStub(keys: readonly string[] = [], pending = false) {
  const held = permissionSet(keys)
  return {
    permissions: computed(() => (pending ? permissionSet([]) : held)),
    pending: ref(pending),
    error: ref<unknown>(null),
    refresh: async (): Promise<void> => undefined,
  }
}

/** The layout's per-link admin booleans and its section-label flag, for one global key set. */
export function adminNavFlags(keys: readonly string[]): Record<string, boolean> {
  const held = permissionSet(keys)
  const flags = {
    canReadUsers: held.has('user.read'),
    canReadFleetDashboard: held.has('fleet.dashboard.read'),
    canReadFleetRunners: held.has('fleet.runner.read'),
    canReadFleetRepos: held.has('fleet.repo.read'),
    canReadFleetBudgets: held.has('fleet.budget.read'),
    canReadFleetApprovals: held.has('fleet.approval.read'),
    canReadFleetAnalytics: held.has('fleet.analytics.read'),
    canReadSkills: held.has('skill.source.read'),
  }
  return { ...flags, showAdminNav: Object.values(flags).some(Boolean) }
}
