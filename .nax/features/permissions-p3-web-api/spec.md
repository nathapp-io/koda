# SPEC: permissions-p3-web-api — the engine reads the web inbox needs

## Summary

This feature is 7a of P3 feature 7 (`p3-web`), split three ways by the user on 2026-10-30:
- 7a: the API additions;
- 7b: the web pages;
- 7c: retiring the fleet approval adapters.

It adds what the approval engine still lacks before the web can drop the `/fleet/approvals` adapters. Everything it adds is additive; nothing is removed:

| Story | What |
|:--|:--|
| US-001 | `GET /approvals/counts`: pending requests the caller can see, per project plus unscoped; `GET /approvals` takes a `jobId` filter |
| US-002 | `GET /approvals/:id` carries a per-key `details` block; the two fleet asks fill it (job, resolution, outcome, re-queue candidates) |
| US-003 | Home "needs you" lists every pending request the caller can see, not only the two fleet keys |
| US-004 | Outbound webhooks `approval.requested` and `approval.resolved` for every key, sent by the engine in the transaction that writes the status |

It is P3 feature 7a in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine", §6 "Web UI").

## Motivation

The fleet inbox, its header badge, the home "needs you" card and the fleet notifications all still read the fleet adapters:
- `GET /fleet/approvals`, `GET /projects/:slug/fleet/approvals` and `GET /fleet/approval-counts`;
- `FleetApprovalDto`;
- the `fleet_approval_requested` outbox event.

The adapters exist only so the web keeps working until the unified inbox ships (`permissions-p3-approval-fleet`, 4b). The web feature (7b) cannot move onto `/approvals` until the engine answers four things it does not answer today:
- **A pending count for the badge.** `GET /fleet/approval-counts` counts only the two fleet keys, over `fleet.approval.read`.
- **What a fleet ask is about.** A bash ask names its job. A budget ask lists the cancelled jobs a raise can re-queue. Its outcome and resolution live on the `FleetApprovalAsk` link, which `ApprovalRequestDto` never shows.
- **Home "needs you" for every key.** `PrismaHomeRepository.pendingWhere` filters to `FLEET_ASK_KEYS`, so a gated agent write waiting on a human never reaches the home card.
- **One webhook family for every key.** Outbound webhooks exist only as `fleet.approval.requested` and `fleet.approval.resolved`, for the two fleet keys.

The user ruled (2026-10-30) that webhooks become `approval.requested`/`approval.resolved` for every key. 7a adds them. 7c deletes the `fleet.approval.*` events.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **One visibility rule.** The `where` that `PrismaApprovalRequestRepository.findVisiblePage` builds today moves into a pure function, `visibleRequestWhere(visibility, filter)`, in the new file `approvals/approval-visibility.ts`. The list, the counts and the home card all call it, so the badge, the inbox and the home card cannot disagree on what a caller sees.
- **Counts count what the list lists.** For a caller, `GET /approvals/counts` returns `total` equal to the `total` of `GET /approvals?status=pending`, so the badge and the inbox's pending tab agree.
  - `ApprovalRequest.projectId` is a plain string with no `Project` relation, so there is no project filter: every visible pending request is counted, whatever its project's state.
  - `unscoped` counts the visible pending requests with `projectId: null`.
  - `projects` has one row per distinct non-null `projectId` among them (a `groupBy` on `projectId` over the visibility `where`), with `slug` read by a second query, `project.findMany({ where: { id: { in } }, select: { id, slug } })`. `slug` is `null` when the project row is gone. Rows are ordered by `slug` ascending, nulls last, then `projectId`.
  - So `total = unscoped + Σ projects[].pending`.
- **New schema names.** The response DTOs are `ApprovalRequestCountsDto` and `ProjectApprovalRequestCountDto`. The fleet's `ApprovalCountsDto` and `ProjectApprovalCountDto` keep their names until 7c deletes them, so the two OpenAPI schemas never collide.
- **Per-key details through the command.**
  - `ApprovalCommand` gains an optional `details?(request: ApprovalRequestRecord): Promise<Record<string, unknown> | null>`.
  - A new `ApprovalRequestQueries.getDetail(principal, id)` calls `get` and then asks the command registered for the request's key and variant (`registry.get(request.permissionKey, request.variant)`). It answers `details` (`null` when no command is registered or the command has no `details`). Only `GET /approvals/:id` calls `getDetail`.
  - `get` is unchanged and stays the visibility pre-check of the decide and cancel handlers, so a decide or cancel never runs `details` or its candidate query.
  - `ApprovalRequestDto.from` maps `details ?? null`, so the decide and cancel responses (built from `{ request, decisions }`) answer `details: null`. The three envelopes keep one shape.
  - The engine never imports the fleet: the fleet commands, already registered by `ApprovalsModule.onModuleInit`, implement it.
  - A `details` call that throws is logged as a warning through a class logger, and `getDetail` answers `details: null`. A broken detail block never hides a request from its decider.
- **The fleet detail blocks.** Both are read through `FleetApprovalAskStore.findApproval(request.id)`, the view the adapter answers today, so the resolution matches what the fleet inbox showed:
  - `fleet.job.shell.escalate`: `{ kind: 'bash', jobId, resolvedBy, outcome }`.
  - `fleet.budget.override`: `{ kind: 'budget', policyId, resolvedBy, outcome }`. While the request is `pending` it also carries `requeueCandidates`, each `{ jobId, projectId, feature, queuedAt }` with `queuedAt` an ISO string, from `findRequeueCandidates(policyId, new Date(input.requestedAt), MAX_REQUEUE_CANDIDATES + 1)`, where `input` is the request's frozen input parsed by the command's own `parse` (the same `requestedAt` `execute` uses), cut to `MAX_REQUEUE_CANDIDATES`. It also carries `requeueCandidatesTruncated: true` when more existed, else `false`. A settled budget request carries neither field.
  - A request whose link is missing (the view answers null) has `details: null`.
- **The decide route stays as it is.** The engine's `POST /approvals/:id/decisions` already parses the fleet `params` through each command's `parseDecision`:
  - the bash choice, checked against nax's offer;
  - the budget raise amount, and the re-queue ids as a set.

  A re-queue id that is not a candidate when the decision executes is recorded as refused in the result, as today. The adapter's earlier 400 for a non-candidate id stays only on the adapter, and goes with it in 7c.
- **The job filter.** `GET /approvals` takes an optional `jobId`. It keeps only requests whose `FleetApprovalAsk` link names that job, through the existing `ApprovalRequest.fleetAsk` relation. It is a filter like `permissionKey`: visibility still applies.
- **Home reads the engine's visibility.**
  - `HomeService` gains a `PermissionService` constructor dependency (after the repository). `HomeService.snapshot(caller, now)` builds the scope from `approvalDecideScopes({ type: 'USER', id: caller.id })`.
  - `PrismaHomeRepository.findPendingApprovals` and `countPendingApprovals` use `visibleRequestWhere(scope.visibility, { status: 'pending' })` as their whole `where`, newest first. There is no project filter, as in the list and the counts.
  - `HomeApprovalRow`, `HomeApprovalView` and `HomeApprovalDto` gain `permissionKey`. `type` becomes nullable: `fleetTypeOfKey(permissionKey)`, so the fleet type for the two fleet keys, else `null`. A fleet-key request with no link keeps its fleet type and has `jobId: null`. `jobId` comes from the link.
  - `HomeApprovalDto.type` keeps its `enum: APPROVAL_TYPES` and gains `nullable: true`.
  - The home card's unscoped rows now follow `approvalDecideScopes` (an admin binding), not the controller's `globalAdmin` flag (`can('project.read')`). A user with a global `project.read` grant but no admin binding no longer sees no-project asks; accepted, since they could not decide them.
  - The blocked-jobs lookup keeps reading the `jobId`s of the scanned pending rows.
- **Webhooks in the status transaction.**
  - `ApprovalRequestEvents.record` already runs in the transaction that writes each status. It also calls `WebhookDispatcherService.dispatch(projectId, event, payload)` when `request.projectId` is not null:
    - event `approval.requested` for status `pending`;
    - event `approval.resolved` for every other status (`approved`, `rejected`, `expired`, `cancelled`, `executed` and `failed`).
  - A decision writes `approved` in the decide transaction and execution writes `executed` in a second one, and each write records. So every approve sends `approval.resolved` twice: `status: 'approved'`, then `status: 'executed'` (or `failed`). For a redeem request the second comes when it is redeemed. A client filters by `status`.
  - A request with no project sends nothing, as the fleet webhooks do.
  - The payload is `ApprovalWebhookPayload`: `requestId`, `permissionKey`, `status`, `projectId`, `requiredMode`, `actorType`, `actorId`, `onBehalfOfType`, `onBehalfOfId`, `expiresAt` (ISO) and `path` (`/approvals?id=<requestId>`). It never carries the frozen input, the result or the decisions.
- **Breaking the module cycle.**
  - `WebhookModule` imports `ApprovalEngineModule` (its routes are gated), so the engine cannot import `WebhookModule`.
  - A new `WebhookDispatchModule` (`webhook/webhook-dispatch.module.ts`, with no `imports`: `PrismaService`, `TRANSACTION_MANAGER` and `OutboxService` are global, as `ApprovalEngineModule` relies on) provides `PrismaWebhookRepository`, `{ provide: WEBHOOK_REPOSITORY, useExisting: PrismaWebhookRepository }` and `WebhookDispatcherService`, and exports only `WebhookDispatcherService` (repositories are module-private, `.nax/rules/api-data.md`).
  - `WebhookModule` imports it and drops only `WebhookDispatcherService` from its `providers`; it keeps its own `PrismaWebhookRepository` and `WEBHOOK_REPOSITORY` providers (stateless, so a second instance is harmless) and keeps exporting `WebhookDispatcherService` by re-exporting `WebhookDispatchModule`.
  - `ApprovalEngineModule` imports `WebhookDispatchModule`.
- **`openapi.json` is regenerated in each story that changes the contract** (US-001, US-002, US-003): `bun run api:export-spec` from the repo root. `apps/cli/src/generated` is not regenerated (7c deletes the CLI command that uses the fleet routes).

### Shared names

| Name | Where | Story |
|:--|:--|:--|
| `visibleRequestWhere(visibility: { principal: PrincipalRef; scopes: DecideScopes }, filter: ApprovalRequestFilter): Prisma.ApprovalRequestWhereInput` | `approvals/approval-visibility.ts` (new) | US-001 |
| `ApprovalRequestCountsDto { total: number; unscoped: number; projects: ProjectApprovalRequestCountDto[] }` | `approvals/dto/approval-request-counts.dto.ts` (new) | US-001 |
| `ProjectApprovalRequestCountDto { projectId: string; slug: string \| null; pending: number }` | same file | US-001 |
| `ApprovalRequestQueries.counts(principal: PrincipalRef): Promise<ApprovalRequestCounts>` | `approvals/approval-request.queries.ts` | US-001 |
| `PrismaApprovalRequestRepository.countVisiblePending(visibility): Promise<{ unscoped: number; projects: Array<{ projectId: string; slug: string \| null; pending: number }> }>` | `approvals/prisma-approval-request.repository.ts` | US-001 |
| `ApprovalCommand.details?(request: ApprovalRequestRecord): Promise<Record<string, unknown> \| null>` | `approvals/approval-command.registry.ts` | US-002 |
| `ApprovalRequestDetail { request; decisions; details?: Record<string, unknown> \| null }` and `ApprovalRequestQueries.getDetail(principal, id): Promise<ApprovalRequestDetail>` | `approvals/approval-request.queries.ts` | US-002 |
| `ApprovalRequestFilter.jobId?: string` | `approvals/approval-request.queries.ts` | US-001 |
| `ApprovalWebhookPayload` and `approvalWebhookPayloadOf(request: ApprovalRequestRecord): ApprovalWebhookPayload` | `approvals/approval-request-events.ts` | US-004 |
| `WebhookDispatchModule` | `webhook/webhook-dispatch.module.ts` (new) | US-004 |

### Integration

Read only (verified at `f51699ce`):
- `ApprovalRequestQueries.list(principal, filter, page)` and `get(principal, id)`: `approvals/approval-request.queries.ts`. `isVisible` (same file) is the in-memory twin of the visibility `where`.
- `PermissionService.approvalDecideScopes(principal): Promise<DecideScopes>`, and `DecideScopes { everywhere; global: DecidePatterns; projects }`: `permissions/permission.service.ts`.
- `ApprovalCommandRegistry.get(key: string, variant?: string): ApprovalCommand | undefined`: `approvals/approval-command.registry.ts`.
- `FleetApprovalAskStore.findApproval(id)` (the fleet view: `jobId`, `policyId`, `resolvedBy`, `outcome`, `requestedAt`) and `findRequeueCandidates(policyId, since, limit)`: `fleet/approvals/fleet-approval-ask.store.ts`. `RequeueCandidate { jobId; projectId; feature; queuedAt: Date }` and `MAX_REQUEUE_CANDIDATES = 200`: `fleet/approvals/domain/approval.domain.ts`.
- `FleetShellEscalateCommand` (`fleet/approvals/commands/fleet-shell-escalate.command.ts`, key `fleet.job.shell.escalate`) and `FleetBudgetOverrideCommand` (`fleet/approvals/commands/fleet-budget-override.command.ts`, key `fleet.budget.override`). Both already inject `FleetApprovalAskStore` as `asks`.
- `WebhookDispatcherService.dispatch(projectId, event, payload)`: `webhook/webhook-dispatcher.service.ts`. It records one `webhook_delivery` outbox row per active webhook subscribed to `event` (exact match on the `events` JSON array), and must run inside the triggering transaction.

Changed (the baseline only locates the code; implement the target):
- `PrismaApprovalRequestRepository.findVisiblePage`.
  - Baseline: it builds the visibility `where` inline.
  - Target: it calls `visibleRequestWhere(visibility, filter)` and keeps its pagination and order.
- `ApprovalRequestFilter`.
  - Baseline: `{ status?; projectId?; permissionKey?; mine? }`.
  - Target: it adds `jobId?: string`.
- `ListApprovalRequestsQuery` (`approvals/dto/list-approval-requests.query.ts`) adds an optional `jobId` (string, not empty, at most 64 characters).
- `ApprovalRequestDetail`.
  - Baseline: `{ request; decisions }`.
  - Target: `{ request; decisions; details?: Record<string, unknown> | null }`; `getDetail` always sets it.
- `ApprovalRequestsController.get`.
  - Baseline: calls `queries.get`.
  - Target: calls `queries.getDetail`. `decide` and `cancel` keep calling `queries.get`.
- `ApprovalRequestDto` (`approvals/dto/approval-request.dto.ts`) adds `details`: an object, or null.
- `ApprovalRequestsController` gains `@Get('counts')`, declared before `@Get(':id')`. It has `@UseGuards(RequiresGuard)`, `@Requires('approval.decide', { enforcedBy: 'service' })` and `@ApiResponse({ status: 200 })` with the `ApprovalRequestCountsDto` envelope schema.
- `HomeApprovalScope`.
  - Baseline: `{ projectIds: string[]; includeUnscoped: boolean }`.
  - Target: `{ visibility: { principal: PrincipalRef; scopes: DecideScopes } }`.
- `HomeApprovalView` / `HomeApprovalDto`.
  - Baseline: `type: string`.
  - Target: `type: string | null`, plus `permissionKey: string`.
- `ApprovalRequestEvents`.
  - Baseline: its constructor is `(outbox: OutboxService)`.
  - Target: `(outbox: OutboxService, webhooks: WebhookDispatcherService)`.

### Failure Handling

| Case | Behaviour | Story |
|:--|:--|:--|
| `details` of a registered command throws | warning logged through the class logger; `GET /approvals/:id` answers 200 with `details: null` | US-002 |
| fleet request whose `FleetApprovalAsk` link is missing | `details: null` | US-002 |
| `GET /approvals/counts` without credentials | 401 | US-001 |
| `GET /approvals?jobId=` empty or over 64 characters | 400 | US-001 |
| a webhook dispatch fails inside `ApprovalRequestEvents.record` | the error propagates and the status write rolls back, like every other write in that transaction | US-004 |
| a project webhook with malformed `events` JSON | skipped and logged by `WebhookDispatcherService` (existing); the status write commits | US-004 |

## Out of Scope

- Any web change: the inbox, badge, notifications page wiring, job page, budget banner and policy pages are 7b `permissions-p3-web`.
- Deleting `/fleet/approvals`, `/projects/:slug/fleet/approvals`, `/fleet/approval-counts`, `FleetApprovalDto`, `ApprovalCountsDto`, the `fleet.approval.read` and `fleet.approval.decide.*` keys, the `fleet_approval` live event, the `fleet.approval.requested`/`fleet.approval.resolved` webhooks, `koda_list_approvals`'s fleet route and the CLI `koda fleet approval` command: 7c `permissions-p3-retire-fleet-approvals`.
- Regenerating `apps/cli/src/generated`: only `openapi.json` is regenerated.
- Leaving out requests of soft-deleted projects from the list, the counts or the home card: `ApprovalRequest` has no `Project` relation, and all three keep the list's visibility exactly.
- A `jobId` (or any fleet field) on `ApprovalRequestSummaryDto` list rows: the fleet block is on the detail only.
- A 400 from the engine's decide route for a budget re-queue id that is not a candidate: the command records it as refused, as today.
- Notifications: the engine's `ApprovalRequestedSubscriber` keeps skipping the two fleet keys, and `FleetApprovalRequestedSubscriber` and the `fleet_approval_requested` outbox event stay. The switch, and deleting the fleet path, move to 7c, after 7b ships the `/approvals` page the engine notification links to (ruled 2026-10-30).
- Webhooks for requests with no project (global budget asks): none are sent, as today.
- US-004 only: a webhook dispatch that fails inside the execution or settle transaction of an approved request. The error propagates, the request stays `approved`, and the existing stale-approved sweep (`ApprovalRequestExpirySweeper`, `findStaleApproved`) owns it; no AC pins that path.
- A changed live event: the engine's `approval_request` live event is unchanged.
- An idempotency key on webhook deliveries: a redelivered status is not possible here, because each status is recorded once in its own write transaction.
- US-002 only: the bash ask's frozen input (`input.payload`, nax's command and options) is already on `ApprovalRequestDto.input`, so the bash `details` block does not repeat it.

## Stories

- **US-001: Pending counts for the badge, over one visibility rule.** No dependencies. Workdir: `apps/api`. Extracts `visibleRequestWhere` from `findVisiblePage`, adds `PrismaApprovalRequestRepository.countVisiblePending`, `ApprovalRequestQueries.counts` and `GET /approvals/counts`, adds the `jobId` list filter (a `fleetAsk: { is: { jobId } }` clause in `visibleRequestWhere`), and regenerates `openapi.json`.
- **US-002: Per-key details on the request, filled by the fleet asks.** No dependencies. Workdir: `apps/api`.
  - Adds `ApprovalCommand.details`, and `details` on `ApprovalRequestDetail` and `ApprovalRequestDto`.
  - Implements `details` on `FleetShellEscalateCommand` and `FleetBudgetOverrideCommand`.
  - Regenerates `openapi.json`.
- **US-003: Home "needs you" over the engine's visibility.** Depends on US-001. Workdir: `apps/api`.
  - Moves `HomeApprovalScope` onto `visibleRequestWhere`; `HomeService` gains `PermissionService`.
  - Adds `permissionKey` to `HomeApprovalDto` and makes `type` nullable.
  - Regenerates `openapi.json`.
- **US-004: `approval.requested` and `approval.resolved` webhooks for every key.** No dependencies. Workdir: `apps/api`.
  - Adds `WebhookDispatchModule`.
  - `ApprovalRequestEvents.record` dispatches the two events in the status transaction, with `ApprovalWebhookPayload`.
### Context Files

**US-001**
- `apps/api/src/approvals/prisma-approval-request.repository.ts`
- `apps/api/src/approvals/approval-request.queries.ts`
- `apps/api/src/approvals/approval-requests.controller.ts`
- `apps/api/src/fleet/approvals/dto/approval-counts.dto.ts`
- `apps/api/test/integration/approvals/approval-request-visibility.integration.spec.ts`

**US-002**
- `apps/api/src/approvals/approval-command.registry.ts`
- `apps/api/src/approvals/approval-request.queries.ts`
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts`
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.ts`
- `apps/api/src/fleet/approvals/dto/fleet-approval.dto.ts`

**US-003**
- `apps/api/src/home/prisma-home.repository.ts`
- `apps/api/src/home/home.service.ts`
- `apps/api/src/home/home.types.ts`
- `apps/api/src/approvals/approval-visibility.ts` — created by US-001, used here
- `apps/api/test/integration/home/home-api.integration.spec.ts`

**US-004**
- `apps/api/src/approvals/approval-request-events.ts`
- `apps/api/src/approvals/approval-engine.module.ts`
- `apps/api/src/webhook/webhook.module.ts`
- `apps/api/src/webhook/webhook-dispatcher.service.ts`
- `apps/api/src/fleet/approvals/approval-payloads.ts`

### Creates

**US-001**
- `apps/api/src/approvals/approval-visibility.ts`
- `apps/api/src/approvals/approval-visibility.spec.ts`
- `apps/api/src/approvals/dto/approval-request-counts.dto.ts`
- `apps/api/test/integration/approvals/approval-request-counts.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/approvals/commands/fleet-ask-details.spec.ts`
- `apps/api/test/integration/approvals/approval-request-details.integration.spec.ts`

**US-003**
None.

**US-004**
- `apps/api/src/webhook/webhook-dispatch.module.ts`
- `apps/api/src/webhook/webhook-dispatch.module.spec.ts`
- `apps/api/test/integration/approvals/approval-request-webhooks.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `findVisiblePage` calls `visibleRequestWhere` instead of building the `where` inline; `countVisiblePending` is added.
- `apps/api/src/approvals/approval-request.queries.ts` — gains `counts(principal)`; `ApprovalRequestFilter` gains `jobId`.
- `apps/api/src/approvals/dto/list-approval-requests.query.ts` — gains the optional `jobId` field (string, not empty, at most 64 characters).
- `apps/api/src/approvals/approval-requests.controller.ts` — gains the counts route (GET approvals/counts), declared before the get-by-id route.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains two cases for the counts route: with the admin token it returns 200, and without credentials 401 (repo rule: every endpoint change is reflected in this file).
- `openapi.json` — regenerated: the new counts operation, the ApprovalRequestCountsDto and ProjectApprovalRequestCountDto schemas, and the jobId query parameter of the list operation.

**US-002**
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand` gains the optional `details` method.
- `apps/api/src/approvals/approval-request.queries.ts` — `ApprovalRequestDetail` gains the optional `details`; a new `getDetail` fills it from the registered command (`ApprovalCommandRegistry` is injected); `get` is unchanged; the class gains a `Logger` for a throwing `details`.
- `apps/api/src/approvals/approval-requests.controller.ts` — the get-by-id handler calls `queries.getDetail`; the decide and cancel handlers keep `queries.get` and build their response from `{ request, decisions }`, which answers `details: null`.
- `apps/api/src/approvals/approval-http.spec.ts` — the expectation of "detail retains result and serializes decisions without internal requestId" gains `details: null`; the other `ApprovalRequestDto.from` cases are unchanged.
- `apps/api/src/approvals/dto/approval-request.dto.ts` — `ApprovalRequestDto` gains `details` (object or null) and `from` maps `details ?? null`.
- `apps/api/src/fleet/approvals/commands/fleet-shell-escalate.command.ts` — implements `details`.
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` — implements `details`.
- `openapi.json` — regenerated: the details property of ApprovalRequestDto.

**US-003**
- `apps/api/src/home/home.types.ts` — `HomeApprovalScope` becomes `{ visibility }`; `HomeApprovalRow` and `HomeApprovalView` gain `permissionKey` and their `type` becomes `string | null`.
- `apps/api/src/home/home.types.spec.ts` — the `approval` fixture gains `permissionKey: 'fleet.job.shell.escalate'`; its assertions are unchanged.
- `apps/api/src/home/home.service.ts` — the constructor gains `PermissionService`; `snapshot` builds the scope from `approvalDecideScopes({ type: 'USER', id: caller.id })`.
- `apps/api/src/home/prisma-home.repository.ts` — `pendingWhere` becomes `visibleRequestWhere(scope.visibility, { status: 'pending' })`; rows map `permissionKey`, `type` from `fleetTypeOfKey` (`null` for another key) and `jobId` from the link.
- `apps/api/src/home/dto/home-dashboard.dto.ts` — `HomeApprovalDto` gains `permissionKey`; `type` keeps `enum: APPROVAL_TYPES` and gains `nullable: true`.
- `apps/api/src/home/prisma-home.repository.pending-approvals.spec.ts` — the four cases are rewritten for the new `where`, which is exactly what `visibleRequestWhere(visibility, { status: 'pending' })` returns (asserted by deep equality with a call to it, not by a hand-written shape): "AC-9: labels each pending request by its fleet key and takes the job from the link" keeps its row mapping and adds `permissionKey`; "AC-10: a global admin scope also reads the asks no project owns" passes an `everywhere` visibility and asserts the `where` has no `OR`; "counts the same rows it would list, and never matches anything on an empty scope" keeps the count-equals-list half and drops the empty-scope half (a principal always sees its own requests, so no scope is empty); "leaves out a row whose key is not a fleet key, and reads the page newest first with its bound" becomes: a row for `agent.create` is read with `type: null` and `permissionKey: 'agent.create'`, with the same order and bound.
- `apps/api/src/home/home.service.spec.ts` — every `new HomeService(repo)` becomes `new HomeService(repo, permissions)` with a `PermissionService` double whose `approvalDecideScopes` answers a fixed scope; the `approval` row helper gains `permissionKey: 'fleet.job.shell.escalate'`; every expectation on the `{ projectIds, includeUnscoped }` scope becomes an expectation on `{ visibility: { principal: { type: 'USER', id: <caller id> }, scopes: <that scope> } }`.
- `apps/api/test/integration/home/home-api.integration.spec.ts` — in `beforeAll`, `bashAsk` is seeded with `onBehalfOf: { type: 'USER', id: world.ids.dev }` (`seedFleetAsk` supports it), so `dev` still sees it under the engine visibility and "scopes a member to their projects", "US-011 AC-9" and their blocked-job, `attentionJobs`, `jobsTotal` and `pendingApprovals` assertions stay unchanged; "gives a global admin every live project plus unscoped approvals" and "US-011 AC-10: the admin approvals count includes the pending budget ask that has no project" (read as `root`) are unchanged. New US-003 cases are added to this file.
- `openapi.json` — regenerated: `HomeApprovalDto.permissionKey` and the nullable `type`.

**US-004**
- `apps/api/src/approvals/approval-request-events.ts` — gains `WebhookDispatcherService` in the constructor, `ApprovalWebhookPayload`, `approvalWebhookPayloadOf`, and the dispatch in `record`.
- `apps/api/src/approvals/approval-engine.module.ts` — imports `WebhookDispatchModule`.
- `apps/api/src/approvals/approval-engine.module.spec.ts` — the module now imports `WebhookDispatchModule`, which has no imports and resolves from the spec's existing global stubs (Prisma, transaction manager, `OutboxService`); no new stub is expected, and if one is needed it is added to the spec's stub module.
- `apps/api/src/webhook/webhook.module.ts` — imports `WebhookDispatchModule`, drops only `WebhookDispatcherService` from `providers` (its `PrismaWebhookRepository` and `WEBHOOK_REPOSITORY` providers stay), and re-exports `WebhookDispatchModule` in place of `WebhookDispatcherService` in `exports`.
- `apps/api/src/approvals/approval-request-events.spec.ts` — `new ApprovalRequestEvents(outbox)` gains a dispatcher double; its existing outbox assertions stay.

### Seams

- US-001 → US-003: `visibleRequestWhere`. US-003 AC-1 enters through `GET /api/home` and also compares its rows with `GET /api/approvals?status=pending` for the same caller.
- US-002: `ApprovalCommand.details` is consumed by `ApprovalRequestQueries.getDetail` in the same story; AC-1 and AC-4 enter through `GET /api/approvals/:id`.
- US-004: `WebhookDispatcherService.dispatch` is reached from `ApprovalRequestEvents.record`; AC-1 and AC-2 enter through the existing gate and decide routes, never by calling `record` directly.

## Acceptance Criteria

Workdir for every story: `apps/api`. Every integration AC runs against the test Postgres through the HTTP app unless it says otherwise.

### US-001: Pending counts for the badge, over one visibility rule

- AC-1 [integration]: `GET /api/approvals/counts` as a global admin, with two pending requests in project A (slug `a-proj`), one in project B (slug `b-proj`), one with no project and one `rejected` request in A, answers 200 with `data` equal to `{ total: 4, unscoped: 1, projects: [{ projectId: A, slug: 'a-proj', pending: 2 }, { projectId: B, slug: 'b-proj', pending: 1 }] }`.
- AC-2 [integration]: for the same caller and data, `data.total` of `GET /api/approvals/counts` equals `data.total` of `GET /api/approvals?status=pending`.
- AC-3 [integration]: a user holding the Approver role (`approval.decide`) in project A only, with pending requests in A and B, gets `{ total: <A's count>, unscoped: 0, projects: [A only] }`.
- AC-4 [integration]: an agent with no decide permission that is the actor of one pending request in project A gets `{ total: 1, unscoped: 0, projects: [{ projectId: A, slug: 'a-proj', pending: 1 }] }` (its own request is visible, as in the list).
- AC-5 [integration]: a pending request whose `projectId` names no `Project` row is counted in `total` and listed with `slug: null`, after the rows that have a slug.
- AC-6 [integration]: `GET /api/approvals/counts` without credentials answers 401.
- AC-7 [unit]: `visibleRequestWhere` for scopes `{ everywhere: true, global: 'all', projects: [] }` and a filter `{ status: 'pending' }` returns a `where` with `status: 'pending'` and no `OR` key.
- AC-8 [unit]: `visibleRequestWhere` for scopes `{ everywhere: false, global: [], projects: [{ projectId: 'p1', patterns: 'all' }] }` returns an `OR` holding the actor clause, the on-behalf-of clause and a clause with `projectId: 'p1'`.
- AC-9 [unit]: `visibleRequestWhere` with `filter.mine: true` and scopes `{ everywhere: true, global: 'all', projects: [] }` returns an `OR` of exactly the actor and on-behalf-of clauses.
- AC-10 [integration]: `GET /api/approvals?status=pending` answers the same records, in the same order, as before the extraction, for a global admin and for a single-project Approver (the existing `approval-request-visibility.integration.spec.ts` cases pass unchanged).
- AC-11 [integration]: `GET /api/approvals?jobId=J` as a global admin, with two bash asks for job J, one for job K and one pending `agent.create` request (no fleet link), answers exactly the two requests for J.
- AC-12 [integration]: `GET /api/approvals?jobId=J` for a caller who cannot see job J's requests answers an empty page (`total: 0`).
- AC-13 [integration]: `GET /api/approvals?jobId=` (empty) answers 400, and a `jobId` of 65 characters answers 400.

### US-002: Per-key details on the request, filled by the fleet asks

- AC-1 [integration]: `GET /api/approvals/:id` for a pending `fleet.job.shell.escalate` request whose link names job J answers `data.details` equal to `{ kind: 'bash', jobId: J, resolvedBy: null, outcome: null }`.
- AC-2 [integration]: `GET /api/approvals/:id` for a pending `fleet.budget.override` request answers `data.details` with `kind: 'budget'`, its `policyId`, `resolvedBy: null`, `outcome: null`, `requeueCandidates` listing each job cancelled for the policy since the request opened as `{ jobId, projectId, feature, queuedAt }` with `queuedAt` an ISO string, and `requeueCandidatesTruncated: false`.
- AC-3 [unit]: `FleetBudgetOverrideCommand.details` with `findRequeueCandidates` answering 201 rows returns 200 `requeueCandidates` and `requeueCandidatesTruncated: true`, having called `findRequeueCandidates` with `input.policyId` from the request's frozen input (the stubbed `findApproval` view answering a different `policyId`, which the block still reports as its `policyId`), `new Date(input.requestedAt)` from the request's frozen input, and the limit 201.
- AC-4 [integration]: `GET /api/approvals/:id` for a `fleet.budget.override` request settled `cancelled` by a window reset answers `data.details` with `resolvedBy: 'window_reset'` and no `requeueCandidates` or `requeueCandidatesTruncated` field.
- AC-5 [unit]: `FleetShellEscalateCommand.details` when `FleetApprovalAskStore.findApproval` answers null returns null.
- AC-6 [integration]: `GET /api/approvals/:id` for a request whose key has a registered command with no `details` method (an `agent.create` redeem request) answers `data.details: null`.
- AC-7 [unit]: `ApprovalRequestQueries.getDetail` when the registered command's `details` rejects with an `Error('boom')` resolves with `details: null` and logs one warning naming the request id.
- AC-8 [unit]: `ApprovalRequestQueries.getDetail` calls `ApprovalCommandRegistry.get` with the request's `permissionKey` and its `variant`, and `ApprovalRequestQueries.get` calls neither the registry nor any `details`.
- AC-9 [integration]: `POST /api/approvals/:id/decisions` with `{ decision: 'approve', params: { amountUsd: <above spend>, requeueJobIds: [<a candidate from AC-2's details>] } }` on a pending budget ask answers 200 with `data.details: null`, and the job is queued again after commit (the detail block feeds the existing decide route).

### US-003: Home "needs you" over the engine's visibility

- AC-1 [integration]: `GET /api/home` as a global admin, with a pending `agent.create` request in project A and a pending bash ask in A, answers both in `data.approvals`. The `agent.create` row has `type: null` and `permissionKey: 'agent.create'`; the bash row has `type: 'nax_bash_escalate'`, `permissionKey: 'fleet.job.shell.escalate'` and its `jobId`; the set of ids equals the ids of `GET /api/approvals?status=pending` for the same caller.
- AC-2 [integration]: `GET /api/home` as a user with the Approver role in project A only answers the pending requests of A and none of project B.
- AC-3 [integration]: `GET /api/home` as `dev` (Developer of project `web`, no `approval.decide`), with a new pending `fleet.budget.override` ask in `web` seeded with no `onBehalfOf`, answers no approval row for it.
- AC-4 [integration]: `GET /api/home` as a global admin counts a pending budget ask with no project in `data.approvalsTotal` and lists it with `projectId: null` and `projectSlug: null`.
- AC-5 [integration]: read as `root`, a job with a pending bash ask visible to the caller is still reported as blocked by its pending approval in the home jobs list (`pendingApprovals` ≥ 1).
- AC-6 [unit]: `HomeService.snapshot` calls `PermissionService.approvalDecideScopes` with `{ type: 'USER', id: <caller id> }` and passes `{ visibility: { principal, scopes } }` to both `findPendingApprovals` and `countPendingApprovals`.
- AC-7 [integration]: `data.approvals` is ordered newest `requestedAt` first and holds at most `HOME_LIMITS.approvals` rows.

### US-004: `approval.requested` and `approval.resolved` webhooks for every key

- AC-1 [integration]: an agent `DELETE /api/projects/:slug/labels/:id` (key `label.delete`, not a redeem route) in project A that answers 202 under a `mode: human` policy for type AGENT, with an active project webhook subscribed to `approval.requested`, records one `webhook_delivery` outbox row whose payload has `event: 'approval.requested'` and `payload` equal to `{ requestId, permissionKey, status: 'pending', projectId: A, requiredMode, actorType: 'AGENT', actorId, onBehalfOfType: null, onBehalfOfId: null, expiresAt, path: '/approvals?id=<requestId>' }`.
- AC-2 [integration]: a human approve of that request through `POST /api/approvals/:id/decisions`, with a webhook subscribed to `approval.resolved`, records exactly two `approval.resolved` deliveries for it, the first with `status: 'approved'` and the second with `status: 'executed'`.
- AC-3 [integration]: approving a redeem request records one `approval.resolved` delivery with `status: 'approved'` and none with `executed`; redeeming it then records one with `status: 'executed'`.
- AC-4 [integration]: a pending fleet bash ask opened through the runner relay records both the existing `fleet.approval.requested` delivery and one `approval.requested` delivery, each to the webhook that subscribes to it.
- AC-5 [integration]: a pending request with `projectId: null` (a global budget ask) records no `approval.requested` delivery.
- AC-6 [integration]: a webhook subscribed only to `ticket.created` receives no approval delivery.
- AC-7 [unit]: `approvalWebhookPayloadOf` for a request whose `input` and `result` are non-empty objects returns a payload with no `input`, `result` or `decisions` key.
- AC-8 [unit]: `ApprovalRequestEvents.record` for a request with status `expired` and `projectId: 'p1'` calls `WebhookDispatcherService.dispatch` once with `('p1', 'approval.resolved', <payload with status 'expired'>)`, after recording the `approval_request_changed` outbox event.
- AC-9 [unit]: `ApprovalRequestEvents.record` for a request with `projectId: null` does not call `dispatch`.
- AC-10 [integration]: with `dispatch` stubbed to reject through `vi.spyOn(app.get(WebhookDispatcherService, { strict: false }), 'dispatch').mockRejectedValue(new Error('boom'))` (one shared instance from `WebhookDispatchModule`), `POST /api/approvals/:id/decisions` answers 500 and the request stays `pending`.
- AC-11 [unit]: compiling `WebhookDispatchModule` with the global stubs `webhook.module.spec.ts` uses (`GlobalStubsModule`) resolves `WebhookDispatcherService` (and does not export `PrismaWebhookRepository`), and compiling `WebhookModule` the same way still resolves `WebhookService` and `WebhookDispatcherService`.
