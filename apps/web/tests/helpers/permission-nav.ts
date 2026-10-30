/**
 * Shared doubles for the layouts/permission specs (Permissions P1 US-006 and US-007).
 *
 * Four shapes are needed:
 * - `globalPermissionsStub`: a `useGlobalPermissions` double for harnesses that run the real layout
 *   `<script setup>` and only need a fixed global key set.
 * - `projectPermissionsStub`: the same double for the project scope, for the specs (US-007) whose
 *   gates read `useProjectPermissions`.
 * - `adminNavFlags`: the template bindings `layouts/default.vue` derives from that set, for the older
 *   harnesses that render the template with a hand-written setup instead of running the real one.
 * - `fakeAsyncData`: Nuxt's `useAsyncData` in miniature, for specs that run the real permissions
 *   composables by injecting their auto-imports.
 *
 * `adminNavFlags` mirrors the layout's mapping, so it is only a convenience for those synthetic
 * contexts: `tests/layouts/default-permission-nav.spec.ts` runs the real setup and is the spec that
 * pins the layout itself.
 */
import { computed, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import { permissionSet } from '~/lib/permissions'

/** One `fakeAsyncData` call: its key, its options, and what the handler resolved with. */
export interface AsyncCall {
  key: string
  options?: { default?: () => unknown }
  /** Exactly what Nuxt would put in the hydration payload. */
  resolved?: unknown
}

/** Every `fakeAsyncData` call recorded since the last `resetAsyncCalls()`. */
export const asyncCalls: AsyncCall[] = []

export function resetAsyncCalls(): void {
  asyncCalls.length = 0
}

/**
 * Nuxt's `useAsyncData` in miniature: `data` is a shallow ref that starts at the `default` option,
 * `pending` is set synchronously when a fetch (or a refresh) starts, a rejection lands in `error`
 * and leaves `data` where it was, and `refresh` runs the handler again.
 */
export function fakeAsyncData<T>(
  key: string,
  run: () => Promise<T>,
  options?: { default?: () => T },
): { data: Ref<T | null>; pending: Ref<boolean>; error: Ref<unknown>; refresh: () => Promise<void> } {
  const call: AsyncCall = { key, options }
  asyncCalls.push(call)
  const data = shallowRef<T | null>(options?.default ? options.default() : null) as Ref<T | null>
  const pending = ref(true)
  const error = ref<unknown>(null)
  const load = (): Promise<void> => {
    pending.value = true
    error.value = null
    return run().then(
      (value) => { call.resolved = value; data.value = value; pending.value = false },
      (err: unknown) => { error.value = err; pending.value = false },
    )
  }
  void load()
  return { data, pending, error, refresh: load }
}

/** Every admin nav entry's global key, in sidebar order. */
export const ADMIN_NAV_KEYS = [
  'user.read',
  'role.read',
  // P3b US-006: the global approval policy page (after Roles).
  'approval.policy.manage',
  'audit.read',
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

/**
 * A `useProjectPermissions` double whose project set is fixed at mount — the same minimal shape
 * `useGlobalPermissions` returns, for the specs (US-007) that mount a page whose gates read the
 * project scope. `pending` and `error` keep every gate closed, exactly as the real composable does;
 * the returned `error` ref stays writable, so a spec can hand a mounted component a failed fetch.
 */
export function projectPermissionsStub(keys: readonly string[] = [], options: { pending?: boolean; error?: unknown } = {}) {
  const held = permissionSet(keys)
  const pending = ref(options.pending === true)
  const error = ref<unknown>(options.error ?? null)
  return {
    // Fail closed like the real composable: a pending or failed fetch exposes nothing.
    permissions: computed(() => (pending.value || error.value ? permissionSet([]) : held)),
    pending,
    error,
    refresh: async (): Promise<void> => undefined,
  }
}

/** The layout's per-link admin booleans and its section-label flag, for one global key set. */
export function adminNavFlags(keys: readonly string[]): Record<string, boolean> {
  const held = permissionSet(keys)
  const flags = {
    canReadUsers: held.has('user.read'),
    canReadRoles: held.has('role.read'),
    // P3b US-006: the global approval policy page follows the key its routes need.
    canManageApprovalPolicies: held.has('approval.policy.manage'),
    canReadAudit: held.has('audit.read'),
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
