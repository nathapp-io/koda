# SPEC: permissions-p3-web — the unified approvals inbox and the policy pages

## Summary

This feature is 7b of P3 feature 7 (`p3-web`), which the user split three ways on 2026-10-30:
- 7a `permissions-p3-web-api`: the API additions. Merged as #354 and deployed at `126c2467`.
- 7b (this spec): the web pages.
- 7c `permissions-p3-retire-fleet-approvals`: retiring the fleet approval API adapters.

It moves every web surface that reads approvals onto the approval engine (`/approvals`). It adds the policy pages that §6 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` lists for P3. It deletes the web's fleet inbox. Everything is in `apps/web`; the API is unchanged.

| Story | What |
|:--|:--|
| US-001 | Engine client: `lib/approval-requests.ts`, `useApprovalInbox`, `useProjectRef`, `PermissionSet.mayDecide`, the `approval_request` live handler, key labels |
| US-002 | Unified inbox list at `/approvals` and `/[project]/approvals`: tabs, rows, opening a row, live reload |
| US-003 | The decide panel for every key, decisions and cancel |
| US-004 | Bash and budget panels and the settled outcome |
| US-005 | Approval toasts and the home "needs you" card on the engine |
| US-006 | Header badge on `GET /approvals/counts`, nav links and the command palette |
| US-007 | Job page approvals, the budget banner and the fleet links on the engine |
| US-008 | Global approval policy page `/admin/approval-policies` |
| US-009 | Project approval policy page `/[project]/approval-policies` |
| US-010 | Terminal cleanup: redirect the two fleet inbox pages, delete the fleet inbox web code |

The user approved an 8-story list on 2026-10-30. The inbox story is split in three (US-002, US-003 and US-004) so each stays under the 15-AC gate. Scope is unchanged.

The feature is one capability, the web's move onto the engine inbox, so it is not split into separate features despite its 10 stories.

## Motivation

The web still reads approvals through the fleet adapters:
- `GET /fleet/approvals`, `GET /projects/:slug/fleet/approvals` and `GET /fleet/approval-counts`;
- `FleetApprovalDto`;
- the `fleet_approval` live event.

Those adapters cover only the two fleet keys (`fleet.job.shell.escalate` and `fleet.budget.override`). An agent write that a policy holds for a human (any of the 126 gated routes) shows up in no web inbox. A human can decide it only through `POST /approvals/:id/decisions`.

The redesign doc (§6 "P3 pages") asks for three pages:
- a unified approvals inbox (`approval.decide*`), which replaces the fleet and assistant inboxes;
- global approval policies (`approval.policy.manage`): per key, the floor, the default mode and the overrides;
- project approval policies (Project Admin): the project's overrides.

7a added what the web needs from the API:
- `GET /approvals/counts`;
- the `jobId` list filter;
- per-key `details` on `GET /approvals/:id`;
- home "needs you" for every key.

7c deletes the fleet adapters once nothing in the web calls them. This feature is what makes that true.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **New modules beside the old ones, then delete the old ones.**
  - The engine client, the inbox and its panels are new files: `lib/approval-requests.ts`, `lib/approval-request-fleet.ts`, `composables/useApprovalInbox.ts`, and `components/approvals/*`.
  - Three existing components are rewritten in place instead, so the specs and the layout that refer to them by name keep working: `components/fleet/ApprovalBadge.vue` (US-006), and `components/fleet/JobApprovals.vue` and `components/fleet/BudgetBanner.vue` (US-007).
  - US-010 deletes the fleet-only code.
- **The list API does not return fleet detail fields; details load for the open row.**
  - `ApprovalRequestSummaryDto` has no `input`, `jobId` or `details`. The inbox shows each row from summary fields:
    - the key label;
    - the requester;
    - the project;
    - the countdown.
  - It fetches `GET /approvals/:id` only for the row it opens.
  - The two surfaces that need a field from `input` fetch the detail per row through `useApprovalInbox().listDetailed(filters, limit)`:
    - the job page, for its command previews;
    - the budget banner, for its `policyId`.
  - `listDetailed` details only the first `limit` rows in the order it is given (`DETAIL_FETCH_LIMIT = 20`). A row past the limit, or one whose detail fetch fails, has `detail: null` and shows the key label.
- **Who sees which controls comes from the row, not from the caller's keys.**
  - `.nax/rules/web.md` says to gate a control on the key its route requires. Here that key is `approval.decide`, and the API checks it per request: pattern, `approverMustHoldAction`, self mode. The browser cannot repeat that check.
  - `GET /approvals` already returns only the requests the caller may see. That is their own requests plus everything their decide scopes cover, narrowed patterns included.
  - So `viewerActions(request, userId)` decides from the row alone.
  - The caller is the **requester** when `actorType === 'USER'` and `actorId === userId`:
    - a pending own request shows Cancel;
    - it shows the decide controls only when `requiredMode === 'self'`.
  - Every other pending request shows the decide controls and no Cancel. A settled request shows neither.
  - A refused decide surfaces through `extractApiError`, as `web.md` requires.
- **The badge counts what the list lists.** `GET /approvals/counts` counts visible pending requests, the caller's own included, so the badge can count an own request the caller cannot decide. That is accepted: the badge, the Pending tab and the home card agree on one number (7a's rule).
- **`PermissionSet.mayDecide()`.** The nav and the palette need to know "may decide something". That is either `approval.decide` or any narrowed `approval.decide@<pattern>` key, which `has()` cannot answer. `permissionSet` gains `mayDecide()`; `EMPTY_PERMISSIONS.mayDecide()` answers `false`.
- **Project nav links live in a slug-keyed child component.**
  - `useProjectPermissions(slug)` takes a fixed slug, so `layouts/default.vue` cannot read project keys for a route that changes.
  - US-006 adds `components/approvals/ProjectApprovalNavLinks.vue` (prop `slug`). It reads `useProjectPermissions(slug)` and renders the two project links.
  - The layout mounts it in the project block with `:key="projectSlug"`, as it mounts the badge.
  - The layout's script gains no new auto-import, because the three layout specs that evaluate it list their auto-imports by hand.
- **Engine decision bodies for the fleet keys.** Bodies follow each command's `parseDecision` (`apps/api/src/fleet/approvals/commands/`):

  | Choice | Body |
  |:--|:--|
  | bash Allow | `{ decision: 'approve', params: { choice: 'allow' } }` |
  | bash Allow for this job | `{ decision: 'approve', params: { choice: 'allow_for_job' } }` |
  | bash Deny | `{ decision: 'reject', params: { choice: 'deny' } }` |
  | budget Raise | `{ decision: 'approve', params: { amountUsd: <number>, requeueJobIds: [<ids>] } }` (`requeueJobIds` always sent, `[]` when none is ticked) |
  | budget Keep paused | `{ decision: 'reject' }` |
  | any other key | `{ decision: 'approve' \| 'reject' }` |

  Every body may carry a trimmed, non-blank `comment` of at most `MAX_REQUEST_COMMENT = 2000` characters, the engine DTO's limit.

  Every panel validates its comment with the zod schema `buildCommentSchema(t)` from `lib/approval-requests.ts`, as `web.md` asks for schema-backed forms. The budget panel validates with `buildBudgetRaiseSchema(t, spentUsd)` from `lib/approval-request-fleet.ts`: the amount through `raiseAmountError`, the comment through the same 2000-character rule.
- **Fleet payloads parse with the existing pure helpers.** Validation is not duplicated:
  - a bash request's `input.payload` goes through `bashPayload({ type: 'nax_bash_escalate', payload })`;
  - a budget request's `input` goes through `budgetPayload({ type: 'budget_override_required', payload: input })`.
  - The bash delivery state goes through `deliveryView({ type: 'nax_bash_escalate', resolvedBy: details.resolvedBy, outcome: details.outcome })`.
  - These helpers stay in `lib/fleet-approvals.ts` after US-010.
- **Key labels.** `requestKeyLabel(t, te, key)` answers `approvals.keys.<key with '.' replaced by '_'>` when that i18n key exists, else the raw key. Only the two fleet keys get labels in this feature.
- **Project names in the global inbox.** `/approvals` resolves a row's slug from `useFleetRepos().loadProjects()` (`GET /projects`), the list the old admin inbox used. A row whose project is not in that list shows its `projectId`. A row with `projectId: null` shows `approvals.inbox.noProject`.
- **Requester names.** A user requester shows the name that a lookup resolves, else their id:
  - `useProjectMemberNames(slug)` on `/[project]/approvals`;
  - `useAdminUsers()` on `/approvals`. It needs `user.read`, so a caller without it sees ids.

  An agent requester shows its id.
- **Project inbox.** `/[project]/approvals` resolves the project id from `GET /projects/:slug` (`useProjectRef(slug)`) and lists with `projectId=<id>`. `/approvals` lists everything the caller can see, with no project filter.
- **Badge numbers and targets.**
  - The badge shows `counts.total` on every page, the one number the home card and the Pending tab of `/approvals` show.
  - Its link target:
    - on a project page, `/<slug>/approvals`;
    - off one, `/approvals` when the global set `mayDecide()`;
    - otherwise `/<slug>/approvals` of the first `counts.projects` row;
    - no link when the counts are empty.
  - A 403 from `GET /approvals/counts` (a caller with no decide key anywhere) stops the badge's polling. The badge then renders nothing.
  - After a successful decide or cancel, `approvalRequestsVersion` is bumped. The badge reloads on the bump.
- **Row status labels.** Rows on the All tab show their status through `approvals.inbox.status.<status>` (US-002), for all seven engine statuses. The fleet `fleet.approvals.status` keys are not reused.
- **`ApprovalRequestInbox` props.** `base: { kind: 'all' } | { kind: 'project'; slug: string; projectId: string }`. The project page renders it once `useProjectRef` has the id.
- **`listForJob(jobId)`** returns `JobApprovalRow[]`. It lists with `{ jobId, size: '100' }` and orders the rows: pending first by soonest `expiresAt`, then the rest newest first. It then details the first `DETAIL_FETCH_LIMIT` rows through `listDetailed`.
- **Composable imports.** Components import the new composables explicitly from `~/composables/...`, so the spec harness doubles them through module aliases (`tests/helpers/mount-sfc.ts` has a closed auto-import list).
- **Auto-import names.** Nuxt prefixes components by directory, so `components/approvals/ProjectApprovalNavLinks.vue` is `ApprovalsProjectApprovalNavLinks` in templates. Layout specs that do not register it render it as an unresolved element, which does not fail them.
- **Visibility also includes `onBehalfOf` rows.** `GET /approvals` also returns requests raised on the caller's behalf. `viewerActions` gives those the decide controls; the API may refuse, and the refusal toasts.
- **Live updates and polling.**
  - The project inbox, the job page, the budget banner and the badge (on a project page) reload on the project stream's `approval_request` event.
  - The fleet index and the job page add `onApprovalRequest` beside their existing `onFleetApproval` handler. 7c removes `onFleetApproval`.
  - The engine publishes no event for a request without a project, so the global inbox reloads on a timer. Every list here polls through the existing visible-tab poller, as the old inbox and badge did.
- **Policy pages share one dialog, one list and one composable.** All three are parameterised by `PolicyBase = { kind: 'global' } | { kind: 'project'; slug: string }`, so US-009 adds only a page.
  - `useApprovalPolicies(base).list()` reads every page with `size: '100'` until `hasNext` is false, so `overrideCount` counts every policy.
  - The dialog creates subjects of kind `all`, `type` and `role`. The `role` kind is offered only when the caller can read roles: `role.read` on the global page (`GET /roles`), project `member.read` on the project page (`GET /projects/:slug/roles`). Creating a `principal` subject is out of scope; existing ones still list.
  - The dialog's mode options are `modeOptions(patternFloor(pattern, keys))`. A pattern that covers no approvable key (`patternFloor` answers `null`) shows `approvals.policies.validation.pattern`, and Save stays disabled.
  - Editing changes only:
    - `mode`;
    - `timeoutSec` (a blank timeout sends `null`);
    - `onTimeout`;
    - `approverMustHoldAction`;
    - `requireDistinctApprover`.

    The pattern and the subject are part of the policy's selector, and `PATCH` does not accept them.
- **Redirects keep the query and use 302.** `/admin/fleet/approvals` and `/[project]/fleet/approvals` become redirect pages, the `pages/projects.vue` pattern, keeping `?id=`. A temporary redirect is used because the fleet notifications still link to `/admin/fleet/approvals` until 7c, and a cached 301 would outlive that.
- **i18n ownership.** Each story adds its own keys to `en.json` and `zh.json`:

  | Story | Keys |
  |:--|:--|
  | US-001 | `approvals.keys`, `approvals.comment.tooLong` |
  | US-002 | `approvals.inbox` |
  | US-003 | `approvals.panel` |
  | US-004 | `approvals.fleet` |
  | US-005 | `notifications.kinds.approval_request` |
  | US-006 | `nav.approvals`, `nav.approvalPolicies` |
  | US-008 | `approvals.policies` |
  | US-009 | `approvals.policies.project` |

  `tests/i18n/approvals-locale-parity.spec.ts` (US-001) compares the whole `approvals` namespace across the two files.

### Shared names

| Name | Where | Created by |
|:--|:--|:--|
| `ApprovalRequestSummary`, `ApprovalRequestDetail`, `ApprovalRequestCounts`, `RequestStatus` | `lib/approval-requests.ts` | US-001 |
| `buildRequestQuery`, `sortPendingRequests`, `viewerActions`, `inboxHref`, `requestKeyLabel`, `buildCommentSchema`, `MAX_REQUEST_COMMENT`, `DETAIL_FETCH_LIMIT` | `lib/approval-requests.ts` | US-001 |
| `useApprovalInbox`, `approvalRequestsVersion` | `composables/useApprovalInbox.ts` | US-001 |
| `useProjectRef` | `composables/useProjectRef.ts` | US-001 |
| `LiveApprovalRequestEvent`, `parseApprovalRequestEvent`, `ProjectEventHandlers.onApprovalRequest` | `lib/project-event-stream.ts` | US-001 |
| `ApprovalRequestInbox` | `components/approvals/` | US-002 |
| `ApprovalRequestPanel` | `components/approvals/` | US-003 |
| `requestPanelKind`, `bashAskOf`, `budgetAskOf`, `requeueCandidatesOf`, `bashRequestBody`, `budgetRaiseBody`, `budgetKeepBody`, `buildBudgetRaiseSchema`, `requestDelivery`, `requestRequeueResults` | `lib/approval-request-fleet.ts` | US-004 |
| `ApprovalRequestBashPanel`, `ApprovalRequestBudgetPanel`, `ApprovalRequestOutcome` | `components/approvals/` | US-004 |
| `useApprovalRequestNotifications` | `composables/useApprovalRequestNotifications.ts` | US-005 |
| `ProjectApprovalNavLinks` | `components/approvals/` | US-006 |
| `PolicyBase`, `patternFloor`, `modeOptions`, `overrideCount`, `buildPolicySchema` | `lib/approval-policies.ts` | US-008 |
| `useApprovalPolicies` | `composables/useApprovalPolicies.ts` | US-008 |
| `ApprovalPolicyDialog`, `ApprovalPolicyList`, `ApprovableKeysTable` | `components/approvals/` | US-008 |

### Integration

The baseline listings below only locate code. Where a target is given, the target is the interface to implement.

**Read only (verified at `126c2467`):**
- API routes:
  - `GET /approvals`. Query: `status`, `projectId`, `permissionKey`, `jobId`, `mine`, `current`, `size` (1 to 100). Answers `{ total, current, size, hasNext, hasPrev, records: ApprovalRequestSummaryDto[] }`.
  - `GET /approvals/counts` answers `{ total, unscoped, projects: [{ projectId, slug, pending }] }`.
  - `GET /approvals/:id` answers `ApprovalRequestDto`, which is the summary plus `input`, `result`, `details` and `decisions[]`.
  - `POST /approvals/:id/decisions` takes `{ decision, comment?, params? }`.
  - `POST /approvals/:id/cancel`.
  - Global policies, all on `approval.policy.manage`:
    - `GET|POST /approval-policies`;
    - `PATCH|DELETE /approval-policies/:id`;
    - `GET /approval-policies/keys`, which answers `{ keys }`.
  - Project policies, where reads need `approval.policy.read` and writes need `approval.policy.manage`:
    - `GET|POST /projects/:slug/approval-policies`;
    - `PATCH|DELETE /projects/:slug/approval-policies/:id`;
    - `GET /projects/:slug/approval-policies/keys`.

    The project list also returns the global policies, which have `projectId: null`. Both policy lists are paged (default size 20, max 100).
  - `GET /roles` needs `role.read`; `GET /projects/:slug/roles` needs `member.read`.
- `ApprovalRequestSummaryDto` fields (`apps/api/src/approvals/dto/approval-request.dto.ts`):
  - `id`, `permissionKey`, `projectId`;
  - `actorType`, `actorId`, `onBehalfOfType`, `onBehalfOfId`, `origin`, `redeem`;
  - `requiredMode`, `status`, `satisfiedBy`, `approverType`, `approverId`;
  - `expiresAt` (always set), `decidedAt`, `settledAt`, `createdAt`.
- `details` blocks:
  - bash: `{ kind: 'bash', jobId, resolvedBy, outcome }`;
  - budget: `{ kind: 'budget', policyId, resolvedBy, outcome, requeueCandidates?: [{ jobId, projectId, feature, queuedAt }], requeueCandidatesTruncated? }`. The candidates come only while the request is pending.
  - A budget `outcome` holds `resumedAmountUsd` and `requeueResults: [{ jobId, ok, error? }]`.
- Frozen `input`:
  - bash: `{ jobId, leaseEpoch, naxAskId, payload }`, where `payload` is the bash payload the fleet DTO carried;
  - budget: `{ policyId, scopeType, scopeId, windowKind, windowStart, spentUsd, amountUsd, requestedAt }`.
- `ApprovalPolicyDto`:
  - `id`, `selector`, `projectId`, `permissionPattern`;
  - `principalType`, `roleId`, `principalId`;
  - `mode`, `timeoutSec`, `onTimeout`;
  - `requiredApprovals`, `approverMustHoldAction`, `requireDistinctApprover`;
  - `updatedByType`, `updatedById`, `createdAt`, `updatedAt`.
- `ApprovableKeyDto`: `key`, `scope`, `risk`, `floor`, `default`. Modes rank `none < self < agent < human`.
- The API's policy validation (`apps/api/src/approvals/approval-policy.validation.ts`):
  - `timeoutSec` must be an integer from 60 to 2592000;
  - `onTimeout: 'approve'` needs floor `none`;
  - the mode may not sit below the strictest floor of the keys the pattern covers. A `prefix.*` pattern covers the keys under `prefix.`, and a pattern that covers none is refused.
- Live: the project stream `/api/projects/:slug/events` sends SSE events named after `type`. `approval_request` carries `{ id, type, projectId, requestId, status, at }`.
- Engine notification kind `approval_request` has `params: { key }` and link `/approvals?id=<requestId>`.
- Web helpers kept as they are (`lib/fleet-approvals.ts`):
  - `bashPayload`, `bashChoices`, `commandPreview`;
  - `budgetPayload`, `raiseAmountError`;
  - `secondsLeft`, `countdownText`, `deliveryView`, `requeueFailure`;
  - `badgeText`, `BADGE_CAP`.
- Web patterns:
  - `useApi().$api`, `extractApiError`, `useAppToast`;
  - `useVisiblePolling`, `createDebouncer`, `useApprovalCountdown`;
  - `useProjectEvents(slug, handlers)`;
  - `useGlobalPermissions()` and `useProjectPermissions(slug)`;
  - `useRoles()`, `useProjectRoles(slug)`, `useProjectMemberNames(slug)`, `useAdminUsers()`, `useFleetRepos().loadProjects()`;
  - the redirect pattern in `pages/projects.vue`.
- `tests/helpers/mount-sfc.ts`: `fleetComponents` registers only `components/fleet/*`. Specs that mount a `components/approvals/*` parent with its real children register them through its `components` option.

**Changed (baseline → target):**
- `PermissionSet` (`lib/permissions.ts`):
  - Baseline: `{ has(key), hasOwn(key) }`.
  - Target: it also has `mayDecide(): boolean`. That is `true` when the keys hold `approval.decide` or any key starting with `approval.decide@`.
  - `EMPTY_PERMISSIONS.mayDecide()` answers `false`.
- `ProjectEventHandlers` (`lib/project-event-stream.ts`):
  - Baseline: `onEvent`, `onFleetJob`, `onFleetApproval`, `onFleetLog`, `onNotification`, `onResync`.
  - Target: it also has `onApprovalRequest?: (event: LiveApprovalRequestEvent) => void`. The stream listens to `approval_request` only when the handler is given, and `createProjectEventHub`'s fan-out forwards it.
- `HomeApproval` (`lib/home-types.ts`):
  - Baseline: `{ id, type: string, projectId, projectSlug, jobId, requestedAt, expiresAt }`.
  - Target: it gains `permissionKey: string`, and `type` is `string | null`. This matches `HomeApprovalDto` after 7a.
- `components/fleet/ApprovalBadge.vue`:
  - Baseline: reads `useFleetApprovalCounts` and `useApprovalNotifications`.
  - Target (US-006): reads `useApprovalInbox().counts` and `useApprovalRequestNotifications`. Its prop stays `slug: string | null`, and its component name `FleetApprovalBadge` is unchanged.
- `components/fleet/JobApprovals.vue`:
  - Baseline: props `{ slug, approvals: FleetApprovalDto[], now }`.
  - Target (US-007): props `{ slug, approvals: JobApprovalRow[], now }`, where `JobApprovalRow = { request: ApprovalRequestSummary; detail: ApprovalRequestDetail | null }`.
- `components/fleet/BudgetBanner.vue`:
  - Baseline: reads `useFleetApprovals` with `type=budget_override_required`.
  - Target (US-007): it resolves the project id with `useProjectRef(slug)`. It then reads `useApprovalInbox().listDetailed` with `status=pending`, `permissionKey=fleet.budget.override` and `projectId`.
- `lib/fleet-dashboard.ts`: `attentionLink(item, scope)` for `job_waiting_approval`:
  - Baseline: `/<slug>/fleet/approvals`.
  - Target (US-007): `/<slug>/approvals`.

### Failure Handling

| Where | Failure | Behaviour |
|:--|:--|:--|
| Inbox list | 403 | Shows `approvals.inbox.forbidden` |
| Inbox list | other error, nothing loaded yet | Toasts `extractApiError` and shows `approvals.inbox.loadFailed` |
| Inbox list | other error after a successful load | Keeps the rows and shows `approvals.inbox.stale` |
| Inbox detail | `GET /approvals/:id` fails | Toasts `extractApiError`, closes the row and clears `?id` |
| Decide or cancel | any refusal | Toasts `extractApiError` and re-fetches the detail; a 409 also reloads the list |
| Project inbox | `GET /projects/:slug` fails | Toasts `extractApiError` and lists nothing |
| Badge | 403 on counts | Stops polling and renders nothing |
| Badge, banner, notifications | any other error | Keeps the last state silently and retries at the next poll or event |
| Job page, banner | one row's detail fetch fails | That row shows the key label; the others render |
| Policy dialog | any refusal (400, 403, 409) | Toasts `extractApiError`; the dialog stays open with the input kept |
| Policy dialog | role list read fails | The `role` subject kind is not offered |
| Policy pages | 403 on load | Shows `approvals.policies.forbidden` |

## Out of Scope

- API changes of any kind. The API already serves every route this feature calls (7a).
- Deleting the `/fleet/approvals` API routes, `FleetApprovalDto`, the `fleet_approval` live event, the `fleet.approval.*` keys, webhooks or notifications, and the CLI `koda fleet approval`. That is 7c.
- Switching the fleet bash and budget notifications to the engine notification kind, and deleting `fleet_approval_requested`. That is 7c. Their link `/admin/fleet/approvals` keeps working through the US-010 redirect.
- Deleting the web type `FleetApprovalDto` from `lib/fleet-types.ts`. The kept helpers in `lib/fleet-approvals.ts` still name it in their parameter types; 7c deletes it with the API DTO.
- Labels for permission keys other than `fleet.job.shell.escalate` and `fleet.budget.override`. Other keys show raw.
- Breadcrumbs for `/approvals`, `/[project]/approvals` and the policy pages. The layout's `fleetLeaf` covers only `/:project/fleet/*`.
- US-002 only: the old inbox's keyboard shortcuts (j/k, Enter, A/D, Esc) are not carried over.
- US-002 only: a filter by key on the inbox. A key picker is a later feature.
- US-002 only: agent requester names. An agent shows its id.
- US-003 only: a link from an assistant (thread-origin) request to its thread, and Cancel for a request raised on the caller's behalf (`onBehalfOf`). Both open the generic panel, and the thread card keeps deciding and cancelling them.
- US-003 only: hiding the decide controls from a requester under a policy with `requireDistinctApprover`. The API refuses, and the refusal toasts.
- US-004 only: budget scope names. The panel shows the scope through `scopeText` with the raw scope id, not the repo, runner or project name.
- US-004 only: re-fetching a decided bash request while its runner delivery is pending. The outcome shows the delivery state as of the last fetch.
- US-002 only: names of requesters beyond the first page of `useAdminUsers()`. They show their id.
- US-003 only: dropping a list load that started before a successful decide. The next poll or live event corrects the list.
- US-004 only: the raised amount line of a settled budget request. The re-queue results show; `details.outcome.resumedAmountUsd` is not displayed.
- US-005 only: dismissing toasts when the pending list is refused. The toasts stay until the next successful refresh.
- US-008 only: the role subject when the role list read fails. The `role` kind is simply not offered.
- US-008 only: creating a policy whose subject is a single principal (`appliesTo.kind: 'principal'`). Existing ones list and can be edited or deleted.
- `components/fleet/threads/ThreadActionCard.vue` and `composables/useApprovalRequests.ts` stay as they are.

## Stories

- **US-001: Engine client and live handler.** No dependencies. Workdir: `apps/web`.
  - Creates `lib/approval-requests.ts` (types and pure helpers), `composables/useApprovalInbox.ts` and `composables/useProjectRef.ts`.
  - `useApprovalInbox` provides `list`, `listForJob`, `listDetailed`, `get`, `counts`, `decide` and `cancel`, and the `approvalRequestsVersion` ref.
  - Adds `mayDecide()` to `PermissionSet`, and `onApprovalRequest` to the project event stream and hub.
  - Adds `approvals.keys` (the two fleet key labels) in both locales and the namespace parity spec.
- **US-002: Unified inbox list.** Depends on US-001. Workdir: `apps/web`.
  - Creates `components/approvals/ApprovalRequestInbox.vue`, `pages/approvals.vue` and `pages/[project]/approvals.vue`.
  - The inbox has Pending and All tabs. Each row shows the key label, the requester, the project and the countdown.
  - Opening a row fetches its detail and writes `?id`.
  - The inbox polls, reloads on project live events, and handles the list failures.
  - Adds `approvals.inbox`.
- **US-003: Decide panel, decisions and cancel.** Depends on US-002. Workdir: `apps/web`.
  - Creates `components/approvals/ApprovalRequestPanel.vue`: the frozen input, the decisions, Approve, Reject with a comment, and Cancel, each per `viewerActions`.
  - `ApprovalRequestInbox.vue` (created by US-002) is changed here to render the panel for the open row, and to run decide and cancel with their failure handling.
  - Adds `approvals.panel`.
- **US-004: Fleet panels and outcome.** Depends on US-003. Workdir: `apps/web`.
  - Creates `lib/approval-request-fleet.ts`, `components/approvals/ApprovalRequestBashPanel.vue`, `components/approvals/ApprovalRequestBudgetPanel.vue` and `components/approvals/ApprovalRequestOutcome.vue`.
  - `ApprovalRequestPanel.vue` (created by US-003) is changed here to pick the bash or budget panel with `requestPanelKind`, and to show the outcome of a settled request.
  - Adds `approvals.fleet`.
- **US-005: Approval toasts and the home card on the engine.** Depends on US-001. Workdir: `apps/web`.
  - Creates `composables/useApprovalRequestNotifications.ts`, which replaces what `useApprovalNotifications` does, over `GET /approvals?status=pending`.
  - `HomeNeedsYou` links rows to the engine inbox and labels rows with no fleet type by key.
  - `HomeApproval` gains `permissionKey`.
  - Adds `notifications.kinds.approval_request`.
- **US-006: Badge, nav and palette.** Depends on US-005. Workdir: `apps/web`.
  - Rewrites `components/fleet/ApprovalBadge.vue` onto `GET /approvals/counts` and `useApprovalRequestNotifications`.
  - Creates `components/approvals/ProjectApprovalNavLinks.vue`: `/[project]/approvals` on project `mayDecide()`, and `/[project]/approval-policies` on project `approval.policy.read`. The layout mounts it in the project block, keyed by slug.
  - Adds two layout links on the global set:
    - `/approvals` on `mayDecide()`, right after My threads;
    - `/admin/approval-policies` on `approval.policy.manage`, right after Roles.
  - Adds an Approvals command to the palette.
  - Adds `nav.approvals` and `nav.approvalPolicies`.
- **US-007: Job page, budget banner and fleet links on the engine.** Depends on US-004. Workdir: `apps/web`.
  - The job page lists its approvals through `listForJob` with the pending rows first, and `JobApprovals` renders `JobApprovalRow`s.
  - `BudgetBanner` maps policies to pending engine requests.
  - The fleet index button and the dashboard attention link point at `/[project]/approvals`.
- **US-008: Global approval policy page.** No dependencies. Workdir: `apps/web`.
  - Creates `lib/approval-policies.ts`, `composables/useApprovalPolicies.ts`, `components/approvals/ApprovalPolicyDialog.vue`, `components/approvals/ApprovalPolicyList.vue`, `components/approvals/ApprovableKeysTable.vue` and `pages/admin/approval-policies.vue`.
  - Adds `approvals.policies`.
- **US-009: Project approval policy page.** Depends on US-008. Workdir: `apps/web`.
  - Creates `pages/[project]/approval-policies.vue` over the US-008 components with `PolicyBase` `{ kind: 'project', slug }`.
  - Global policies show as inherited and read-only.
  - Adds `approvals.policies.project`.
- **US-010: Terminal cleanup.** Depends on US-001, US-002, US-003, US-004, US-005, US-006, US-007, US-008, US-009. Workdir: `apps/web`.
  - Turns `pages/admin/fleet/approvals.vue` and `pages/[project]/fleet/approvals.vue` into 302 redirects that keep `?id`.
  - Deletes:
    - `components/fleet/ApprovalInbox.vue`, `ApprovalBashPanel.vue`, `ApprovalBudgetPanel.vue`, `ApprovalActionPanel.vue` and `ApprovalOutcome.vue`;
    - `composables/useFleetApprovals.ts`, `composables/useApprovalNotifications.ts` and `composables/useActionPreview.ts`;
    - the fleet-only exports of `lib/fleet-approvals.ts`;
    - the admin nav link to `/admin/fleet/approvals`.
  - Deletes the test files of the deleted code: tests/pages/fleet-approvals-pages.spec.ts, tests/components/fleet-approval-{inbox,action-panel,bash-panel,budget-panel,outcome}.spec.ts, tests/composables/useFleetApprovals.spec.ts and tests/composables/useActionPreview.spec.ts.
  - Rewrites the two fleet approval E2E journeys onto `/[project]/approvals`.
  - Verification: `bun run type-check`, `bun run lint` and `bun run test` in `apps/web`. A removed export that is still imported fails the type check.
  - The `lib/fleet-approvals.ts` exports to delete:
    - `INBOX_PENDING_SIZE`, `INBOX_PAGE_SIZE`;
    - `ApprovalBase`, `ApprovalViewer`, `INBOX_TABS`, `InboxTab`, `ApprovalListFilters`;
    - `buildApprovalQuery`, `sortPending`;
    - `AssistantApprovalPayload`, `assistantPayload`;
    - `canDecide`, `toRaiseBody`, `toKeepPausedBody`, `toBashBody`, `toActionBody`;
    - `threadApiPath`, `keyboardDecision`, `firstPending`;
    - `requeueResults`, `resumedAmount`, `pendingByPolicy`;
    - `inboxPath`, `badgeTarget`, `approvalSummary`;
    - `MAX_COMMENT`, `commentTooLong`, `buildRaiseSchema` (only the deleted panels use them);
    - the imports these deletions leave unused.

### Context Files

**US-001**
- `apps/web/lib/fleet-approvals.ts`
- `apps/web/composables/useFleetApprovals.ts`
- `apps/web/lib/project-event-stream.ts`
- `apps/web/lib/project-event-hub.ts`
- `apps/web/lib/permissions.ts`

**US-002**
- `apps/web/components/fleet/ApprovalInbox.vue`
- `apps/web/pages/admin/fleet/approvals.vue`
- `apps/web/pages/[project]/fleet/approvals.vue`
- `apps/web/lib/approval-requests.ts` — created by US-001, used here
- `apps/web/composables/useApprovalInbox.ts` — created by US-001, used here

**US-003**
- `apps/web/components/approvals/ApprovalRequestInbox.vue` — created by US-002, changed here
- `apps/web/components/fleet/ApprovalInbox.vue`
- `apps/web/components/fleet/ApprovalActionPanel.vue`
- `apps/web/lib/approval-requests.ts` — created by US-001, used here
- `apps/web/composables/useApprovalInbox.ts` — created by US-001, used here

**US-004**
- `apps/web/components/fleet/ApprovalBashPanel.vue`
- `apps/web/components/fleet/ApprovalBudgetPanel.vue`
- `apps/web/components/fleet/ApprovalOutcome.vue`
- `apps/web/components/approvals/ApprovalRequestPanel.vue` — created by US-003, changed here
- `apps/web/lib/fleet-approvals.ts`

**US-005**
- `apps/web/composables/useApprovalNotifications.ts`
- `apps/web/components/home/HomeNeedsYou.vue`
- `apps/web/lib/home-types.ts`
- `apps/web/lib/notifications.ts`
- `apps/web/composables/useApprovalInbox.ts` — created by US-001, used here

**US-006**
- `apps/web/components/fleet/ApprovalBadge.vue`
- `apps/web/layouts/default.vue`
- `apps/web/components/CommandPalette.vue`
- `apps/web/tests/helpers/permission-nav.ts`
- `apps/web/composables/useApprovalRequestNotifications.ts` — created by US-005, used here

**US-007**
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/components/fleet/JobApprovals.vue`
- `apps/web/components/fleet/BudgetBanner.vue`
- `apps/web/lib/fleet-dashboard.ts`
- `apps/web/lib/approval-request-fleet.ts` — created by US-004, used here

**US-008**
- `apps/web/pages/admin/roles.vue`
- `apps/web/composables/useRoles.ts`
- `apps/web/components/RoleEditorDialog.vue`
- `apps/api/src/approvals/dto/approval-policy.dto.ts`
- `apps/api/src/approvals/approval-policy.validation.ts`

**US-009**
- `apps/web/components/approvals/ApprovalPolicyDialog.vue` — created by US-008, used here
- `apps/web/components/approvals/ApprovalPolicyList.vue` — created by US-008, used here
- `apps/web/composables/useApprovalPolicies.ts` — created by US-008, used here
- `apps/web/composables/useProjectRoles.ts`
- `apps/web/pages/[project]/settings.vue`

**US-010**
- `apps/web/pages/projects.vue`
- `apps/web/lib/fleet-approvals.ts`
- `apps/web/tests/e2e/fleet-approvals.e2e.spec.ts`
- `apps/web/tests/e2e/fixtures/fleet-approvals-api.ts`
- `apps/web/layouts/default.vue`

### Creates

**US-001**
- `apps/web/lib/approval-requests.ts`
- `apps/web/composables/useApprovalInbox.ts`
- `apps/web/composables/useProjectRef.ts`
- `apps/web/tests/lib/approval-requests.spec.ts`
- `apps/web/tests/composables/useApprovalInbox.spec.ts`
- `apps/web/tests/i18n/approvals-locale-parity.spec.ts`

**US-002**
- `apps/web/components/approvals/ApprovalRequestInbox.vue`
- `apps/web/pages/approvals.vue`
- `apps/web/pages/[project]/approvals.vue`
- `apps/web/tests/components/approval-request-inbox.spec.ts`
- `apps/web/tests/pages/approvals-pages.spec.ts`

**US-003**
- `apps/web/components/approvals/ApprovalRequestPanel.vue`
- `apps/web/tests/components/approval-request-panel.spec.ts`

**US-004**
- `apps/web/lib/approval-request-fleet.ts`
- `apps/web/components/approvals/ApprovalRequestBashPanel.vue`
- `apps/web/components/approvals/ApprovalRequestBudgetPanel.vue`
- `apps/web/components/approvals/ApprovalRequestOutcome.vue`
- `apps/web/tests/lib/approval-request-fleet.spec.ts`
- `apps/web/tests/components/approval-request-fleet-panels.spec.ts`

**US-005**
- `apps/web/composables/useApprovalRequestNotifications.ts`
- `apps/web/tests/composables/useApprovalRequestNotifications.spec.ts`

**US-006**
- `apps/web/components/approvals/ProjectApprovalNavLinks.vue`
- `apps/web/tests/components/project-approval-nav-links.spec.ts`
- `apps/web/tests/components/command-palette-approvals.spec.ts`
- `apps/web/tests/layouts/default-approvals-nav.spec.ts`

**US-007**
None.

**US-008**
- `apps/web/lib/approval-policies.ts`
- `apps/web/composables/useApprovalPolicies.ts`
- `apps/web/components/approvals/ApprovalPolicyDialog.vue`
- `apps/web/components/approvals/ApprovalPolicyList.vue`
- `apps/web/components/approvals/ApprovableKeysTable.vue`
- `apps/web/pages/admin/approval-policies.vue`
- `apps/web/tests/lib/approval-policies.spec.ts`
- `apps/web/tests/pages/admin-approval-policies.spec.ts`

**US-009**
- `apps/web/pages/[project]/approval-policies.vue`
- `apps/web/tests/pages/project-approval-policies.spec.ts`

**US-010**
- `apps/web/tests/pages/fleet-approvals-redirects.spec.ts`

### Modifies

**US-001**
- `apps/web/lib/permissions.ts` — `PermissionSet` gains `mayDecide()`; `permissionSet` implements it and `EMPTY_PERMISSIONS` answers `false`.
- `apps/web/lib/project-event-stream.ts` — adds `LiveApprovalRequestEvent`, `parseApprovalRequestEvent` and the optional `onApprovalRequest` handler, listened to only when given.
- `apps/web/lib/project-event-hub.ts` — the hub's fan-out forwards `onApprovalRequest` to every subscriber of the URL.
- `apps/web/i18n/locales/en.json` — adds `approvals.keys` with labels for `fleet_job_shell_escalate` and `fleet_budget_override`, and `approvals.comment.tooLong`.
- `apps/web/i18n/locales/zh.json` — adds `approvals.keys` and `approvals.comment.tooLong` in Chinese, key for key.

**US-002**
- `apps/web/i18n/locales/en.json` — adds `approvals.inbox` (title, tabs, row labels, status labels for the seven statuses, pager, noProject, forbidden, loadFailed, stale, empty).
- `apps/web/i18n/locales/zh.json` — adds `approvals.inbox` in Chinese, key for key.

**US-003**
- `apps/web/i18n/locales/en.json` — adds `approvals.panel` (input, decisions, approve, reject, cancel, comment, toasts).
- `apps/web/i18n/locales/zh.json` — adds `approvals.panel` in Chinese, key for key.

**US-004**
- `apps/web/i18n/locales/en.json` — adds `approvals.fleet` (bash and budget panel labels, truncated, delivery, requeue results).
- `apps/web/i18n/locales/zh.json` — adds `approvals.fleet` in Chinese, key for key.

**US-005**
- `apps/web/components/home/HomeNeedsYou.vue` — `approvalTarget` answers `inboxHref(projectSlug, id)`, and a row with `type: null` shows `requestKeyLabel(t, te, permissionKey)`.
- `apps/web/lib/home-types.ts` — `HomeApproval` gains `permissionKey: string`, and `type` becomes `string | null`.
- `apps/web/tests/components/home-needs-you.spec.ts` — its assertions that approval rows link to the fleet inbox paths are replaced by the engine inbox paths with `?id=`, and its approval fixtures gain `permissionKey`.
- `apps/web/i18n/locales/en.json` — adds `notifications.kinds.approval_request` ("Approval needed: {key}").
- `apps/web/i18n/locales/zh.json` — adds `notifications.kinds.approval_request` in Chinese.

**US-006**
- `apps/web/components/fleet/ApprovalBadge.vue` — rewritten onto `useApprovalInbox().counts`, `useApprovalRequestNotifications`, `approvalRequestsVersion` and the `approval_request` live event; prop and component name unchanged.
- `apps/web/tests/components/fleet-approval-badge.spec.ts` — its doubles of `useFleetApprovalCounts`, `useApprovalNotifications` and `onFleetApproval` are replaced. The new doubles are `useApprovalInbox`, `useApprovalRequestNotifications` and `onApprovalRequest`, and the target assertions move to the engine inbox paths.
- `apps/web/tests/pages/fleet-schedule-approval-gates.spec.ts` — the US-009 AC-8, AC-9, AC-10, AC-11, fix-round-1 and US-011 blocks are deleted. They mount the old badge over the fleet approval counts and the old `useApprovalNotifications`. The new badge and notification specs replace them; the schedule gate blocks stay.
- `apps/web/layouts/default.vue` — adds the global engine inbox link (global `mayDecide()`, after My threads) and the admin approval policies link (`approval.policy.manage`, after Roles, counted in `showAdminNav`) inline. It mounts `ProjectApprovalNavLinks` in the project block, keyed by slug, and adds no new auto-import to its script.
- `apps/web/components/CommandPalette.vue` — offers an `approvals` command to the engine inbox when the global set `mayDecide()`.
- `apps/web/tests/helpers/permission-nav.ts` — `adminNavFlags` gains `canManageApprovalPolicies` (`approval.policy.manage`), and `ADMIN_NAV_KEYS` gains `approval.policy.manage`.
- `apps/web/tests/layouts/default-permission-nav.spec.ts` — the admin-section flag list it compares includes `canManageApprovalPolicies`, and the source-order pin includes the two new inline links.
- `apps/web/i18n/locales/en.json` — adds `nav.approvals` and `nav.approvalPolicies`.
- `apps/web/i18n/locales/zh.json` — adds `nav.approvals` and `nav.approvalPolicies` in Chinese.

**US-007**
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — loads approvals with `useApprovalInbox().listForJob(jobId)`, links the callout to `inboxHref(slug, id)` of the soonest-expiring pending request, and adds an `onApprovalRequest` reload beside its `onFleetApproval` one.
- `apps/web/components/fleet/JobApprovals.vue` — props become `JobApprovalRow[]`; a row's preview reads `bashAskOf(detail)` and links to `inboxHref(slug, id)`.
- `apps/web/components/fleet/BudgetBanner.vue` — maps `budgetAskOf(detail).policyId` to request ids from `listDetailed` over the project's pending `fleet.budget.override` requests, with the project id from `useProjectRef`.
- `apps/web/pages/[project]/fleet/index.vue` — the Approvals button goes to the project engine inbox, and the page adds an `onApprovalRequest` reload beside its `onFleetApproval` one.
- `apps/web/lib/fleet-dashboard.ts` — `attentionLink` sends `job_waiting_approval` to the project engine inbox.
- `apps/web/tests/components/fleet-job-approvals.spec.ts` — fixtures become `JobApprovalRow`s, and the link assertions move to the engine inbox path with `?id=`.
- `apps/web/tests/components/fleet-budget-banner.spec.ts` — the `useFleetApprovals` double becomes a `useApprovalInbox` double, with the engine query asserted.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — its source-string pins move off the old code: the `useFleetApprovals` import, `inboxPath(... firstPending ...)` and `:approvals="jobApprovals"`. They now pin the `useApprovalInbox` import, the `inboxHref` callout and the `JobApprovalRow` binding, and the `jobApprovals.value.length > 0` pin follows the renamed rows. The `onFleetApproval` handler pin stays.
- `apps/web/tests/pages/fleet-job-detail-workflow.spec.ts` — its `useFleetApprovals` double becomes a `useApprovalInbox` double returning `[]` from `listForJob`.
- `apps/web/tests/pages/fleet-job-budget-gates.spec.ts` — its `useFleetApprovals` double becomes a `useApprovalInbox` double.
- `apps/web/tests/lib/fleet-dashboard-attention.spec.ts` — the `job_waiting_approval` href assertion moves to the project engine inbox.
- `apps/web/tests/components/fleet-dashboard-attention.spec.ts` — the attention link list it pins replaces the fleet approvals path with the project engine inbox path.
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — the Approvals button source pin navigates to the project engine inbox; its order pin stays.

**US-008**
- `apps/web/i18n/locales/en.json` — adds `approvals.policies` (page, keys table, list, dialog, subject, validation, forbidden).
- `apps/web/i18n/locales/zh.json` — adds `approvals.policies` in Chinese, key for key.

**US-009**
- `apps/web/i18n/locales/en.json` — adds `approvals.policies.project` (title, inherited).
- `apps/web/i18n/locales/zh.json` — adds `approvals.policies.project` in Chinese, key for key.

**US-010**
- `apps/web/pages/admin/fleet/approvals.vue` — becomes a 302 redirect to the global engine inbox, keeping `?id`.
- `apps/web/pages/[project]/fleet/approvals.vue` — becomes a 302 redirect to the project engine inbox, keeping `?id`.
- `apps/web/layouts/default.vue` — removes the admin fleet approvals link and `canReadFleetApprovals` from `showAdminNav`.
- `apps/web/lib/fleet-approvals.ts` — deletes the fleet-only exports the story lists; the shared helpers stay.
- `apps/web/tests/lib/fleet-approvals.spec.ts` — drops the cases of the deleted exports; the cases of the kept helpers stay.
- `apps/web/tests/helpers/permission-nav.ts` — `ADMIN_NAV_KEYS` and `adminNavFlags` drop the `fleet.approval.read` key and the `canReadFleetApprovals` flag.
- `apps/web/tests/helpers/mount-sfc.ts` — drops the five deleted components from its fleet component map and the `FleetComponentName` union, and `useActionPreview` from `NUXT_AUTO_IMPORTS`.
- `apps/web/tests/layouts/default-permission-nav.spec.ts` — drops its admin fleet approvals link cases and asserts the link is gone for a caller holding `fleet.approval.read`.
- `apps/web/tests/pages/fleet-schedule-approval-gates.spec.ts` — drops the remaining approval blocks: the `canDecide`/`ApprovalViewer` imports and cases (US-009 AC-2, AC-7) and the two-pages block (US-009 AC-6). The schedule gate blocks stay.
- `apps/web/tests/components/thread-action-card.spec.ts` — drops the `useFleetApprovals` double and its `not.toHaveBeenCalled` assertions; the card never used it.
- `apps/web/tests/e2e/fleet-approvals.e2e.spec.ts` — the journey opens the project engine inbox and decides through the engine panels.
- `apps/web/tests/e2e/fleet-bash-approvals.e2e.spec.ts` — the bash journey opens the project engine inbox at the ask and answers through `ApprovalRequestBashPanel`.
- `apps/web/tests/e2e/fixtures/fleet-approvals-api.ts` — reads requests through the engine list route instead of the fleet adapter.

### Seams

- `useApprovalInbox` (US-001) → US-002 AC-1, US-002 AC-2, US-006 AC-1 and US-007 AC-1. Each mounts the real entry point (a page, or the badge) with a `$api` double and asserts the engine path and query it sends.
- `ProjectEventHandlers.onApprovalRequest` (US-001) → US-002 AC-11, US-006 AC-5 and US-007 AC-4. Each feeds an `approval_request` event through the `useProjectEvents` double and asserts a reload.
- `PermissionSet.mayDecide` (US-001) → US-006 AC-7, AC-8 and AC-11. The layout, the project links and the palette are mounted with stub key sets.
- `ProjectApprovalNavLinks` (US-006) → US-006 AC-15. The layout, on a project route, mounts it with the route's slug.
- `ApprovalRequestPanel` (US-003) → US-003 AC-1. It mounts `ApprovalRequestInbox` with an open request and asserts the panel renders, registering the child through `mountSfc`'s `components` option.
- `requestPanelKind` and the fleet panels (US-004) → US-004 AC-1 and AC-2. They mount `ApprovalRequestPanel` with a detail per key.
- `useApprovalRequestNotifications` (US-005) → US-006 AC-6. The badge's counts load triggers `refresh`.
- `ApprovalPolicyDialog`, `ApprovalPolicyList` and `useApprovalPolicies` (US-008) → US-009 AC-5. The project page's create posts to the project route.

## Acceptance Criteria

### US-001: Engine client and live handler

1. [unit] `buildRequestQuery({ tab: 'pending' })` returns exactly `{ status: 'pending', size: '100' }`.
2. [unit] `buildRequestQuery({ tab: 'all', page: 3, projectId: 'p1' })` returns exactly `{ size: '20', current: '3', projectId: 'p1' }`.
3. [unit] `sortPendingRequests` given summaries expiring at `2026-11-02T00:00:00Z` and `2026-11-01T00:00:00Z` returns the `2026-11-01` one first.
4. [unit] `viewerActions` for a `pending` request with `actorType: 'USER'`, `actorId: 'u1'` and `requiredMode: 'human'`, viewed by `'u1'`, returns `{ decide: false, cancel: true }`.
5. [unit] `viewerActions` for a `pending` request with `actorType: 'USER'`, `actorId: 'u1'` and `requiredMode: 'self'`, viewed by `'u1'`, returns `{ decide: true, cancel: true }`.
6. [unit] `viewerActions` for a `pending` request with `actorType: 'AGENT'`, viewed by `'u1'`, returns `{ decide: true, cancel: false }`.
7. [unit] `viewerActions` for an `executed` request returns `{ decide: false, cancel: false }`.
8. [unit] `inboxHref('sandbox', 'r1')` returns `/sandbox/approvals?id=r1`.
9. [unit] `requestKeyLabel(t, te, 'label.create')`, with a `te` that knows no `approvals.keys.label_create`, returns `label.create`.
10. [unit] `buildCommentSchema(t)` rejects a 2001-character comment with the `approvals.comment.tooLong` message.
11. [unit] `permissionSet(['approval.decide@fleet.job.shell.escalate']).mayDecide()` returns `true`.
12. [unit] `useApprovalInbox().decide('r1', { decision: 'approve', comment: 'ok' })` posts to `/approvals/r1/decisions` with that body.
13. [unit] `useApprovalInbox().listDetailed({ status: 'pending' }, 2)` over a list of three records returns the third row with `detail: null`.
14. [unit] `useProjectRef('sandbox').load()`, with `GET /projects/sandbox` answering `{ id: 'p1' }`, sets `id` to `'p1'`.
15. [unit] A project event hub subscriber with `onApprovalRequest` receives an `approval_request` SSE message `{ id, type: 'approval_request', projectId, requestId: 'r1', status: 'pending', at }` as a `LiveApprovalRequestEvent` with `requestId: 'r1'`.

### US-002: Unified inbox list

1. [unit] Mounting `pages/approvals.vue` makes the inbox request `GET /approvals` with query `{ status: 'pending', size: '100' }`.
2. [unit] Mounting `pages/[project]/approvals.vue` for slug `sandbox`, with `GET /projects/sandbox` answering `{ id: 'p1' }`, makes the inbox request `GET /approvals` with `projectId: 'p1'`.
3. [unit] Selecting the All tab requests `GET /approvals` with `size: '20'` and no `status`.
4. [unit] A listed `fleet.budget.override` request's row shows the `approvals.keys.fleet_budget_override` label.
5. [unit] On `/approvals`, a row of a user requester `u1` shows the name `Ann` when `useAdminUsers` lists `{ id: 'u1', name: 'Ann' }`.
6. [unit] On `/approvals`, a row with `projectId: 'p1'` shows slug `sandbox` when `GET /projects` lists `{ id: 'p1', slug: 'sandbox' }`.
7. [unit] Opening a row requests `GET /approvals/<id>`.
8. [unit] Opening a row replaces the route query with `id=<id>`.
9. [unit] On the All tab, with a list answer `hasNext: true`, clicking Next requests `GET /approvals` with `current: '2'`.
10. [unit] A failed `GET /approvals/<id>` removes `id` from the route query.
11. [unit] On `/[project]/approvals`, an `approval_request` live event triggers one list reload after the 300 ms debounce.
12. [unit] A 403 list answer shows `approvals.inbox.forbidden`.
13. [unit] A list that fails with 500 before any load shows `approvals.inbox.loadFailed`.
14. [unit] A list that fails with 500 after a successful load keeps the loaded rows and shows `approvals.inbox.stale`.
15. [unit] A failed `GET /projects/sandbox` on `/[project]/approvals` makes no `GET /approvals` request.

### US-003: Decide panel, decisions and cancel

1. [unit] Opening a `label.create` request in `ApprovalRequestInbox` renders `ApprovalRequestPanel` with that request's detail.
2. [unit] The panel shows the request's `input` as indented JSON text through interpolation.
3. [unit] The panel lists each decision's `deciderId`, `decision` and `comment`.
4. [unit] Approve with comment `ok` posts `{ decision: 'approve', comment: 'ok' }` to `/approvals/<id>/decisions`.
5. [unit] Reject with a blank comment posts `{ decision: 'reject' }`, with no `comment` field.
6. [unit] A comment of 2001 characters posts nothing.
7. [unit] A decide answered with 409 requests the list again.
8. [unit] A decide answered with 403 requests `GET /approvals/<id>` again.
9. [unit] A pending request whose `viewerActions` is `{ decide: false, cancel: true }` renders no Approve button.
10. [unit] Clicking Cancel on that request posts to `/approvals/<id>/cancel`.
11. [unit] A settled request renders no Approve, Reject or Cancel button.
12. [unit] A successful decide increases `approvalRequestsVersion` by 1.

### US-004: Fleet panels and outcome

1. [unit] `ApprovalRequestPanel` renders `ApprovalRequestBashPanel` for an open pending `fleet.job.shell.escalate` request.
2. [unit] `ApprovalRequestPanel` renders `ApprovalRequestBudgetPanel` for an open pending `fleet.budget.override` request.
3. [unit] The bash panel shows the `command` of the request's `input.payload`.
4. [unit] The bash panel links the job at `/<slug>/fleet/jobs/<details.jobId>` when the request's project slug is known.
5. [unit] A bash payload whose `options` are `['deny']` offers only the Deny button.
6. [unit] Allow posts `{ decision: 'approve', params: { choice: 'allow' } }`.
7. [unit] Allow for this job posts `{ decision: 'approve', params: { choice: 'allow_for_job' } }`.
8. [unit] Deny posts `{ decision: 'reject', params: { choice: 'deny' } }`.
9. [unit] The budget panel ticks every `details.requeueCandidates` row by default.
10. [unit] Raise with amount `50` and one of two candidates unticked posts `{ decision: 'approve', params: { amountUsd: 50, requeueJobIds: [<the ticked id>] } }`.
11. [unit] Raise with an amount not above the frozen `spentUsd` posts nothing.
12. [unit] Keep paused posts `{ decision: 'reject' }`.
13. [unit] A budget detail with `requeueCandidatesTruncated: true` shows `approvals.fleet.budget.truncated`.
14. [unit] The outcome of a settled bash request whose `details.resolvedBy` is `user` and `details.outcome.delivery` is `{ result: 'ok' }` shows `approvals.fleet.delivery.delivered`.
15. [unit] The outcome of an executed budget request shows a `requeueResults` entry `{ jobId: 'j2', ok: false, error: '{"code":"fleet.jobState"}' }` with the `notCancelled` reason label.

### US-005: Approval toasts and the home card on the engine

1. [unit] `refresh()` with counts `total: 0` makes no `GET /approvals` request.
2. [unit] `refresh()` with counts `total: 2` requests `GET /approvals` with `{ status: 'pending', size: '100' }`.
3. [unit] A listed request whose `viewerActions` allows deciding, not seen before, raises one toast whose action leads to `inboxHref(null, id)`.
4. [unit] A second `refresh()` listing the same request raises no second toast.
5. [unit] A listed request whose `viewerActions` is `{ decide: false, cancel: true }` raises no toast.
6. [unit] A listed request whose `expiresAt` is in the past raises no toast.
7. [unit] `decided('r1')` dismisses the toast of r1.
8. [unit] A `refresh()` whose list no longer holds a toasted request dismisses its toast.
9. [unit] `toggleBrowserNotifications()` with the browser permission `granted` stores the preference under `koda-approval-notifications-<userId>`.
10. [unit] The notification bell renders a notification of kind `approval_request` with `params: { key: 'label.create' }` as the `notifications.kinds.approval_request` text.
11. [unit] `HomeNeedsYou` links an approval row with `projectSlug: 'sandbox'` and id `r1` to `/sandbox/approvals?id=r1`.
12. [unit] `HomeNeedsYou` links an approval row with `projectSlug: null` and id `r1` to `/approvals?id=r1`.
13. [unit] `HomeNeedsYou`, with a `te` double that answers `false`, shows an approval row with `type: null` and `permissionKey: 'label.create'` as `label.create`.

### US-006: Badge, nav and palette

1. [unit] The mounted badge, with `GET /approvals/counts` answering `total: 120`, shows `99+`.
2. [unit] The badge renders nothing when `total` is 0.
3. [unit] On a project page with slug `sandbox`, the badge links to `/sandbox/approvals`.
4. [unit] Off a project page, the badge links to `/approvals` when the global set `mayDecide()`.
5. [unit] An `approval_request` live event triggers one counts reload after the 300 ms debounce.
6. [unit] Every successful counts load is followed by one `useApprovalRequestNotifications().refresh()` call.
7. [unit] The layout renders a `/approvals` nav link when the global set `mayDecide()`.
8. [unit] `ProjectApprovalNavLinks` with slug `sandbox` renders a `/sandbox/approvals` link when the project set `mayDecide()`.
9. [unit] `ProjectApprovalNavLinks` with slug `sandbox` renders a `/sandbox/approval-policies` link when the project set holds `approval.policy.read`.
10. [unit] The layout renders an `/admin/approval-policies` link for a caller whose only global key is `approval.policy.manage`.
11. [unit] The command palette lists an `approvals` command that navigates to `/approvals` when the global set `mayDecide()`.
12. [unit] Off a project page, for a caller whose global set does not `mayDecide()`, the badge links to `/<slug>/approvals` of the first `projects` row of the counts.
13. [unit] A 403 counts answer stops the badge's polling.
14. [unit] A bump of `approvalRequestsVersion` triggers one counts reload.
15. [unit] The layout, on a project route with slug `sandbox`, mounts `ApprovalsProjectApprovalNavLinks` with `slug: 'sandbox'`.

### US-007: Job page, budget banner and fleet links on the engine

1. [unit] The job page for job `j1` requests `GET /approvals` with `{ jobId: 'j1', size: '100' }`.
2. [unit] `listForJob` given a settled row then a pending row returns the pending row first.
3. [unit] `JobApprovals` shows a row whose detail holds a bash payload with that payload's `commandPreview`.
4. [unit] The job page reloads its approvals after an `approval_request` live event.
5. [unit] `JobApprovals` links a row to `/<slug>/approvals?id=<id>`.
6. [unit] `JobApprovals` shows a row whose `detail` is `null` with its raw `permissionKey`.
7. [unit] The job page's review callout links to `/<slug>/approvals?id=<id>` of the pending request with the soonest `expiresAt`.
8. [unit] The budget banner on slug `sandbox` (project id `p1`) requests `GET /approvals` with `{ status: 'pending', permissionKey: 'fleet.budget.override', projectId: 'p1', size: '100' }`.
9. [unit] The banner links a paused policy whose id equals a listed request's `budgetAskOf(detail).policyId` to `/sandbox/approvals?id=<that request id>`.
10. [unit] A failed banner request raises no toast.
11. [unit] The fleet index Approvals button navigates to `/<slug>/approvals`.
12. [unit] `attentionLink` for an item of kind `job_waiting_approval` in project `koda` returns `/koda/approvals`.

### US-008: Global approval policy page

1. [unit] `patternFloor('fleet.*', keys)` returns the strictest `floor` among the keys under `fleet.`.
2. [unit] `patternFloor('nothing.here', keys)` returns `null`.
3. [unit] `modeOptions('agent')` returns `['agent', 'human']`.
4. [unit] `overrideCount('label.create', policies)` counts the policies whose pattern is `label.create` or `label.*`, and not one whose pattern is `ticket.*`.
5. [unit] `buildPolicySchema(t, 'none')` rejects a `timeoutSec` of `30` with the `approvals.policies.validation.timeout` message.
6. [unit] `buildPolicySchema(t, 'human')` rejects `onTimeout: 'approve'` with the `approvals.policies.validation.timeoutApprove` message.
7. [unit] `useApprovalPolicies({ kind: 'global' }).list()`, whose first `GET /approval-policies` answer has `hasNext: true`, requests the list again with `current: '2'`.
8. [unit] With global `approval.policy.manage`, mounting `/admin/approval-policies` requests `GET /approval-policies/keys`.
9. [unit] Without `approval.policy.manage`, the page shows `approvals.policies.forbidden` and requests nothing.
10. [unit] `ApprovableKeysTable` shows each key's `overrideCount`.
11. [unit] Creating with pattern `label.create`, subject type `AGENT`, mode `human` and an empty timeout posts `{ permissionPattern: 'label.create', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human', onTimeout: 'reject' }` to `/approval-policies`.
12. [unit] Without global `role.read`, the dialog does not offer the `role` subject kind.
13. [unit] Editing a policy with a blank timeout sends `PATCH /approval-policies/<id>` with `timeoutSec: null`.
14. [unit] Confirming Delete sends `DELETE /approval-policies/<id>`.
15. [unit] A create answered with 400 toasts `extractApiError` and keeps the dialog open.

### US-009: Project approval policy page

1. [unit] With project `approval.policy.read`, mounting `/sandbox/approval-policies` requests `GET /projects/sandbox/approval-policies/keys`.
2. [unit] Without project `approval.policy.read`, the page shows `approvals.policies.forbidden` and requests nothing.
3. [unit] A listed policy with `projectId: null` shows `approvals.policies.project.inherited` and no Edit button.
4. [unit] Without project `approval.policy.manage`, the page renders no Create button.
5. [unit] Creating a policy posts to `/projects/sandbox/approval-policies`.
6. [unit] Editing a project policy sends `PATCH /projects/sandbox/approval-policies/<id>`.
7. [unit] Confirming Delete on a project policy sends `DELETE /projects/sandbox/approval-policies/<id>`.
8. [unit] With project `member.read`, the dialog's role picker lists `useProjectRoles('sandbox').roles`.
9. [unit] The keys table's override count for `label.create` counts a global `label.*` policy and a project `label.create` policy.

### US-010: Terminal cleanup

1. [unit] Loading `/admin/fleet/approvals?id=r1` navigates to `/approvals?id=r1` with redirect code 302.
2. [unit] Loading `/admin/fleet/approvals` with no query navigates to `/approvals`.
3. [unit] Loading `/sandbox/fleet/approvals?id=r1` navigates to `/sandbox/approvals?id=r1` with redirect code 302.

Removals (verified by `bun run type-check`, `bun run lint` and `bun run test` in `apps/web`, not by ACs):
- the fleet inbox components;
- `useFleetApprovals`, `useApprovalNotifications` and `useActionPreview`;
- the fleet-only `lib/fleet-approvals.ts` exports;
- the admin fleet approvals nav link.
