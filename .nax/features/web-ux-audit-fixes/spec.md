# SPEC: Web UX audit fixes (round 2 high severity + round 1 leftovers)

## Summary

Fix the high-severity findings of the 2026-11-12 web UI/UX audit (round 2: R2-1 to R2-7) and the cheap round 1
leftovers (R1-15, R1-17 to R1-20), all tracked in `docs/ux/redesign/AUDIT-2026-11.md`. Pages stop showing raw
database ids and enum codes where a readable value is available in the browser, stop showing a false
"no permission" or a raw id while data is still loading, give every audited form control an accessible name, fix a
light-mode contrast failure and a horizontal scroll at phone width, and tidy four board/dashboard layout issues.
The feature is web-only (`apps/web`); it calls no new API route and changes no API contract.

## Motivation

A scripted Playwright + axe sweep of all 46 routes on koda-wk (dark 1440 px, dark 390 px, light 1440 px) plus a
screenshot review found:

- R2-1: `/[project]/fleet/dispatch` renders "You do not have permission to dispatch jobs" while the project
  permissions are still loading, then replaces it with the form. A permitted user is first told they are refused.
- R2-2: the Memory page shows subjects as raw `ticket:<cuid>` / `agent:<cuid>`, ticket-status objects as raw enums
  (`IN_PROGRESS`), and kinds as raw codes (`INCIDENT_PATTERN`).
- R2-3: the Timeline shows the actor as a raw user id, the event as `ticket_event` and the action as a raw code
  (`TICKET_CREATED`, `status_changed`).
- R2-4: the flow detail page is titled "Flow" with the raw flow id as subtitle although the flow's feature names
  are known; dates print as ISO strings (`2026-11-10T14:07:45.657Z`); stage rows read
  "Spec review · AGENT · COMPLETED · $0.01"; the pull request line reads "Pull request#36".
- R2-5: the admin fleet analytics bundle-ingest table shows raw job and project ids; at 390 px the page scrolls
  sideways by about 30 px because the table header's screen-reader-only text escapes its scroll box.
- R2-6: axe reports form controls with no accessible name: the email and in-app checkboxes on
  `/settings/notifications`, the From/To date inputs on `/admin/slos` and `/[project]/timeline`, the event-type
  select on the timeline, and the kind/status selects on the Memory page.
- R2-7: on the light dashboard the "N need attention" chip is 4.21:1, under WCAG AA.
- R1-15: the fleet job page shows the raw repo id and runner id until the repo/runner options load.
- R1-17: the project board shows "New Ticket" and "Import Issue" as two filled primary buttons.
- R1-18: the board's Created column header is taller than the others (its inline New Ticket button).
- R1-19: empty "My tickets" / "Approvals" dashboard cards stretch to the tallest card in the row.
- R1-20: at phone width the fleet jobs state chips and the board priority chips are under 44 px tall.

## Design

### Calls made while drafting (not user rulings)

- No API change. Memory subjects are not resolved to ticket refs (that needs an API lookup); a ticket subject links
  to `/<slug>/tickets/<cuid>`, which the ticket route already accepts (`GET /projects/:slug/tickets/:ref` takes
  "KODA-42 or CUID").
- A shortened id is the first 8 characters of the id. The full raw value stays available as the element's `title`.
- jsdom has no layout engine, so layout and touch-target fixes are asserted through the Tailwind classes the
  rendered element carries. The audit verified the live effect.
- Readable labels reuse existing helpers: `codeLabel(t, te, prefix, code)` from `~/lib/fleet-i18n` (translation
  or the raw code), `humanizeCode(code)` from `~/lib/humanize-code` (words for a code with no key), the
  `tickets.status.*` keys, the `home.activity.eventType.*` keys and `fleet.command.*` / `fleet.state.*`.
- Actor and approver names come from `useProjectMemberNames(slug).nameOf`, which already names the signed-in user
  when they are not a project member; an id it cannot name renders raw.
- Accessible names come from a `<label for>` / control `id` pair where a visible label already sits above the
  control, and from `aria-label` where the control has no visible label of its own (the per-row notification
  checkboxes).
- The "need attention" chip keeps its red text and border but drops the `bg-destructive/10` tint, sitting on
  `bg-card`; `--status-rejected` on `--card` is already pinned at 4.5:1 or more by
  `tests/lib/token-contrast.spec.ts`.
- Touch-target fixes set `h-11` below the `sm` breakpoint and an explicit height from `sm` up: `sm:h-9` for the
  board priority chips (their current height) and `sm:h-8` for the fleet state chips. The fleet chips have no
  explicit height today (about 26 px from `py-1 text-xs`), so on desktop they grow to 32 px; this is intended.
- A value that is still loading renders the existing `common.loading` text (en `Loading...`), never a hardcoded
  character.
- Dates on the flow page are formatted with the existing `timeText(iso)` from `~/lib/fleet-analytics-format`
  (`new Date(iso).toLocaleString()`, `-` when absent).
- `dispatch.vue` keeps its existing `<p v-if="!canDispatch" ...>` element and its `canDispatch` computed line
  unchanged (`tests/pages/fleet-dispatch-page.spec.ts` pins both); the loading state is added around it: a
  `LoadingState` when project permissions are pending, and the existing chain otherwise.
- The project list for the ingest table is read through a new `projects()` method on `useFleetAnalyticsAdmin()`,
  not by the page directly (`.nax/rules/web.md`: API calls live in composables).
- `TicketBoard` column header rows get `data-testid="board-column-header-<STATUS>"` so tests can find them.
- Only the email checkboxes on `/settings/notifications` get an `aria-label`: each in-app checkbox is already named
  by its row's `<label for>`.
- Test harness: page and component ACs mount with `mountSfc` (`apps/web/tests/helpers/mount-sfc.ts`) and assert on
  the rendered DOM, as `tests/pages/notification-settings-page.spec.ts` does; the binding-only harness of
  `tests/pages/admin-slos-mount.spec.ts` cannot observe `id` / `for` attributes.

### Integration

Symbols this feature only reads (verified 2026-11-12 at `e5a59883`):

- `useProjectPermissions(slug): Permissions` in `apps/web/composables/usePermissions.ts`; `Permissions` carries
  `permissions: ComputedRef<PermissionSet>` and `pending: Ref<boolean>` (true while the read is in flight).
- `useProjectMemberNames(slug)` in `apps/web/composables/useProjectMemberNames.ts`: `{ members, load, nameOf }`,
  `nameOf(userId: string): string | null`.
- `humanizeCode(code: string): string` in `apps/web/lib/humanize-code.ts`.
- `codeLabel(t, te, prefix: string, code: string): string` in `apps/web/lib/fleet-i18n.ts`.
- `GET /projects` (already used by `components/CommandPalette.vue`): an array of projects each carrying `id`,
  `slug` and `name`.
- `LoadingState` component (`apps/web/components/LoadingState.vue`).
- `timeText(iso)` in `apps/web/lib/fleet-analytics-format.ts`.

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `useFleetDispatchOptions(slug)` in `apps/web/composables/useFleetDispatchOptions.ts`.
  Baseline: returns `{ repos, runners, moreRepos, moreRunners, load, profileOptions, labelOptions, repoName,
  runnerName }`.
  Target: also returns `settled: Ref<boolean>`, `false` until the first `load()` call resolves or rejects, then
  `true`. `repoName` / `runnerName` keep their current fallback to the raw id.
- `FleetAnalyticsIngestTable` (`apps/web/components/fleet/analytics/IngestTable.vue`).
  Baseline: `defineProps<{ rows: readonly IngestRowDto[]; busyJobId: string | null }>()`.
  Target: `defineProps<{ rows: readonly IngestRowDto[]; busyJobId: string | null; projects?: readonly
  IngestProject[] }>()` with `projects` defaulting to `[]`, where `IngestProject = { id: string; slug: string;
  name: string }` is exported from `apps/web/lib/fleet-analytics-types.ts`.
- `useFleetAnalyticsAdmin()` in `apps/web/composables/useFleetAnalytics.ts`.
  Baseline: returns an object of request functions (`spend`, ingest reads and the re-run call) over `$api`.
  Target: also returns `projects: () => Promise<IngestProject[]>`, which issues `GET /projects` and maps each row
  to `{ id, slug, name }`.
- `apps/web/lib/fleet-flows.ts` gains `flowTitle(flow: { features: readonly { feature: string }[] }): string | null`
  — the feature names joined with `", "`, or `null` when there are none.

New module:

```ts
// apps/web/lib/memory-subject.ts
export interface MemorySubject {
  type: 'ticket' | 'agent' | 'other'
  /** The part after the `ticket:` / `agent:` prefix; the whole subject for `other`. */
  id: string
  /** `id` cut to its first 8 characters. */
  short: string
}
// `ticket:` / `agent:` with nothing after the prefix is `other` (the whole subject is the id).
// Only the first colon splits: `ticket:a:b` has id `a:b`.
export function memorySubject(subject: string): MemorySubject
```

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `useFleetAnalyticsAdmin().projects()` rejects on `/admin/fleet/analytics` | The ingest table renders with `projects = []` (raw project ids, no job links); no toast. |
| `useFleetDispatchOptions().load()` rejects on the fleet job page | `settled` becomes `true`; the subtitle and Runner field fall back to the raw id. |
| The members read fails on the timeline | Events still render; actors show the raw id; no toast for the members read. |

## Out of Scope

- Resolving memory `ticket:<cuid>` subjects to ticket refs (`SB-10`); it needs an API lookup.
- Audit findings R2-8 to R2-21 (medium and low severity): the settings page title and Delete Project placement, missing breadcrumb leaves, the ticket page assignee list and empty gap, disabled primary buttons that read as enabled, filter select heights, raw codes on the notifications page, hydration-mismatch warnings, breadcrumb and other sub-32 px touch targets, the KB empty state, the admin users status chip and button heights, the audit log cell wrap, permission-read rate limits, and the repo config page load time.
- Round 1 R1-16 (job page detail grid layout); it needs a layout decision.
- New Playwright e2e specs; the feature is verified with Jest.
- Updating `docs/ux/redesign/AUDIT-2026-11.md` and `docs/ux/redesign/MASTER-PLAN.md`; a human updates them after the run.
- Any `apps/api` change and any change to `openapi.json`.

## Stories

### US-001: Readable Memory page

No dependencies. Workdir: `apps/web`.

Add `memorySubject` in `apps/web/lib/memory-subject.ts`. In `pages/[project]/memory.vue`, render a ticket subject
as the label `Ticket` plus the short id, linked to `/<slug>/tickets/<id>`; an agent subject as the label `Agent`
plus the short id; any other subject unchanged; the raw subject as the `title`. Render a `status` object through
`tickets.status.*` when that key exists, and kinds through new `memory.kinds.*` keys (falling back to
`humanizeCode`), in the table and in the Kind filter options. Associate the Kind and Status filter labels with
their selects. Add `memory.kinds.*` (FACT, DECISION, PREFERENCE, CONSTRAINT, INCIDENT_PATTERN, NOTE) and
`memory.subject.ticket` / `memory.subject.agent` to `en.json` and `zh.json`.

### US-002: Readable Timeline

No dependencies. Workdir: `apps/web`.

In `pages/[project]/timeline.vue`, load project member names with `useProjectMemberNames(slug)` on mount and render
the actor through `nameOf`, falling back to the raw id. Render the event type through `home.activity.eventType.*`
(falling back to `humanizeCode`) in the rows and in the filter options, and the action through `humanizeCode` with
the raw code as `title`. Associate the Event Type, From and To labels with their controls. Page tests supply
`useProjectMemberNames` through `mountSfc`'s `globals` (it is not in the default auto-import list) or an `alias`.

### US-003: Flow detail page

No dependencies. Workdir: `apps/web`.

Add `flowTitle` to `lib/fleet-flows.ts`. `pages/[project]/flows/[id].vue` uses it as the page title (falling back
to `fleet.flows.detail.title`), drops the raw id from the subtitle and shows it as an `ID` row (new key
`fleet.flows.detail.id`) in the flow details list, formats Created and Recorded with `timeText`, and renders each
row of its own "Flow jobs" list with the command through `codeLabel(t, te, 'fleet.command', command)` and the state
through `codeLabel(t, te, 'fleet.state', state)`. `components/fleet/flows/FlowFeatureSection.vue` renders each job row's command
through `codeLabel(t, te, 'fleet.command', command)` and its state through `codeLabel(t, te, 'fleet.state',
state)`, and renders a space between the Pull request label and `#<number>`. Add `fleet.flows.detail.id` to
`en.json` and `zh.json`.

### US-004: Admin analytics ingest table

No dependencies. Workdir: `apps/web`.

Add the `IngestProject` type, the `projects()` method on `useFleetAnalyticsAdmin()` and the `projects` prop to
`FleetAnalyticsIngestTable`. The project cell shows the
project name when the id is in `projects`, else the raw id. The job cell shows the short job id (full id as
`title`) plus `#<leaseEpoch>`, linked to `/<slug>/fleet/jobs/<jobId>` when the project is known. The element that
wraps the table carries `relative` with `overflow-x-auto`. `pages/admin/fleet/analytics.vue` calls `projects()`
once on mount and passes the result as `projects`, using `[]` when the read fails.

### US-005: Truthful loading on dispatch and the job page

No dependencies. Workdir: `apps/web`.

`pages/[project]/fleet/dispatch.vue` renders `LoadingState` while the project permissions are pending and only
shows `dispatch-no-permission` once they have loaded without `fleet.job.dispatch`; the existing
`<p v-if="!canDispatch"` element and `canDispatch` line stay as they are. `useFleetDispatchOptions` gains `settled`.
`pages/[project]/fleet/jobs/[id]/index.vue` shows the `common.loading` text in place of the repo name in the
subtitle and in the Runner field until `settled` is `true`; a job with no runner shows the unassigned text at once.

### US-006: Accessible names and the attention chip

No dependencies. Workdir: `apps/web`.

`pages/settings/notifications.vue` gives each row's email checkbox the `aria-label` from new key
`notifications.preferences.emailFor` (takes `{category}`, the row's translated label). `pages/admin/slos.vue`
associates its From and To labels with the date inputs. `components/home/HomeProjectList.vue` renders the attention
chip on `bg-card`. Add the key to `en.json` (`Email: {category}`) and `zh.json`.

### US-007: Board and dashboard layout

No dependencies. Workdir: `apps/web`.

On `pages/[project]/index.vue` the Import Issue button uses `variant="outline"`; the priority filter chips carry
`h-11 sm:h-9`. In `components/TicketBoard.vue` every column header row carries
`data-testid="board-column-header-<STATUS>"` and `h-8`, and the inline New Ticket button carries `h-7`. `components/home/HomeNeedsYou.vue`'s card grid carries `items-start`. On
`pages/[project]/fleet/index.vue` each state filter chip carries `h-11 sm:h-8`.

### Context Files

**US-001**

- `apps/web/pages/[project]/memory.vue`
- `apps/web/composables/useMemory.ts`
- `apps/web/lib/humanize-code.ts`
- `apps/web/tests/pages/memory-mount.spec.ts`
- `apps/web/tests/helpers/fleet-harness.ts`

**US-002**

- `apps/web/pages/[project]/timeline.vue`
- `apps/web/composables/useProjectMemberNames.ts`
- `apps/web/lib/humanize-code.ts`
- `apps/web/tests/pages/timeline.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`

**US-003**

- `apps/web/pages/[project]/flows/[id].vue`
- `apps/web/components/fleet/flows/FlowFeatureSection.vue`
- `apps/web/lib/fleet-flows.ts`
- `apps/web/tests/pages/fleet-flow-detail.spec.ts`
- `apps/web/tests/components/flow-feature-section.spec.ts`

**US-004**

- `apps/web/components/fleet/analytics/IngestTable.vue`
- `apps/web/pages/admin/fleet/analytics.vue`
- `apps/web/lib/fleet-analytics-types.ts`
- `apps/web/tests/components/fleet-ingest-table.spec.ts`
- `apps/web/tests/pages/admin-fleet-analytics.spec.ts`

**US-005**

- `apps/web/pages/[project]/fleet/dispatch.vue`
- `apps/web/composables/useFleetDispatchOptions.ts`
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/tests/pages/fleet-dispatch-pr-page.spec.ts`
- `apps/web/tests/helpers/permission-nav.ts`

**US-006**

- `apps/web/pages/settings/notifications.vue`
- `apps/web/pages/admin/slos.vue`
- `apps/web/components/home/HomeProjectList.vue`
- `apps/web/tests/pages/notification-settings-page.spec.ts`
- `apps/web/tests/pages/admin-slos-mount.spec.ts`

**US-007**

- `apps/web/pages/[project]/index.vue`
- `apps/web/components/TicketBoard.vue`
- `apps/web/components/home/HomeNeedsYou.vue`
- `apps/web/pages/[project]/fleet/index.vue`
- `apps/web/tests/pages/project-board.spec.ts`

### Creates

**US-001**

- `apps/web/lib/memory-subject.ts`
- `apps/web/tests/lib/memory-subject.spec.ts`
- `apps/web/tests/pages/memory-readable.spec.ts`

**US-002**

- `apps/web/tests/pages/timeline-readable.spec.ts`

**US-003**

- `apps/web/tests/lib/fleet-flows-title.spec.ts`
- `apps/web/tests/pages/flow-detail-readable.spec.ts`

**US-004**

- `apps/web/tests/components/fleet-ingest-projects.spec.ts`

**US-005**

- `apps/web/tests/pages/fleet-dispatch-loading.spec.ts`

**US-006**

- `apps/web/tests/pages/accessible-names.spec.ts`

**US-007**

- `apps/web/tests/components/board-layout.spec.ts`

### Modifies

**US-001**

- `apps/web/tests/pages/memory.spec.ts` — its SSR render tests build the template context in `createRenderContext`, which holds only the bindings the page has today; the page template now also uses the subject, kind and status label bindings this story adds. Add those bindings to `createRenderContext`; keep the `{{ ... item.subject ... }}` interpolation pins and every other existing assertion as they are.
- `apps/web/tests/pages/memory-mount.spec.ts` — its `useI18n` stub returns only `t` and `locale`; the page now also destructures `te` for the kind and status labels. Add `te: () => false` to the stub; every existing assertion stays as it is.
- `apps/web/tests/pages/memory-retire-visibility.spec.ts` — its `useI18n` stub returns only `t`; the page now also destructures `te`. Add `te: () => false` to the stub; every existing assertion stays as it is.
- `apps/web/tests/pages/memory-retire-flow.spec.ts` — the page-level `i18nStub()` passed as `useI18n` may lack `te`, which the page now destructures. Add `te: () => false` to the object it returns if absent; every existing assertion stays as it is.

**US-002**

- `apps/web/tests/pages/timeline.spec.ts` — its SSR render tests build the template context in `createRenderContext`, which lacks the actor-name, event-type label and action label bindings the template now uses. Add those bindings to `createRenderContext`; keep the `{{ ... event.eventType ... }}`, `{{ ... event.actorId ... }}` and `{{ ... event.action ... }}` interpolation pins and every other existing assertion as they are.

**US-003**

- `apps/web/tests/components/flow-feature-section.spec.ts` — its `useI18n` stub returns only `t`; the section now calls `codeLabel(t, te, ...)`. Add `te: () => false` to the stub so labels fall back to the raw code; every existing assertion stays as it is.
- `apps/web/tests/pages/fleet-flow-detail.spec.ts` — its `useI18n` stub returns only `t`, and the page and `FlowFeatureSection` now call `codeLabel(t, te, ...)`; add `te: () => false` to the stub. Its AC-10 test asserts the raw ISO string `2026-01-02T03:04:05.000Z` for Created, which this story replaces with `timeText`; change that one expectation to the value of `new Date('2026-01-02T03:04:05.000Z').toLocaleString()`. Every other existing assertion stays as it is (with `te` false, the flow jobs row still reads `RUN · RUN · QUEUED · $0.50`).

**US-004**

- `apps/web/tests/pages/admin-fleet-analytics.spec.ts` — its makeGet double throws for any API path it does not know, and the page now reads the project list (the projects route) on mount. Make makeGet answer the projects route with an empty array; every existing assertion stays as it is.

**US-005**

- `apps/web/tests/pages/fleet-job-detail.spec.ts` — its `useFleetDispatchOptions` double has no `settled`, which the job page now reads. Add `settled: ref(true)` to the double; every existing assertion stays as it is.
- `apps/web/tests/pages/fleet-job-detail-workflow.spec.ts` — its `useFleetDispatchOptions` double has no `settled`, which the job page now reads. Add `settled: ref(true)` to the double; every existing assertion stays as it is.
- `apps/web/tests/pages/fleet-job-agent-result.spec.ts` — its `useFleetDispatchOptions` double has no `settled`, which the job page now reads. Add `settled: ref(true)` to the double; every existing assertion stays as it is.
- `apps/web/tests/pages/fleet-job-fix-action.spec.ts` — its `useFleetDispatchOptions` double has no `settled`, which the job page now reads. Add `settled: ref(true)` to the double; every existing assertion stays as it is.
- `apps/web/tests/pages/fleet-job-budget-gates.spec.ts` — its job-page `useFleetDispatchOptions` double has no `settled`, which the job page now reads. Add `settled: ref(true)` to the double; every existing assertion stays as it is.

**US-006**

None. The notification settings, SLO and home project list specs assert behaviour the change keeps.

**US-007**

None. No existing spec pins the button variant, header height, grid alignment or chip height this story changes.

### Seams

None across stories: every story is independent, and each new exported symbol (`memorySubject`, `flowTitle`,
`IngestProject` / the `projects` prop, `settled`) is consumed by a page in the same story, whose page-level ACs
exercise it through the page.

## Acceptance Criteria

### US-001

- [unit] `memorySubject('ticket:cmw852hth00c408tguaxw2f78')` returns `{ type: 'ticket', id: 'cmw852hth00c408tguaxw2f78', short: 'cmw852ht' }`.
- [unit] `memorySubject('agent:a1')` returns `{ type: 'agent', id: 'a1', short: 'a1' }`.
- [unit] `memorySubject('deploy')` returns `{ type: 'other', id: 'deploy', short: 'deploy' }`.
- [unit] `memorySubject('ticket:')` returns `{ type: 'other', id: 'ticket:', short: 'ticket:' }`.
- [unit] `memorySubject('ticket:a:b')` returns `{ type: 'ticket', id: 'a:b', short: 'a:b' }`.
- [unit] Mounting `pages/[project]/memory.vue` for slug `acme` with an item whose subject is `ticket:t1` renders a link to `/acme/tickets/t1` whose text includes the en label `Ticket` and `t1`.
- [unit] On that page the element rendering subject `ticket:t1` carries `title="ticket:t1"`.
- [unit] An item whose subject is `agent:a1` renders the en label `Agent` and `a1` as plain text.
- [unit] An item with predicate `status` and object `IN_PROGRESS` renders the object as `In progress`.
- [unit] An item with predicate `status` and object `open` renders the object as `open`.
- [unit] An item of kind `INCIDENT_PATTERN` renders the kind as `Incident pattern` from `memory.kinds.INCIDENT_PATTERN`.
- [unit] The Kind filter's `FACT` option has the value `FACT` and the text `Fact`.
- [unit] The Kind filter select's `id` equals the `for` attribute of the label whose text is `Kind`.
- [unit] The Status filter select's `id` equals the `for` attribute of the label whose text is `Status`.
- [unit] Every key under `memory.kinds` and `memory.subject` in `en.json` exists in `zh.json` with a non-empty value.

### US-002

- [unit] Mounting `pages/[project]/timeline.vue` with an event `{ eventType: 'ticket_event', actorId: 'u1', action: 'TICKET_CREATED' }` and a members read returning `u1` named `Ann` renders `Ann` in that row's actor cell.
- [unit] An event whose `actorId` is not a member and not the signed-in user renders that raw `actorId`.
- [unit] An event with `eventType` `ticket_event` renders `Ticket` in its event cell.
- [unit] An event with `eventType` `foo_event` renders `Foo event` in its event cell.
- [unit] An event with action `TICKET_CREATED` renders `Ticket created` in an element carrying `title="TICKET_CREATED"`.
- [unit] An event with action `status_changed` renders `Status changed`.
- [unit] The event-type filter option with value `ticket_event` has the text `Ticket`.
- [unit] The event-type filter option with the empty value has the text `All`.
- [unit] The event-type select's `id` equals the `for` attribute of the label whose text is `Event Type`.
- [unit] The From date input's `id` equals the `for` attribute of the label whose text is `From`.
- [unit] The To date input's `id` equals the `for` attribute of the label whose text is `To`.
- [unit] Mounting the page issues `GET /projects/acme/members` with query `size: '100'` exactly once for slug `acme`.
- [unit] When the members read rejects, the events still render with raw actor ids and no error toast is raised for that read.

### US-003

- [unit] `flowTitle({ features: [{ feature: 'f17-min3' }] })` returns `'f17-min3'`.
- [unit] `flowTitle({ features: [{ feature: 'a' }, { feature: 'b' }] })` returns `'a, b'`.
- [unit] `flowTitle({ features: [] })` returns `null`.
- [unit] Mounting `pages/[project]/flows/[id].vue` with a flow whose features are `[f17-min3]` passes `f17-min3` as the `PageHeader` title.
- [unit] Mounting the page with a flow that has no features passes the `fleet.flows.detail.title` text as the `PageHeader` title.
- [unit] The `PageHeader` subtitle the page passes does not include the flow id.
- [unit] The page renders the flow id in the details list under the `fleet.flows.detail.id` label.
- [unit] A flow with `createdAt` `2026-01-02T03:04:05.000Z` renders the Created value equal to `new Date('2026-01-02T03:04:05.000Z').toLocaleString()`.
- [unit] A flow whose approval has `approvedAt` `2026-01-02T03:04:05.000Z` renders the Recorded value equal to `new Date('2026-01-02T03:04:05.000Z').toLocaleString()`.
- [unit] Mounting the flow page with the en locale and a flow-level job `{ step: null, command: 'AGENT', state: 'COMPLETED' }` renders a "Flow jobs" row containing `Agent task` and `Completed`.
- [unit] Mounting `FlowFeatureSection` with the en locale and a job `{ command: 'AGENT', state: 'COMPLETED' }` renders a job row containing `Agent task` and `Completed`.
- [unit] With the en locale, a feature with `prNumber` 33 and a pull request URL renders the pull request line text as `Pull request #33`.
- [unit] `fleet.flows.detail.id` exists in both `en.json` and `zh.json` with a non-empty value.

### US-004

- [unit] Mounting `FleetAnalyticsIngestTable` with a row whose `projectId` is `proj-1` and `projects` `[{ id: 'proj-1', slug: 'acme', name: 'Acme' }]` renders `Acme` in that row's project cell.
- [unit] A row whose `projectId` is not in `projects` renders the raw `projectId` in its project cell.
- [unit] A row whose `projectId` maps to slug `acme` and whose `jobId` is `job-1` renders a link to `/acme/fleet/jobs/job-1` in its job cell.
- [unit] A row whose `projectId` is not in `projects` renders its job id as text with no link.
- [unit] A row whose `jobId` is `cmwaryvzf008i07s1ojm2l6qg` renders `cmwaryvz` in its job cell, inside an element carrying `title="cmwaryvzf008i07s1ojm2l6qg"`.
- [unit] A row with `leaseEpoch` 2 still renders `#2` in its job cell.
- [unit] The element wrapping the table carries both the `overflow-x-auto` and the `relative` classes.
- [unit] `useFleetAnalyticsAdmin().projects()` issues `GET /projects` and resolves `[{ id: 'proj-1', slug: 'acme', name: 'Acme' }]` when the API answers that project with further fields.
- [unit] Mounting `pages/admin/fleet/analytics.vue` with `GET /projects` returning `[{ id: 'proj-1', slug: 'acme', name: 'Acme' }]` passes that array as the `projects` prop of `FleetAnalyticsIngestTable`.
- [unit] When `GET /projects` rejects, the page passes `projects` `[]` to `FleetAnalyticsIngestTable`.
- [unit] When `GET /projects` rejects, the page raises no error toast for that read.

### US-005

- [unit] Mounting `pages/[project]/fleet/dispatch.vue` with project permissions still pending renders `LoadingState`.
- [unit] With project permissions still pending, the page renders no `dispatch-no-permission` element.
- [unit] With project permissions loaded without `fleet.job.dispatch`, the page renders the `dispatch-no-permission` element.
- [unit] With project permissions loaded with `fleet.job.dispatch`, the page renders no `dispatch-no-permission` element.
- [unit] `useFleetDispatchOptions('acme').settled.value` is `false` before `load()` is called.
- [unit] After `load()` resolves, `settled.value` is `true`.
- [unit] After `load()` rejects, `settled.value` is `true`.
- [unit] After `load()` rejects, `repoName('r1')` returns `'r1'`.
- [unit] Mounting `pages/[project]/fleet/jobs/[id]/index.vue` with an options double whose `settled` is `false` passes a subtitle to `PageHeader` that contains `Loading...` and not the job's `repoId`.
- [unit] With `settled` `false` and a job whose `runnerId` is `r1`, the `fleet-job-runner` field renders `Loading...`.
- [unit] With `settled` `false` and a job whose `runnerId` is `null`, the `fleet-job-runner` field renders the `fleet.jobs.detail.unassigned` text.
- [unit] With `settled` `true` and `repoName` returning `nathapp-io/koda-fleet-sandbox`, the subtitle contains `nathapp-io/koda-fleet-sandbox`.
- [unit] With `settled` `true` and `repoName` returning the raw repo id (the options read failed), the subtitle contains that repo id.

### US-006

- [unit] Mounting `pages/settings/notifications.vue` with `mountSfc` and the en locale renders the email checkbox `notification-pref-email-ASSIGNED` with an `aria-label` equal to `Email: ` followed by that category's translated label.
- [unit] `notifications.preferences.emailFor` exists in both `en.json` and `zh.json` with a value containing `{category}`.
- [unit] Mounting `pages/admin/slos.vue` with `mountSfc` renders the From date input with an `id` equal to the `for` attribute of the label whose text is the `slos.window.from` text.
- [unit] The To date input on that page has an `id` equal to the `for` attribute of the label whose text is the `slos.window.to` text.
- [unit] Mounting `HomeProjectList` with a project whose `attentionJobs` is 2 renders the attention chip with the classes `bg-card` and `text-status-rejected`.
- [unit] That attention chip does not carry the class `bg-destructive/10`.

### US-007

- [unit] Mounting `pages/[project]/index.vue` renders the Import Issue `Button` with `variant` `outline`.
- [unit] On that page the New Ticket `Button` keeps the default variant.
- [unit] On that page each priority filter chip carries the classes `h-11` and `sm:h-9`.
- [unit] Mounting `TicketBoard` with tickets in every status renders six `board-column-header-<STATUS>` elements, each carrying the class `h-8`.
- [unit] The Created column's New Ticket button in `TicketBoard` carries the class `h-7`.
- [unit] Mounting `HomeNeedsYou` with items to show renders its card grid with the class `items-start`.
- [unit] Mounting `pages/[project]/fleet/index.vue` renders each state filter chip with the classes `h-11` and `sm:h-8`.
