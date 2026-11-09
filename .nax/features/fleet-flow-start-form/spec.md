<!-- spec-writing: completed-through-phase-5 -->
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
  the flow's cap. The hint is advisory; the API decides.
- **Start flow availability.** Shown on a REPO thread that is not archived when the viewer holds `fleet.flow.create`.
  Disabled with a reason when the thread has no published spec (`specPublished` false or `publishedSha` null) or when
  the thread has a live flow (listed through `useFleetFlows().list(1, threadId)` when the viewer holds
  `fleet.flow.read`; without that key the check is skipped and the API's 409 is shown).
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
  - `tickCovers(tick: ThreadPreApproval | null, costCapUsd: number, viewer: { userId: string; isThreadCreator: boolean }): boolean`
- `apps/web/lib/fleet-flow-start-form.ts`:
  - `FLOW_MAX_FEATURES = 20`, `FLOW_COST_CAP_MAX_USD = 1000`, `FLOW_ROLE_RE` (the API role pattern),
    `FLOW_SPEC_PATH_MAX = 300`
  - `buildFlowStartSchema(t)` (zod), `type FlowStartFormValues`, `buildPreApprovalSchema(t)`
  - `interface FlowStartBody { features: { feature: string; specPath: string; dependsOn: string[] }[];
    roles: { reviewer: string; supervisor: string }; costCapUsd: number }`
  - `toFlowStartBody(values: FlowStartFormValues): FlowStartBody`
- `apps/web/composables/useThreadPreApproval.ts`: `useThreadPreApproval(slug)` returning
  `set(threadId, costCapUsd: number): Promise<PreApprovalWrite>` and `clear(threadId): Promise<PreApprovalWrite>`,
  `type PreApprovalWrite = { kind: 'done' } | { kind: 'pending'; request: ApprovalRequestSummary }`.
- `apps/web/components/fleet/threads/ThreadStartFlowDialog.vue`, `ThreadStartFlow.vue`, `ThreadPreApprovalCard.vue`.

`tickCovers` compares caps as integers of ten-thousandths (`Math.round(x * 10000)`), never as raw floats.

### Failure Handling

| Case | Behaviour |
|---|---|
| Create route answers an error (400 invalid input, 403, 404, 409 thread busy or not published) | Toast `extractApiError(error)`; the dialog stays open with the values kept. |
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

## Stories

### US-001: Flow start rows and availability

No dependencies. Workdir: `apps/web`.

`ThreadDto` gains `preApproval: ThreadPreApproval | null`. New pure module `lib/fleet-flow-start.ts` with
`FLOW_SPEC_PATH_RE`, `FlowStartRow`, `flowStartRows`, `FlowStartBlock` and `flowStartState`, as in Design. Tests in
`tests/lib/fleet-flow-start.spec.ts`.

### US-002: Flow start defaults

Depends on US-001. Workdir: `apps/web`.

New pure module `lib/fleet-flow-start-defaults.ts` with `defaultFlowRoles` and `tickCovers`, as in Design.
`tickCovers` takes the `ThreadPreApproval` type US-001 adds. Tests in `tests/lib/fleet-flow-start-defaults.spec.ts`.

### US-003: Flow start form schema

No dependencies. Workdir: `apps/web`.

New module `lib/fleet-flow-start-form.ts` with the constants, `buildFlowStartSchema(t)`, `buildPreApprovalSchema(t)`
(a `{ costCapUsd }` object with the same cap rule and the message key `fleet.flows.preapproval.validation`) and
`toFlowStartBody`, mirroring `lib/thread-handoff-form.ts`. Validation messages are i18n keys under
`fleet.flows.start.validation` and `fleet.flows.preapproval.validation` in `en.json` and `zh.json`. Tests in
`tests/lib/fleet-flow-start-form.spec.ts`.

### US-004: Flow start and pre-approval composables

Depends on US-001, US-003. Workdir: `apps/web`.

`useFleetFlows(slug)` gains `createFromThread(threadId, body)` posting to `/projects/:slug/threads/:threadId/flows`
and mapping the answer with the existing `write` helper. New composable `composables/useThreadPreApproval.ts` with
`set` (PUT) and `clear` (DELETE) on `/projects/:slug/threads/:threadId/preapproval`, mapping an answer that carries
`permissionKey` (`isPendingFlowAnswer`) to `{ kind: 'pending', request }` and any other answer to `{ kind: 'done' }`.
Tests in `tests/composables/useFleetFlows.spec.ts` and `tests/composables/useThreadPreApproval.spec.ts`.

### US-005: Start flow dialog

Depends on US-001, US-002, US-003. Workdir: `apps/web`.

New `components/fleet/threads/ThreadStartFlowDialog.vue` (Shadcn `Dialog`, vee-validate + zod). Props: `open`,
`thread: ThreadDetailDto`, `viewerId: string`. On open it fills the form from `flowStartRows(thread)`,
`defaultFlowRoles(thread)` and the cap default (the tick's cap, else 5). Each row has feature and spec path inputs,
one checkbox per earlier row's feature for `dependsOn`, and a remove button; an add-row button appends an empty row
with no dependencies. A hint states whether the tick covers the current cap, using `tickCovers` with the viewer
`{ userId: viewerId, isThreadCreator: thread.createdById === viewerId }`. Submit validates with
`buildFlowStartSchema` and emits `submit` with `toFlowStartBody(values)`. i18n keys under `fleet.flows.start` in
`en.json` and `zh.json`. Tests in `tests/components/thread-start-flow-dialog.spec.ts`.

### US-006: Start flow on the thread page

Depends on US-001, US-004, US-005. Workdir: `apps/web`.

New `components/fleet/threads/ThreadStartFlow.vue` (props `slug`, `thread`): reads `fleet.flow.create` and
`fleet.flow.read` from `useProjectPermissions(slug)`, lists the thread's flows with
`useFleetFlows(slug).list(1, thread.id)` when `fleet.flow.read` is held (re-checked on a late grant, as
`ThreadFlowsPanel` does), renders the Start flow button and its blocked reason from `flowStartState` (`liveFlow` is
true when a listed flow's state passes `isLiveFlow`), opens `ThreadStartFlowDialog` with `viewerId` from
`useAuth().user`, and on `submit` calls `createFromThread`: done navigates with `navigateTo('/<slug>/flows/<id>')`,
pending toasts and shows the approvals link, an error toasts `extractApiError`. The thread page mounts it after
`FleetThreadsThreadFlowsPanel`. Tests in `tests/components/thread-start-flow.spec.ts`; the thread page tests gain a
stub for it.

### US-007: Pre-approval card on the thread page

Depends on US-001, US-003, US-004. Workdir: `apps/web`.

New `components/fleet/threads/ThreadPreApprovalCard.vue` (props `slug`, `thread`; emits `changed`): visible on a REPO
thread that is not archived when the viewer holds `fleet.thread.preapprove`. With a tick it shows the cap, the set
time as `new Date(tick.at).toLocaleString()` and a Clear button; without one, a cap input validated by
`buildPreApprovalSchema` and a Set button. A done write emits `changed`; pending toasts
`fleet.flows.toast.approvalRequested`; an error toasts `extractApiError`. The thread page mounts it after
`FleetThreadsThreadStartFlow` and calls `controller.reloadThread()` on `changed`. i18n keys under
`fleet.flows.preapproval`. Tests in `tests/components/thread-preapproval-card.spec.ts`; the thread page tests gain a
stub for it and a `changed` case.

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
- `apps/web/composables/useApi.ts`
- `apps/web/lib/fleet-flows.ts`
- `apps/web/lib/fleet-flow-start-form.ts` — created by US-003, consumed here

**US-005**
- `apps/web/components/fleet/threads/ThreadHandoffDialog.vue`
- `apps/web/tests/components/thread-action-bar.spec.ts`
- `apps/web/tests/helpers/fleet-harness.ts`
- `apps/web/lib/fleet-flow-start.ts` — created by US-001, consumed here
- `apps/web/lib/fleet-flow-start-defaults.ts` — created by US-002, consumed here

**US-006**
- `apps/web/components/fleet/threads/ThreadFlowsPanel.vue`
- `apps/web/tests/components/thread-flows-panel.spec.ts`
- `apps/web/components/fleet/flows/FlowAnswerForm.vue`
- `apps/web/components/fleet/threads/ThreadStartFlowDialog.vue` — created by US-005, integrated here
- `apps/web/lib/fleet-flow-start.ts` — created by US-001, consumed here

**US-007**
- `apps/web/components/fleet/threads/ThreadControls.vue`
- `apps/web/composables/useThreadPreApproval.ts` — created by US-004, consumed here
- `apps/web/lib/fleet-flow-start-form.ts` — created by US-003, consumed here
- `apps/web/tests/helpers/fleet-harness.ts`

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
- `apps/web/composables/useThreadPreApproval.ts`
- `apps/web/tests/composables/useThreadPreApproval.spec.ts`

**US-005**
- `apps/web/components/fleet/threads/ThreadStartFlowDialog.vue`
- `apps/web/tests/components/thread-start-flow-dialog.spec.ts`

**US-006**
- `apps/web/components/fleet/threads/ThreadStartFlow.vue`
- `apps/web/tests/components/thread-start-flow.spec.ts`

**US-007**
- `apps/web/components/fleet/threads/ThreadPreApprovalCard.vue`
- `apps/web/tests/components/thread-preapproval-card.spec.ts`

### Modifies

**US-001**
- `apps/web/lib/thread-types.ts` — `ThreadDto` gains `preApproval: ThreadPreApproval | null` and the file exports the new `ThreadPreApproval` interface; existing fields are unchanged.

**US-002**
None. US-002 only creates `lib/fleet-flow-start-defaults.ts` and its test; it changes no existing file.

**US-003**
- `apps/web/i18n/locales/en.json` — gains the `fleet.flows.start.validation` keys (feature, featureDuplicate, specPath, dependsOn, featuresCount, role, costCap) and `fleet.flows.preapproval.validation`; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-004**
- `apps/web/composables/useFleetFlows.ts` — the returned object gains `createFromThread`; `list`, `get`, `overview`, `stop` and `answer` are unchanged.
- `apps/web/tests/composables/useFleetFlows.spec.ts` — gains the "createFromThread" cases; existing cases are unchanged.

**US-005**
- `apps/web/i18n/locales/en.json` — gains the `fleet.flows.start` dialog keys (title, feature, specPath, dependsOn, addRow, removeRow, reviewer, supervisor, costCap, submit, tickCovers, tickExceeded, noTick); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same `fleet.flows.start` dialog keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-006**
- `apps/web/pages/[project]/threads/[id].vue` — mounts `FleetThreadsThreadStartFlow` with `slug` and the thread after `FleetThreadsThreadFlowsPanel`; nothing else on the page changes.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — its explicit `components` stub map gains a `FleetThreadsThreadStartFlow` stub (props `slug`, `thread`) and one case asserting the stub's props; existing assertions are unchanged.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — its explicit `components` stub map gains the same `FleetThreadsThreadStartFlow` stub; existing assertions are unchanged.
- `apps/web/i18n/locales/en.json` — gains `fleet.flows.start.button`, `fleet.flows.start.blocked.notPublished`, `fleet.flows.start.blocked.flowLive` and `fleet.flows.start.openApprovals`; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same four keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

**US-007**
- `apps/web/pages/[project]/threads/[id].vue` — mounts `FleetThreadsThreadPreApprovalCard` with `slug` and the thread after `FleetThreadsThreadStartFlow`, and its `changed` event calls `controller.reloadThread()`; nothing else on the page changes.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — its `components` stub map gains a `FleetThreadsThreadPreApprovalCard` stub that can emit `changed`, and one case asserts the page reloads the thread on it; existing assertions are unchanged.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — its `components` stub map gains the same `FleetThreadsThreadPreApprovalCard` stub; existing assertions are unchanged.
- `apps/web/i18n/locales/en.json` — gains the `fleet.flows.preapproval` card keys (title, cap, setAt, set, clear, none); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same `fleet.flows.preapproval` card keys as the English locale file so the locale parity check stays green; existing keys are unchanged.

### Seams

- US-005 consumes `flowStartRows` (US-001), `defaultFlowRoles` and `tickCovers` (US-002), and `buildFlowStartSchema`
  and `toFlowStartBody` (US-003): US-005 AC-1, AC-2, AC-11 and AC-12 render the dialog and assert the prefilled rows,
  roles, the hint and the emitted body.
- US-006 consumes `useFleetFlows().createFromThread` (US-004) and `ThreadStartFlowDialog` (US-005): US-006 AC-9 stubs
  `createFromThread`, emits `submit` from the dialog stub and asserts the call arguments.
- US-007 consumes `useThreadPreApproval().set|clear` (US-004): US-007 AC-7 and AC-9 stub them, click the card's
  buttons and assert the call arguments.
- The thread page consumes `ThreadStartFlow` (US-006) and `ThreadPreApprovalCard` (US-007): US-006 AC-15 and US-007
  AC-14 and AC-15 mount the page and assert each stub's props and the reload on `changed`.

## Acceptance Criteria

### US-001

1. [unit] `flowStartRows` on a thread with `feature: 'f-min'`, `specPath: '.nax/features/f-min/spec.md'` and
   `lastWrite: null` returns `[{ feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }]`.
2. [unit] `flowStartRows` on that thread with `lastWrite` of kind `published` and `paths`
   `['.nax/features/f-min/spec.md', 'docs/design.md', '.nax/features/f-clamp/spec.md']` returns two rows, the second
   `{ feature: 'f-clamp', specPath: '.nax/features/f-clamp/spec.md', dependsOn: ['f-min'] }`.
3. [unit] `flowStartRows` on a thread with own feature `a` and published `paths` `['.nax/features/b/spec.md',
   '.nax/features/c/spec.md']` returns rows `a`, `b`, `c` whose third row has `dependsOn: ['b']`.
4. [unit] `flowStartRows` on a thread whose `lastWrite.kind` is `discarded` returns only the thread's own row.
5. [unit] `flowStartRows` on a thread with `feature: null` and published `paths` `['.nax/features/x/spec.md']`
   returns `[{ feature: 'x', specPath: '.nax/features/x/spec.md', dependsOn: [] }]`.
6. [unit] `flowStartState` on a REPO thread with `archivedAt: null`, `specPublished: true`, `publishedSha: 'abc'` and
   `{ canCreate: true, liveFlow: false }` returns `{ visible: true, enabled: true, reason: null }`.
7. [unit] `flowStartState` on a PROJECT thread returns `visible: false`.
8. [unit] `flowStartState` on a REPO thread with `archivedAt` set returns `visible: false`.
9. [unit] `flowStartState` with `canCreate: false` returns `visible: false`.
10. [unit] `flowStartState` on a visible thread with `specPublished: false` and `liveFlow: true` returns
    `{ visible: true, enabled: false, reason: 'notPublished' }` (the published check comes first).
11. [unit] `flowStartState` on a visible thread with `specPublished: true` and `publishedSha: null` returns
    `reason: 'notPublished'`.
12. [unit] `flowStartState` on a visible published thread with `liveFlow: true` returns
    `{ visible: true, enabled: false, reason: 'flowLive' }`.

### US-002

1. [unit] `defaultFlowRoles` on a thread whose backend is `{ kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' }`
   returns that model for both `reviewer` and `supervisor`.
2. [unit] `defaultFlowRoles` on a thread whose backend is `{ kind: 'native' }` returns
   `{ reviewer: '', supervisor: '' }`.
3. [unit] `defaultFlowRoles` on a thread whose backend kind is `acp` with a model returns
   `{ reviewer: '', supervisor: '' }`.
4. [unit] `tickCovers` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3`
   and viewer `{ userId: 'u1', isThreadCreator: false }` returns true.
5. [unit] `tickCovers` with that tick, cap `3.0001` and viewer `u1` returns false.
6. [unit] `tickCovers` with tick cap `'0.3000'`, cap `0.1 + 0.2` and viewer equal to the tick's user returns true
   (caps compared in ten-thousandths, not raw floats).
7. [unit] `tickCovers` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3` and viewer `{ userId: 'u2', isThreadCreator: true }` returns true.
8. [unit] `tickCovers` with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }`, cap `3` and viewer `{ userId: 'u2', isThreadCreator: false }` returns
   false.
9. [unit] `tickCovers` with a `null` tick returns false.

### US-003

1. [unit] `buildFlowStartSchema(t).safeParse` accepts one row `{ feature: 'f-min', specPath:
   '.nax/features/f-min/spec.md', dependsOn: [] }`, roles `{ reviewer: 'm', supervisor: 'm' }` and cap `2`.
2. [unit] The schema rejects the feature name `bad name` with the message key `fleet.flows.start.validation.feature`.
3. [unit] The schema rejects the feature name `a..b` with `fleet.flows.start.validation.feature`.
4. [unit] The schema rejects two rows both named `f-min` with `fleet.flows.start.validation.featureDuplicate`.
5. [unit] The schema rejects an empty row list with `fleet.flows.start.validation.featuresCount`.
6. [unit] The schema rejects 21 valid, distinct rows with `fleet.flows.start.validation.featuresCount`.
7. [unit] The schema rejects the spec path `/abs/spec.md` with `fleet.flows.start.validation.specPath`.
8. [unit] The schema rejects the spec path `docs/spec.txt` with `fleet.flows.start.validation.specPath`.
9. [unit] The schema rejects the spec path `docs/../spec.md` with `fleet.flows.start.validation.specPath`.
10. [unit] The schema rejects a first row whose `dependsOn` is `['f-clamp']` while `f-clamp` is the second row, with
    `fleet.flows.start.validation.dependsOn`.
11. [unit] The schema rejects the reviewer `has space` with `fleet.flows.start.validation.role`.
12. [unit] The schema rejects the cap `1000.0001` with `fleet.flows.start.validation.costCap`.
13. [unit] The schema rejects the cap `1.23456` with `fleet.flows.start.validation.costCap`.
14. [unit] `toFlowStartBody` on valid values returns `{ features: [{ feature, specPath, dependsOn }], roles: {
    reviewer, supervisor }, costCapUsd }` with `costCapUsd` a number and a row without dependencies carrying
    `dependsOn: []`.
15. [unit] `toFlowStartBody` on a row whose feature is `' f-min '` returns the feature `'f-min'` (surrounding spaces
    trimmed; spec paths and roles are trimmed the same way).

### US-004

1. [unit] `useFleetFlows('web').createFromThread('t1', body)` calls `$api.post` with
   `/projects/web/threads/t1/flows` and exactly `body`.
2. [unit] `createFromThread` resolves `{ kind: 'done', flow }` when the API answers a `FleetFlowDto`.
3. [unit] `createFromThread` resolves `{ kind: 'pending', request }` when the API answers an object carrying
   `permissionKey`.
4. [unit] `createFromThread` rejects with the identical error object the API call rejected with.
5. [unit] `createFromThread('a/b', body)` calls `$api.post` with the path `/projects/web/threads/a%2Fb/flows`.
6. [unit] `useThreadPreApproval('web').set('t1', 3)` calls `$api.put` with `/projects/web/threads/t1/preapproval`
   and the body `{ costCapUsd: 3 }`, and resolves `{ kind: 'done' }` for a tick answer.
7. [unit] `useThreadPreApproval('web').clear('t1')` calls `$api.delete` with `/projects/web/threads/t1/preapproval`
   and resolves `{ kind: 'done' }` for `{ cleared: true }`.
8. [unit] `set` resolves `{ kind: 'pending', request }` when the API answers an object carrying `permissionKey`.
9. [unit] `clear` resolves `{ kind: 'pending', request }` when the API answers an object carrying `permissionKey`.
10. [unit] `set` rejects with the identical error object the API call rejected with.
11. [unit] `clear` rejects with the identical error object the API call rejected with.

### US-005

1. [unit] Mounting `ThreadStartFlowDialog` open on a thread with own feature `f-min` and a published
   `.nax/features/f-clamp/spec.md` renders two rows whose inputs hold those names and paths, with the `f-min`
   dependency checkbox of row 2 checked.
2. [unit] On open the reviewer and supervisor inputs hold the thread's native backend model.
3. [unit] On open on a thread with a tick of cap `'3.0000'` the cap input holds `3`.
4. [unit] Clicking the add-row button appends an empty row with no dependency checked.
5. [unit] Clicking row 2's remove button removes that row and leaves row 1 unchanged.
6. [unit] Removing row 1 removes its feature from every later row's `dependsOn`.
7. [unit] Row 1 renders no dependency checkboxes.
8. [unit] Row 3 renders exactly two dependency checkboxes, labelled with the feature names of rows 1 and 2.
9. [unit] Submitting with two rows named `f-min` renders the English text of
   `fleet.flows.start.validation.featureDuplicate` in the form's alert and emits no `submit`.
10. [unit] Editing any field after a failed submit clears the alert.
11. [unit] Submitting the prefilled form on a thread with own feature `f-min`, a published `.nax/features/f-clamp/spec.md` and no tick, with both roles `m`, emits `submit` once
    with `{ features: [{ feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }, { feature:
    'f-clamp', specPath: '.nax/features/f-clamp/spec.md', dependsOn: ['f-min'] }], roles: { reviewer: 'm',
    supervisor: 'm' }, costCapUsd: 5 }`.
12. [unit] With a tick of cap `'3.0000'` whose `userId` is the `viewerId` and the cap input at `3`, the hint renders the
    English text of `fleet.flows.start.tickCovers`.
13. [unit] With the same tick and the cap input at `4`, the hint renders the English text of
    `fleet.flows.start.tickExceeded`.
14. [unit] On a thread without a tick the hint renders the English text of `fleet.flows.start.noTick`.
15. [unit] Closing the dialog after adding a row and reopening it renders only the rows from `flowStartRows(thread)`.

### US-006

1. [unit] `ThreadStartFlow` on a published REPO thread, with `fleet.flow.create` and `fleet.flow.read` held and no
   flow listed, renders an enabled Start flow button.
2. [unit] Without `fleet.flow.create` it renders nothing.
3. [unit] On a thread with `specPublished: false` the button is disabled and the English text of
   `fleet.flows.start.blocked.notPublished` renders.
4. [unit] When `list(1, thread.id)` returns a flow in state `RUNNING` the button is disabled and the English text of
   `fleet.flows.start.blocked.flowLive` renders.
5. [unit] When `list` returns only `COMPLETED` and `STOPPED` flows the button is enabled.
6. [unit] Without `fleet.flow.read` the component does not call `list` and the button is enabled on a published
   thread.
7. [unit] A grant of `fleet.flow.read` after mount calls `list(1, thread.id)` once.
8. [unit] When `list` rejects, the button is enabled and no toast is shown.
9. [unit] Clicking the button opens the dialog, and the dialog stub emitting `submit` with a body calls
   `createFromThread(thread.id, body)` once.
10. [unit] A `{ kind: 'done', flow: { id: 'f9' } }` answer calls `navigateTo('/web/flows/f9')`.
11. [unit] A `{ kind: 'pending' }` answer shows a success toast with the English text of
    `fleet.flows.toast.approvalRequested` and does not navigate.
12. [unit] After a `{ kind: 'pending' }` answer a link to `/web/approvals` renders.
13. [unit] A rejected `createFromThread` shows an error toast with `extractApiError(error)`'s text and keeps the dialog
    open.
14. [unit] A second `submit` while the first `createFromThread` has not settled does not call it again.
15. [unit] Mounting `pages/[project]/threads/[id].vue` renders the `FleetThreadsThreadStartFlow` stub with the page's
    `slug` and the loaded thread.

### US-007

1. [unit] `ThreadPreApprovalCard` on a REPO thread without a tick, with `fleet.thread.preapprove` held, renders the cap
   input and the Set button.
2. [unit] Without `fleet.thread.preapprove` it renders nothing.
3. [unit] On an archived thread it renders nothing.
4. [unit] On a thread with tick `{ userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }` it renders
   the cap as `$3.00` and the set time as `new Date('2026-11-09T06:36:35.837Z').toLocaleString()`.
5. [unit] On that thread it renders a Clear button and no Set button.
6. [unit] Clicking Set with the cap input at `0` renders the English text of `fleet.flows.preapproval.validation` and
   does not call `set`.
7. [unit] Clicking Set with the cap input at `3` calls `useThreadPreApproval('web').set(thread.id, 3)` once.
8. [unit] A `{ kind: 'done' }` answer to `set` emits `changed` once.
9. [unit] Clicking Clear calls `clear(thread.id)` once.
10. [unit] A `{ kind: 'done' }` answer to `clear` emits `changed` once.
11. [unit] A `{ kind: 'pending' }` answer to `set` shows a success toast with the English text of
    `fleet.flows.toast.approvalRequested` and does not emit `changed`.
12. [unit] A rejected `set` shows an error toast with `extractApiError(error)`'s text and does not emit `changed`.
13. [unit] While a `set` has not settled, a second click on Set does not call `set` again.
14. [unit] Mounting `pages/[project]/threads/[id].vue` renders the `FleetThreadsThreadPreApprovalCard` stub with the
    page's `slug` and the loaded thread.
15. [unit] On that page, the card stub emitting `changed` calls the thread controller's `reloadThread` once.
