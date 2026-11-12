# SPEC: Page polish: settings, ticket detail, job detail, notifications, KB, admin tables, agent names, form selects

## Summary

The page-level findings left from the 2026-11 web audit (`docs/ux/redesign/AUDIT-2026-11.md`): R2-8, R2-9,
R2-11, R2-14, R2-17, R2-18, R2-19, R2-22, R2-23, R2-24 and R1-16, plus the rest of R2-13 (16 raw `<select>`s
the shared-UI feature left at 32 or 36 px). Project settings gets a correct title and first tab and moves Delete
Project into a "Danger zone" card. Ticket detail collapses the assignee picker, stops the empty gap above the
description, names the fleet run command and formats comment times. Job detail uses one 3-column grid and hides
live-only and empty fields. Flow notifications and the flow page name the stop reason instead of raw codes. The
KB explains its empty states. Admin users shows status as a chip with aligned actions, and the audit log keeps
the project slug on one line. Agents are named by name on the timeline and in memory: the project agent roster
API gains the agent `id` so the web can map an actor id to a name. Every remaining raw select uses
`FILTER_CONTROL_CLASS`.

## Motivation

- R2-8: `pages/[project]/settings.vue` renders `PageHeader :title="t('vcs.title')"` ("VCS Integration Settings")
  on every tab, and its first tab reads `t('projects.title')` ("Projects") for a single project.
- R2-9: `components/SettingsProjectCard.vue` puts the destructive "Delete Project" button beside "Save Project"
  in the same form row.
- R2-11: `components/TicketProperties.vue` always renders `AssigneePicker`, a search box plus 9+ option rows, in
  the properties rail. The ticket page grid in `pages/[project]/tickets/[ref].vue` has the rail span two rows,
  so a tall rail stretches row 1 and leaves an empty gap between Fleet runs and the description.
  `components/TicketFleetRuns.vue` shows the command as the raw code (`RUN`).
- R2-14: `flow_stopped` and `flow_questions` have no `notifications.kinds.*` key, so the inbox row and the bell
  show the API's English fallback title and, for `flow_stopped`, its server body
  (`SPEC_REVIEW job cmw82wqnx...: no verdict JSON in the agent output`): a raw step code and a raw job id. The
  flow detail page shows `flow.stopReason` raw (`verdict_unreadable`).
- R2-17: before any search the KB Search tab repeats the input placeholder ("Search the knowledge base...") as
  its empty state; the Documents tab says only "No documents yet."
- R2-18: admin users shows Role as a chip but Status as plain text, and the "Edit roles" button (with an icon)
  sits 2 px higher than "Disable" in the same cell (live: top 362 vs 364 px at 1440 px).
- R2-19: the audit log Project cell breaks `koda-dogfood` at the hyphen.
- R2-22: the timeline actor falls back to the raw id for agents: `useProjectMemberNames.nameOf` resolves users
  only, and `GET /projects/:slug/agents` (`ProjectAgentDto`) carries no agent `id` to map from.
- R2-23: the memory Retire dialog body reads "You are retiring: agent:<id>" (the raw subject) while the row shows
  "Agent cmutp0nw" (a short id, not the agent's name).
- R2-24: `components/CommentThread.vue` renders `comment.createdAt` raw (`2026-11-10T14:07:45.657Z`).
- R1-16: job detail stacks a 4-column grid (`FleetJobProgress`) over a 3-column one, and a finished job shows
  Progress, Current story, Phase and Last heartbeat as `-` plus several other empty `-` fields.
- R2-13 rest (live check §9.191, recounted): 16 raw selects still use `h-9` or `h-8` (BackendPicker x3,
  ApprovalPolicyDialog x5, ProjectMembersPanel x4, RoleEditorDialog, PrincipalRolesDialog, ProjectInvitesPanel,
  `pages/[project]/agents.vue`), while `Input` and `FILTER_CONTROL_CLASS` controls are 40 px.

## Design

Rulings (owner, 2026-11-12): R1-16 = one consistent 3-column grid, live-only fields (Progress, Current story,
Phase, Last heartbeat) only while the job is active, other empty fields hidden. R2-11 = collapsed assignee
picker (current assignee + Change, list on demand, closes after a pick). R2-9 = Delete Project moves to a
separate "Danger zone" card at the bottom of the Project tab and keeps its confirm.

Every new user-facing string gets a key in both `i18n/locales/en.json` and `i18n/locales/zh.json`.

### Integration

Read-only (verified, unchanged):

- `lib/form-control.ts` exports `FILTER_CONTROL_CLASS = 'h-10 rounded-md border border-input bg-background px-3 text-sm'`.
- `lib/fleet-i18n.ts` `codeLabel(t, te, prefix, code)` returns `t(prefix + '.' + code)` when that key exists,
  else `code`. `fleet.command.*` keys exist for `AGENT RUN PLAN CONFIG_EDIT CONFIG_DRIFT REVIEW FIX THREAD`
  (`RUN` = "Run").
- `lib/humanize-code.ts` `humanizeCode(code)` turns `verdict_unreadable` into `Verdict unreadable`.
- `lib/fleet-jobs.ts` `isActiveJobState(state)` is true for `QUEUED ASSIGNED RUNNING UPLOADING`.
- `lib/memory-subject.ts` `memorySubject(subject)` returns `{ type: 'ticket' | 'agent' | 'other', id, short }`.
- `composables/useProjectMemberNames.ts` `useProjectMemberNames(slug)` returns `{ members, load, nameOf }`;
  `nameOf(userId)` returns the member's name or email, the signed-in user's, or null.
- `lib/notifications.ts` `notificationText(n, i18n)` words a notification from `notifications.kinds.<kind>`
  with `n.params`, else returns `n.title`.
- API `apps/api/src/agents/prisma-agent.repository.ts` `findProjectRoster(projectId)` already selects
  `agent.id` (it maps memberships by `principalId`); it just does not return it.
- API flow stop reasons (`apps/api/src/fleet/flows/flow-step-decision.ts` `FlowStopReason` plus the service's
  `human_stop` and `approval_rejected`): `step_failed verdict_unreadable review_findings review_ambiguous
  calls_failed plan_no_result run_no_pr pr_not_ready cost_cap creator_lost_access budget_paused
  dispatch_refused pr_closed spec_changed human_stop approval_rejected`. The `flow_stopped` notification
  params are `{ flowId, feature, stopReason }`; `flow_questions` params are `{ flowId, feature, step, count }`.

Changed. The baseline exists only to locate the code; implement the target.

- API `apps/api/src/agents/dto/project-agent.dto.ts`
  - Baseline: `ProjectAgentRecord` and `ProjectAgentDto` have no `id`.
  - Target: both gain `id: string` (the Agent row id); `ProjectAgentDto.from` copies it and the DTO declares it
    with `@ApiProperty()`. `findProjectRoster` returns `id: row.agent.id`. `openapi.json` and the CLI types are
    regenerated with `bun run generate` from the repo root, never hand-edited.
- `composables/useProjectAgents.ts` `ProjectAgent` gains `id: string`.
- `composables/useProjectAgentNames.ts` (new) `useProjectAgentNames(slug)` returns `{ agents, load, nameOf }`.
  `load()` reads `GET /projects/:slug/agents` through `useApi()` and stores the response `items` in `agents`; `nameOf(agentId)` returns the
  roster agent's `name` for that `id`, else null. A failed `load()` rejects; callers catch it and keep falling
  back (see Failure Handling).
- `pages/[project]/timeline.vue` `actorName(actorId)`
  - Baseline: `memberNames.nameOf(actorId) ?? actorId`.
  - Target: `memberNames.nameOf(actorId) ?? agentNames.nameOf(actorId) ?? actorId`; the page calls
    `agentNames.load()` on mount beside `memberNames.load()`, each with its own `.catch`.
- `pages/[project]/memory.vue` subject label
  - Baseline: an agent subject renders `t('memory.subject.agent') + ' ' + subject.short`; the retire dialog gets
    `:item-label="retireTarget?.subject"` (raw).
  - Target: one page function `subjectLabel(item)` gives `Agent <name>` when `agentNames.nameOf(id)` resolves,
    else `Agent <short>`; `Ticket <short>` for a ticket subject; the raw subject otherwise. The row text and the
    dialog `item-label` both use it. The row keeps its `:title="item.subject"`, the ticket link, and the
    `{{ item.subject }}` mustache of the `v-else` branch for an other-type subject. The page calls
    `useProjectAgentNames(slug)` as an auto-imported composable (no explicit import), as `timeline.vue` calls
    `useProjectMemberNames`.
- `pages/[project]/settings.vue`
  - Baseline: `PageHeader :title="t('vcs.title')"`; first tab `t('projects.title')`; the first card heading
    `t('projects.settings.title')`; no danger zone.
  - Target: `PageHeader :title="t('projects.settings.title')"` ("Project Settings"); first tab
    `t('projects.settings.tab')` (new, "General" / "常规"); the first card heading
    `t('projects.settings.detailsTitle')` (new, "Project details" / "项目详情"). The VCS tab keeps its own
    `vcs.title` heading. Last in the Project tab, after the memory card and only once `projectData` loaded,
    renders `SettingsDangerZoneCard` with `:project="projectData"`.
- `components/SettingsDangerZoneCard.vue` (new) — a `rounded-md border border-destructive/50 p-6 space-y-4`
  card, `data-testid="settings-danger-zone"`, heading `t('projects.settings.dangerZone.title')` ("Danger zone"),
  text `t('projects.settings.dangerZone.description')` ("Deleting a project removes its tickets, settings and
  history. This cannot be undone."), and the destructive `projects.settings.delete` button,
  `data-testid="project-delete"`. Its `deleteProject()` is the one moved out of `SettingsProjectCard`
  unchanged: `window.confirm(t('projects.settings.deleteConfirm'))`, then
  `$api.delete(apiPath\`/projects/${props.project.slug}\`)`, success toast, `useRouter().push('/')`; on error
  `toast.error(extractApiError(err))`.
- `components/SettingsProjectCard.vue` keeps only the Save button in its button row; `deleteProject` and
  `deletingProject` move to the new card.
- `components/TicketProperties.vue` assignee block (when `canAssign`)
  - Baseline: `AssigneePicker` and the Unassign button always render under the assignee row.
  - Target: a `pickerOpen` ref (false). Closed: an outline `size="sm"` button `data-testid="assignee-change"`
    (`t('tickets.assignee.change')`, new, "Change" / "更改") beside the Unassign button; no `AssigneePicker`.
    Clicking Change sets `pickerOpen` true: `AssigneePicker` renders with a ghost `size="sm"` button
    `data-testid="assignee-cancel"` (`t('common.cancel')`) that sets it false. A successful
    `onAssigneeSelect` sets `pickerOpen` false; a failed one leaves it open.
- `pages/[project]/tickets/[ref].vue` grid
  - Baseline: `grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start`.
  - Target: adds `lg:grid-rows-[auto_1fr]`, so the rail's extra height goes to row 2 and row 1 stays as tall as
    the header and fleet runs.
- `components/TicketFleetRuns.vue` command chip: `codeLabel(t, te, 'fleet.command', row.run.command)`, with `const { t, te } = useI18n()`.
- `lib/format-date-time.ts` (new) `formatDateTime(iso: string, locale: string | undefined)` returns
  `new Date(iso).toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })`,
  or `iso` unchanged when it does not parse to a valid date.
- `components/CommentThread.vue` comment time
  - Baseline: `<span class="text-xs text-muted-foreground">{{ comment.createdAt }}</span>`.
  - Target: `<time class="text-xs text-muted-foreground" :datetime="comment.createdAt" data-testid="comment-time">{{ formatDateTime(comment.createdAt, commentLocale()) }}</time>`, with `const { t, locale } = useI18n()` and a script helper `commentLocale = () => unref(locale)` (templates unwrap the destructured ref, so the template must not read `.value`). An i18n stub without `locale` (the existing CommentThread specs use `enI18n()`, which returns only `t` and `te`) gives `undefined`, which formats in the runtime default locale.
- `components/fleet/FleetJobProgress.vue`
  - Baseline: `grid grid-cols-2 ... sm:grid-cols-4`; Progress, Current story, Phase and Cost always render.
  - Target: `grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3`; the Progress, Current story and Phase
    items render only when `isActiveJobState(job.state)`; Cost always renders.
- `pages/[project]/fleet/jobs/[id]/index.vue` detail `dl` (already `sm:grid-cols-3`)
  - Baseline: every item renders, empty values as `-`.
  - Target: Runner, Requester, Bash (non-config job) and Queued always render. Last heartbeat renders only when
    the job is active. Profiles only when `job.profiles` is non-empty; Started only when `startedAt`; Finished
    only when `finishedAt`; Finish result only when `finishResult` (and not a config job); Branch only when
    `resultBranch` or the WIP-push status (`wipPush`) is set, since that `dd` is the only place the push status shows; Pull request only when `prUrl` or `resultPrUrl`. Plan from and Tickets keep their conditions.
- `lib/notifications.ts` gains `notificationDetail(n, i18n)`: for kind `flow_stopped` with a string
  `params.stopReason`, `codeLabel(t, te, 'fleet.flows.stopReason', stopReason)` but with `humanizeCode(stopReason)`
  in place of the raw code when no key exists; for every other kind, `n.body`.
- `pages/notifications.vue` and `components/NotificationBell.vue` render `notificationDetail(item, i18n)` where
  they rendered `item.body` (same `v-if` on a non-empty value).
- New i18n keys: `notifications.kinds.flow_stopped` ("Flow {feature} stopped" / "流程 {feature} 已停止"),
  `notifications.kinds.flow_questions` ("Flow {feature} needs {count} answer(s)" / "流程 {feature} 需要 {count} 个回答"),
  and `fleet.flows.stopReason.<reason>` for the 16 reasons listed above.
- `pages/[project]/flows/[id].vue` stop reason `dd`: the same label rule as `notificationDetail` (key, else
  `humanizeCode`), `data-testid="flow-stop-reason"`.
- `pages/[project]/kb.vue`
  - Baseline: the pre-search block renders `t('kb.search.placeholder')`; the documents empty block renders
    `t('kb.documents.empty')` only.
  - Target: the pre-search block, `data-testid="kb-search-prompt"`, renders `t('kb.search.promptTitle')`
    ("Search this project's knowledge") and `t('kb.search.promptHint')` ("Type a question or keywords above and
    press Search. Results come from the documents indexed for this project."). The documents empty block,
    `data-testid="kb-documents-empty"`, adds `t('kb.documents.emptyHint')` ("Add a document to make it
    searchable.") under the existing text.
- `pages/admin/users.vue`
  - Status cell, baseline: plain text. Target: `<Badge variant="outline" data-testid="user-status-chip" :data-status="user.disabled ? 'disabled' : 'active'">`
    with a leading dot `span` (`h-1.5 w-1.5 rounded-full`, `bg-status-done` when active, `bg-status-rejected`
    when disabled, `aria-hidden="true"`) and the same `admin.users.status.*` text.
  - Actions cell, baseline: `<TableCell class="space-x-2 text-right">` with the buttons inline. Target: the
    cell holds one `div` `data-testid="user-actions"` with class `flex items-center justify-end gap-2`, and
    the Disable/Enable button gains `data-testid="user-toggle-disabled"`.
- `pages/admin/audit.vue` Project `TableCell` (the one holding the existing `audit-project` button, which keeps its testid): adds `whitespace-nowrap` and `data-testid="audit-project-cell"`.
- The 16 raw selects use `FILTER_CONTROL_CLASS` in place of their `h-9`/`h-8 rounded-md border border-input
  bg-background px-2|px-3 text-sm` base, keeping their other classes and every id, `data-testid`, binding and
  handler:

  | file | select(s) | extra classes kept |
  |:--|:--|:--|
  | `components/fleet/threads/BackendPicker.vue` | `#thread-backend-agent`, `#thread-backend-model`, `#thread-backend-effort` | `w-full` |
  | `components/approvals/ApprovalPolicyDialog.vue` | `#policy-subject-kind`, `#policy-principal-type`, `#policy-role` (rendered only while the subject kind is `role`), `#policy-mode`, `#policy-on-timeout` | `w-full` |
  | `components/ProjectMembersPanel.vue` | `member-add-role`, `agent-add-select`, `agent-add-role`, `member-chip-add-role` | `max-w-xs` on `agent-add-select` |
  | `components/RoleEditorDialog.vue` | `#role-scope` | `w-full` |
  | `components/PrincipalRolesDialog.vue` | `binding-role-select` | `w-full` |
  | `components/ProjectInvitesPanel.vue` | `invite-role` | none |
  | `pages/[project]/agents.vue` | the row status select | `disabled:cursor-not-allowed disabled:opacity-50` |

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `agentNames.load()` rejects (no permission, network) | No toast. Timeline shows the raw actor id; memory shows `Agent <short>` in the row and the dialog. |
| `formatDateTime` gets a value that is not a valid date | Returns the value unchanged. |
| `flow_stopped` with no string `stopReason` param | `notificationDetail` returns `n.body`. |
| Assign request fails | Error toast as today (`extractApiError`); the picker stays open. |
| Delete project fails | Error toast (`extractApiError`); the page stays. |

## Out of Scope

- R2-21 (slow repo nax config page) stays open as its own item; R1-14 was not reproduced.
- The audit tracker (`docs/ux/redesign/AUDIT-2026-11.md`) is updated by hand on this branch, not by a story.
- Notification kinds other than `flow_stopped` and `flow_questions` keep their current wording; the API's English fallback titles and bodies are unchanged.
- The `flow_questions` body (the question text) is shown as is.
- Agent names come only from the project agent roster; an agent no longer on the roster shows its raw id (timeline) or short id (memory).
- The project agent roster DTO gains only `id`; no other API field, route or permission changes.
- Delete Project keeps the `window.confirm` dialog; no typed-name confirmation is added.
- The Unassign button keeps its current visibility rule.
- Job detail: the Plan from and Tickets items, the pipeline and the open-items panel keep their current conditions.
- Measured sizes, alignment and wrapping are checked in the post-merge live sweep on koda-wk, not in unit tests (jsdom has no layout).
- Selects already on `FILTER_CONTROL_CLASS` or `FleetNativeSelect`, and Shadcn `Select` components, are unchanged.

## Stories

### US-001: The project agent roster carries the agent id

No dependencies. Workdir: `apps/api`.

Add `id` to `ProjectAgentRecord` and `ProjectAgentDto` (with `@ApiProperty()`), return `id: row.agent.id` from
`findProjectRoster`, and regenerate `openapi.json` and the CLI types with `bun run generate` from the repo root.
The existing `src/agents/prisma-agent.repository.find-roster.spec.ts` keys agent ids by slug, so the id test goes in a new spec (see Creates); the controller route
spec is `src/projects/projects.controller.spec.ts`.

### US-002: Agents named by name on the timeline and in memory

Depends on US-001. Workdir: `apps/web`.

Add `id` to the web `ProjectAgent`, create `composables/useProjectAgentNames.ts`, use it in the timeline actor
column and in the memory subject label for both the row and the retire dialog, per Design § Integration.

### US-003: Project settings title, General tab and Danger zone card

No dependencies. Workdir: `apps/web`.

Fix the settings page title, first tab and first card heading, create `SettingsDangerZoneCard.vue` with the
delete flow moved from `SettingsProjectCard.vue`, and render it last in the Project tab.

### US-004: Ticket detail: collapsed assignee picker, no gap above the description, named command, readable comment times

No dependencies. Workdir: `apps/web`.

Collapse the assignee picker behind Change, add `lg:grid-rows-[auto_1fr]` to the ticket page grid, label the
fleet run command with `codeLabel`, and create `lib/format-date-time.ts` for the comment time in
`CommentThread.vue`.

### US-005: Job detail: one 3-column grid, live fields only while active, empty fields hidden

No dependencies. Workdir: `apps/web`.

Change `FleetJobProgress.vue` to the 3-column grid with live-only items, and hide the empty items of the job
detail `dl`, per Design § Integration.

### US-006: Flow stop reasons and KB empty states in words

No dependencies. Workdir: `apps/web`.

Add the flow notification kinds and stop reason keys, `notificationDetail` in `lib/notifications.ts`, use it in
the inbox page and the bell, label the flow page stop reason, and give the KB its prompt and empty hint.

### US-007: Admin tables and the remaining raw selects

No dependencies. Workdir: `apps/web`.

Admin users gets a status chip and an aligned actions row, the audit log project cell stops wrapping, and the
16 raw selects use `FILTER_CONTROL_CLASS`.

### Context Files

**US-001**

- `apps/api/src/agents/dto/project-agent.dto.ts`
- `apps/api/src/agents/prisma-agent.repository.ts`
- `apps/api/src/agents/prisma-agent.repository.find-roster.spec.ts`
- `apps/api/src/projects/projects.controller.spec.ts`

**US-002**

- `apps/web/composables/useProjectAgents.ts`
- `apps/web/composables/useProjectMemberNames.ts`
- `apps/web/pages/[project]/timeline.vue`
- `apps/web/pages/[project]/memory.vue`
- `apps/web/tests/pages/memory-readable.spec.ts` — the memory page mount harness to reuse

**US-003**

- `apps/web/pages/[project]/settings.vue`
- `apps/web/components/SettingsProjectCard.vue`
- `apps/web/tests/components/settings-project-card.spec.ts`
- `apps/web/tests/pages/settings-vcs-tab.spec.ts` — the settings page mount harness to reuse

**US-004**

- `apps/web/components/TicketProperties.vue`
- `apps/web/components/TicketFleetRuns.vue`
- `apps/web/components/CommentThread.vue`
- `apps/web/pages/[project]/tickets/[ref].vue`
- `apps/web/lib/fleet-i18n.ts`

**US-005**

- `apps/web/components/fleet/FleetJobProgress.vue`
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/lib/fleet-jobs.ts`
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — the job page mount harness to reuse

**US-006**

- `apps/web/lib/notifications.ts`
- `apps/web/pages/notifications.vue`
- `apps/web/components/NotificationBell.vue`
- `apps/web/pages/[project]/flows/[id].vue`
- `apps/web/pages/[project]/kb.vue`

**US-007**

- `apps/web/pages/admin/users.vue`
- `apps/web/pages/admin/audit.vue`
- `apps/web/lib/form-control.ts`
- `apps/web/components/ProjectMembersPanel.vue`
- `apps/web/components/approvals/ApprovalPolicyDialog.vue`

### Creates

**US-001**

- `apps/api/src/agents/dto/project-agent.dto.spec.ts`
- `apps/api/src/agents/project-agent-openapi.contract.spec.ts`
- `apps/api/src/agents/prisma-agent.repository.roster-id.spec.ts` — a new harness for AC-2; the existing find-roster spec keys agent ids by slug, so it cannot hold an id different from the slug

**US-002**

- `apps/web/composables/useProjectAgentNames.ts`
- `apps/web/tests/composables/use-project-agent-names.spec.ts`
- `apps/web/tests/pages/timeline-agent-actor.spec.ts`
- `apps/web/tests/pages/memory-agent-subject.spec.ts`

**US-003**

- `apps/web/components/SettingsDangerZoneCard.vue`
- `apps/web/tests/components/settings-danger-zone-card.spec.ts`
- `apps/web/tests/pages/settings-page-title.spec.ts`

**US-004**

- `apps/web/lib/format-date-time.ts`
- `apps/web/tests/lib/format-date-time.spec.ts`
- `apps/web/tests/components/ticket-assignee-collapsed.spec.ts`
- `apps/web/tests/components/comment-thread-time.spec.ts`
- `apps/web/tests/pages/ticket-detail-grid.spec.ts`

**US-005**

- `apps/web/tests/pages/fleet-job-detail-fields.spec.ts`

**US-006**

- `apps/web/tests/lib/notification-detail.spec.ts`
- `apps/web/tests/pages/notifications-flow-kinds.spec.ts`
- `apps/web/tests/pages/flow-stop-reason.spec.ts`
- `apps/web/tests/pages/kb-empty-states.spec.ts`

**US-007**

- `apps/web/tests/pages/admin-users-status.spec.ts`
- `apps/web/tests/pages/admin-audit-project-cell.spec.ts`
- `apps/web/tests/components/raw-select-height.spec.ts`

### Modifies

**US-001**

- `openapi.json` — regenerated by `bun run generate` from the repo root so `ProjectAgentDto` lists `id`; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — the CLI types regenerated by bun run generate together with the root OpenAPI document, so ProjectAgentDto gains id; never hand-edited.

**US-002**

- `apps/web/tests/pages/memory-readable.spec.ts` — the page now also calls the `useProjectAgentNames` composable (US-002); the harness gains a stub for it returning `{ nameOf: () => null, load: async () => undefined }`, provided the same way the harness provides its other composables (a global or an alias), so no extra API call is made and every existing assertion stays.
- `apps/web/tests/pages/memory-retire-visibility.spec.ts` — the page now also calls the `useProjectAgentNames` composable (US-002); the harness gains a stub for it returning `{ nameOf: () => null, load: async () => undefined }`, provided the same way the harness provides its other composables (a global or an alias), so no extra API call is made and every existing assertion stays.
- `apps/web/tests/pages/memory-retire-flow.spec.ts` — the page now also calls the `useProjectAgentNames` composable (US-002); the harness gains a stub for it returning `{ nameOf: () => null, load: async () => undefined }`, provided the same way the harness provides its other composables (a global or an alias), so no extra API call is made and every existing assertion stays.
- `apps/web/tests/pages/memory-mount.spec.ts` — the page now also calls the `useProjectAgentNames` composable (US-002); the harness gains a stub for it returning `{ nameOf: () => null, load: async () => undefined }`, provided the same way the harness provides its other composables (a global or an alias), so no extra API call is made and every existing assertion stays.
- `apps/web/tests/pages/timeline-readable.spec.ts` — the page now also calls the `useProjectAgentNames` composable (US-002); the harness gains a stub for it returning `{ nameOf: () => null, load: async () => undefined }`, provided the same way the harness provides its other composables (a global or an alias), so no extra API call is made and every existing assertion stays.
- `apps/web/tests/pages/memory.spec.ts` — its createRenderContext renders the page template with a hand-built context that has memorySubject but no subjectLabel; the context gains `subjectLabel: (item) => item.subject`, and the source test that expects a mustache interpolating item.subject keeps passing because the v-else branch keeps it.
- `apps/web/tests/pages/filter-select-height.spec.ts` — the page now also calls the `useProjectAgentNames` composable (US-002); the harness gains a stub for it returning `{ nameOf: () => null, load: async () => undefined }`, provided the same way the harness provides its other composables (a global or an alias), so no extra API call is made and every existing assertion stays.

**US-003**

- `apps/web/tests/openapi/web-gap-ops.spec.ts` — the test "project settings uses GET/PATCH/DELETE /projects/:slug" asserts the project DELETE call lives in the SettingsProjectCard component; the delete now lives in the new SettingsDangerZoneCard component, so the test reads that component's source for the DELETE call and keeps the GET (page) and PATCH (project card) checks.

**US-004**

- `apps/web/tests/components/ticket-fleet-runs.spec.ts` — the test asserting the `ticket-fleet-run-command` chip text is `RUN` now expects the label `Run`, the `fleet.command.RUN` translation.
- `apps/web/tests/pages/project-permission-gates.spec.ts` — the US-007 AC-1 test expects `assignee-search` with only `ticket.assign`; the picker is now collapsed, so the test expects the `assignee-change` button instead (and its control case expects no `assignee-change`), keeping the Unassign, label, link and delete checks.
- `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` — the assign step fills `assignee-search` directly; it now clicks `assignee-change` first, then fills `assignee-search` and picks the option as before.

**US-005**

- `apps/web/tests/components/fleet-job-progress.spec.ts` — the `job()` fixture has no `state`, so Progress, Current story and Phase would no longer render; the fixture gains `state: 'RUNNING'` and every existing assertion stays.

**US-006**

- `apps/web/tests/pages/fleet-flow-detail.spec.ts` — the AC-6 test mounts a flow with stopReason failed and an i18n stub whose te returns false, and asserts the page text contains lowercase failed; the stop reason now falls back to humanizeCode, so it expects Failed and keeps the stop detail and ticket checks.

The checked specs that need no change: `tests/components/settings-project-card.spec.ts` tests only the
brief, name and description save paths; `tests/e2e/vcs-integration-settings.e2e.spec.ts` finds "VCS
Integration Settings" on the VCS tab, whose heading is kept; `tests/components/CommentThread*.spec.ts` pin no
time text and their `enI18n()` stub has no `locale`, which the Design handles (one fixture uses `createdAt: 'now'`, which `formatDateTime` returns unchanged);
`tests/components/fleet-job-stories.spec.ts` tests a different component's `fleet-job-story` rows;
`tests/e2e/fleet-dispatch.e2e.spec.ts` reads `fleet-job-cost` (always renders), `fleet-job-story` on a RUNNING job, and `fleet-job-finish` and `fleet-job-pr` on a COMPLETED job with those values set, so all still render.

### Seams

**US-002**: `ProjectAgent.id` and the roster `id` come from US-001. `useProjectAgentNames` (new export) is
consumed in the same story by `timeline.vue` and `memory.vue`; the page ACs mount each page with the roster API
stubbed and assert the agent's name in the rendered cell or dialog, which proves the wiring.

**US-003**: `SettingsDangerZoneCard` (new component) is consumed in the same story by `settings.vue`; AC US-003-4
must mount the page with the real `SettingsDangerZoneCard` registered (the existing settings harnesses stub
components through `uiStubs`), so the assertion proves the page renders it.

**US-004**: `formatDateTime` (new export of `lib/format-date-time.ts`) is consumed in the same story by
`CommentThread.vue`; AC US-004-9 mounts the component and asserts the rendered time.

**US-006**: `notificationDetail` (new export of `lib/notifications.ts`) is consumed in the same story by
`pages/notifications.vue` and `components/NotificationBell.vue`; ACs US-006-6 and US-006-7 mount each and assert
the rendered stop reason text.

## Acceptance Criteria

### US-001

1. [unit] `ProjectAgentDto.from` given a record with `id` `agent-1`, slug `bot` and the other roster fields returns a DTO whose `id` is `agent-1`.
2. [unit] `findProjectRoster('proj-1')`, with the Prisma client stubbed to return one AGENT membership whose `principalId` is `agent-1` and one agent row whose `id` is `agent-1` and slug `bot`, returns a record whose `id` is `agent-1` and slug `bot`.
3. [unit] Parsing the committed `openapi.json` (the pattern of `src/fleet/fleet-openapi.contract.spec.ts`), the `ProjectAgentDto` schema has an `id` property of type `string` and lists `id` in its `required` array.

### US-002

1. [unit] `useProjectAgentNames('web').load()` calls `GET /projects/web/agents` through `useApi()`.
2. [unit] After `load()` resolves with items `[{ id: 'agent-1', name: 'Probe Bot', slug: 'probe' }]`, `nameOf('agent-1')` returns `Probe Bot`.
3. [unit] After the same load, `nameOf('agent-2')` returns null.
4. [unit] Mounting `pages/[project]/timeline.vue` with one event whose `actorId` is `agent-1`, the members API returning no member with that id and the agents API returning `{ id: 'agent-1', name: 'Probe Bot' }`, renders `Probe Bot` in that event's actor cell.
5. [unit] On the same mount, an event whose `actorId` is `user-1`, a member named `Ada`, still renders `Ada` in the actor cell.
6. [unit] Mounting the timeline page with the agents API rejecting renders the raw `agent-1` in the actor cell and shows no error toast for the agents read.
7. [unit] Mounting `pages/[project]/memory.vue` (permissions stubbed with `memory.decision.retire`, as `tests/pages/memory-retire-visibility.spec.ts` does) with an active `DECISION` item whose subject is `agent:agent-1` and the agents API returning `{ id: 'agent-1', name: 'Probe Bot' }` renders `Agent Probe Bot` in that row's subject cell.
8. [unit] On that mount, opening the item's Retire dialog passes `Agent Probe Bot` as the dialog's `item-label`.
9. [unit] Mounting the memory page with the agents API rejecting renders `Agent agent-1` (the first 8 characters of the id) in the row and passes the same text as the dialog's `item-label`.
10. [unit] On the same permission stub, opening the Retire dialog for an active `DECISION` item whose subject is `ticket:ticket-123456789` passes `Ticket ticket-1` as the `item-label`.

### US-003

1. [unit] Mounting `pages/[project]/settings.vue` renders the `PageHeader` with title `Project Settings`.
2. [unit] On that mount the first tab trigger (value `project`) reads `General`.
3. [unit] On that mount the first card heading reads `Project details`.
4. [unit] Once the project loads, the Project tab renders `settings-danger-zone` after the memory card, as the last child of the Project tab content.
5. [unit] Mounting `SettingsProjectCard` with a project renders no `Delete Project` button.
6. [unit] Mounting `SettingsDangerZoneCard` with project slug `web` renders the heading `Danger zone` and a `project-delete` button reading `Delete Project`.
7. [unit] Clicking `project-delete` with `window.confirm` returning true calls `$api.delete` with `/projects/web`, shows the `projects.settings.deleted` success toast and pushes the router to `/`.
8. [unit] Clicking `project-delete` with `window.confirm` returning false makes no `$api.delete` call.
9. [unit] Clicking `project-delete` with `$api.delete` rejecting shows `extractApiError` of that error as an error toast and does not push the router.

### US-004

1. [unit] Mounting `TicketProperties` with `canAssign` true renders an `assignee-change` button reading `Change` and no `assignee-search` input.
2. [unit] Clicking `assignee-change` renders the `AssigneePicker` (`assignee-search` present) and an `assignee-cancel` button.
3. [unit] With the picker open, clicking `assignee-cancel` removes `assignee-search`.
4. [unit] With the picker open, picking an option whose assign POST resolves removes `assignee-search` (the picker closes).
5. [unit] With the picker open, picking an option whose assign POST rejects keeps `assignee-search` rendered and shows the error toast.
6. [unit] Mounting `TicketProperties` with `canAssign` false renders neither `assignee-change` nor `assignee-search`.
7. [unit] Mounting `pages/[project]/tickets/[ref].vue` with a loaded ticket renders the page grid with class `lg:grid-rows-[auto_1fr]`.
8. [unit] Mounting `TicketFleetRuns` with a run whose `command` is `RUN` renders `Run` in that row's `ticket-fleet-run-command` chip.
9. [unit] Mounting `CommentThread` with an i18n stub whose `locale` is a ref holding `en` and a comment whose `createdAt` is `2026-11-10T14:07:45.657Z` renders a `comment-time` `time` element whose `datetime` is `2026-11-10T14:07:45.657Z` and whose text equals `formatDateTime('2026-11-10T14:07:45.657Z', 'en')`; with the locale ref holding `zh` instead, the text equals `formatDateTime('2026-11-10T14:07:45.657Z', 'zh')`.
10. [unit] `formatDateTime('2026-11-10T14:07:45.657Z', 'en')` returns a string that includes `Nov` and `2026` and does not include `T14`.
11. [unit] `formatDateTime('now', 'en')` returns `now`.

### US-005

1. [unit] Mounting `FleetJobProgress` with a `RUNNING` job renders `fleet-job-progress`, `fleet-job-story`, `fleet-job-phase` and `fleet-job-cost`.
2. [unit] Mounting `FleetJobProgress` with a `COMPLETED` job renders `fleet-job-cost` and none of `fleet-job-progress`, `fleet-job-story` or `fleet-job-phase`.
3. [unit] `FleetJobProgress` renders its `dl` with classes `grid-cols-1` and `sm:grid-cols-3` and without `sm:grid-cols-4`.
4. [unit] Mounting the job detail page with a `COMPLETED` job whose `lastHeartbeatAt` is set renders no Last heartbeat item (`fleet.jobs.detail.heartbeat` label absent).
5. [unit] Mounting the job detail page with a `RUNNING` job whose `lastHeartbeatAt` is set renders the Last heartbeat item.
6. [unit] Mounting the job detail page with a `COMPLETED` job whose `profiles` is empty, `finishResult`, `resultBranch`, `resultPrUrl` and `startedAt` null renders none of the Profiles, Finish result, Branch, Pull request or Started labels.
7. [unit] On that mount the Runner, Requester and Queued labels still render.
8. [unit] Mounting the job detail page with a `COMPLETED` job whose `finishResult` is `promoted` and `resultBranch` is `feat/x` renders the Finish result item reading `promoted` and the Branch item reading `feat/x`.
9. [unit] Mounting the job detail page with a `CANCELLED` RUN job whose `resultBranch` is null and `wipPush` is `failed:auth` renders the Branch item with the `fleet.jobs.detail.wipPush.failed` text.

### US-006

1. [unit] `notificationDetail` for a `flow_stopped` notification with `params.stopReason` `verdict_unreadable` and the English messages returns the `fleet.flows.stopReason.verdict_unreadable` translation.
2. [unit] `notificationDetail` for a `flow_stopped` notification with `params.stopReason` `brand_new_reason` (no key) returns `Brand new reason`.
3. [unit] `notificationDetail` for a `flow_stopped` notification with no `stopReason` param returns its `body`.
4. [unit] `notificationDetail` for a `job_failed` notification returns its `body` unchanged.
5. [unit] `notificationText` for a `flow_stopped` notification with `params.feature` `f12-max` and the English messages returns `Flow f12-max stopped`.
6. [unit] Mounting `pages/notifications.vue` with one `flow_stopped` record (stopReason `verdict_unreadable`, body `SPEC_REVIEW job cmw82: no verdict JSON`) renders the stop reason translation in that row and not the text `SPEC_REVIEW`.
7. [unit] Mounting `NotificationBell` with the same record renders the stop reason translation and not the text `SPEC_REVIEW`.
8. [unit] Mounting `pages/[project]/flows/[id].vue` with a flow whose `stopReason` is `verdict_unreadable` renders the `fleet.flows.stopReason.verdict_unreadable` translation in `flow-stop-reason`.
9. [unit] Mounting `pages/[project]/kb.vue` before any search renders `kb-search-prompt` with the `kb.search.promptTitle` and `kb.search.promptHint` texts and not the `kb.search.placeholder` text.
10. [unit] Mounting the KB page with no documents and switching to the Documents tab renders `kb-documents-empty` with the `kb.documents.empty` and `kb.documents.emptyHint` texts.
11. [unit] Every new key (`notifications.kinds.flow_stopped`, `notifications.kinds.flow_questions`, the 16 `fleet.flows.stopReason.*` keys, `kb.search.promptTitle`, `kb.search.promptHint`, `kb.documents.emptyHint`) resolves to a non-empty string in both the `en` and the `zh` locale messages.

### US-007

1. [unit] Mounting `pages/admin/users.vue` with an active user renders that row's `user-status-chip` with `data-status` `active` and the text `Active`.
2. [unit] On the same mount a disabled user's `user-status-chip` has `data-status` `disabled` and the text `Disabled`.
3. [unit] On that mount each row's `user-actions` element has classes `flex`, `items-center` and `justify-end` and holds the `user-toggle-disabled` button.
4. [unit] Mounting `pages/admin/audit.vue` with one entry whose project is `koda-dogfood` renders that row's `audit-project-cell` table cell with class `whitespace-nowrap`, and the `audit-project` button inside it still reads the project label.
5. [unit] Mounting `BackendPicker` renders `#thread-backend-agent`, `#thread-backend-model` and `#thread-backend-effort` each with classes `h-10` and `w-full` and without `h-9`.
6. [unit] Mounting `ApprovalPolicyDialog` open renders `#policy-subject-kind`, `#policy-principal-type`, `#policy-mode` and `#policy-on-timeout` each with class `h-10` and without `h-9`; after the subject kind is set to `role`, `#policy-role` also has class `h-10`.
7. [unit] Mounting `ProjectMembersPanel` with one member and one agent to add renders `member-add-role`, `agent-add-select` and `agent-add-role` each with class `h-10`, and `agent-add-select` keeps `max-w-xs`.
8. [unit] On that mount the `member-chip-add-role` select has class `h-10` and not `h-8`.
9. [unit] Mounting `RoleEditorDialog` open renders `#role-scope` with class `h-10`.
10. [unit] Mounting `PrincipalRolesDialog` open renders `binding-role-select` with class `h-10`.
11. [unit] Mounting `ProjectInvitesPanel` renders `invite-role` with class `h-10`.
12. [unit] Mounting `pages/[project]/agents.vue` with one rostered agent renders that row's status select with classes `h-10` and `disabled:opacity-50` and without `h-8`.
