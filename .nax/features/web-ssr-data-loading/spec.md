# SPEC: SSR data loading: one permissions read per scope, loading state that hydrates

## Summary

Two server-render defects from the 2026-11 web audit (`docs/ux/redesign/AUDIT-2026-11.md`, R2-20 and
R2-15). First, every `useGlobalPermissions` / `useProjectPermissions` instance in one server render fires
its own `GET /me/permissions`, so a page makes 3 to 8 reads where it needs one per scope. Second, three
permission-gated screens render their content branch on the server and their loading branch on the
client, so Vue reports a hydration mismatch. This feature makes same-key permission reads share one
request and makes those screens show their loading state until their first load has completed, on the
server and the client alike.

## Motivation

- R2-20: `/me/permissions` returns 429 under fast navigation. Measured on koda-wk `f6e833f3`: a server
  render reads `/me/permissions` 3 times on `/`, 4 on `/sandbox`, 5 on fleet and memory pages and 8 on
  `/sandbox/settings`. Nuxt 4.6.4 `useAsyncData` defaults to `dedupe: 'cancel'`; on the server no cached
  data exists, so each instance's initial fetch aborts the one in flight and starts another, and the API
  counts every one against the 100/min per-client limit.
- R2-15: production logs "Hydration completed but contains mismatches" on `/admin/approval-policies`,
  `/<project>/approval-policies` and `/<project>/settings` (provider keys card). On the server the
  permissions are still pending when the immediate permission watcher first runs, so no load starts and
  the content branch renders with `pending` false. On the client the permissions arrive in the payload,
  the watcher starts the load during setup, `pending` is true, and the client expects the loading branch.

## Design

### Integration

Read-only (verified, unchanged):

- `tests/helpers/permission-nav.ts` `fakeAsyncData(key, run, options)` records every call's `key` and
  `options` in `asyncCalls`.
- `pages/admin/approval-policies.vue` and `pages/[project]/approval-policies.vue` read
  `useApprovalPolicies(base)` (`policies`, `keys`, `pending`, `list`, `loadKeys`, `remove`) and start
  `reload()` from `watch(canManage | canRead, gate, { immediate: true })`; `reload()` sets `loaded`,
  `loadFailed`, `incomplete` or `loadForbidden`.
- `components/SettingsProviderKeysCard.vue` reads `useProviderCredentials(...)` as `vault`
  (`pending`, `credentials`, `load`) and starts `load()` from `watch(canRead, ..., { immediate: true })`.

Changed. The baseline exists only to locate the code; implement the target.

- `composables/usePermissions.ts` `usePermissionsFor`
  - Baseline: `useAsyncData<PermissionKeys>(key, handler, { default: () => [] })`
  - Target: `useAsyncData<PermissionKeys>(key, handler, { default: () => [], dedupe: 'defer' })`
- `pages/admin/approval-policies.vue` and `pages/[project]/approval-policies.vue` loading branch
  - Baseline: `<LoadingState v-if="pending && !loaded" />`
  - Target: `LoadingState` shows while the page may read policies and its first load has neither
    completed nor failed (`!loaded && !loadFailed && !incomplete`), independent of `pending`.
- `components/SettingsProviderKeysCard.vue` loading branch
  - Baseline: `v-if="vault.pending.value && vault.credentials.value.length === 0"`
  - Target: the loading text shows while `canRead` is true and the card's first `load()` has not settled
    (a card-local `firstLoadSettled` ref set to true in a `finally` around the existing `try` in `load()`,
    after the `if (!canRead.value) return` guard), independent of `vault.pending`. `load()` itself never
    rejects: it catches and toasts.

### Approach

`dedupe: 'defer'` makes a second same-key `useAsyncData` call return the promise already in flight
instead of aborting it; a call after the first settles finds `status` `success` and does not refetch. A
manual `refresh()` still re-reads.

Test recipe for US-002. The page specs alias `~/composables/useApprovalPolicies`; replace it with a stub
`{ policies: ref([]), keys: ref([]), pending: ref(false), list, loadKeys: async () => [], remove }` whose
`list` never resolves to model "no load completed" with `pending` false (the real composable reports
`pending` true while a request hangs). The card spec adds an alias for
`~/composables/useProviderCredentials` with `pending: ref(false)`, `credentials: ref([])` and a `load`
that never resolves or rejects as the AC needs. `mountSfc` (`tests/helpers/mount-sfc.ts`) supports `alias`.

For the hydration fix, the loading branch is derived from "has the first load finished", which is false
on the server (no load ran) and false on the client during hydration (the load just started), so both
render the loading branch. The immediate watchers stay as they are.

### Failure Handling

| Input | Behaviour |
|:--|:--|
| first policy load fails with a non-403 error | the retry state shows (`policies-retry`), not `LoadingState` |
| first policy load answers 403 | the forbidden message shows |
| first provider-credential load fails | the card leaves the loading text and shows its normal content with the error toast |

## Out of Scope

- Other `useAsyncData` keys and other components with permission-gated immediate watchers whose templates do not branch on the loading flag (for example `pages/[project]/tickets/[ref].vue`), which hydrate cleanly today.
- The R2-20 bell reads (`/me/notifications`, one per full page load) and the per-client throttle limits are unchanged.
- The live check on koda-wk (count `/me/permissions` per server render; no hydration warning on the three pages) is a manual post-merge step.
- On a client-side navigation the permissions are pending at setup, so the approval-policy pages can briefly show the forbidden message before their load starts; that is not a hydration defect and is unchanged here.
- Other audit items (R2-8 to R2-14, R2-16 to R2-24, R1-16) belong to the shared-UI and page-polish features.

## Stories

### US-001: One permissions read per scope per render

No dependencies. Workdir: `apps/web`.

Pass `dedupe: 'defer'` to the `useAsyncData` call in `usePermissionsFor`.

### US-002: Permission-gated screens render the loading state until their first load finishes

No dependencies. Workdir: `apps/web`.

Change the loading condition on the two approval-policy pages and the provider keys card as described in
Design § Integration.

### Context Files

**US-001**

- `apps/web/composables/usePermissions.ts`
- `apps/web/tests/composables/usePermissions.spec.ts`
- `apps/web/tests/helpers/permission-nav.ts` — `AsyncCall.options` is typed `{ default? }`; the new test casts to read `dedupe` and the helper is not edited

**US-002**

- `apps/web/pages/admin/approval-policies.vue`
- `apps/web/pages/[project]/approval-policies.vue`
- `apps/web/components/SettingsProviderKeysCard.vue`
- `apps/web/tests/pages/admin-approval-policies.spec.ts`
- `apps/web/tests/components/SettingsProviderKeysCard.spec.ts`
- `apps/web/tests/pages/project-approval-policies.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/tests/helpers/fleet-harness.ts`
- `apps/web/composables/useApprovalPolicies.ts`
- `apps/web/composables/useProviderCredentials.ts`

### Creates

**US-002**

- `apps/web/tests/pages/approval-policies-first-load.spec.ts`

### Modifies

**US-001**

- `apps/web/tests/composables/usePermissions.spec.ts` — add the dedupe ACs as new tests beside the existing US-006 cases; no existing assertion changes (none compares the whole `useAsyncData` options object).

### Seams

None: no new exported symbol.

## Acceptance Criteria

### US-001

1. [unit] `useGlobalPermissions()` calls `useAsyncData` with key `permissions-global` and options whose `dedupe` is `'defer'`.
2. [unit] `useProjectPermissions('web')` calls `useAsyncData` with key `permissions-project-web` and options whose `dedupe` is `'defer'`.
3. [unit] Regression guard: `useProjectPermissions('web')` still exposes the keys `GET /me/permissions?project=web` returned (`permissions.value.has('ticket.create')` is true when the answer lists `ticket.create`).

### US-002

1. [unit] `/admin/approval-policies` rendered with `approval.policy.manage` granted, `useApprovalPolicies` reporting `pending` false and no load completed shows `LoadingState` and not the empty policy list.
2. [unit] Regression guard: `/admin/approval-policies` whose first load rejects with a non-403 error shows the `policies-retry` button and not `LoadingState`.
3. [unit] `/admin/approval-policies` whose first load rejects with a 403 `ApiError` shows `policies-forbidden` and neither `LoadingState` nor `policies-retry`.
4. [unit] Regression guard: `/admin/approval-policies` whose first load completes with zero policies shows the empty policy list and not `LoadingState`.
5. [unit] `/admin/approval-policies` whose first load rejects with an `IncompletePolicyListError` shows `policies-incomplete` and not `LoadingState`.
6. [unit] `/<project>/approval-policies` rendered with the read permission granted, `useApprovalPolicies` reporting `pending` false and no load completed shows `LoadingState` and not the empty policy list.
7. [unit] Regression guard: `/<project>/approval-policies` whose first load rejects with a non-403 error shows the `policies-retry` button and not `LoadingState`.
8. [unit] `/<project>/approval-policies` whose first load rejects with a 403 `ApiError` shows `policies-forbidden` and neither `LoadingState` nor `policies-retry`.
9. [unit] `SettingsProviderKeysCard` with `project.credential.read` granted, `vault.pending` false and its first `load()` not settled shows the `common.loading` text.
10. [unit] Regression guard: `SettingsProviderKeysCard` whose `vault.load` rejects no longer shows the `common.loading` text once `load()` settles.
