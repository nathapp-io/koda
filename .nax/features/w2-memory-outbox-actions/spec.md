# SPEC: W2 memory retire and outbox retry

## Summary

The web app gets the two write actions that, until now, only the CLI offered. A member can retire an active
DECISION or NOTE from the project Memory page (`/[project]/memory`). A global admin gets a new Outbox page
(`/admin/outbox`) that lists outbox events by status and retries a dead or stuck pending event. Both actions call
API routes that already exist; this feature is web-only (`apps/web`).

## Motivation

The 07-06 gap analysis split the missing web UIs into W1 (read-only pages, shipped in PR #124) and W2
(admin/mutation UIs, deferred). A route audit on 2026-11-11 found that most W2 actions have since landed through
other work. Two that matter are still CLI-only:

- A wrong or stale memory item keeps reaching agents through retrieval. The Memory page shows it, but removing it
  needs `koda memory` from a terminal.
- A failed outbox delivery (`status: dead`) is invisible in the web app. Nothing shows that events are stuck, and
  resetting one needs `koda admin`.

## Design

### Calls made while drafting (not user rulings)

- Retire is offered only for rows of kind `DECISION` or `NOTE` with status `active`. These are the only kinds the
  API can retire (`POST /memory/:id/retire` answers 422 for any non-decision; `POST /memory/notes/:id/retire`
  answers 422 for any non-note). Retiring FACT, PREFERENCE, CONSTRAINT or INCIDENT_PATTERN rows needs a new API
  route and is out of scope.
- The DECISION gate reads only `memory.decision.retire`. The API also runs a `memory.update` replace check
  (`MemoryWriteService.retireDecision` calls `writeGuard.mayReplace`), so a caller holding the retire key without
  `memory.update` sees the button and gets a 403 toast. `web.md` allows this: a gate only hides a control, and every
  refusal is surfaced with `extractApiError()`.
- A retired row becomes `superseded` on the API. After a successful retire the page calls `applyFilters()` from
  `useMemory` (which resets to page 1 and reloads) rather than patching the row locally, so the current status
  filter decides whether the row stays visible. `loadMemory()` is not used for this: it keeps the current page and
  would collapse a list grown by "Load more" to that one page.
- The Outbox page opens on status `dead`, the status a human acts on. The API's own default is `pending`; the
  page always sends `status` explicitly. The status control is a native `<select>` (as on the Memory page) offering
  exactly four options in this order: `dead`, `pending`, `processing`, `published`.
- The outbox list is capped at 100 rows by the API (`LIST_LIMIT`) and has no paging. The page shows the en text
  `Showing {count} of {total}` (key `outbox.showing`) above the rows. It does not page.
- The outbox `payload` and `headers` fields are never rendered. They can carry event data the admin page has no
  need to show.
- The Outbox page detects a refused list the way `apps/web/pages/admin/slos.vue` does: `err instanceof ApiError &&
  err.code === 403` sets an `adminOnly` state; any other error toasts.
- `memory.vue` imports every Vue function it uses (`ref`, `computed`, `reactive`) from `vue` explicitly, as it
  already does for `reactive`: the `tests/pages/memory-mount.spec.ts` sandbox does not provide Nuxt auto-imports.
- Pages import the feature's composables explicitly rather than relying on Nuxt auto-import: `memory.vue` adds
  `useMemory` to its existing `import { ... } from '~/composables/useMemory'` and imports `useProjectRef` from
  `~/composables/useProjectRef`; `outbox.vue` imports `useAdminOutbox` from `~/composables/useAdminOutbox`.
  `mountSfc` (`tests/helpers/mount-sfc.ts`) injects only its fixed `NUXT_AUTO_IMPORTS` list, which holds none of
  the three. The `memory-mount.spec.ts` sandbox still rewrites the `useMemory(` call site.
- Page specs that assert the `ApiError` branch pass `alias: { '~/composables/useApi': apiModule }` to `mountSfc`,
  as `tests/components/add-skill-source-dialog.spec.ts` does, so the page and the test share one `ApiError` class.
- Page specs mount the real `MemoryRetireDialog` through `loadSfc` with the Shadcn form components, as
  `tests/components/add-skill-source-dialog.spec.ts` does; the dialog is not stubbed.
- `memory.vue` names its new bindings `canRetire(item)` (row eligibility), `retireTarget` (the row being retired, or
  `null` when the dialog is closed), `retireBusy` (true while a retire request is in flight), `openRetire(item)` and
  `confirmRetire(reason)`. It passes `retireBusy` to the dialog's `busy` prop.
- The Outbox nav link uses the lucide icon `Send`, added to the layout's existing `lucide-vue-next` import.

### Integration

Read-only symbols (verified 2026-11-11 on `main` `72c30222`):

- `POST /memory/:id/retire` (`apps/api/src/memory/memory.controller.ts` `retireDecision`), body `RetireDecisionDto`
  `{ reason?: string }` with `@MaxLength(500)`. Permission `memory.decision.retire` (project scope). Approval-gated:
  answers `201` with the retired item in the `{ ret, data }` envelope, or `202` with an `ApprovalRequestSummary` in
  the envelope. Refusals: 403, 404, 409 (not active), 422 (not a decision).
- `POST /memory/notes/:id/retire` (`retireNote`), body `RetireNoteDto` `{ projectId?: string; reason?: string }`.
  `projectId` is required for a user-scoped note and ignored for a project note. Permission `memory.create`
  (scopes `project` and `own`) plus a `memory.update` replace check in the service. Approval-gated (201 or 202).
  Refusals: 400 (user note with no projectId), 403, 404, 409, 422.
- `GET /admin/outbox?status=<pending|processing|published|dead>` (`apps/api/src/outbox/admin.controller.ts`
  `getOutbox`). Permission `outbox.read` (global). Answers a bare object `{ items: OutboxEventDomain[]; total:
  number }` with no `{ ret, data }` envelope; `unwrap` in `apps/web/composables/useApi.ts` passes a non-envelope
  answer through unchanged.
- `OutboxEventDomain` (`apps/api/src/outbox/domain/outbox-event.domain.ts`): `id`, `projectId`, `type`, `eventId`,
  `payload`, `headers`, `status`, `attempts`, `nextAttemptAt`, `leaseUntil`, `owner`, `lastError`, `publishedAt`,
  `createdAt`, `updatedAt` (dates arrive as ISO strings).
- `POST /admin/outbox/:eventId/retry` (`retryOutboxEvent`). Permission `outbox.retry` (global). Approval-gated:
  answers `200` with an empty body, or `202` with an `ApprovalRequestSummary`. Refusals: 403, 404, 409 (status is
  `processing` or `published`, message `Outbox event is <status>; only dead or pending events can be retried`).
  **The path parameter is the row's `id`, not its `eventId` field**: `OutboxAdminService.retry` looks the row up
  with `outboxRepo.findById(eventId)`, which queries `outboxEvent.findUnique({ where: { id } })`.
- `useProviderCredentials` (`apps/web/composables/useProviderCredentials.ts`) is the pattern for an approval-gated
  write: `isPendingAnswer(data)` checks `'permissionKey' in data` and the composable returns
  `{ kind: 'pending', request }` for a 202 summary. `ApprovalRequestSummary` is exported from
  `apps/web/lib/approval-requests.ts`.
- `useProjectRef(slug)` (`apps/web/composables/useProjectRef.ts`) resolves a slug to the project id with
  `GET /projects/:slug`; `load()` returns the id and throws on failure.
- `useProjectPermissions(slug)` and `useGlobalPermissions()` (`apps/web/composables/usePermissions.ts`) expose
  `permissions`, a computed `PermissionSet` with `has(key)` and `hasOwn(key)`.
- `ApiError` (`apps/web/composables/useApi.ts`) carries `code`; `extractApiError(err)` returns the message to toast.
- `apps/web/pages/admin/slos.vue` is the pattern for a global admin page (layout `default`, `adminOnly` state on a
  403, request sequencing with `latestRequestId`).
- Test helpers: `mountSfc` (`apps/web/tests/helpers/mount-sfc.ts`) mounts an SFC with stubbed globals;
  `uiStubs`, `i18nStub` and `enI18n` (`apps/web/tests/helpers/fleet-harness.ts`); `projectPermissionsStub` and
  `globalPermissionsStub` (`apps/web/tests/helpers/permission-nav.ts`).

Mutated symbols. The baseline is listed only to locate the code; implement the target.

- `useMemory(slug)` in `apps/web/composables/useMemory.ts`.
  Baseline: returns `{ items, isLoading, error, hasMore, kindFilter, statusFilter, textFilter, loadMemory,
  applyFilters, loadMore, ... }`.
  Target: additionally returns `retireDecision(id: string, reason?: string): Promise<RetireOutcome>` and
  `retireNote(id: string, projectId: string, reason?: string): Promise<RetireOutcome>`, where
  `RetireOutcome = { kind: 'retired' } | { kind: 'pending'; request: ApprovalRequestSummary }` is exported from
  the same file. The reason is sent trimmed; a reason that is empty after trimming is left out of the body.
- `apps/web/pages/[project]/memory.vue`.
  Baseline: a read-only table with columns subject, predicate, object, kind, confidence, status.
  Target: one more trailing column holding a Retire button (label `memory.retire.action`) on eligible rows, and a
  `MemoryRetireDialog` bound to the row being retired.
- `apps/web/layouts/default.vue`.
  Baseline: the Admin block lists Users, Roles, Approval policies, Audit, then the fleet links.
  Target: a computed `canReadOutbox = computed(() => globalPermissions.value.has('outbox.read'))` and an Outbox link
  (`/admin/outbox`, label `nav.outbox`) directly after the Audit link, shown when `canReadOutbox` is true;
  `showAdminNav` also turns true for `canReadOutbox` alone.
- `adminNavFlags` and `ADMIN_NAV_KEYS` in `apps/web/tests/helpers/permission-nav.ts`.
  Baseline: flags and keys for the ten existing admin links.
  Target: `ADMIN_NAV_KEYS` gains `'outbox.read'` after `'audit.read'`, and `adminNavFlags` returns
  `canReadOutbox: held.has('outbox.read')`.

New symbols:

- `apps/web/components/memory/MemoryRetireDialog.vue`: a Shadcn `Dialog` with an optional reason `Textarea`
  validated by a vee-validate + zod schema (`reason` at most 500 characters, message key
  `memory.retire.reasonTooLong`). Props `open: boolean`, `itemLabel: string`, `busy: boolean`. Emits
  `confirm(reason: string)` and `update:open(value: boolean)`. The confirm button (label `memory.retire.confirm`) is
  disabled while `busy` is true; the cancel button (label `common.cancel`) emits `update:open` with `false`.
- `apps/web/composables/useAdminOutbox.ts`: `useAdminOutbox()` returns `{ items, total, isLoading, error, status,
  load, retry }`. `status` is a ref with initial value `'dead'`. `load()` sends `GET /admin/outbox` with query
  `{ status: status.value }`. `retry(id: string): Promise<OutboxRetryOutcome>`, where `OutboxRetryOutcome =
  { kind: 'retried' } | { kind: 'pending'; request: ApprovalRequestSummary }` is exported from the same file.
- `apps/web/pages/admin/outbox.vue`: the Outbox page.

### Failure Handling

| Case | Behaviour |
| --- | --- |
| Retire POST rejected (403, 404, 409, 422, 400, network) | Toast `extractApiError(err)`; dialog stays open; list not reloaded |
| Retire answered 202 | Toast `memory.retire.pending`; dialog closes; list not reloaded |
| `GET /projects/:slug` fails while retiring a NOTE | Toast `extractApiError(err)`; no retire POST is sent |
| Retire reason over 500 characters | Inline zod message `memory.retire.reasonTooLong`; no `confirm` emitted |
| Outbox list GET rejects with `ApiError` code 403 | Page renders `outbox.adminOnly`; no toast |
| Outbox list GET fails otherwise | Toast `extractApiError(err)`; page renders `outbox.error` |
| Retry POST rejected (403, 404, 409, network) | Toast `extractApiError(err)`; list not reloaded |
| Retry answered 202 | Toast `outbox.retry.pending`; list not reloaded |

## Out of Scope

- Retiring memory items of kind FACT, PREFERENCE, CONSTRAINT or INCIDENT_PATTERN: the API has no route for it.
- Any change under `apps/api`, `apps/cli` or `apps/runner`: every route this feature calls already exists.
- Editing, recording or extracting memory from the web (`POST /memory`, `POST /memory/decisions`,
  `POST /memory/extract`).
- Hiding the DECISION or NOTE Retire button from a caller who lacks `memory.update`: the API's 403 is toasted
  instead.
- An AC pinning the order of the Outbox status options: the order is stated in Design only.
- Rendering an outbox event's `payload` or `headers`.
- Paging the outbox list past the API's 100-row cap.
- Bulk retry of several outbox events at once.
- Disabling a Retry button while its request is in flight.
- A Command Palette entry for the Outbox page.
- Project webhooks CRUD, knowledge-base import and evaluation, code-intel reindex and context query web UIs (the
  other W2 gaps found by the 2026-11-11 route audit).

## Stories

### US-001: Memory retire calls in useMemory

No dependencies. Workdir: `apps/web`.

Add `retireDecision` and `retireNote` to `useMemory`, each telling a 202 approval summary apart from a completed
retire by the `permissionKey` marker, and export `RetireOutcome`.

### US-002: Memory retire dialog

No dependencies. Workdir: `apps/web`.

Add `MemoryRetireDialog` with the optional reason field, its zod length check, the busy-disabled confirm button and
the cancel button. Add the `memory.retire.*` dialog keys to `en.json` and `zh.json`.

### US-003: Retire button visibility on the Memory page

Depends on US-001. Workdir: `apps/web`.

Add the trailing column to `memory.vue` with a Retire button on each `active` DECISION row when the project
permission set `has('memory.decision.retire')`, and on each `active` NOTE row when it `has('memory.create')` or
`hasOwn('memory.create')`. No other row gets the button. Add `memory.retire.action` to `en.json` and `zh.json`.
The page spec this story creates mounts the page with a `useProjectRef` double whose `load` resolves `null` (passed
through `mountSfc`'s `alias` for `~/composables/useProjectRef`), so the setup-time `useProjectRef` call US-004 adds
needs no change to it.

### US-004: Retire flow on the Memory page

Depends on US-001, US-002, US-003. Workdir: `apps/web`.

Clicking Retire opens `MemoryRetireDialog` for that row. Confirming a DECISION calls `retireDecision`; confirming a
NOTE first resolves the project id with `useProjectRef(slug).load()` and calls `retireNote`. Handle the retired,
pending and rejected outcomes as the Failure Handling table states. Add `memory.retire.done` and
`memory.retire.pending` to `en.json` and `zh.json`.

### US-005: Outbox admin page

No dependencies. Workdir: `apps/web`.

Add `useAdminOutbox` with `load` and the `status` filter, and the `/admin/outbox` page listing events for the chosen
status with the `outbox.showing` count, the `adminOnly` state on a 403 and the `outbox.error` state otherwise. Add
the `outbox.*` page keys to `en.json` and `zh.json`. The page spec this story creates mounts the page with
`useGlobalPermissions` stubbed by `globalPermissionsStub()` with no keys, so the Retry gate US-007 adds needs no
change to it.

### US-006: Outbox nav link

Depends on US-005. Workdir: `apps/web`.

Add `canReadOutbox` and the Outbox link to the Admin block of `layouts/default.vue`, directly after Audit, and let
`showAdminNav` turn true for it. Extend the shared test helper flags. Add `nav.outbox` to `en.json` and `zh.json`.

### US-007: Retry an outbox event

Depends on US-005. Workdir: `apps/web`.

Add `retry` to `useAdminOutbox` and a Retry button (label `outbox.retry.action`) on each `dead` or `pending` row
when the caller holds global `outbox.retry`. Retry posts the row's `id`. Handle the retried, pending and rejected
outcomes as the Failure Handling table states. Add `outbox.retry.*` keys to `en.json` and `zh.json`.

### Context Files

**US-001**

- `apps/web/composables/useMemory.ts`
- `apps/web/composables/useProviderCredentials.ts`
- `apps/web/lib/approval-requests.ts`
- `apps/web/tests/composables/useMemory.spec.ts`

**US-002**

- `apps/web/tests/components/add-skill-source-dialog.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/tests/helpers/fleet-harness.ts`

**US-003**

- `apps/web/pages/[project]/memory.vue`
- `apps/web/tests/pages/memory-mount.spec.ts`
- `apps/web/tests/pages/memory.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/tests/helpers/permission-nav.ts`

**US-004**

- `apps/web/pages/[project]/memory.vue`
- `apps/web/components/memory/MemoryRetireDialog.vue` — created by US-002, integrated here
- `apps/web/composables/useProjectRef.ts`
- `apps/web/tests/components/add-skill-source-dialog.spec.ts`
- `apps/web/tests/helpers/permission-nav.ts`
- `apps/web/tests/pages/memory-retire-visibility.spec.ts` — created by US-003, extended here

**US-005**

- `apps/web/pages/admin/slos.vue`
- `apps/web/tests/pages/admin-slos-mount.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/tests/components/add-skill-source-dialog.spec.ts`
- `apps/web/composables/useApi.ts`

**US-006**

- `apps/web/layouts/default.vue`
- `apps/web/tests/layouts/default-permission-nav.spec.ts`
- `apps/web/tests/helpers/permission-nav.ts`

**US-007**

- `apps/web/composables/useAdminOutbox.ts` — created by US-005, extended here
- `apps/web/pages/admin/outbox.vue` — created by US-005, extended here
- `apps/web/tests/pages/admin-outbox.spec.ts` — created by US-005, extended here
- `apps/web/tests/components/add-skill-source-dialog.spec.ts`

### Creates

**US-001**

- `apps/web/tests/composables/useMemory-retire.spec.ts`

**US-002**

- `apps/web/components/memory/MemoryRetireDialog.vue`
- `apps/web/tests/components/memory-retire-dialog.spec.ts`

**US-003**

- `apps/web/tests/pages/memory-retire-visibility.spec.ts`

**US-004**

- `apps/web/tests/pages/memory-retire-flow.spec.ts`

**US-005**

- `apps/web/composables/useAdminOutbox.ts`
- `apps/web/pages/admin/outbox.vue`
- `apps/web/tests/composables/useAdminOutbox.spec.ts`
- `apps/web/tests/pages/admin-outbox.spec.ts`

**US-007**

- `apps/web/tests/composables/useAdminOutbox-retry.spec.ts`
- `apps/web/tests/pages/admin-outbox-retry.spec.ts`

### Modifies

**US-003**

- `apps/web/tests/pages/memory-mount.spec.ts` — the sandbox that runs `memory.vue`'s script provides only the globals the read-only page called; the page now also calls `useProjectPermissions`, so the sandbox stubs it with an empty `PermissionSet`. Every existing assertion stays as it is.
- `apps/web/tests/pages/memory.spec.ts` — `createRenderContext()` is a closed, hand-built binding set that SSR-renders the real `memory.vue` template; the template now calls `canRetire(item)` for each row, so the context gains `canRetire` returning `false` (no row eligible). Every existing assertion stays as it is.

**US-004**

- `apps/web/tests/pages/memory-mount.spec.ts` — the page now also calls `useProjectRef`, so the sandbox stubs it with a `load` resolving `null`. Every existing assertion stays as it is.
- `apps/web/tests/pages/memory.spec.ts` — the template now binds `retireTarget`, `retireBusy`, `openRetire` and `confirmRetire`, so `createRenderContext()` gains them with inert defaults (`retireTarget` `null`, `retireBusy` `false`, no-op handlers). Every existing assertion stays as it is.

**US-006**

- `apps/web/tests/layouts/default-permission-nav.spec.ts` — the `ADMIN_LINKS` table gains a row pairing the href /admin/outbox with the key outbox.read so the existing every-link and no-link tests cover the new link, and a describe block holds this story's ACs. Every existing assertion stays as it is.
- `apps/web/tests/helpers/permission-nav.ts` — `ADMIN_NAV_KEYS` gains `'outbox.read'` after `'audit.read'` and `adminNavFlags` returns `canReadOutbox`, so the fleet, skills and flows nav specs that spread `adminNavFlags` keep a complete binding set for the layout. Existing keys and flags stay as they are.

### Seams

- US-004 calls `retireDecision` and `retireNote` (US-001) and mounts `MemoryRetireDialog` (US-002). Its ACs click
  Retire on the mounted Memory page and assert the POST, so both call sites are proven at the page entry point.
- US-007 extends `useAdminOutbox` (US-005) with `retry`; its page ACs click Retry on the mounted `/admin/outbox`
  page and assert the POST.
- US-006 links to the page US-005 creates; its ACs assert the link's `href`.

## Acceptance Criteria

### US-001

1. [unit] `useMemory('sb').retireDecision('m1', 'obsolete')` sends `POST /memory/m1/retire` with body
   `{ reason: 'obsolete' }`.
2. [unit] `useMemory('sb').retireDecision('m1', '   ')` sends `POST /memory/m1/retire` with body `{}`.
3. [unit] `useMemory('sb').retireNote('n1', 'p1', 'dup')` sends `POST /memory/notes/n1/retire` with body
   `{ projectId: 'p1', reason: 'dup' }`.
4. [unit] `useMemory('sb').retireNote('n1', 'p1', '')` sends `POST /memory/notes/n1/retire` with body
   `{ projectId: 'p1' }`.
5. [unit] `retireDecision` resolves `{ kind: 'retired' }` when the POST answers an item with no `permissionKey`
   field.
6. [unit] `retireNote` resolves `{ kind: 'pending', request }` with `request` equal to the answer when the POST
   answers an object that has a `permissionKey` field.
7. [unit] `retireDecision` rejects with the same error when the POST rejects.

### US-002

1. [unit] Mounting `MemoryRetireDialog` with `open: true`, typing `obsolete` into the reason field and clicking the
   `memory.retire.confirm` button emits `confirm` with `'obsolete'`.
2. [unit] Mounting `MemoryRetireDialog` with a 501-character reason and clicking `memory.retire.confirm` renders the
   `memory.retire.reasonTooLong` text.
3. [unit] Mounting `MemoryRetireDialog` with a 501-character reason and clicking `memory.retire.confirm` emits no
   `confirm` event.
4. [unit] Mounting `MemoryRetireDialog` with `busy: true` renders the `memory.retire.confirm` button disabled.
5. [unit] Clicking the `common.cancel` button in `MemoryRetireDialog` emits `update:open` with `false`.
6. [unit] Typing `old` into the reason field, setting `open` to `false` and then back to `true` renders the reason
   field empty.

### US-003

1. [integration] Mounting `/[project]/memory` with an `active` `DECISION` row and a project permission set holding
   `memory.decision.retire` renders a `memory.retire.action` button in that row.
2. [integration] Mounting the Memory page with an `active` `DECISION` row and a permission set without
   `memory.decision.retire` renders no `memory.retire.action` button in that row.
3. [integration] Mounting the Memory page with an `active` `NOTE` row and a permission set whose `hasOwn('memory.create')`
   is true and `has('memory.create')` is false renders a `memory.retire.action` button in that row.
4. [integration] Mounting the Memory page with an `active` `FACT` row and every memory permission granted renders no
   `memory.retire.action` button in that row.
5. [integration] Mounting the Memory page with a `superseded` `DECISION` row and every memory permission granted
   renders no `memory.retire.action` button in that row.

### US-004

1. [integration] On the Memory page, clicking `memory.retire.action` on `DECISION` row `m1` and confirming the dialog
   with reason `obsolete` sends `POST /memory/m1/retire` with body `{ reason: 'obsolete' }`.
2. [integration] On the Memory page for slug `sb`, clicking `memory.retire.action` on `NOTE` row `n1` and confirming
   sends `POST /memory/notes/n1/retire` with `projectId` equal to the `id` that `GET /projects/sb` answered.
3. [integration] When `GET /projects/sb` rejects during a `NOTE` retire, the page calls `toast.error` with the
   `extractApiError` text of that rejection.
4. [integration] When `GET /projects/sb` rejects during a `NOTE` retire, the page sends no
   `POST /memory/notes/n1/retire`.
5. [integration] When the retire POST answers an item with no `permissionKey`, the page calls `toast.success` with
   `memory.retire.done`.
6. [integration] On the Memory page after "Load more" fetched page 2, a retire whose POST answers an item with no
   `permissionKey` sends `GET /projects/sb/memory` without a `current` query parameter (page 1, through
   `applyFilters`).
7. [integration] When the retire POST answers an object with a `permissionKey` field, the page calls the toast with
   `memory.retire.pending`.
8. [integration] When the retire POST answers an object with a `permissionKey` field, the page sends no further
   `GET /projects/sb/memory`.
9. [integration] When the retire POST answers an object with a `permissionKey` field, the `memory.retire.confirm`
   button is no longer rendered (the dialog closed).
10. [integration] When the retire POST rejects with an `ApiError` whose message is `Decision is not active`, the page
    calls `toast.error` with `Decision is not active`.
11. [integration] When the retire POST rejects, the `memory.retire.confirm` button is still rendered (the dialog
    stays open).
12. [integration] When the retire POST rejects, the page sends no further `GET /projects/sb/memory`.
13. [integration] When the retire POST answers an item with no `permissionKey`, the `memory.retire.confirm` button
    is no longer rendered (the dialog closed).
14. [integration] While the retire POST has not yet settled, the `memory.retire.confirm` button is disabled.

### US-005

1. [unit] `useAdminOutbox().load()` with the initial `status` sends `GET /admin/outbox` with query
   `{ status: 'dead' }`.
2. [unit] After `load()` receives `{ items: [row], total: 7 }`, `items.value` equals `[row]`.
3. [unit] After `load()` receives `{ items: [row], total: 7 }`, `total.value` equals `7`.
4. [integration] Changing the status select on `/admin/outbox` to `pending` sends `GET /admin/outbox` with query
   `{ status: 'pending' }`.
5. [integration] A listed row renders the event's `type` text.
6. [integration] A listed row renders the event's `eventId` text.
7. [integration] A listed row renders the event's `attempts` count.
8. [integration] A listed row renders the event's `lastError` text.
9. [integration] A listed row whose `payload` is `'{"secret":"s3"}'` renders no `s3` text anywhere on the page.
10. [integration] With 2 rows listed and `total` 7, the page rendered with the en locale shows `Showing 2 of 7`.
11. [integration] When `GET /admin/outbox` rejects with an `ApiError` whose `code` is 403, the page renders the
    `outbox.adminOnly` text.
12. [integration] When `GET /admin/outbox` rejects with an `ApiError` whose `code` is 403, the page does not call
    `toast.error`.
13. [integration] When `GET /admin/outbox` rejects with an `ApiError` whose `code` is 500, the page calls
    `toast.error` with that error's `extractApiError` text.
14. [integration] When `GET /admin/outbox` rejects with an `ApiError` whose `code` is 500, the page renders the
    `outbox.error` text.

### US-006

1. [integration] The default layout rendered with global permission `outbox.read` shows a link to `/admin/outbox`
   labelled `nav.outbox`.
2. [integration] The default layout rendered without `outbox.read` shows no link to `/admin/outbox`.
3. [integration] The default layout whose only global permission is `outbox.read` shows the `nav.sectionAdmin`
   label.
4. [integration] The default layout rendered with `audit.read`, `outbox.read` and `fleet.dashboard.read` places the
   `/admin/outbox` link after the `/admin/audit` link and before the `/admin/fleet` link.

### US-007

1. [unit] `useAdminOutbox().retry('row-1')` sends `POST /admin/outbox/row-1/retry`.
2. [unit] `retry` resolves `{ kind: 'retried' }` when the POST answers an empty body.
3. [unit] `retry` resolves `{ kind: 'pending', request }` with `request` equal to the answer when the POST answers
   an object that has a `permissionKey` field.
4. [integration] On `/admin/outbox` with global `outbox.retry`, a `dead` row renders an `outbox.retry.action` button.
5. [integration] On `/admin/outbox` with global `outbox.retry` and the status filter set to `pending`, a `pending`
   row renders an `outbox.retry.action` button.
6. [integration] On `/admin/outbox` without `outbox.retry`, a `dead` row renders no `outbox.retry.action` button.
7. [integration] On `/admin/outbox` with `outbox.retry` and the status filter set to `published`, a `published` row
   renders no `outbox.retry.action` button.
8. [integration] Clicking `outbox.retry.action` on a row with `id` `row-1` and `eventId` `evt-9` sends
   `POST /admin/outbox/row-1/retry`.
9. [integration] When the retry POST answers an empty body, the page calls `toast.success` with
    `outbox.retry.done`.
10. [integration] When the retry POST answers an empty body, the page sends `GET /admin/outbox` again with query
    `{ status: 'dead' }` (the current status).
11. [integration] When the retry POST answers an object with a `permissionKey` field, the page calls the toast with
    `outbox.retry.pending`.
12. [integration] When the retry POST answers an object with a `permissionKey` field, the page sends no further
    `GET /admin/outbox`.
13. [integration] When the retry POST rejects with an `ApiError` whose message is
    `Outbox event is processing; only dead or pending events can be retried`, the page calls `toast.error` with that
    message.
14. [integration] When the retry POST rejects, the page sends no further `GET /admin/outbox`.
