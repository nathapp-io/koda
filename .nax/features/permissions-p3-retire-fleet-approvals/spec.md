# SPEC: permissions-p3-retire-fleet-approvals — retire the fleet approval adapters

Closes: #356

## Summary

This feature is 7c of P3 feature 7 (`p3-web`), split three ways by the user on 2026-10-30:
- 7a `permissions-p3-web-api` (merged #354): the API additions;
- 7b `permissions-p3-web` (merged #355): the unified inbox and policy pages;
- 7c (this feature): retiring the fleet approval adapters.

After 7b nothing in the web reads the fleet approval adapters. This feature moves the last fleet-only paths onto the approval engine, then deletes the adapters:

| Story | What |
|:--|:--|
| US-001 | The engine's `ApprovalRequestedSubscriber` notifies the two fleet asks (bash, budget) |
| US-002 | Delete the fleet's own `fleet_approval_requested` notification path |
| US-003 | #356: a successful zero-count refresh dismisses every approval toast |
| US-004 | The assistant tool `koda_list_approvals` reads the engine; the MCP alias `koda_list_fleet_approvals` goes |
| US-005 | Delete the `fleet.approval.requested` / `fleet.approval.resolved` webhooks |
| US-006 | Delete the `fleet_approval` live event in the API, and `FleetApprovalAsk.publishedStatus` |
| US-007 | Web: drop the `fleet_approval` stream handler, the fleet approval web types and the 7b redirect pages |
| US-008 | Re-point the integration tests that decide, list or count through the fleet routes at the engine routes |
| US-009 | Runner test harness: list and decide asks through the engine routes |
| US-010 | Delete the `/fleet/approvals`, `/projects/:slug/fleet/approvals` and `/fleet/approval-counts` routes, `ApprovalsService` and their DTOs |
| US-011 | CLI: `koda approval approve` takes the bash choice and the budget raise |
| US-012 | CLI: delete `koda fleet approval` and regenerate the client |
| US-013 | Delete the `fleet.approval.read` and `fleet.approval.decide.*` keys, with a data migration |

It is the last P3 feature in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine", §6 "Web UI").

## Motivation

The fleet approvals moved onto the approval engine in 4b (`permissions-p3-approval-fleet`). The old fleet surface was kept as adapters, only so the web kept working until the unified inbox shipped. 7b shipped it, and `koda-wk` runs it (§9.150). What remains costs:
- **Two notification paths.** A fleet ask still notifies every global admin through `FleetApprovalRequestedSubscriber`, linking to `/admin/fleet/approvals`, while the engine notification (which reaches users holding `approval.decide` in the project and links to `/approvals`) skips the two fleet keys.
- **Two webhook families.** Every fleet ask sends `fleet.approval.*` beside the engine's `approval.requested`/`approval.resolved` (7a).
- **Two live events.** Every fleet ask change publishes `fleet_approval` beside the engine's `approval_request`, threaded through about fifteen fleet files.
- **Three adapter routes and a CLI command** that read the engine through a fleet-shaped DTO, gated by four permission keys nothing else uses.
- **#356.** The web keeps an approval toast on screen forever once the last pending request is settled elsewhere, on any page that does not receive the project settlement event.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **`koda_list_approvals` (assistant) is gated by `project.read`.** It reads `ApprovalRequestQueries.list` for the tool context's actor with `projectId: ctx.projectId`. The engine's visibility already limits rows to the caller's own requests and the ones it may decide, so no approval-specific read key is needed. One line per row: `<id> <permissionKey> <status> <createdAt ISO>`. The status filter is `APPROVAL_REQUEST_STATUSES` (`apps/api/src/approvals/dto/list-approval-requests.query.ts`), default `pending`, in both `parse` and the descriptor. The principal is `{ type: isAgentPrincipal(ctx.actor) ? 'AGENT' : 'USER', id: ctx.actor.id }`, as `action-tools.ts` builds it.
- **MCP keeps one `koda_list_approvals`: the engine's** (`ApprovalMcpTools`). `mcpToolDescriptors()` leaves the assistant descriptor `koda_list_approvals` out instead of renaming it, and `assistantToolName` (the alias map back) is deleted. MCP clients lose `koda_list_fleet_approvals`.
- **The CLI gains decision params before the fleet command goes** (US-011). `koda fleet approval decide` is today the only CLI path that can approve a budget ask (the engine requires `params.amountUsd`) or answer `allow_for_job`. `koda approval approve` gains `--choice <allow|allow_for_job>`, `--amount <usd>` and `--requeue <all|ids>`, sent as the decide body's `params`. `--amount` is sent as a JSON number (the budget command's `isRaiseAmount` refuses a string), validated with the rule of `parseBudgetUsd` (`apps/cli/src/utils/parse-usd.ts`: more than 0, at most 1,000,000, at most 4 decimals). `--requeue all` reads `details.requeueCandidates` from `GET /approvals/:id` and refuses when `details.requeueCandidatesTruncated` is true. Every option check runs inside the action, not as a Commander option parser: a failed check calls `handleApiError(err, { validationError: true })` (exit 3) and returns, as `approval policy set` does, so no decide request follows under the spec harness's no-op `process.exit`.
- **`FleetApprovalAsk.publishedStatus` is dropped** (US-006, migration `20261110090000_fleet_ask_drop_published_status`). It only acknowledged `fleet_approval` frames. `recordedStatus` stays: it keeps the activity row once-only.
- **`ApprovalChange.live` goes, and the closer stops answering frames.** `closeForJob` and `recordResolved` answer `Promise<void>`; `JobTransitionsService.apply` loses `approvalLive`; `CommandAckProcessor.process` and `JobReportProcessor` lose their `approvalLive` lists.
- **The runner's integration harness moves too** (US-009). `apps/runner/test/integration/harness/world.ts` lists and decides asks through `/fleet/approvals`. The two calls move into a new helper module `apps/runner/test/integration/harness/approval-routes.ts` exporting `listJobApprovals(http, jobId)` and `decideApproval(http, id, choice)`, where `http` is the harness's request function passed in, so a unit spec can stub it; `world.ts` delegates to them. `listJobApprovals` reads `GET /approvals?jobId=` and then `GET /approvals/:id` per row, mapping `details.resolvedBy` and `details.outcome`; `decide(id, choice)` posts `POST /approvals/:id/decisions` (`allow` and `allow_for_job` as `approve` with `params: { choice }`, `deny` as `reject`).
- **Fleet decision vocabulary on the engine route** (US-008, US-009). Bash: `allow` and `allow_for_job` become `{ decision: 'approve', params: { choice } }`; `deny` becomes `{ decision: 'reject' }`. Budget: `keep_paused` becomes `{ decision: 'reject' }`; `raise_budget_and_resume` becomes `{ decision: 'approve', params: { amountUsd, requeueJobIds } }`, with `amountUsd` a number.
- **Fleet asks notify the engine's deciders, not the requester** (US-001 AC-5). `principalIdsWithKey(..., 'approval.decide')` leaves out holders of only the scoped entry `approval.decide@fleet.job.shell.escalate`, which is the seeded Developer grant, so a developer who requested the job is not notified of its bash ask. Before this feature the fleet path notified only global admins, so nobody loses a notification they had.
- **`fleet-approval-view.ts` stays.** `PrismaFleetApprovalAskRepository` imports `fleetStatusWhere`, `toFleetApproval` and `FleetAskRow` from it; only the adapter DTOs go.
- **The fleet-route integration tests move first** (US-008, test-only). About forty cases decide, list or count through the routes US-010 deletes. They are re-pointed at `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/decisions` and `GET /approvals/counts` while both route families exist, so US-010 is a pure deletion. A case that only asserts the adapter's own translation is deleted, not re-pointed: fleet error prefixes (`fleet.approvalNotPending`, `fleet.approvalSelfDecide`, `fleet.approvalInput`, `fleet.approvalDecisionInvalid`), the removed `assistant_action` filter, and the gate on the deleted decide route.
- **The key migration** (US-013, `20261111090000_retire_fleet_approval_keys`):
  - strips every entry containing the text `fleet.approval.` (exact keys, `.*` patterns, negations and `approval.decide@fleet.approval.*` scopes) from every `Role.permissions`. It must run before the new code serves: the unlocked `developer` system role still stores `fleet.approval.decide.bash`, the seeder never rewrites an unlocked role, and `PermissionService` drops a whole role (logging `invalid permission entry`) when one stored entry names a key the catalog no longer has;
  - deletes `ApprovalPolicy` rows whose `permissionPattern` starts with `fleet.approval.`;
  - sets `status = 'cancelled'` and `settledAt = NOW()` on `ApprovalRequest` rows whose `permissionKey` starts with `fleet.approval.` and whose status is `pending` or `approved` (their route commands no longer exist, so they can never execute);
  - rewrites `Notification.link` `/admin/fleet/approvals` to `/approvals` (the redirect pages are deleted in US-007).
  - The SQL holds no literal `;` inside a statement and no `DO $$` block (the migration test helper `migrationStatements` splits on `;`); the role rewrite is `COALESCE((SELECT jsonb_agg(e ORDER BY ord) FROM jsonb_array_elements("permissions") WITH ORDINALITY AS t(e, ord) WHERE position('fleet.approval.' in e #>> '{}') = 0), '[]'::jsonb)`, so the remaining entries keep their order and a role left with none stores `[]`, never NULL. Its test seeds pre-migration rows with `scratchSchemaBefore(url, schema, '20261111090000_retire_fleet_approval_keys')`, as `developer-bash-decide-migration.integration.spec.ts` does.
- **The inventory TSV follows the catalog** (US-013). `catalog.spec.ts` asserts the catalog equals the keys of `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` plus the new-key list, so the TSV loses the seven `fleet/approvals` route rows and its `koda_list_approvals` row is re-keyed to `project.read`.
- **`NotificationSourceType` keeps `'fleet_approval'`.** Thread pending-action notifications (`action_requested`) still use it.

### User rulings (2026-10-30)

- 7c is one feature, and #356 is folded into it.
- The 7b redirect pages `/admin/fleet/approvals` and `/[project]/fleet/approvals` are deleted; old links 404 (US-013 rewrites stored notification links).
- The webhook rename (`fleet.approval.*` to `approval.*`, every key) is a contract change, accepted in 7a. The CLI `koda fleet approval` command is deleted.

### Integration

Read, not changed:
- `ApprovalRequestQueries.list(principal: PrincipalRef, filter: ApprovalRequestFilter, page: IPageOption): Promise<IPageResult<ApprovalRequestRecord>>` (`apps/api/src/approvals/approval-request.queries.ts`); `ApprovalRequestFilter` has `status`, `projectId`, `permissionKey`, `jobId`, `mine`. `ApprovalEngineModule` exports `ApprovalRequestQueries`.
- `decideEligibility(request, principal, keys)` (`apps/api/src/approvals/approval-eligibility.ts`).
- `ApprovalRequestLiveSubscriber` (`apps/api/src/live/approval-request-live.subscriber.ts`) publishes `approval_request` for every `APPROVAL_REQUEST_CHANGED` with a project; it becomes the only approval live event.
- `ApprovalRequestEvents.record` (`apps/api/src/approvals/approval-request-events.ts`) dispatches `approval.requested`/`approval.resolved` (7a); unchanged.
- `ApprovalMcpTools` (`apps/api/src/approvals/mcp/approval-mcp-tools.ts`); unchanged.
- `approvalRequestsControllerGet` and `approvalRequestsControllerDecide` (`apps/cli/src/generated/sdk.gen.ts`); the decide body already has `params?: Record<string, unknown>`.
- `FleetShellEscalateCommand.parseDecision` accepts approve `params` `{ choice: 'allow' | 'allow_for_job' }` (absent means `allow`). `FleetBudgetOverrideCommand.parseDecision` requires approve `params.amountUsd` and accepts `params.requeueJobIds`. A refused parse answers 400 through `ApprovalDecisionParamsInvalidError`.

Changed (the baseline only locates the code; implement the target):
- `ApprovalRequestedSubscriber.handle` (`apps/api/src/notifications/approvals/approval-requested.subscriber.ts`)
  - Baseline: returns early when `p.permissionKey` is one of `ASK_KEYS_BY_COMPONENT`'s values.
  - Target: no key-based early return.
- `listApprovalsTool` (`apps/api/src/fleet/assistant/tools/fleet-tools.ts`)
  - Baseline: `listApprovalsTool(approvals: ApprovalsService)`, key `fleet.approval.read`.
  - Target: `listApprovalsTool(queries: ApprovalRequestQueries)`, key `project.read`; `FleetTools` injects `ApprovalRequestQueries` in place of `ApprovalsService`.
- `ApprovalCloser` (`apps/api/src/fleet/approvals/approval-closer.ts`)
  - Baseline: constructor `(store, askService, activity, webhooks, livePublisher, outbox, audit)`; `ApprovalChange { approval, live, answer? }`; `closeForJob` and `recordResolved` answer `LiveFleetApprovalEvent[]`.
  - Target: after US-002 the constructor has no `outbox`; after US-005 no `webhooks`; after US-006 it is `(store, askService, activity, audit)`, `ApprovalChange` is `{ approval, answer? }`, and `closeForJob` and `recordResolved` answer `Promise<void>`.
- `useApprovalRequestNotifications().refresh` (`apps/web/composables/useApprovalRequestNotifications.ts`)
  - Baseline: `if (!snapshot || snapshot.total <= 0 || !userId || !current()) return` before reconciling.
  - Target: when the snapshot is non-null with `total <= 0`, the user is signed in and the refresh is current, every active notice is dismissed through `dismiss(id)` and the refresh returns without listing.
- `registerDecision` (`apps/cli/src/commands/approval.ts`)
  - Baseline: `approve <id>` and `reject <id>` take `--comment` and `--json`.
  - Target: `approve <id>` also takes `--choice`, `--amount` and `--requeue`.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A fleet ask's request is gone or no longer pending when the engine notification is handled | Nothing is delivered (existing behaviour, covered by the subscriber's existing cases "AC-9: ignores sources already cancelled" and "missing sources stop quietly") |
| The counts snapshot is null (never loaded or failed) | The notices stay; #356 must not read a failure as zero |
| `--requeue all` on a budget ask whose `details.requeueCandidatesTruncated` is true | Exit 3 with a message naming `koda approval show <id>`; nothing is decided |
| `--amount` not more than 0, above 1,000,000 or with more than 4 decimals | Exit 3, no request |
| `--requeue` without `--amount` | Exit 3, no request |
| `--choice` together with `--amount` or `--requeue` | Exit 3, no request |
| `--requeue all` on a request whose `details` carries no `requeueCandidates` | Exit 3, no request |
| `--choice` other than `allow` or `allow_for_job` | Exit 3, no request |
| Outbox rows of type `fleet_approval_requested` left from before US-002 | The relay claims them, finds no handler and marks them done |

## Out of Scope

- `docs/deployment/runner.md` still describes `koda fleet approval` and `/<project>/fleet/approvals`; it is edited by hand when the feature merges, not by a story.
- Renaming or deleting the thread pending-action notifications (`action_requested`, `sourceType: 'fleet_approval'`): they are not fleet approvals and stay.
- Deleting existing `Notification` rows of kind `approval_requested`: they stay; US-013 only rewrites their link.
- Deleting existing `Webhook` subscriptions that list `fleet.approval.requested` or `fleet.approval.resolved`: the events are never sent again, and a subscription's `events` column is free text.
- Any change to runner source (`apps/runner/src`), `packages/fleet-protocol` or the nax bash relay; only the runner's integration harness changes (US-009).
- US-011 only: `--amount` or `--requeue` on a bash request and `--choice` on a budget request: the CLI does not read the request's key first, and the API answers 400 (`ApprovalDecisionParamsInvalidError`).
- US-011 only: duplicate ids in `--requeue`: the budget command de-duplicates them in order.
- US-011 only: `--requeue` values with empty entries (`j1,,j2`, `""`), whitespace around ids, `all` mixed with ids, or more ids or longer ids than the budget command accepts: the CLI splits on commas and sends the rest; the API answers 400 for what the command refuses.
- The fleet read-model store methods and constants that lose their last production caller with `ApprovalsService` (`countPendingAllProjects`, the list and count methods of `FleetApprovalAskStore`, `MAX_COUNTED_PROJECTS`) and their `fleet-ask-read-model.integration.spec.ts`: they stay; a later cleanup removes them.
- `FleetApprovalAsk.recordedStatus` and the fleet activity rows (`approval.requested`, `approval.decided`, `approval.cancelled`, `approval.expired`): unchanged.
- A replacement for the fleet live event: the engine's `approval_request` event is the only approval live event.
- `apps/web/tests/layouts/default-permission-nav.spec.ts` passing the key string `fleet.approval.read` to the nav: the web does not validate keys against the catalog, so the cases stay green and unchanged.
- US-004 only: a project filter on the engine MCP tool `koda_list_approvals`: unchanged.
- US-011 only: `--choice deny` on `approve`: a bash deny is `koda approval reject`.
- US-003 only: the browser-notification permission prompt and the announce history: unchanged.

## Stories

- **US-001: The engine notifies the fleet asks.** No dependencies. Workdir: `apps/api`. Removes the fleet-key early return from `ApprovalRequestedSubscriber`. The recipients stay the subscriber's own: users holding `approval.decide` in the request's project (every global admin for a request with no project), filtered by `decideEligibility`. A fleet ask opens with `approverMustHoldAction: true`, so a project user also needs the ask's key (`fleet.job.shell.escalate` or `fleet.budget.override`). The notification is kind `approval_request` with link `/approvals?id=<requestId>`.
- **US-002: Delete the `fleet_approval_requested` notification path.** Depends on US-001. Workdir: `apps/api`. Deletion only:
  - `ApprovalCloser.enqueueRequested`, its two calls, and the closer's `outbox` constructor parameter (its only use);
  - `FleetApprovalRequestedSubscriber` and its registration in `NotificationsModule`;
  - `FLEET_APPROVAL_REQUESTED`, `FleetApprovalRequestedPayload` and `parseApprovalRequestedPayload`;
  - `approvalDrafts`, and `FleetNotificationReader.approvalContext`;
  - the `approvalConsumerReady` claim gate in `PrismaOutboxStore.claimBatch`, and the store's `publisher` constructor parameter (its only use).
- **US-003: A zero-count refresh dismisses the approval toasts (#356).** No dependencies. Workdir: `apps/web`. Changes `refresh` in `useApprovalRequestNotifications`.
- **US-004: `koda_list_approvals` reads the engine.** No dependencies. Workdir: `apps/api`. Rewrites `listApprovalsTool` over `ApprovalRequestQueries`, sets `KODA_LIST_APPROVALS`'s status enum to the engine statuses, and removes the MCP alias.
- **US-005: Delete the `fleet.approval.*` webhooks.** Depends on US-002. Workdir: `apps/api`. Deletion only: `ApprovalCloser.dispatch`, its three calls and the `webhooks` constructor parameter; `approvalWebhookPayload` and `approvalPath` in `approval-payloads.ts`.
- **US-006: Delete the `fleet_approval` live event in the API.** Depends on US-005. Workdir: `apps/api`. Deletion only:
  - `ApprovalLivePublisher` and its spec, `LiveFleetApprovalEvent` and its member of the `LiveEvent` union;
  - `ApprovalChange.live`, every `approvalLive` list, field and publish call in jobs, sync, budgets and the two approval sweepers;
  - the publication half of `FleetAskEventsSubscriber` (`liveFrameId`, the `publish` flag, `setPublishedStatus`), the store and repository `setPublishedStatus`, and the domain field `publishedStatus`;
  - the column `FleetApprovalAsk.publishedStatus` (schema plus migration `20261110090000_fleet_ask_drop_published_status`).
- **US-007: Web: retire the fleet approval stream, types and redirects.** No dependencies. Workdir: `apps/web`. Deletion only:
  - the `fleet_approval` parse and listener in `lib/project-event-stream.ts`, and `onFleetApproval` in `lib/project-event-hub.ts`, `pages/[project]/fleet/index.vue` and `pages/[project]/fleet/jobs/[id]/index.vue`;
  - `FleetApprovalDto`, `ApprovalCountsDto`, `RequeueCandidateDto` and `DecideApprovalBody` in `lib/fleet-types.ts`; the helpers in `lib/fleet-approvals.ts` that took `Pick<FleetApprovalDto, ...>` take structural types instead;
  - the `/fleet/approvals` breadcrumb in `layouts/default.vue`, and the pages `pages/admin/fleet/approvals.vue` and `pages/[project]/fleet/approvals.vue`.
- **US-008: Re-point the fleet-route integration tests at the engine routes.** No dependencies. Workdir: `apps/api`. Test-only: every case that decides, lists or counts through `/fleet/approvals`, `/projects/:slug/fleet/approvals` or `/fleet/approval-counts` uses the engine route instead, or is deleted when it only asserts the adapter's own translation (see Designer's calls).
- **US-009: Runner test harness: list and decide asks through the engine routes.** No dependencies. Workdir: `apps/runner`. Test-only: creates `test/integration/harness/approval-routes.ts` (`listJobApprovals`, `decideApproval`) over the engine routes, and `approvals` and `decide` in `test/integration/harness/world.ts` delegate to it (see Designer's calls); `approval-relay.integration.spec.ts` is unchanged.
- **US-010: Delete the fleet approval routes.** Depends on US-004, US-006, US-008, US-009. Workdir: `apps/api`. Deletion only: `FleetApprovalsController`, `ProjectFleetApprovalsController`, `FleetApprovalCountsController`, `FleetApprovalRouteCommands`, `ApprovalsService`, and the DTO files `fleet-approval.dto.ts`, `approval-counts.dto.ts`, `list-approvals.query.ts` and `decide-approval.dto.ts`. `ApprovalsModule` keeps the two sweepers, `FleetAskEventsSubscriber` and the two commands, and exports nothing. Regenerates `openapi.json` (`bun run api:export-spec` from the repo root).
- **US-011: `koda approval approve` takes the fleet decision params.** No dependencies. Workdir: `apps/cli`. Adds `--choice`, `--amount` and `--requeue` to `approve`.
- **US-012: Delete `koda fleet approval`.** Depends on US-010, US-011. Workdir: `apps/cli`. Deletion only: `src/commands/fleet-approval.ts`, its spec and its registration in `src/commands/fleet.ts`, and the generated client regenerated from the US-010 OpenAPI document (`bun run generate:cli` from the repo root).
- **US-013: Delete the `fleet.approval.*` keys.** Depends on US-010. Workdir: `apps/api`. Removes the four keys from the catalog (`INVENTORY_SCOPE_ROWS`, `PENDING_SURFACE_KEYS`) and from the inventory TSV and `fleet.approval.decide.bash` from the `developer` seed in the same change (the seeder validates every seed at bootstrap), regenerates the role-matrix snapshot, and adds the data migration `20261111090000_retire_fleet_approval_keys`.

### Context Files

**US-001**
- `apps/api/src/notifications/approvals/approval-requested.subscriber.ts`
- `apps/api/src/notifications/approvals/approval-request-drafts.ts`
- `apps/api/src/approvals/approval-eligibility.ts`
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/approvals/approval-closer.ts`
- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts`
- `apps/api/src/notifications/fleet/fleet-notification-events.ts`
- `apps/api/src/notifications/fleet/fleet-notification.reader.ts`
- `apps/api/src/outbox/prisma-outbox.store.ts`

**US-003**
- `apps/web/composables/useApprovalRequestNotifications.ts`
- `apps/web/tests/composables/useApprovalRequestNotifications.spec.ts`

**US-004**
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts`
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts`
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts`
- `apps/api/src/approvals/approval-request.queries.ts`
- `apps/api/src/approvals/mcp/approval-mcp-tools.ts`

**US-005**
- `apps/api/src/fleet/approvals/approval-closer.ts`
- `apps/api/src/fleet/approvals/approval-payloads.ts`
- `apps/api/test/integration/fleet/fleet-ask-events.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/approvals/approval-closer.ts`
- `apps/api/src/fleet/approvals/fleet-ask-events.subscriber.ts`
- `apps/api/src/fleet/approvals/approval-live.publisher.ts`
- `apps/api/src/live/approval-request-live.subscriber.ts`
- `apps/api/src/fleet/jobs/job-transitions.service.ts`

**US-007**
- `apps/web/lib/project-event-stream.ts`
- `apps/web/lib/project-event-hub.ts`
- `apps/web/lib/fleet-approvals.ts`
- `apps/web/lib/fleet-types.ts`
- `apps/web/layouts/default.vue`

**US-008**
- `apps/api/src/approvals/approval-requests.controller.ts`
- `apps/api/src/fleet/approvals/approvals.service.ts`
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts`
- `apps/api/src/fleet/approvals/commands/fleet-shell-escalate.command.ts`
- `apps/api/test/integration/fleet/fleet-approvals-decide.integration.spec.ts`

**US-009**
- `apps/runner/test/integration/harness/world.ts`
- `apps/runner/test/integration/approval-relay.integration.spec.ts`
- `apps/api/src/approvals/approval-requests.controller.ts`

**US-010**
- `apps/api/src/fleet/approvals/approvals.module.ts`
- `apps/api/src/fleet/approvals/approvals.service.ts`
- `apps/api/src/fleet/approvals/fleet-approval-route.commands.ts`
- `apps/api/src/fleet/approvals/fleet-approval-view.ts`

**US-011**
- `apps/cli/src/commands/approval.ts`
- `apps/cli/src/commands/fleet-approval.ts`
- `apps/cli/src/commands/approval.spec.ts`

**US-012**
- `apps/cli/src/commands/fleet.ts`
- `apps/cli/src/commands/fleet.spec.ts`

**US-013**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/permissions/system-roles.ts`
- `apps/api/src/permissions/system-role.seeder.ts`
- `apps/api/prisma/migrations/20261106090000_approval_fleet_core/migration.sql`
- `apps/api/test/integration/permissions/developer-bash-decide-migration.integration.spec.ts`

### Creates

**US-001**
None.

**US-002**
None.

**US-003**
None.

**US-004**
None.

**US-005**
None.

**US-006**
- `apps/api/prisma/migrations/20261110090000_fleet_ask_drop_published_status/migration.sql`

**US-007**
None.

**US-008**
None.

**US-009**
- `apps/runner/test/integration/harness/approval-routes.ts`
- `apps/runner/test/unit/approval-routes.spec.ts`

**US-010**
None.

**US-011**
None.

**US-012**
None.

**US-013**
- `apps/api/prisma/migrations/20261111090000_retire_fleet_approval_keys/migration.sql`
- `apps/api/test/integration/permissions/retire-fleet-approval-keys-migration.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/notifications/approvals/approval-requested.subscriber.ts` — the early return for the fleet ask keys, its comment and the now-unused `ASK_KEYS_BY_COMPONENT` import are deleted.
- `apps/api/src/notifications/approvals/approval-requested.subscriber.spec.ts` — "AC-6: a pending fleet bash ask notifies nobody through the engine" and "AC-7: a pending fleet budget ask notifies nobody through the engine" become: each delivers one `approval_request` draft per eligible user, as "AC-8: a pending payload for a non-fleet key with one eligible user still delivers once" asserts for a non-fleet key.
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts` — "US-011 AC-14: the outbox relay tells every global admin once, through the fleet approval only" becomes: every global admin has exactly one `approval_request` notification for the request (and, until US-002, one fleet one; the case filters by `kind`).
- `apps/api/test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts` — "hard stop: the override ask reaches every global admin while pending, and a settled ask notifies nobody" also asserts one `approval_request` notification per global admin (filtered by `kind`) while pending, and still none for a settled ask.

**US-002**
- `apps/api/src/fleet/approvals/approval-closer.ts` — `enqueueRequested`, its two calls and the `outbox` constructor parameter are deleted.
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — "enqueues a fleet_approval_requested outbox event for every fresh project budget ask (#208)" and "enqueues a fleet_approval_requested outbox event for every fresh project bash ask (#208)" are deleted; "AC-19 (S5b US-001): a fresh escalated ask still enqueues exactly approvalWebhookPayload, with no action extras" keeps only its webhook-dispatch assertion; the closer is constructed without the outbox argument, so every later positional argument moves up one.
- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — deleted.
- `apps/api/src/notifications/notifications.module.ts` — drops `FleetApprovalRequestedSubscriber` from `providers` and its import.
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — drops `FLEET_APPROVAL_REQUESTED`, `FleetApprovalRequestedPayload` and `parseApprovalRequestedPayload`.
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — the cases on `parseApprovalRequestedPayload` are deleted.
- `apps/api/src/notifications/fleet/fleet-notification-drafts.ts` — drops `approvalDrafts`.
- `apps/api/src/notifications/fleet/fleet-notification-drafts.spec.ts` — the cases on `approvalDrafts` are deleted.
- `apps/api/src/notifications/fleet/fleet-notification.reader.ts` — drops `approvalContext`.
- `apps/api/src/notifications/fleet/fleet-notification.reader.spec.ts` — the cases on `approvalContext` are deleted.
- `apps/api/src/notifications/fleet/fleet-subscribers.spec.ts` — the `FleetApprovalRequestedSubscriber` construction and the cases "bash approval ask -> every global admin, labelled with the repo" and "AC-12: a nax_bash_escalate ask still delivers one draft per admin id findGlobalAdminIds answers" are deleted; the budget-incident and malformed-payload cases of the other subscribers stay.
- `apps/api/src/outbox/prisma-outbox.store.ts` — `claimBatch` drops `approvalConsumerReady` and its `fleet_approval_requested` condition; the `publisher` constructor parameter is deleted.
- `apps/api/src/outbox/prisma-outbox.store.spec.ts` — the store is constructed without the `FanOutPublisher` argument.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — `new PrismaOutboxStore(prismaService, publisher)` becomes `new PrismaOutboxStore(prismaService)`; its assertions are unchanged.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the `FleetApprovalRequestedSubscriber` import and its `[FleetApprovalRequestedSubscriber, 'system.notification.fleet']` row are deleted; the other writers' rows stay.
- `apps/api/test/integration/notifications/fleet-ask-notifications.integration.spec.ts` — "US-011 AC-12: a pending bash ask answers pending with the job repo as owner/name", "US-011 AC-13: a pending budget ask answers pending with no repo" and "answers the engine status of a settled ask, and null for a request that is gone" are deleted (they test `approvalContext`); "writes need an action context" stays.
- `apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts` — "holds unhandled approval notifications without blocking other events, then releases them when a consumer registers" is deleted.
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts` — "AC-12: the pending open records one fleet_approval_requested outbox event keyed by the request id" is deleted; the US-001 version of "US-011 AC-14" drops its fleet-notification half and asserts exactly one notification per global admin, of kind `approval_request`.
- `apps/api/test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts` — "AC-10: a global policy asks with no project and records no fleet_approval_requested event" keeps the no-project ask and drops the outbox-event half.
- `apps/api/test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts` — the hard-stop case asserts only the `approval_request` notification per global admin.

**US-003**
- `apps/web/composables/useApprovalRequestNotifications.ts` — `refresh` dismisses every active notice on a non-null zero-count snapshot before returning; its doc comment says so.
- `apps/web/tests/composables/useApprovalRequestNotifications.spec.ts` — "AC-1: counts total 0 makes no GET /approvals request" keeps its assertion; the new #356 cases are added to this file.

**US-004**
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts` — `listApprovalsTool` takes `ApprovalRequestQueries`, parses `status` against `APPROVAL_REQUEST_STATUSES` (default `pending`), builds the principal with `isAgentPrincipal`, its key becomes `project.read`, and its lines become `<id> <permissionKey> <status> <createdAt ISO>`; `FleetTools` injects `ApprovalRequestQueries` instead of `ApprovalsService`; the `ApprovalsService` and `ApprovalRoute` import is deleted.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_LIST_APPROVALS`'s `status` enum becomes `APPROVAL_REQUEST_STATUSES` (`pending`, `approved`, `rejected`, `expired`, `cancelled`, `executed`, `failed`) and its description says "approval requests".
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `mcpToolDescriptors` filters the descriptor `koda_list_approvals` out instead of renaming it; `assistantToolName` is deleted and its callers pass the MCP name unchanged.
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.ts` — stops calling `assistantToolName`.
- `apps/api/src/fleet/assistant/tools/fleet-tools.spec.ts` — "every fleet tool declares its own read key" maps `koda_list_approvals` to `project.read`; "koda_list_approvals parse defaults to pending and refuses a status outside the enum" uses the engine statuses; "AC-8 (US-004): koda_list_approvals reads the project route with the project id only and reports the ids" asserts the `ApprovalRequestQueries.list` call of US-004 AC-3 instead of the project route.
- `apps/api/src/fleet/assistant/tools/origin-tools.spec.ts` — "AC-12: approvals use the project id only, for an agent and for a user actor" asserts `ApprovalRequestQueries.list` called with the actor's principal and `projectId` for both actors, instead of `ApprovalsService.list`.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.spec.ts` — the `mcpName` helper is deleted; "US-012: reserves the approval inbox name for the MCP-only tool, leaving thread descriptors intact" asserts `koda_list_approvals` and `koda_list_fleet_approvals` are both absent from `mcpToolDescriptors()` and `koda_list_approvals` still present in `KODA_TOOL_DESCRIPTORS`; "AC-8: rewrites the sentence once, leaving the rest of the description as the catalog spells it" looks descriptors up by their own name.
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.spec.ts` — "keeps the legacy fleet inbox visible under an alias and dispatches to its existing executor" is deleted.

**US-005**
- `apps/api/src/fleet/approvals/approval-closer.ts` — `dispatch`, its three calls and the `webhooks` constructor parameter are deleted.
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — the `webhooks` double and every `webhooks.dispatch` expectation are deleted (in "opens the ask on the engine as fleet.budget.override for the stop snapshot, then links it and announces the view", "opens a global policy ask with no project, and sends no webhook, outbox row or live event", "closes the pending ask of a policy on the engine and stamps the link, or answers nothing when there is none", "a manual resume closes the ask cancelled on the engine and reports approved through the link, with the resumer in the outcome", "opens the ask on the engine as fleet.job.shell.escalate for the job requester, then links and announces it", "a re-reported ask answers the stored view and writes nothing", "an ask the policy resolves to none is answered allow at once, with no request and no link"); "AC-19 (S5b US-001): a fresh escalated ask still enqueues exactly approvalWebhookPayload, with no action extras" is deleted; later positional constructor arguments move up one.
- `apps/api/src/fleet/approvals/approval-payloads.ts` — `approvalWebhookPayload` and `approvalPath` are deleted; `approvalActivityPayload` stays.
- `apps/api/src/fleet/approvals/approval-payloads.spec.ts` — "builds the inbox path" and "webhook body carries ids and state, never the payload (A8)" are deleted; "activity payload keys never trip the secret check" stays.
- `apps/api/src/fleet/approvals/fleet-ask-events.subscriber.ts` — the class comment no longer lists the `fleet.approval.resolved` webhook.
- `apps/api/test/integration/fleet/fleet-ask-events.integration.spec.ts` — "AC-4: the rejected change dispatches fleet.approval.resolved with status rejected" is deleted; the webhook subscription in its setup lists `approval.requested` and `approval.resolved`.
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts` — "AC-11: the pending open dispatches fleet.approval.requested to the project webhook with the request id" becomes US-005 AC-1.
- `apps/api/test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts` — "AC-1: a hard stop opens one engine budget ask for the system component, linked to its policy" asserts `hooks('approval.requested')` is 1 instead of `fleet.approval.requested`; "AC-10" asserts `hooks('approval.requested')` is 0.
- `apps/api/test/integration/fleet/fleet-approval-recorder.integration.spec.ts` — `resolvedWebhooks` counts `approval.resolved` deliveries, and the subscription lists the engine events; each case's expected count is the engine's (one `approval.resolved` per non-pending status the engine records).
- `apps/api/test/integration/approvals/approval-request-webhooks.integration.spec.ts` — "AC-4: runner relay retains fleet requested and adds engine requested subscriptions" becomes: a subscription to `fleet.approval.requested` alone receives no delivery for a relayed ask, and one to `approval.requested` receives one.

**US-006**
- `apps/api/src/live/live-event.ts` — `LiveFleetApprovalEvent` and its member of the union are deleted; the header comment drops `fleet_approval`.
- `apps/api/src/fleet/approvals/approval-live.publisher.ts` — deleted.
- `apps/api/src/fleet/approvals/approval-live.publisher.spec.ts` — deleted.
- `apps/api/src/fleet/approvals/approval-store.module.ts` — drops `ApprovalLivePublisher` from `providers` and `exports`.
- `apps/api/src/fleet/approvals/approval-store.module.spec.ts` — "compiles and resolves the closer and the live publisher" and "AC-12: a consumer still injects the closer and the live publisher" resolve the closer only.
- `apps/api/src/fleet/approvals/approval-closer.ts` — `ApprovalChange.live`, the `livePublisher` constructor parameter and every frame list are deleted; `closeForJob` and `recordResolved` answer `Promise<void>`.
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — every expectation on `live` frames is deleted, including "supersedes the stray pending ask on the engine before opening the new one and carries both live frames" (it keeps the stray-close assertion); "closeForJob cancels every pending ask job_ended on the engine and reports each resolution" asserts the engine closes and activity rows instead of returned frames; "closeForJob answers [] when the job has no pending ask" asserts no engine close; "US-006 AC-13 (F1 round 3): one call closes at most MAX_ASKS_CLOSED_PER_CALL asks, and repeated calls drain the job", "US-006 AC-14 (F1): a held ask is skipped and the sweep still reaches every ask past it" and "US-006 AC-13 (F1 round 3): repeated bounded calls drain a job far beyond one page" count engine close calls instead of returned frames; the live publisher double is removed from the constructor.
- `apps/api/src/fleet/approvals/fleet-ask-events.subscriber.ts` — the `ApprovalLivePublisher` parameter, `liveFrameId`, the `publish` flag, the publish and acknowledge calls, and `setPublishedStatus` are deleted; `record` returns nothing and runs only when `recordedStatus` differs.
- `apps/api/src/fleet/approvals/fleet-ask-events.subscriber.spec.ts` — "AC-5: publishes one fleet_approval event with the mapped status, after the transaction commits", "acknowledges the delivered ids only after the publication marker commits", "a failed listener rejects, keeps the frame owed and releases nothing until the retry succeeds", "gives the frame a durable id, so a republished retry is the same frame", "republishes an undelivered frame under a separate acknowledgement, without repeating the outputs", "publishes nothing for a frame the link already acknowledged" and "records a projectless ask but publishes no frame, as a live channel is per project" are deleted; the other cases drop their live-publisher double and frame assertions.
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.ts` — `setPublishedStatus` is deleted.
- `apps/api/src/fleet/approvals/prisma-fleet-approval-ask.repository.ts` — `setPublishedStatus` and the `publishedStatus` mapping are deleted.
- `apps/api/src/fleet/approvals/domain/fleet-approval-ask.domain.ts` — `publishedStatus` and `setPublishedStatus` are deleted from the record and the repository interface.
- `apps/api/prisma/schema.prisma` — `FleetApprovalAsk.publishedStatus` is deleted, and the model's comment no longer names a later story that removes the table.
- `apps/api/src/fleet/approvals/approval-job-end.sweeper.ts` — the `ApprovalLivePublisher` parameter and its publish call are deleted.
- `apps/api/src/fleet/approvals/policy-ask-close.sweeper.ts` — the `ApprovalLivePublisher` parameter and its publish call are deleted.
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` — the `ApprovalLivePublisher` parameter and its `committedEffect` publish are deleted.
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.spec.ts` — the live publisher double and its publish expectations are deleted.
- `apps/api/src/fleet/jobs/job-transitions.service.ts` — `approvalLive` is deleted from `apply`'s result; `leaveRunning` awaits `closeForJob` and answers nothing.
- `apps/api/src/fleet/jobs/job-transitions.service.spec.ts` — `APPROVAL_LIVE` and every `r.approvalLive` expectation are deleted ("RUNNING -> %s closes the asks and withdraws unsent answers" keeps its `closeForJob` and `withdrawPendingCommands` expectations; "a move that does not leave RUNNING touches no approvals" asserts `closeForJob` is not called).
- `apps/api/src/fleet/sync/command-ack.processor.ts` — `approvalLive` is deleted from `Applied` and from `process`'s result.
- `apps/api/src/fleet/sync/command-ack.processor.spec.ts` — every `approvalLive` field in doubles and expectations is deleted ("an ok ASSIGN ack returns no job and no approval events", "a rejected READOPT on a RUNNING job returns both live lists (plan D263)" (now one list), "AC-9: an ok THREAD_PUBLISH ack is routed to the thread effects and returns no live events").
- `apps/api/src/fleet/sync/job-report.processor.ts` — `approvalLive` is deleted from `ReportOutcome` and `applyOne`.
- `apps/api/src/fleet/sync/job-report.processor.spec.ts` — "opens a bash approval for an approval_request on a RUNNING job and returns its live event" asserts the opened approval instead of a frame; the `approvalLive` expectation in "US-006 AC-8: an ask the policy resolves to none is answered with an APPROVAL_ANSWER command in the report transaction" and the `approvalLive: []` in doubles are deleted.
- `apps/api/src/fleet/sync/sync.service.ts` — the `ApprovalLivePublisher` parameter, the `approvalLive` list and its publish are deleted.
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — the `CommandAckProcessor` double answers `{ live: [] }` and the service is constructed without the live publisher.
- `apps/api/src/fleet/sync/fleet-sweeper.ts` — the `ApprovalLivePublisher` parameter and its publish are deleted.
- `apps/api/src/fleet/sync/fleet-sweeper.spec.ts` — "crashes a silent runner-held job and publishes both live lists (plan D263)" publishes the job list only; the approval publisher double is removed from the constructor.
- `apps/api/src/fleet/budgets/budget-evaluator.ts` — the `ApprovalLivePublisher` parameter, `approvalLive` and its publish are deleted.
- `apps/api/src/fleet/budgets/budget-sweeper.ts` — the `ApprovalLivePublisher` parameter and its two publishes are deleted.
- `apps/api/src/fleet/budgets/budgets.service.ts` — the `ApprovalLivePublisher` parameter, its two `committedEffect` publishes and the `live` fields of its local `{ approval: null, live: [] }` results are deleted.
- `apps/api/src/fleet/budgets/budget-committed-effects.spec.ts` — "${action}: external effects follow owning approval transaction ${outcome}" drops the live publisher double and its publish expectations, and its `closeForPolicy` double answers `{ approval: null }`; its remaining committed-effect expectations stay.
- `apps/api/src/fleet/approvals/approval-job-end.sweeper.spec.ts` — the sweeper is constructed without the live publisher argument (later positional arguments move up one); its publish expectations are deleted.
- `apps/api/src/fleet/approvals/policy-ask-close.sweeper.spec.ts` — the sweeper is constructed without the live publisher argument; its publish expectations are deleted.
- `apps/api/src/fleet/approvals/commands/fleet-ask-details.spec.ts` — `new FleetBudgetOverrideCommand(` drops the live publisher argument; its assertions are unchanged.
- `apps/api/src/fleet/budgets/budget-evaluator.spec.ts` — the evaluator is constructed without the approval live publisher argument; `approvalLive` expectations are deleted.
- `apps/api/src/fleet/budgets/budget-sweeper.spec.ts` — every construction drops the approval live publisher argument; its publish expectations are deleted.
- `apps/api/src/fleet/budgets/budgets.service.spec.ts` — every construction drops the `{ publish: vi.fn() }` live argument, and `closeForPolicy` doubles answer `{ approval: null }`.
- `apps/api/test/integration/fleet/fleet-approval-ask.repository.integration.spec.ts` — the `setPublishedStatus` call and the `publishedStatus` assertions are deleted.
- `apps/api/test/integration/fleet/approval-job-end.sweeper.integration.spec.ts` — "F2: a failed close audit rolls back request, link, activity and outbox, publishes nothing, and retries" drops the `ApprovalLivePublisher` spy and constructor argument; its rollback assertions stay.
- `apps/api/test/integration/fleet/fleet-approval-recorder.integration.spec.ts` — "US-009 fix round 2: a failed listener fails the relay, and the retry re-delivers only to it" and "US-009 fix round 1: an unacknowledged frame stays owed and reaches a listener that missed it" are deleted; "F6 round 4: an executed job_ended ask announces the cancelled fleet view, and a linkless ask emits nothing" and the other cases drop frame and `publishedStatus` assertions and keep their activity and `recordedStatus` assertions.

**US-007**
- `apps/web/lib/project-event-stream.ts` — `LiveFleetApprovalEvent`, `parseFleetApprovalEvent`, its parse branch, the `onFleetApproval` handler field and its `fleet_approval` listener are deleted.
- `apps/web/lib/project-event-hub.ts` — the `onFleetApproval` fan-out is deleted.
- `apps/web/pages/[project]/fleet/index.vue` — the `onFleetApproval` handler and its comment are deleted.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the `onFleetApproval` handler and its comment are deleted.
- `apps/web/lib/fleet-types.ts` — `FleetApprovalDto`, `ApprovalCountsDto`, `RequeueCandidateDto` and `DecideApprovalBody` are deleted (nothing else in the web uses them).
- `apps/web/lib/fleet-approvals.ts` — `budgetPayload`, `bashPayload` and `deliveryView` take structural parameter types (`{ type: string; payload: unknown }`, `{ type: string; resolvedBy: string | null; outcome: unknown }`) instead of `Pick<FleetApprovalDto, ...>`; their behaviour is unchanged.
- `apps/web/layouts/default.vue` — the "/${project}/fleet/approvals" breadcrumb line is deleted.
- `apps/web/pages/admin/fleet/approvals.vue` — deleted.
- `apps/web/pages/[project]/fleet/approvals.vue` — deleted.
- `apps/web/tests/pages/fleet-approvals-redirects.spec.ts` — deleted.
- `apps/web/tests/lib/project-event-stream-fleet.spec.ts` — the `fleet_approval notices (S1.5 1b)` describe ("parses a notice and accepts any non-empty status (D253)", "rejects other shapes", "delivers fleet_approval events once each, only when a handler is given") and the `approvalEvent` helper are deleted; the `fleet_log` cases stay.
- `apps/web/tests/lib/project-event-stream-approval-request.spec.ts` — the `a fleet_approval event` row of the not-an-approval-request table stays (it still parses to null); the cases that pass `onFleetApproval` drop it and keep their `onApprovalRequest` assertions.
- `apps/web/tests/lib/project-event-hub.spec.ts` — the `fleet_approval` fan-out cases (the `approval` fixture and the `onFleetApproval` expectations) are deleted or re-pointed at `approval_request` and `onApprovalRequest`.
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — "the list reloads on an approval_request event as well as fleet_approval (P3b US-007)" asserts the `onApprovalRequest` reload only; "a job with pending approvals is marked next to its state, and the list reloads on fleet_approval (spec §5)" asserts the marker and the `onApprovalRequest` reload; the "/${SLUG}/fleet/approvals" entry in its link list is deleted.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — "P3b US-007: live reloads follow both approval notices; onFleetApproval stays until 7c" asserts `onApprovalRequest` reloads and no `onFleetApproval` key.
- `apps/web/tests/layouts/fleet-jobs-nav.spec.ts` — the expectation that the layout holds the "/${project}/fleet/approvals" breadcrumb line is deleted.
- `apps/web/tests/lib/fleet-approvals.spec.ts` — its fixtures stop importing `FleetApprovalDto` and build plain objects; its cases are unchanged.

**US-008**
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — the `PROJECT` and `ADMIN` route constants, the "/api/fleet/approval-counts" calls and the `ApprovalsService` import go; every route case is re-pointed at the engine route (list: "GET /api/approvals?projectId=" or `?status=`; get: "GET /api/approvals/:id" reading `details`; decide: "POST /api/approvals/:id/decisions" with `params`; counts: "GET /api/approvals/counts") keeping its state assertions (pause lifted, jobs re-queued, 403/404 for outsiders): "members list and get; outsiders get 403; candidates on a pending budget approval", "an authenticated project agent reads approvals (%s)", "an authenticated project agent cannot decide a budget override", "an authenticated project agent allows a bash approval of a user's job", "an authenticated project agent reads approval counts", "a developer cannot decide a budget override; a project admin can keep it paused", "raise and resume lifts the pause and re-queues the selected candidates, including a placement-cancelled job", "partial re-queue: an active duplicate fails alone, the resume stands (review focus 2)", "admin prefix on a project policy resumes it (review focus 5)", "decide after the policy was deleted is 409 (review focus 3)", "concurrent evaluate and decide over HTTP: no deadlock (review focus 1)", "counts pending over memberships; unscoped for a global admin only", "a global policy approval is on the admin routes only" (becomes: visible to a global admin through "GET /api/approvals", not to a project member) and the "US-011 AC-1" to "AC-5" cases; "refuses a missing amount, an amount not above spend, and a non-candidate id" asserts the engine's answers (400 for a missing amount; the engine's recorded refusal for a non-candidate id); "concurrent in-process decide and evaluate: no deadlock, and never a P2034 (review focus 1)" calls `ApprovalDecisionService.decide` instead of `ApprovalsService.decide`, keeping its deadlock assertions; "writes need an action context" and "fixtures grant through bindings only" stay. The same engine-visibility rule as the enforce spec applies.
- `apps/api/test/integration/fleet/fleet-approvals-decide.integration.spec.ts` — the route constants and helper call "POST /api/approvals/:id/decisions"; cases "AC-1" to "AC-15" and "allow_for_job reaches the bash command as the fleet choice, not as nax's option name" keep their state assertions on the engine route; a case whose only assertion is a fleet error prefix (`fleet.approvalNotPending`, `fleet.approvalSelfDecide`, `fleet.approvalInput`, `fleet.approvalDecisionInvalid`, `fleet.budgetAmountNotAboveSpend`, `fleet.budgetNotPaused`) asserts the engine's status code and error instead, or is deleted when the engine has no equivalent refusal; the header comment names the engine route.
- `apps/api/test/integration/fleet/gated-fleet-approval-decide-route.integration.spec.ts` — deleted (it tests the gate on the deleted project decide route; the engine decide route is covered by the engine's own specs).
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts` — "US-012 AC-1: a project member with fleet.approval.read cannot filter by assistant_action (400)" is deleted; every other case that reaches a fleet approval route ("AC-1" to "AC-12", "AC-14" to "AC-18", "AC-26", "AC-27") uses the engine route for the same setup. Where the engine answers differently, the expectation follows the engine: a principal sees a request it opened or may decide (a roster-only agent that may decide nothing lists none); counts include requests of soft-deleted projects (7a); an admin-prefix case becomes the same decide on the engine route; a refused decide answers the engine's 403.
- `apps/api/test/integration/permissions/membership-fleet-consumers.integration.spec.ts` — "AC-2: a user whose only source in p1 is a developer binding counts p1's pending approvals only" reads "GET /api/approvals/counts" and asserts the `projects` row for p1.
- `apps/api/test/integration/fleet/fleet-approval-recorder.integration.spec.ts` — its `decide` helper posts the engine decision with the fleet vocabulary mapped (see Designer's calls); every case using it keeps its assertions.
- `apps/api/test/integration/audit/audit-fleet-approvals.integration.spec.ts` — every case deciding through a fleet route ("AC-1/2: records keep-paused with actor, resource, summary and project; global scope is null", "AC-5/7: refused budget and unauthorized bash decisions do not record", "AC-6/8/9/11: records a valid bash decision only; ended, expired and repeated asks add none") posts the engine decision with the fleet vocabulary mapped and keeps its audit assertions; "AC-3/4: raise-and-resume writes the engine decision, the command entry and the requeued job entry" decides through "POST /api/approvals/:id/decisions" with `params: { amountUsd, requeueJobIds }`.
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts` — "US-012 AC-1: a relayed ask allowed on the fleet route and acked ok reads back approved with delivery ok" allows through "POST /api/approvals/:id/decisions" with `params: { choice: 'allow' }`, and its read-back uses "GET /api/approvals/:id", asserting `status` `executed` and `details.outcome.delivery.result` `ok`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the describe "project fleet decide approval lifecycle" is deleted: it tests the wait-policy gate on the deleted project decide route (`seedWaitPolicy` on `fleet.approval.decide.bash`, the 202 outer request, fleet error prefixes); the other describes are unchanged.

**US-009**
- `apps/runner/test/integration/harness/world.ts` — approvals(jobId) and decide(id, choice) delegate to listJobApprovals and decideApproval with the harness's own request function; their signatures and answers are unchanged.

**US-010**
- `apps/api/src/fleet/approvals/fleet-approvals.controller.ts` — deleted.
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts` — deleted.
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.spec.ts` — deleted.
- `apps/api/src/fleet/approvals/fleet-approval-counts.controller.ts` — deleted.
- `apps/api/src/fleet/approvals/fleet-approval-route.commands.ts` — deleted.
- `apps/api/src/fleet/approvals/fleet-approval-route.commands.spec.ts` — deleted.
- `apps/api/src/fleet/approvals/approvals.service.ts` — deleted.
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — deleted.
- `apps/api/src/fleet/approvals/dto/fleet-approval.dto.ts` — deleted.
- `apps/api/src/fleet/approvals/dto/approval-counts.dto.ts` — deleted.
- `apps/api/src/fleet/approvals/dto/list-approvals.query.ts` — deleted.
- `apps/api/src/fleet/approvals/dto/decide-approval.dto.ts` — deleted.
- `apps/api/src/fleet/approvals/approvals.module.ts` — drops the three controllers, `FleetApprovalRouteCommands`, `ApprovalsService` and the `exports`; drops imports used only by them.
- `apps/api/src/fleet/approvals/approvals.module.spec.ts` — "compiles and resolves the service" resolves the two registered commands instead of `ApprovalsService`.
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` — the comment naming `DecideApprovalDto` is reworded.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — "exposes the approval routes, the counts route and the approval schemas (S1.5 §2.3)" is deleted.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the "['post', '/api/projects/{slug}/fleet/approvals/{id}/decide']" entry of the expected gated routes is deleted.
- `openapi.json` — regenerated: the fleet approval paths and the `FleetApprovalDto`, `DecideApprovalDto`, `ApprovalCountsDto`, `ProjectApprovalCountDto` and `RequeueCandidateDto` schemas are gone.

**US-011**
- `apps/cli/src/commands/approval.ts` — `approve` gains `--choice`, `--amount` and `--requeue`, builds `params`, and for `--requeue all` reads the request through `approvalRequestsControllerGet` first.
- `apps/cli/src/commands/approval.spec.ts` — the new US-011 cases are added; the existing approve and reject cases are unchanged.

**US-012**
- `apps/cli/src/commands/fleet-approval.ts` — deleted.
- `apps/cli/src/commands/fleet-approval.spec.ts` — deleted.
- `apps/cli/src/commands/fleet.ts` — the `registerFleetApproval` import and call are deleted; the group description drops "approvals (S1.5 §2.5)".
- `apps/cli/src/commands/fleet.spec.ts` — "registers the fleet group with runner, repo, config, dispatch, ingest, job, budget, schedule, approval, analytics and status" expects the list without `approval`.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated from the US-010 OpenAPI document (`bun run generate:cli` from the repo root); never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated together with the SDK file; never hand-edited.

**US-013**
- `apps/api/src/permissions/catalog.ts` — `fleet.approval.read`, `fleet.approval.decide.budget`, `fleet.approval.decide.bash` and `fleet.approval.decide.assistant` are deleted from `INVENTORY_SCOPE_ROWS`, and `fleet.approval.decide.assistant` from `PENDING_SURFACE_KEYS`.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the seven "fleet/approvals" route rows are deleted and the `koda_list_approvals` tool row's key becomes `project.read`, so "catalog.spec.ts" (catalog equals inventory keys plus new keys) stays green.
- `apps/api/src/permissions/system-roles.ts` — `fleet.approval.decide.bash` is deleted from the `developer` seed; `approval.decide@fleet.job.shell.escalate` stays.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated by the role-matrix spec's update mode; the four key rows are gone from every role block.
- `apps/api/src/permissions/entry-matcher.spec.ts` — in "AC-1/2/3: Developer can decide the narrowed fleet shell escalation ask" the assertion that `developer.permissions` contains `fleet.approval.decide.bash` is deleted; the `approval.decide@` assertions stay.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `fleet.approval.decide.assistant` is deleted from the `expectedPending` set.
- `apps/api/test/integration/permissions/developer-bash-decide-migration.integration.spec.ts` — `oldDeveloperPermissions` becomes a hard-coded pre-migration list holding `fleet.approval.decide.bash`, because it can no longer be derived from `SYSTEM_ROLES`; cases "AC-4" to "AC-7" are unchanged.
- `apps/api/test/integration/fleet/permissions-assistant-tools.integration.spec.ts` — `APPROVAL_READER_ROLE`'s `customRole` drops `fleet.approval.read` (it already holds `project.read`); the cases' assertions are unchanged.

### Seams

- US-001: `ApprovalRequestedSubscriber` is reached from the outbox relay; US-001 AC-1 and AC-2 enter through the runner relay route and a budget hard stop, never by calling the handler directly.
- US-004: `ApprovalRequestQueries.list` is reached from the assistant tool executor; US-004 AC-1 enters through the runner tool route `POST /api/fleet/runner/jobs/:id/tools/koda_list_approvals`.
- US-008, US-009 → US-010: US-010 deletes routes only after US-008 (api tests) and US-009 (runner harness) moved every caller off them.
- US-011 → US-012: `koda approval approve` with params replaces `koda fleet approval decide` before it is deleted.

## Acceptance Criteria

Every API integration AC runs against the test Postgres through the HTTP app unless it says otherwise.

### US-001: The engine notifies the fleet asks

- AC-1 [integration]: a bash ask opened pending in project A through the runner relay gives every global admin one notification of kind `approval_request` with `link` `/approvals?id=<requestId>` and `params.key` `fleet.job.shell.escalate`.
- AC-2 [integration]: a budget hard stop opening a pending `fleet.budget.override` ask in project A gives every global admin one `approval_request` notification for that request.
- AC-3 [integration]: a user holding, in project A, the Approver role plus a role granting `fleet.job.shell.escalate` receives the `approval_request` notification for a bash ask in A.
- AC-4 [integration]: a user holding only the Approver role in project A receives no notification for a bash ask in A.
- AC-5 [integration]: a project Developer in A (holding `approval.decide@fleet.job.shell.escalate` but not `approval.decide`) receives no notification for a bash ask in A.
- AC-6 [integration]: a user holding `approval.decide` and `fleet.job.shell.escalate` only in project B receives no notification for a bash ask in project A.
- AC-7 [unit]: `ApprovalRequestedSubscriber`'s handler, given a pending payload with `permissionKey: 'fleet.job.shell.escalate'` and one eligible user, calls `NotificationWriter.deliver` once with one draft for that user.
- AC-8 [unit]: the handler, given a pending payload with `permissionKey: 'fleet.budget.override'` for a request with `projectId: null`, reads candidates through `NotificationEligibility.findGlobalAdminIds` and delivers one draft per eligible admin.
- AC-9 [unit]: the handler, given a payload with `status: 'executed'` and `permissionKey: 'fleet.job.shell.escalate'`, calls `NotificationWriter.deliver` zero times.

### US-002: Delete the `fleet_approval_requested` notification path

Removals only, verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/api`.

- AC-1 [integration]: a pending bash ask opened through the runner relay records no outbox event of type `fleet_approval_requested`, and every global admin has exactly one notification for the request, of kind `approval_request`.
- AC-2 [integration]: `PrismaOutboxStore.claimBatch` claims a due pending outbox row of type `fleet_approval_requested` left from before the change, and the relay marks it done with no notification written.

### US-003: A zero-count refresh dismisses the approval toasts (#356)

- AC-1 [unit]: with one shared counts ref, after a refresh with counts `{ total: 1 }` raises a toast for request `r1`, a refresh with counts `{ total: 0 }` dismisses the toast whose id is `r1`'s toast id.
- AC-2 [unit]: that zero-count refresh makes no `GET /approvals` request (the list call count stays at the one from the first refresh).
- AC-3 [unit]: with browser notifications enabled, `document.visibilityState` `'hidden'` and a constructible `Notification` double whose instances carry a `close` spy, after `r1` raised a browser notification the zero-count refresh calls that instance's `close()`.
- AC-4 [unit]: when the counts value is `null`, a refresh leaves the `r1` toast undismissed.
- AC-5 [unit]: a zero-count refresh whose signed-in user is absent (`auth.user` null) dismisses nothing through `refresh`.
- AC-6 [unit]: after a zero-count refresh dismissed `r1`, a later refresh with counts `{ total: 1 }` listing `r1` again raises no new toast for `r1`.

### US-004: `koda_list_approvals` reads the engine

- AC-1 [integration]: in a PROJECT thread of project A, the runner tool route `POST /api/fleet/runner/jobs/:id/tools/koda_list_approvals` with `{}` answers one line per pending request of project A that the thread's actor may see, each line starting with the request id followed by its `permissionKey`.
- AC-2 [integration]: a pending request of project B that the same actor may decide does not appear in that answer.
- AC-3 [unit]: `listApprovalsTool(queries).execute(ctx, { status: 'pending', page: 2 })` with a user actor calls `queries.list` once with the principal `{ type: 'USER', id: <the user id> }`, the filter `{ status: 'pending', projectId: ctx.projectId }` and the page `{ current: 2, size: 20 }`.
- AC-4 [unit]: the same call with an agent actor passes the principal `{ type: 'AGENT', id: <the agent id> }`.
- AC-5 [unit]: the tool's `key` is `project.read`.
- AC-6 [unit]: the tool's `parse({})` answers `{ status: 'pending', page: 1 }`, and `parse({ status: 'executed' })` answers status `executed`.
- AC-7 [unit]: the tool's `parse({ status: 'decided' })` throws the invalid-input error the other fleet tools throw for a value outside an enum.
- AC-8 [unit]: when `queries.list` answers an empty page the tool answers `no approvals`.
- AC-9 [unit]: when `queries.list` answers a page with `hasNext: true` and `current: 1`, the tool's last line is `more: call koda_list_approvals with page 2`.
- AC-10 [unit]: `mcpToolDescriptors()` holds no descriptor named `koda_list_approvals` and none named `koda_list_fleet_approvals`.
- AC-11 [integration]: an MCP `tools/list` call through `POST /api/mcp` answers exactly one tool named `koda_list_approvals`, whose description is the `ApprovalMcpTools` one.

### US-005: Delete the `fleet.approval.*` webhooks

Removals only, verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/api`.

- AC-1 [integration]: with a project webhook subscribed to `fleet.approval.requested`, `fleet.approval.resolved`, `approval.requested` and `approval.resolved`, a bash ask opened through the runner relay records one `webhook_delivery` outbox row for `approval.requested` and none for `fleet.approval.requested`.
- AC-2 [integration]: with that subscription, rejecting the ask through `POST /api/approvals/:id/decisions` records an `approval.resolved` delivery and none for `fleet.approval.resolved`.

### US-006: Delete the `fleet_approval` live event in the API

Removals only, verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/api`.

- AC-1 [integration]: a bash ask opened through the runner relay, then rejected through `POST /api/approvals/:id/decisions`, with the outbox relay run after each step (`dispatchPendingBatch`), publishes on `ProjectEventBus` `approval_request` events with status `pending` and then `rejected`, and no event of type `fleet_approval`.
- AC-2 [integration]: moving a RUNNING job with a pending bash ask to CANCELLED, with the outbox relay run, publishes an `approval_request` event with status `cancelled` for that request, and no `fleet_approval` event.
- AC-3 [integration]: relaying the same `approval_request_changed` outbox event of an executed fleet ask twice writes its `approval.decided` activity row once.
- AC-4 [integration]: after the migrations run, the `FleetApprovalAsk` table has no column named `publishedStatus`.

### US-007: Web: retire the fleet approval stream, types and redirects

Removals only, verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/web`.

- AC-1 [unit]: `openProjectEventStream` given only `onApprovalRequest` and `onResync` handlers adds no `fleet_approval` listener to its `EventSource`.
- AC-2 [unit]: `budgetPayload` given a plain object `{ type: 'budget_override', payload: <a budget ask input> }` answers the `BudgetApprovalPayload` it answered before the type change.

### US-008: Re-point the fleet-route integration tests at the engine routes

- AC-1 [integration]: approving a pending `fleet.budget.override` request through `POST /api/approvals/:id/decisions` with `params: { amountUsd: <above spend>, requeueJobIds: [<a candidate>] }` lifts the policy's pause and re-queues that job.
- AC-2 [integration]: approving it through the same route with `params: {}` (no amount) answers 400 and the request stays `pending`.
- AC-3 [integration]: approving a pending bash request through `POST /api/approvals/:id/decisions` with `params: { choice: 'allow_for_job' }` writes one `APPROVAL_ANSWER` command for the job with choice `allow_for_job`.
- AC-4 [integration]: `GET /api/approvals/counts` for a user whose only binding in project p1 is a developer binding answers a `projects` row for p1 and none for another project.

### US-009: Runner test harness: list and decide asks through the engine routes

Test-only; the helper is unit-tested from `test/unit/approval-routes.spec.ts` (the runner `test` script covers `test/unit`); `approval-relay.integration.spec.ts` exercises `world.ts` against a live API.

- AC-1 [unit]: `decideApproval(http, 'a1', 'deny')` with a stubbed `http` sends `POST /approvals/a1/decisions` with body `{ decision: 'reject' }`.
- AC-2 [unit]: `decideApproval(http, 'a1', 'allow_for_job')` with a stubbed `http` sends `POST /approvals/a1/decisions` with body `{ decision: 'approve', params: { choice: 'allow_for_job' } }`.
- AC-3 [unit]: with a stubbed `http` where `GET /approvals?jobId=j1` answers one row `a1` and `GET /approvals/a1` answers `details: { resolvedBy: 'user', outcome: { delivery: { result: 'ok' } } }`, `listJobApprovals(http, 'j1')` answers `[{ id: 'a1', status: <the row status>, resolvedBy: 'user', outcome: { delivery: { result: 'ok' } } }]`.

### US-010: Delete the fleet approval routes

Removals only, verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/api`.

- AC-1 [integration]: `GET /api/fleet/approvals`, `GET /api/projects/:slug/fleet/approvals` and `GET /api/fleet/approval-counts` each answer 404 for a global admin.
- AC-2 [unit]: (regeneration check, as the existing `*-openapi.contract.spec.ts` do) the committed OpenAPI document has no path starting with `/api/fleet/approvals`, `/api/projects/{slug}/fleet/approvals` or `/api/fleet/approval-counts`, and no schema named `FleetApprovalDto` or `ApprovalCountsDto`.
- AC-3 [unit]: compiling `ApprovalsModule` resolves `FleetShellEscalateCommand` and `FleetBudgetOverrideCommand`, and `ApprovalCommandRegistry` holds a command for `fleet.job.shell.escalate` and one for `fleet.budget.override`.

### US-011: `koda approval approve` takes the fleet decision params

Every refusal below runs inside the action: it calls `handleApiError(err, { validationError: true })` and returns, so the test asserts `process.exit` was called with 3 and `approvalRequestsControllerDecide` was not called.

- AC-1 [cli]: `koda approval approve r1 --choice allow_for_job` calls `approvalRequestsControllerDecide` once with `path: { id: 'r1' }` and `body: { decision: 'approve', params: { choice: 'allow_for_job' } }`.
- AC-2 [cli]: `koda approval approve r1 --amount 80` sends `body.params` `{ amountUsd: 80 }`, with `80` a JSON number.
- AC-3 [cli]: `koda approval approve r1 --amount 80.25 --requeue j1,j2` sends `body.params` `{ amountUsd: 80.25, requeueJobIds: ['j1', 'j2'] }`.
- AC-4 [cli]: `koda approval approve r1 --amount 80 --requeue all`, with `approvalRequestsControllerGet` answering `details.requeueCandidates` `[{ jobId: 'j1' }, { jobId: 'j3' }]` and `details.requeueCandidatesTruncated: false`, sends `requeueJobIds: ['j1', 'j3']`.
- AC-5 [cli]: `koda approval approve r1 --amount 80 --requeue all`, with `details.requeueCandidatesTruncated: true`, exits 3 with a message on stderr (the test spies on `console.error`) naming `koda approval show r1`, and no decide request is sent.
- AC-6 [cli]: `koda approval approve r1 --amount 80 --requeue all`, with `approvalRequestsControllerGet` answering `details: null`, exits 3 and no decide request is sent.
- AC-7 [cli]: `koda approval approve r1 --amount 0` exits 3 and no decide request is sent.
- AC-8 [cli]: `koda approval approve r1 --amount 1.23456` exits 3 and no decide request is sent.
- AC-9 [cli]: `koda approval approve r1 --choice deny` exits 3 and no decide request is sent.
- AC-10 [cli]: `koda approval approve r1 --requeue j1` (no `--amount`) exits 3 and no decide request is sent.
- AC-11 [cli]: `koda approval approve r1 --choice allow --amount 80` exits 3 and no decide request is sent.
- AC-12 [cli]: `koda approval approve r1 --amount 1000001` exits 3 and no decide request is sent.
- AC-13 [cli]: `koda approval approve r1 --choice allow --requeue j1` exits 3 and no decide request is sent.
- AC-14 [cli]: `koda approval approve r1` with none of the new options sends a body with no `params` key.

### US-012: Delete `koda fleet approval`

Removals only, verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/cli`.

- AC-1 [cli]: `fleetCommand(program)` registers the subcommands `analytics`, `budget`, `dispatch`, `drift-check`, `ingest`, `job`, `nax-files`, `repo`, `runner`, `schedule` and `status`, and no `approval`.

### US-013: Delete the `fleet.approval.*` keys

- AC-1 [integration]: after the migrations run, a `Role` row stored with permissions `["*.read", "fleet.approval.decide.bash", "!fleet.approval.read", "fleet.approval.*", "approval.decide@fleet.approval.decide.bash", "label.create"]` holds `["*.read", "label.create"]`.
- AC-2 [integration]: after the migrations run, a `Role` row stored with permissions `["fleet.approval.read", "fleet.approval.decide.bash"]` holds `[]`.
- AC-3 [integration]: after the migrations run, an `ApprovalPolicy` row with `permissionPattern` `fleet.approval.decide.bash` is gone and one with `label.create` remains.
- AC-4 [integration]: after the migrations run, an `ApprovalRequest` with `permissionKey` `fleet.approval.decide.budget` and status `pending` has status `cancelled` and a non-null `settledAt`.
- AC-5 [integration]: after the migrations run, an `ApprovalRequest` with `permissionKey` `fleet.approval.decide.bash` and status `executed` keeps status `executed`.
- AC-6 [integration]: after the migrations run, a `Notification` with `link` `/admin/fleet/approvals` has `link` `/approvals`, and one with `link` `/admin/fleet/budgets` is unchanged.
- AC-7 [unit]: `PERMISSION_CATALOG` holds no key starting with `fleet.approval.`.
- AC-8 [unit]: the `developer` entry of `SYSTEM_ROLES` holds `approval.decide@fleet.job.shell.escalate` and no entry starting with `fleet.approval.`.
- AC-9 [integration]: `POST /api/roles` with permissions `["fleet.approval.read"]` answers 400.
