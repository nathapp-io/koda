# SPEC: Fleet flow start form

## Summary

A published REPO thread gets a **Start flow** button and a **pre-approval card** on its page (fleet flow design G2
thread entry and G4). Start flow opens a dialog that lists the feature specs the thread published (editable: add,
remove, rename, spec path, dependencies), the reviewer and supervisor role models and a cost cap, and posts it to the
existing `POST /api/projects/:slug/threads/:id/flows`. The pre-approval card lets a human with
`fleet.thread.preapprove` set or clear the thread's one-flow auto-approve tick and its cost cap through the existing
`PUT|DELETE /api/projects/:slug/threads/:id/preapproval`. The API already serves both; this feature is web only.

## Motivation

Every fleet flow so far (flows 6 to 14) was started by hand with `curl` against the API, with a hand-written JSON
body, and approved through a second API call. F1 (`fleet-flow-record`) built the thread entry route and the
pre-approval routes, and F6 (`fleet-flow-page`) built the pages that read and act on an existing flow, but no screen
creates a flow or sets the tick. The F6 spec recorded both as a separate feature. Without them the flow is not usable
from koda's web app, which is where a brainstorm thread publishes its spec set.

## Design

### Calls made while drafting (not user rulings)

- **Web only.** The thread DTO already carries `kind`, `feature`, `specPath`, `backend`, `archivedAt`, `createdById`,
  `publishedSha`, `specPublished`, `preApproval` and `lastWrite`; the two routes already exist and are approval-gated.
  No API, DTO or migration change.
- **Feature prefill.** `writtenPaths` is cleared by every publish (`thread-write-fold.ts`), so it cannot list the
  published specs. The rows come from the thread's own feature (`feature` + `specPath`) first, then each
  `.nax/features/<name>/spec.md` path in `lastWrite.paths` (only when `lastWrite.kind === 'published'`) whose `<name>`
  is not already a row, in path order. Specs published by an earlier publish are not listed; the user adds them as
  rows by hand. The API stays the authority on whether a spec path is real.
- **Dependency prefill.** The design says to prefill dependencies from the design doc when it declares them; the web
  cannot read the doc's content, so each prefilled row after the first depends on the row before it (the safe
  default: no later feature starts before the earlier PR merges). The user edits them in the dialog.
- **Role defaults.** Both roles default to the thread's `backend.model` when the backend is `native` and has a model,
  else empty (the user types a model id). Role inputs are free text checked against the API's role pattern.
- **Cap default.** The tick's cap when the thread has a tick, else 5 (the thread handoff default).
- **Tick hint.** The dialog tells the user whether this flow will start without asking: the API's rule
  (`coversFlow`) is that the flow's creator is the tick's user or the thread's creator, and the tick's cap is at least
  the flow's cap. `tickHint` returns one of four outcomes, checked in this order: `none` (no tick), `notYours` (the
  viewer is neither the tick's user nor the thread's creator, whatever the cap), `exceeded` (the cap is above the
  tick's cap), `covers`. The hint is advisory; the API decides. When `useAuth().user` is null the viewer id is `''`,
  which no tick or thread creator matches.
- **Feature names.** The schema also refuses a name containing `..` (as `fleet-dispatch.ts` does), although the
  API's `FEATURE_RE` alone would accept it: git refuses the branch `feat/<a..b>`.
- **Dependencies follow renames.** Dependencies are stored by feature name, so renaming a row rewrites that name in
  every later row's `dependsOn`, and removing a row drops it from them.
- **Checkboxes.** `components/ui/` has no Shadcn checkbox; the dependency checkboxes are native
  `<input type="checkbox">`, as `ApprovalPolicyDialog.vue` does.
- **Money.** The pre-approval cap arrives as a 4-place string and is shown with `usd()` from
  `lib/fleet-analytics-format.ts`, never re-rounded (web context rule A7).
- **Form errors.** The form shows the first zod issue only, in schema order: rows (top to bottom), then reviewer,
  supervisor, cap. The duplicate-name and `dependsOn` checks are refinements on the `features` array (not the root
  object), so an invalid role or cap never hides them.
- **Form values.** `FlowStartFormValues = { features: FlowStartRow[]; roles: { reviewer: string; supervisor: string };
  costCapUsd: number | string }`. The schema trims feature names, spec paths and roles (`z.string().trim()`) before
  every other check, so duplicate and `dependsOn` checks compare trimmed names; it coerces the cap with `Number()` and
  checks at most four decimals as `Math.round(x * 10000) / 10000 === x`. `toFlowStartBody` takes the schema's parsed
  output and does not trim again.
- **Composable imports.** Components import `useFleetFlows` and `useThreadPreApproval` explicitly from
  `~/composables/...` (as `ThreadFlowsPanel.vue` does), because the Jest mount harness injects only its fixed
  auto-import list; tests supply them through the mount `alias`. Composable paths are built with `apiPath`
  (`lib/api-path.ts`), which the `api-path-guard` test enforces.
- **Start flow availability.** Shown on a REPO thread that is not archived when the viewer holds `fleet.flow.create`.
  Disabled with a reason when the thread has no published spec (`specPublished` false or `publishedSha` null) or when
  the thread has a live flow (listed through `useFleetFlows().list(1, threadId)` when the viewer holds
  `fleet.flow.read`; without that key the check is skipped and the API's 409 is shown). Only the first page (20
  flows, newest first) is read; the API's `fleet.flows.threadBusy` 409 is the backstop.
- **After submit.** A created flow (state `PENDING` or `APPROVED`) navigates to `/:project/flows/:id`; the flow page
  already links pending flows to the approvals page. An approval-gated route answer (the `fleet.flow.create` route
  itself needs approval) shows the `fleet.flows.toast.approvalRequested` toast and a link to `/:project/approvals`.
- **Pre-approval card.** Shown on a REPO thread that is not archived when the viewer holds `fleet.thread.preapprove`.
  With a tick it shows the cap and the local date-time the tick was set, and a Clear button; without one, a cap input
  and a Set button. A done write reloads the thread; a pending write shows the approval toast.

### Integration

Read-only symbols (verified on `main` `f0032aae`):

- `apps/web/lib/thread-types.ts`: `ThreadDto` (`kind`, `feature`, `specPath`, `backend: ThreadBackend`,
  `archivedAt`, `createdById`, `publishedSha`, `specPublished`, `lastWrite: ThreadWriteResult | null`),
  `ThreadDetailDto extends ThreadDto`, `ThreadWriteResult` (`{ kind: 'published'; ...; paths: string[] }` among
  others), `ThreadBackend` (`{ kind: 'native'; model?: string } | { kind: 'acp'; ...; model?: string }`).
- `apps/web/lib/fleet-dispatch.ts`: `FEATURE_RE` (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`).
- `apps/web/lib/fleet-flows.ts`: `FleetFlowDto`, `isLiveFlow(state)`, `isPendingFlowAnswer(data)`.
- `apps/web/lib/approval-requests.ts`: `ApprovalRequestSummary`.
- `apps/web/composables/useApi.ts`: `useApi().$api.post|put|delete`, `extractApiError`.
- `apps/web/lib/thread-handoff-form.ts` and `components/fleet/threads/ThreadHandoffDialog.vue`: the zod +
  vee-validate dialog pattern to mirror (schema builder taking `t`, defaults, values-to-body function).
- `apps/web/components/fleet/threads/ThreadFlowsPanel.vue`: the permission-watch pattern for a late
  `fleet.flow.read` grant.
- API contract (unchanged): `POST /api/projects/:slug/threads/:id/flows` body
  `{ features: [{ feature, specPath, dependsOn?: string[] }] (1..20), roles: { reviewer, supervisor },
  costCapUsd: number | string }`; features unique by name, `dependsOn` names only earlier features, `specPath`
  relative, ends `.md`, no `..`, at most 300 chars; roles match `/^[A-Za-z0-9._:/\x5b\x5d=,-]{1,200}$/`;
  `costCapUsd` > 0, <= 1000, at most 4 decimals. Answers 201 with `FleetFlowDto`, or the approval request summary
  when the route itself is gated. `PUT .../preapproval` body `{ costCapUsd }` (same cap rules) answers the
  `{ userId, at, costCapUsd }` tick; `DELETE .../preapproval` answers `{ cleared: true }`; both may answer an
  approval request summary instead.

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `ThreadDto` in `apps/web/lib/thread-types.ts`.
  Baseline: no `preApproval` field.
  Target: `preApproval: ThreadPreApproval | null`, with the new exported
  `interface ThreadPreApproval { userId: string; at: string; costCapUsd: string }`.
- `useFleetFlows(slug)` in `apps/web/composables/useFleetFlows.ts`.
  Baseline: returns `{ list, get, overview, stop, answer }`.
  Target: also returns `createFromThread(threadId: string, body: FlowStartBody): Promise<FlowWrite>`.
- `pages/[project]/threads/[id].vue`.
  Baseline: mounts `FleetThreadsThreadFlowsPanel` after the header.
  Target: also mounts `FleetThreadsThreadStartFlow` and `FleetThreadsThreadPreApprovalCard` after the flows panel.

New modules:

- `apps/web/lib/fleet-flow-start.ts` (pure, no Vue imports):
  - `FLOW_SPEC_PATH_RE = /^\.nax\/features\/([^/]+)\/spec\.md$/`
  - `interface FlowStartRow { feature: string; specPath: string; dependsOn: string[] }`
  - `flowStartRows(thread: ThreadDto): FlowStartRow[]`
  - `type FlowStartBlock = 'notPublished' | 'flowLive'`
  - `flowStartState(thread: ThreadDto, opts: { canCreate: boolean; liveFlow: boolean }): { visible: boolean;
    enabled: boolean; reason: FlowStartBlock | null }`
- `apps/web/lib/fleet-flow-start-defaults.ts` (pure, no Vue imports):
  - `defaultFlowRoles(thread: ThreadDto): { reviewer: string; supervisor: string }`
  - `type TickHint = 'none' | 'notYours' | 'exceeded' | 'covers'`
  - `tickHint(tick: ThreadPreApproval | null, costCapUsd: number, viewer: { userId: string; isThreadCreator: boolean }): TickHint`
- `apps/web/lib/fleet-flow-start-form.ts`:
  - `FLOW_MAX_FEATURES = 20`, `FLOW_COST_CAP_MAX_USD = 1000`, `FLOW_ROLE_RE` (the API role pattern),
    `FLOW_SPEC_PATH_MAX = 300`
  - `buildFlowStartSchema(t)` (zod), `type FlowStartFormValues`, `buildPreApprovalSchema(t)`
- `apps/web/lib/fleet-flow-start-body.ts`:
  - `interface FlowStartBody { features: { feature: string; specPath: string; dependsOn: string[] }[];
    roles: { reviewer: string; supervisor: string }; costCapUsd: number }`
  - `toFlowStartBody(values: FlowStartFormValues): FlowStartBody`
- `apps/web/composables/useThreadPreApproval.ts`: `useThreadPreApproval(slug)` returning
  `set(threadId, costCapUsd: number): Promise<PreApprovalWrite>` and `clear(threadId): Promise<PreApprovalWrite>`,
  `type PreApprovalWrite = { kind: 'done' } | { kind: 'pending'; request: ApprovalRequestSummary }`.
- `apps/web/components/fleet/threads/ThreadStartFlowDialog.vue`, `ThreadStartFlow.vue`, `ThreadPreApprovalCard.vue`.

`tickHint` compares caps as integers of ten-thousandths (`Math.round(x * 10000)`), never as raw floats.

### Failure Handling

| Case | Behaviour |
|---|---|
| Create route answers an error (400 invalid input, 403, 404, 409 `threadBusy`, `notPublished`, `runnerMissing`, `disabled`, `archived`) | Toast `extractApiError(error)`; the dialog stays open with the values kept. |
| Create route answers an approval request summary | Toast `fleet.flows.toast.approvalRequested`, close the dialog, show a link to `/:project/approvals`. |
| Live-flow list read fails | Treat as no live flow (the API's 409 still guards); no toast. |
| Pre-approval set/clear answers an error | Toast `extractApiError(error)`; the card keeps its state. |
| Pre-approval set/clear answers an approval request summary | Toast `fleet.flows.toast.approvalRequested`; the thread is not reloaded. |
| Form value invalid (feature name, duplicate name, spec path, dependency, role, cap) | Show the first issue's i18n message under the form; nothing is sent. |

## Out of Scope

- Any API, DTO, OpenAPI or migration change; the thread entry and pre-approval routes are used as they are.
- Reading the design doc to prefill feature dependencies; prefilled rows depend on the row before them and the user edits them.
- Listing specs from publishes before the thread's last publish; the user adds those rows by hand.
- Starting a flow from a PROJECT or WORKSPACE thread, or from the nax entry (`POST /api/fleet/flows`).
- A model picker sourced from runner-advertised models for the role inputs; roles are free text.
- Project-wide auto-approve; the tick is per thread (user ruling 4).
- Reordering feature rows by drag and drop; rows are added at the end and removed individually.
- Playwright end-to-end tests for the start form; component and page tests cover it.
- Showing the tick setter's name instead of the cap and date; the card does not resolve user ids.
- US-003 only: no acceptance criterion pins the 300-character spec path limit or a zero or negative flow cap; the schema enforces both and the API refuses them.
- US-009 only: no acceptance criterion pins that the dialog keeps its field values after a failed create; it stays open and mounted, so its form state is not reset.

## Stories

Eleven stories, one capability: starting a flow from a published thread, with the thread's one-flow pre-approval.
The start form and the pre-approval card share the thread page, the locale files and the composable story.

### US-001: Flow start rows and availability

No dependencies. Workdir: `apps/web`.

`ThreadDto` gains `preApproval: ThreadPreApproval | null`. New pure module `lib/fleet-flow-start.ts` with
`FLOW_SPEC_PATH_RE`, `FlowStartRow`, `flowStartRows`, `FlowStartBlock` and `flowStartState`, as in Design. Tests in
`tests/lib/fleet-flow-start.spec.ts`.

### US-002: Flow start defaults and tick hint

Depends on US-001. Workdir: `apps/web`.

New pure module `lib/fleet-flow-start-defaults.ts` with `defaultFlowRoles`, `TickHint` and `tickHint`, as in Design
(outcomes checked in the order `none`, `notYours`, `exceeded`, `covers`). `tickHint` takes the `ThreadPreApproval`
type US-001 adds. Tests in `tests/lib/fleet-flow-start-defaults.spec.ts`.

### US-003: Flow start form schema

No dependencies. Workdir: `apps/web`.

New module `lib/fleet-flow-start-form.ts` with `FLOW_MAX_FEATURES`, `FLOW_COST_CAP_MAX_USD`, `FLOW_ROLE_RE`,
`FLOW_SPEC_PATH_MAX`, `buildFlowStartSchema(t)`, `FlowStartFormValues` and `buildPreApprovalSchema(t)` (a
`{ costCapUsd }` object with the same cap rule and the message key `fleet.flows.preapproval.validation`), mirroring
`lib/thread-handoff-form.ts`. Issues are reported in schema order: rows top to bottom, then reviewer, supervisor, cap.
The schema trims strings and coerces the cap as in Design; the duplicate-name and `dependsOn` checks are
refinements on the `features` array. Validation messages are i18n keys under `fleet.flows.start.validation` and
`fleet.flows.preapproval.validation`.
Tests in `tests/lib/fleet-flow-start-form.spec.ts`.

### US-004: Flow start request body

Depends on US-003. Workdir: `apps/web`.

New module `lib/fleet-flow-start-body.ts` with `FlowStartBody` and `toFlowStartBody(values: FlowStartFormValues)` over
the schema's parsed (already trimmed) output: it sends `costCapUsd` as a number and every row's `dependsOn` as a new
array, without mutating its input. Tests in `tests/lib/fleet-flow-start-body.spec.ts`.

### US-005: Flow start and pre-approval composables

Depends on US-004. Workdir: `apps/web`.

`useFleetFlows(slug)` gains `createFromThread(threadId, body: FlowStartBody)` posting (path built with `apiPath`) to
`/projects/:slug/threads/:threadId/flows` and mapping the answer with the existing `write` helper. New composable
`composables/useThreadPreApproval.ts` with `set` (PUT) and `clear` (DELETE) on
`/projects/:slug/threads/:threadId/preapproval`, mapping an answer that carries `permissionKey`
(`isPendingFlowAnswer`) to `{ kind: 'pending', request }` and any other answer to `{ kind: 'done' }`. Tests in
`tests/composables/useFleetFlows.spec.ts` and `tests/composables/useThreadPreApproval.spec.ts`.

### US-006: Start flow dialog rows

Depends on US-001, US-003. Workdir: `apps/web`.

New `components/fleet/threads/ThreadStartFlowDialog.vue` (Shadcn `Dialog`, vee-validate + zod with
`buildFlowStartSchema`). Props: `open`, `thread: ThreadDetailDto`, `viewerId: string`; emits `update:open` and
`submit`. On each open it fills the rows from `flowStartRows(thread)`. Each row has feature and spec path inputs, one
native checkbox per earlier row's feature for `dependsOn`, and a remove button; an add-row button appends an empty row
with no dependencies. Renaming a row rewrites that name in later rows' `dependsOn`; removing a row drops it from them.
This story builds the rows part of the dialog; US-007 adds the roles, cap, hint and submit to the same component.
Tests in `tests/components/thread-start-flow-dialog.spec.ts`.

### US-007: Start flow dialog defaults, hint and submit

Depends on US-002, US-004, US-006. Workdir: `apps/web`.

`ThreadStartFlowDialog.vue` (created by US-006) gains the reviewer and supervisor inputs filled from
`defaultFlowRoles(thread)`, the cap input filled with the tick's cap or `5`, and a hint rendering the
`fleet.flows.start.tick.<outcome>` text for `tickHint(thread.preApproval, cap, { userId: viewerId, isThreadCreator:
thread.createdById === viewerId })`. Submit validates with `buildFlowStartSchema`, shows the first issue's message in
an alert (cleared on the next edit), and on success emits `submit` with `toFlowStartBody(values)`. Tests in
`tests/components/thread-start-flow-dialog-submit.spec.ts`.

### US-008: Start flow button availability

Depends on US-001. Workdir: `apps/web`.

New `components/fleet/threads/ThreadStartFlow.vue` (props `slug`, `thread`): reads `fleet.flow.create` and
`fleet.flow.read` from `useProjectPermissions(slug)`, lists the thread's flows with
`useFleetFlows(slug).list(1, thread.id)` (imported explicitly from `~/composables/useFleetFlows`, as
`ThreadFlowsPanel.vue` does) when `fleet.flow.read` is held (re-checked on a late grant, as
`ThreadFlowsPanel` does; a failed list counts as no live flow, with no toast), and renders the Start flow button and
its blocked reason from `flowStartState` (`liveFlow` is true when a listed flow's state passes `isLiveFlow`). Tests in
`tests/components/thread-start-flow.spec.ts`.

### US-009: Start flow submit and page mount

Depends on US-005, US-007, US-008. Workdir: `apps/web`.

`ThreadStartFlow.vue` (created by US-008) opens `ThreadStartFlowDialog` on click with `thread`, `open` and
`viewerId` (`useAuth().user.value?.id ?? ''`), and on `submit` calls `createFromThread(thread.id, body)` once per
submit (a submit while one is in flight is ignored): done navigates with `navigateTo('/<slug>/flows/<id>')`; pending
closes the dialog, toasts `fleet.flows.toast.approvalRequested` and renders a link to `/<slug>/approvals`; an error
toasts `extractApiError(error)` and keeps the dialog open. The thread page mounts it after
`FleetThreadsThreadFlowsPanel`. Tests in `tests/components/thread-start-flow-submit.spec.ts`; the thread page tests
gain a stub for it.

### US-010: Pre-approval card display

Depends on US-001. Workdir: `apps/web`.

New `components/fleet/threads/ThreadPreApprovalCard.vue` (props `slug`, `thread`; emits `changed`): visible on a REPO
thread that is not archived when the viewer holds `fleet.thread.preapprove`. With a tick it shows the cap with
`usd(tick.costCapUsd)`, the set time as `new Date(tick.at).toLocaleString()` and a Clear button; without one, a cap
input and a Set button. Tests in `tests/components/thread-preapproval-card.spec.ts`.

### US-011: Pre-approval card actions and page mount

Depends on US-003, US-005, US-009, US-010. Workdir: `apps/web`.

`ThreadPreApprovalCard.vue` (created by US-010) validates the cap with `buildPreApprovalSchema` and calls
(imported explicitly from `~/composables/useThreadPreApproval`) `useThreadPreApproval(slug).set(thread.id, cap)` on Set and `clear(thread.id)` on Clear, ignoring clicks while a
write is in flight. A done write emits `changed`; pending toasts `fleet.flows.toast.approvalRequested`; an error
toasts `extractApiError(error)`; neither emits `changed`. The thread page mounts it after
`FleetThreadsThreadStartFlow` and calls `controller.reloadThread()` on `changed`. Tests in
`tests/components/thread-preapproval-card-actions.spec.ts`; the thread page tests gain a stub for it.

### Context Files

**US-001**
- `apps/web/lib/thread-types.ts`
- `apps/web/lib/thread-handoff.ts`
- `apps/web/tests/lib/thread-handoff.spec.ts`

**US-002**
- `apps/web/lib/thread-types.ts`
- `apps/api/src/fleet/flows/fleet-flows.service.ts`

**US-003**
- `apps/web/lib/thread-handoff-form.ts`
- `apps/web/lib/fleet-dispatch.ts`
- `apps/web/tests/lib/thread-handoff-form.spec.ts`
- `apps/api/src/fleet/flows/flow-input.ts`

**US-004**
- `apps/web/lib/thread-handoff-form.ts`
- `apps/web/lib/fleet-flow-start-form.ts` — created by US-003, consumed here

**US-005**
- `apps/web/composables/useApi.ts`
- `apps/web/lib/api-path.ts`
- `apps/web/lib/fleet-flows.ts`
- `apps/web/lib/fleet-flow-start-body.ts` — created by US-004, consumed here

**US-006**
- `apps/web/components/fleet/threads/ThreadHandoffDialog.vue`
- `apps/web/components/approvals/ApprovalPolicyDialog.vue`
- `apps/web/tests/components/thread-action-bar.spec.ts`
- `apps/web/lib/fleet-flow-start.ts` — created by US-001, consumed here
- `apps/web/lib/fleet-flow-start-form.ts` — created by US-003, consumed here

**US-007**
- `apps/web/components/fleet/threads/ThreadStartFlowDialog.vue` — created by US-006, extended here
- `apps/web/lib/fleet-flow-start-defaults.ts` — created by US-002, consumed here
- `apps/web/lib/fleet-flow-start-body.ts` — created by US-004, consumed here
- `apps/web/tests/helpers/fleet-harness.ts`

**US-008**
- `apps/web/components/fleet/threads/ThreadFlowsPanel.vue`
- `apps/web/tests/components/thread-flows-panel.spec.ts`
- `apps/web/lib/fleet-flows.ts`
- `apps/web/lib/fleet-flow-start.ts` — created by US-001, consumed here

**US-009**
- `apps/web/components/fleet/threads/ThreadStartFlow.vue` — created by US-008, extended here
- `apps/web/components/fleet/flows/FlowAnswerForm.vue`
- `apps/web/composables/useFleetFlows.ts`
- `apps/web/tests/pages/threads-detail-page.spec.ts`

**US-010**
- `apps/web/components/fleet/threads/ThreadControls.vue`
- `apps/web/lib/fleet-analytics-format.ts`
- `apps/web/tests/helpers/fleet-harness.ts`

**US-011**
- `apps/web/components/fleet/threads/ThreadPreApprovalCard.vue` — created by US-010, extended here
- `apps/web/composables/useThreadPreApproval.ts` — created by US-005, consumed here
- `apps/web/lib/fleet-flow-start-form.ts` — created by US-003, consumed here
- `apps/web/tests/pages/threads-detail-page.spec.ts`

### Creates

**US-001**
- `apps/web/lib/fleet-flow-start.ts`
- `apps/web/tests/lib/fleet-flow-start.spec.ts`

**US-002**
- `apps/web/lib/fleet-flow-start-defaults.ts`
- `apps/web/tests/lib/fleet-flow-start-defaults.spec.ts`

**US-003**
- `apps/web/lib/fleet-flow-start-form.ts`
- `apps/web/tests/lib/fleet-flow-start-form.spec.ts`

**US-004**
- `apps/web/lib/fleet-flow-start-body.ts`
- `apps/web/tests/lib/fleet-flow-start-body.spec.ts`

**US-005**
- `apps/web/composables/useThreadPreApproval.ts`
- `apps/web/tests/composables/useThreadPreApproval.spec.ts`

**US-006**
- `apps/web/components/fleet/threads/ThreadStartFlowDialog.vue`
- `apps/web/tests/components/thread-start-flow-dialog.spec.ts`

**US-007**
- `apps/web/tests/components/thread-start-flow-dialog-submit.spec.ts`

**US-008**
- `apps/web/components/fleet/threads/ThreadStartFlow.vue`
- `apps/web/tests/components/thread-start-flow.spec.ts`

**US-009**
- `apps/web/tests/components/thread-start-flow-submit.spec.ts`

**US-010**
- `apps/web/components/fleet/threads/ThreadPreApprovalCard.vue`
- `apps/web/tests/components/thread-preapproval-card.spec.ts`

**US-011**
- `apps/web/tests/components/thread-preapproval-card-actions.spec.ts`

### Modifies

**US-001**
- `apps/web/lib/thread-types.ts` — `ThreadDto` gains `preApproval: ThreadPreApproval | null` and the file exports the new `ThreadPreApproval` interface; existing fields are unchanged.

**US-002**
None. US-002 only creates `lib/fleet-flow-start-defaults.ts` and its test; it changes no existing file.

**US-003**
- `apps/web/i18n/locales/en.json` — gains the `fleet.flows.start.validation` keys (feature, featureDuplicate, specPath, dependsOn, featuresCount, role, costCap) and `fleet.flows.preapproval.validation`; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-004**
None. US-004 only creates `lib/fleet-flow-start-body.ts` and its test; it changes no existing file.

**US-005**
- `apps/web/composables/useFleetFlows.ts` — the returned object gains `createFromThread`; `list`, `get`, `overview`, `stop` and `answer` are unchanged.
- `apps/web/tests/composables/useFleetFlows.spec.ts` — gains the "createFromThread" cases; existing cases are unchanged.

**US-006**
- `apps/web/i18n/locales/en.json` — gains the `fleet.flows.start` row keys (title, feature, specPath, dependsOn, addRow, removeRow); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same `fleet.flows.start` row keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-007**
- `apps/web/i18n/locales/en.json` — gains `fleet.flows.start.reviewer`, `supervisor`, `costCap`, `submit` and `fleet.flows.start.tick.none`, `tick.notYours`, `tick.exceeded`, `tick.covers`; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-008**
- `apps/web/i18n/locales/en.json` — gains `fleet.flows.start.button`, `fleet.flows.start.blocked.notPublished` and `fleet.flows.start.blocked.flowLive`; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same three keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-009**
- `apps/web/pages/[project]/threads/[id].vue` — mounts `FleetThreadsThreadStartFlow` with `slug` and the thread after `FleetThreadsThreadFlowsPanel`; nothing else on the page changes.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — its explicit `components` stub map gains a `FleetThreadsThreadStartFlow` stub (props `slug`, `thread`) and cases asserting the stub's props; existing assertions are unchanged.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — its explicit `components` stub map gains the same `FleetThreadsThreadStartFlow` stub; existing assertions are unchanged.
- `apps/web/i18n/locales/en.json` — gains `fleet.flows.start.openApprovals`; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains `fleet.flows.start.openApprovals` so the locale parity check stays green; existing keys are unchanged.

**US-010**
- `apps/web/i18n/locales/en.json` — gains the `fleet.flows.preapproval` card keys (title, cap, setAt, set, clear, none); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same `fleet.flows.preapproval` card keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-011**
- `apps/web/pages/[project]/threads/[id].vue` — mounts `FleetThreadsThreadPreApprovalCard` with `slug` and the thread after `FleetThreadsThreadStartFlow`, and its `changed` event calls `controller.reloadThread()`; nothing else on the page changes.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — its `components` stub map gains a `FleetThreadsThreadPreApprovalCard` stub that can emit `changed`, and cases assert its props and that the page reloads the thread on it; existing assertions are unchanged.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — its `components` stub map gains the same `FleetThreadsThreadPreApprovalCard` stub; existing assertions are unchanged.

### Seams

- US-006 consumes `flowStartRows` (US-001) and `buildFlowStartSchema` (US-003): US-006 AC-1 to AC-4 mount the dialog
  and assert the prefilled rows.
- US-007 consumes `defaultFlowRoles` and `tickHint` (US-002) and `toFlowStartBody` (US-004): US-007 AC-1, AC-2 and
  AC-8 to AC-13 mount the dialog and assert the roles, the emitted body and each hint.
- US-009 consumes `useFleetFlows().createFromThread` (US-005) and `ThreadStartFlowDialog` (US-006, US-007): US-009
  AC-2 to AC-5 assert the dialog stub's props and the `createFromThread` call.
- US-011 consumes `useThreadPreApproval().set|clear` (US-005): US-011 AC-3 and AC-5 click the card's buttons and
  assert the call arguments.
- The thread page consumes `ThreadStartFlow` (US-009) and `ThreadPreApprovalCard` (US-011): US-009 AC-14, AC-15 and
  US-011 AC-12 to AC-14 mount the page and assert each stub's props and the reload on `changed`.

## Acceptance Criteria

### US-001

1. [unit] `flowStartRows` on a thread with `feature: 'f-min'`, `specPath: '.nax/features/f-min/spec.md'` and
   `lastWrite: null` returns `[{ feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }]`.
2. [unit] `flowStartRows` on that thread with `lastWrite` of kind `published` and `paths`
   `['.nax/features/f-min/spec.md', 'docs/design.md', '.nax/features/f-clamp/spec.md']` returns two rows, the second
   `{ feature: 'f-clamp', specPath: '.nax/features/f-clamp/spec.md', dependsOn: ['f-min'] }`.
3. [unit] `flowStartRows` on a thread with own feature `a` and published `paths` `['.nax/features/b/spec.md',
   '.nax/features/c/spec.md']` returns three rows whose third row is `{ feature: 'c', specPath:
   '.nax/features/c/spec.md', dependsOn: ['b'] }`.
4. [unit] `flowStartRows` on a thread with own feature `f-min` whose `lastWrite.kind` is `discarded` returns only the
   thread's own row.
5. [unit] `flowStartRows` on a thread with `feature: null` and published `paths` `['.nax/features/x/spec.md']`
   returns `[{ feature: 'x', specPath: '.nax/features/x/spec.md', dependsOn: [] }]`.
6. [unit] `flowStartState` on a REPO thread with `archivedAt: null`, `specPublished: true`, `publishedSha: 'abc'` and
   `{ canCreate: true, liveFlow: false }` returns `{ visible: true, enabled: true, reason: null }`.
7. [unit] `flowStartState` on a PROJECT thread returns `visible: false`.
8. [unit] `flowStartState` on a REPO thread with `archivedAt` set returns `visible: false`.
9. [unit] `flowStartState` with `canCreate: false` returns `visible: false`.
10. [unit] `flowStartState` on a visible thread with `specPublished: false` and `liveFlow: true` returns
    `{ visible: true, enabled: false, reason: 'notPublished' }`.
11. [unit] `flowStartState` on a visible thread with `specPublished: true` and `publishedSha: null` returns
    `{ visible: true, enabled: false, reason: 'notPublished' }`.
12. [unit] `flowStartState` on a visible published thread with `liveFlow: true` returns
    `{ visible: true, enabled: false, reason: 'flowLive' }`.
13. [unit] `flowStartRows` on a thread with own feature `f-min` whose `lastWrite.kind` is `publish_failed` returns only
    the thread's own row.
14. [unit] `flowStartRows` on a thread with own feature `a` and published `paths` `['.nax/features/b/spec.md',
    '.nax/features/b/spec.md']` returns two rows.

### US-002

1. [unit] `defaultFlowRoles` on a thread whose backend is `{ kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' }`
   returns `{ reviewer: 'opencode-go/deepseek-v4.1-flash', supervisor: 'opencode-go/deepseek-v4.1-flash' }`.
2. [unit] `defaultFlowRoles` on a thread whose backend is `{ kind: 'native' }` returns
   `{ reviewer: '', supervisor: '' }`.
3. [unit] `defaultFlowRoles` on a thread whose backend kind is `acp` with a model returns
   `{ reviewer: '', supervisor: '' }`.
4. [unit] `tickHint` with a `null` tick, cap `3` and viewer `{ userId: 'u1', isThreadCreator: true }` returns `'none'`.
5. [unit] `tickHint` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3` and
   viewer `{ userId: 'u1', isThreadCreator: false }` returns `'covers'`.
6. [unit] `tickHint` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3.0001`
   and viewer `{ userId: 'u1', isThreadCreator: false }` returns `'exceeded'`.
7. [unit] `tickHint` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '0.3000' }`, cap
   `0.1 + 0.2` and viewer `{ userId: 'u1', isThreadCreator: false }` returns `'covers'`.
8. [unit] `tickHint` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3` and
   viewer `{ userId: 'u2', isThreadCreator: true }` returns `'covers'`.
9. [unit] `tickHint` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3` and
   viewer `{ userId: 'u2', isThreadCreator: false }` returns `'notYours'`.
10. [unit] `tickHint` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `9` and
    viewer `{ userId: 'u2', isThreadCreator: false }` returns `'notYours'` (the viewer check comes before the cap).

### US-003

1. [unit] `buildFlowStartSchema(t).safeParse` succeeds on one row `{ feature: 'f-min', specPath:
   '.nax/features/f-min/spec.md', dependsOn: [] }`, roles `{ reviewer: 'm', supervisor: 'm' }` and cap `2`.
2. [unit] On the feature name `bad name`, the parse's first issue message is `fleet.flows.start.validation.feature`.
3. [unit] On the feature name `a..b`, the parse's first issue message is `fleet.flows.start.validation.feature`.
4. [unit] On two rows both named `f-min`, the parse's first issue message is
   `fleet.flows.start.validation.featureDuplicate`.
5. [unit] On an empty row list, the parse's first issue message is `fleet.flows.start.validation.featuresCount`.
6. [unit] On 21 valid, distinct rows, the parse's first issue message is `fleet.flows.start.validation.featuresCount`.
7. [unit] On the spec path `/abs/spec.md`, the parse's first issue message is `fleet.flows.start.validation.specPath`.
8. [unit] On the spec path `docs/spec.txt`, the parse's first issue message is `fleet.flows.start.validation.specPath`.
9. [unit] On the spec path `docs/../spec.md`, the parse's first issue message is
   `fleet.flows.start.validation.specPath`.
10. [unit] On a first row whose `dependsOn` is `['f-clamp']` while `f-clamp` is the second row, the parse's first issue
    message is `fleet.flows.start.validation.dependsOn`.
11. [unit] On a row whose `dependsOn` is `['gone']` when no row is named `gone`, the parse's first issue message is
    `fleet.flows.start.validation.dependsOn`.
12. [unit] On the reviewer `has space`, the parse's first issue message is `fleet.flows.start.validation.role`.
13. [unit] On the cap `1000.0001`, the parse's first issue message is `fleet.flows.start.validation.costCap`.
14. [unit] On the cap `1.23456`, the parse's first issue message is `fleet.flows.start.validation.costCap`.
15. [unit] On the feature name `' f-min '`, the parse succeeds and its output feature is `'f-min'`.

### US-004

1. [unit] `toFlowStartBody` on one row `{ feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }`,
   roles `{ reviewer: 'm', supervisor: 'm' }` and cap `2` returns `{ features: [{ feature: 'f-min', specPath:
   '.nax/features/f-min/spec.md', dependsOn: [] }], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 }`.
2. [unit] `toFlowStartBody` on parsed values whose cap is the string `'2.5'` returns `costCapUsd` as the number `2.5`.
3. [unit] `toFlowStartBody` on a row whose `dependsOn` is `['f-min']` returns that row's `dependsOn` as a new array
   equal to `['f-min']` (the input array is not shared).
4. [unit] `toFlowStartBody` returns a `features` array that is not the input `features` array, leaving the input
   unchanged.

### US-005

1. [unit] `useFleetFlows('web').createFromThread('t1', body)` calls `$api.post` with
   `/projects/web/threads/t1/flows` and exactly `body`.
2. [unit] `createFromThread` resolves `{ kind: 'done', flow }` when the API answers a `FleetFlowDto`.
3. [unit] `createFromThread` resolves `{ kind: 'pending', request }` when the API answers an object carrying
   `permissionKey`.
4. [unit] `createFromThread` rejects with the identical error object the API call rejected with.
5. [unit] `createFromThread('a/b', body)` calls `$api.post` with the path `/projects/web/threads/a%2Fb/flows`.
6. [unit] `useThreadPreApproval('web').set('t1', 3)` calls `$api.put` with `/projects/web/threads/t1/preapproval`
   and the body `{ costCapUsd: 3 }`.
7. [unit] `set` resolves `{ kind: 'done' }` when the API answers a tick `{ userId, at, costCapUsd }`.
8. [unit] `useThreadPreApproval('web').clear('t1')` calls `$api.delete` with `/projects/web/threads/t1/preapproval`.
9. [unit] `clear` resolves `{ kind: 'done' }` when the API answers `{ cleared: true }`.
10. [unit] `set` resolves `{ kind: 'pending', request }` when the API answers an object carrying `permissionKey`.
11. [unit] `clear` resolves `{ kind: 'pending', request }` when the API answers an object carrying `permissionKey`.
12. [unit] `set` rejects with the identical error object the API call rejected with.
13. [unit] `clear` rejects with the identical error object the API call rejected with.

### US-006

1. [unit] Mounting `ThreadStartFlowDialog` open on a thread with own feature `f-min` and a published
   `.nax/features/f-clamp/spec.md` renders two rows.
2. [unit] On that mount, row 2's feature input holds `f-clamp`.
3. [unit] On that mount, row 2's spec path input holds `.nax/features/f-clamp/spec.md`.
4. [unit] On that mount, row 2's `f-min` dependency checkbox is checked.
5. [unit] Row 1 renders no dependency checkboxes.
6. [unit] With three rows, row 3 renders exactly two dependency checkboxes.
7. [unit] With rows `a`, `b`, `c`, row 3's dependency checkboxes are labelled `a` and `b`.
8. [unit] Clicking the add-row button appends a row whose feature input is empty.
9. [unit] A row appended with the add-row button has no dependency checkbox checked.
10. [unit] Clicking row 2's remove button leaves one row.
11. [unit] With rows `a`, `b`, `c` where `c` depends on `a`, removing row `a` leaves row `c` with no dependency
    checked.
12. [unit] Renaming row 1 from `f-min` to `f-low` leaves row 2's dependency checkbox labelled `f-low` checked.
13. [unit] Closing the dialog after adding a row and reopening it renders the two rows from the thread.
14. [unit] Closing the dialog emits `update:open` with `false`.

### US-007

1. [unit] Mounting `ThreadStartFlowDialog` open on a thread whose backend is
   `{ kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' }` fills the reviewer input with that model.
2. [unit] On that mount the supervisor input holds the same model.
3. [unit] On a thread with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }` the cap
   input holds `3`.
4. [unit] On a thread without a tick the cap input holds `5`.
5. [unit] Submitting with two rows named `f-min` renders the English text of
   `fleet.flows.start.validation.featureDuplicate` in the form's alert.
6. [unit] Submitting with two rows named `f-min` emits no `submit`.
7. [unit] Editing any field after a failed submit clears the alert.
8. [unit] Submitting the prefilled form on a thread with own feature `f-min`, a published
   `.nax/features/f-clamp/spec.md`, no tick and both roles `m` emits `submit` once with `{ features: [{ feature:
   'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }, { feature: 'f-clamp', specPath:
   '.nax/features/f-clamp/spec.md', dependsOn: ['f-min'] }], roles: { reviewer: 'm', supervisor: 'm' },
   costCapUsd: 5 }`.
9. [unit] On a thread without a tick the hint renders the English text of `fleet.flows.start.tick.none`.
10. [unit] With a tick of cap `'3.0000'` whose `userId` equals `viewerId` and the cap input at `3`, the hint renders the
    English text of `fleet.flows.start.tick.covers`.
11. [unit] With that tick and the cap input at `4`, the hint renders the English text of
    `fleet.flows.start.tick.exceeded`.
12. [unit] With a tick whose `userId` is `u1`, `viewerId` `u2` and a thread created by `u3`, the hint renders the
    English text of `fleet.flows.start.tick.notYours`.
13. [unit] With a tick whose `userId` is `u1`, `viewerId` `u2`, a thread created by `u2` and the cap input at `3`, the
    hint renders the English text of `fleet.flows.start.tick.covers`.

### US-008

1. [unit] `ThreadStartFlow` on a published REPO thread, with `fleet.flow.create` and `fleet.flow.read` held and no
   flow listed, renders an enabled Start flow button.
2. [unit] Without `fleet.flow.create` it renders nothing.
3. [unit] On a thread with `specPublished: false` the Start flow button is disabled.
4. [unit] On a thread with `specPublished: false` the English text of `fleet.flows.start.blocked.notPublished`
   renders.
5. [unit] When `list(1, thread.id)` returns a flow in state `RUNNING` the Start flow button is disabled.
6. [unit] When `list(1, thread.id)` returns a flow in state `RUNNING` the English text of
   `fleet.flows.start.blocked.flowLive` renders.
7. [unit] When `list` returns only `COMPLETED` and `STOPPED` flows the Start flow button is enabled.
8. [unit] Without `fleet.flow.read` the component does not call `list`.
9. [unit] Without `fleet.flow.read` the Start flow button on a published thread is enabled.
10. [unit] A grant of `fleet.flow.read` after mount calls `list(1, thread.id)` once.
11. [unit] When `list` rejects, the Start flow button is enabled.
12. [unit] When `list` rejects, no toast is shown.

### US-009

1. [unit] Clicking the Start flow button renders the `ThreadStartFlowDialog` stub with `open` true.
2. [unit] The dialog stub receives the component's `thread` prop as `thread`.
3. [unit] With `useAuth().user` holding `{ id: 'u1' }` the dialog stub receives `viewerId` `'u1'`.
4. [unit] With `useAuth().user` null the dialog stub receives `viewerId` `''`.
5. [unit] The dialog stub emitting `submit` with a body calls `createFromThread(thread.id, body)` once.
6. [unit] A second `submit` before the first `createFromThread` settles does not call it again.
7. [unit] A `{ kind: 'done', flow: { id: 'f9' } }` answer calls `navigateTo('/web/flows/f9')`.
8. [unit] A `{ kind: 'pending' }` answer shows a success toast with the English text of
   `fleet.flows.toast.approvalRequested`.
9. [unit] A `{ kind: 'pending' }` answer does not call `navigateTo`.
10. [unit] A `{ kind: 'pending' }` answer sets the dialog stub's `open` to false.
11. [unit] After a `{ kind: 'pending' }` answer a link to `/web/approvals` renders.
12. [unit] A rejected `createFromThread` shows an error toast with `extractApiError(error)`'s text.
13. [unit] A rejected `createFromThread` leaves the dialog stub's `open` true.
14. [unit] Mounting `pages/[project]/threads/[id].vue` renders the `FleetThreadsThreadStartFlow` stub with the page's
    `slug`.
15. [unit] On that page the `FleetThreadsThreadStartFlow` stub receives the loaded thread.

### US-010

1. [unit] `ThreadPreApprovalCard` on a REPO thread without a tick, with `fleet.thread.preapprove` held, renders the Set
   button.
2. [unit] On that thread it renders the cap input.
3. [unit] Without `fleet.thread.preapprove` it renders nothing.
4. [unit] On an archived thread it renders nothing.
5. [unit] On a PROJECT thread it renders nothing.
6. [unit] On a thread with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }` it renders
   the cap as `$3.0000` (`usd()` of the string, not re-rounded).
7. [unit] On that thread it renders the set time as `new Date('2026-11-09T06:36:35.837Z').toLocaleString()`.
8. [unit] On that thread it renders a Clear button.
9. [unit] On that thread it renders no Set button.

### US-011

1. [unit] Clicking Set with the cap input at `0` renders the English text of `fleet.flows.preapproval.validation`.
2. [unit] Clicking Set with the cap input at `0` does not call `set`.
3. [unit] Clicking Set with the cap input at `3` calls `useThreadPreApproval('web').set(thread.id, 3)` once.
4. [unit] A `{ kind: 'done' }` answer to `set` emits `changed` once.
5. [unit] Clicking Clear calls `clear(thread.id)` once.
6. [unit] A `{ kind: 'done' }` answer to `clear` emits `changed` once.
7. [unit] A `{ kind: 'pending' }` answer to `set` shows a success toast with the English text of
   `fleet.flows.toast.approvalRequested`.
8. [unit] A `{ kind: 'pending' }` answer to `set` does not emit `changed`.
9. [unit] A rejected `clear` shows an error toast with `extractApiError(error)`'s text.
10. [unit] A rejected `clear` does not emit `changed`.
11. [unit] While a `set` has not settled, a second click on Set does not call `set` again.
12. [unit] Mounting `pages/[project]/threads/[id].vue` renders the `FleetThreadsThreadPreApprovalCard` stub with the
    page's `slug`.
13. [unit] On that page the `FleetThreadsThreadPreApprovalCard` stub receives the loaded thread.
14. [unit] On that page the card stub emitting `changed` calls the thread controller's `reloadThread` once.
15. [unit] A `{ kind: 'pending' }` answer to `clear` does not emit `changed`.
