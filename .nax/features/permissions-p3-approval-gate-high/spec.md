# SPEC: Permissions P3e-2 — Gating the High-Risk REST Routes

## Summary

This feature makes an agent's REST writes on the high-risk keys wait for approval. It uses the route gate that `permissions-p3-approval-gate-core` (5a) shipped.
- **29 routes are gated.** These are the approvable write routes whose key has a catalog default other than `none` (every one is `high`, default `agent`), minus 6 routes that carry a secret:
  - fleet budgets: global and project create, update, delete and resume;
  - fleet repos: create, delete and check;
  - fleet runners: update and delete;
  - fleet analytics delete; project schedule delete; repo drift checks;
  - project, agent and skill-source deletes;
  - project and global webhook deletes; VCS connection delete and test;
  - ticket delete, label delete, ticket-label remove, ticket-link remove, comment delete;
  - KB document delete.
- **Per domain module, one commands class.** Each module that owns a gated route registers its route variants (`rest:<controller>.<verb>`) in `onModuleInit`, as `PermissionRouteCommands` does. Each gated handler runs `ApprovalRouteGate.run` and throws `ApprovalPending` for a pending outcome.
- **What an agent now sees.** Under the shipped defaults an agent holding one of these keys gets `202 Accepted` with the pending request, and another agent or a human approves it. A human, or any caller under a `none` policy, still runs the write at once.
- **Secret-bearing routes are deferred.** `POST /fleet/enrollments`, `POST` and `PATCH /projects/:slug/vcs`, `POST /projects/:slug/vcs/webhook-secret/rotate`, `POST /projects/:slug/webhooks` and `PATCH /projects/:slug/webhooks/:id` move from `gate-high` to a new `PENDING_GATE_ROUTES` label `gate-secret`. They are not gated here.
- **The contract closes `gate-high`.** When the 29 routes are gated, `gate-high` leaves `PendingGateFeature`, the booted app has exactly 41 gated routes, and `openapi.json` shows `202` on each.

This is the second part of feature 5 of P3 (`p3-approval-gate`) in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine", "Shipped defaults").

## Motivation

5a built the mechanism and gated the 12 permission and approval routes. Every other approvable write route is listed in `PENDING_GATE_ROUTES` with the feature that will gate it. The 35 `gate-high` routes are the ones the design's shipped defaults already make agents wait on (`high` → `agent`), yet an agent calling them over REST or the `koda` CLI still writes at once: it can delete a project, a ticket or a runner, raise a budget or unregister a repo the moment it holds the key.

**Rulings that bind this feature** (user):
- 2026-10-26 and 2026-10-28 (as in 5a): every approvable REST write route is gated, split by risk into about four features; the deferred run is the command registry; a human acting directly satisfies any mode.
- 2026-10-28: 5b is one feature, not split into fleet and project halves.
- 2026-10-28: the 6 secret-bearing `gate-high` routes are deferred to a later feature under a new label `gate-secret`. A deferred request freezes its body into `ApprovalRequest.input` and stores its answer as `result`, both plain JSON that deciders read. These routes take a forge access token or a webhook secret in the body, or answer a token or secret shown once.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **One commands class per domain module, registered in that module.** The module imports `ApprovalEngineModule` (the registry and `ApprovalRouteGate`) and `AuthRepositoryModule` (`ActorPrincipalLoader`). `ApprovalEngineModule` imports nothing and is one instance per application, so importing it from many modules shares one registry.
- **The frozen input is what the service call needs, never config.** An input carries ids, slugs and the validated body. It never carries a value read from config: the VCS test command reads `vcsConfig.encryptionKey` when it runs.
- **Reads the handler already makes before its service call stay before the gate.** Their answers stay as today, and no request is opened when they refuse:
  - the analytics query validation (400 from the global validation pipe on `@Query() raw: DeleteAnalyticsQuery`; `parseQuery` only strips undeclared fields);
  - the VCS encryption-key check on `test` (400 `vcs`);
  - the KB route's project lookup and its row-ownership preflight (404 / 400 / 403);
  - the comment's project lookup (404 `comments`), which the gate needs for its scope.

  Every check inside a service runs when the command runs, at once or after approval; a failing check settles the request `failed`. This is 5a's rule.
- **The project id of a project route comes from `@CurrentProject()`.** `ProjectMembershipGuard` has already resolved it. Services that take a slug get the slug from the frozen input.
- **The gate key is the route's `@Requires` key.** For an ownable key (`comment.delete`, `ticket.link.remove`, `kb.document.delete`, `fleet.schedule.delete`), `ApprovalRouteGate` already accepts `<key>.own`. The row-level check (whose row it is) runs in the command.
- **The schedule command recomputes "may administer" when it runs:** `(await permissions.can(principal, 'fleet.schedule.delete', { projectId })).allowed`, the controller's `canAdminister` rule. A deferred delete is judged on the principal's keys at execution.
- **KB deletion moves into a service.** The handler's preflight, delete loop and audit move to `KbDocumentDeletion` (rag module) unchanged:
  - `preflight(principal, projectId, sourceId, source?)` answers the creators by source after the ownership check;
  - `delete(principal, projectId, sourceId, source?)` runs `preflight` again, then deletes and audits as today.

  The handler calls `preflight` before the gate so a refusal is immediate; the command calls `delete`, so a deferred run re-checks ownership.
- **The comment route needs a project before the gate.** `CommentsService.resolveCommentProject(commentId, principal): Promise<string>` is the existing private `assertCommentProjectMembership` exposed to answer only the project id, with the same 404 `comments` for a missing comment, a deleted ticket or project, or a non-member.
- **Service-enforced routes now refuse a keyless caller first.** On `DELETE /projects/:slug/tickets/:ref/links/:linkId` and `DELETE /comments/:id`, a caller holding neither the key nor its `.own` form gets 403 `permissions` from the route gate before any lookup; an unknown link used to answer 404 first. A caller holding the key still gets the service's 404 when the command runs.
- **`RagController`'s own helpers stay.** `assertMayDeleteRow` and `mayDeleteAnyRow` are also used by `addDocument` and stay in the controller; `KbDocumentDeletion` makes its own `PermissionService.can` check.
- **`parseRouteInput` for composite id inputs.** `parseRouteInput(input, names)` (in `approvals/route/parse-route-input.ts`) answers an object with exactly the named members, each a non-empty string. A non-object input, an array, or a missing, empty or non-string member throws `ValidationAppException({}, 'approvals.invalidInput')`. The 5a helper `parseIdInput` stays where it is; new commands use `parseRouteInput(input, ['id'])`.
- **Each gating story removes its own `PENDING_GATE_ROUTES` rows.** The contract test reports a `stale-pending-gate-route` for a gated route left on the allowlist, so a story that gates a route must drop its row. US-001 relaxes the exact gated-route count to a lower bound, and US-010 restores an exact count (41).
- **`gate-secret` is chosen from an explicit list, not derived.** `SECRET_GATE_ROUTES` (exported from `pending-gate-routes.ts`) names the 6 labels. The integration rule checks that list first, so every other route keeps the 5a derivation.
- **Only the HTTP handlers change.** The controllers' non-route helper methods (`AgentsController.deleteAgent`, `CommentsController.delete`, `LabelsController.delete` and `removeLabel`, `TicketsController.deleteTicket`) stay as they are, and so do their spec cases. A gated handler drops a `@Principal()` parameter it no longer reads, except where `no-principal-params.spec.ts` requires it (`RagController.deleteDocument` keeps `@Principal()`). Route parameters (`@Param('slug')`, `@Param('id')`, …) always stay declared, even when the handler reads the project from `@CurrentProject()` (name an unread one `_slug`), so the OpenAPI document keeps every path parameter.
- **Controller unit specs move their service expectations to the commands spec.** A spec that builds a controller provides an `ApprovalRouteGate` double. Gated handler cases assert the `run` call (`key`, `variant`, `projectId`, `input`) and the executed or pending mapping. The service call each one used to assert is pinned in the commands spec instead.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `parseRouteInput(input, names)` | `approvals/route/parse-route-input.ts` | exactly the named non-empty string members |
| `PendingGateFeature` | `permissions/pending-gate-routes.ts` | gains `'gate-secret'` (US-001), loses `'gate-high'` (US-010) |
| `SECRET_GATE_ROUTES: ReadonlySet<string>` | same | the 6 secret-bearing route labels |
| `BudgetRouteCommands`, `BUDGET_ROUTE_VARIANTS` | `fleet/budgets/budget-route.commands.ts` | |
| `FleetRepoRouteCommands`, `FLEET_REPO_ROUTE_VARIANTS` | `fleet/repos/fleet-repo-route.commands.ts` | |
| `RunnerRouteCommands`, `RUNNER_ROUTE_VARIANTS` | `fleet/runners/runner-route.commands.ts` | |
| `AnalyticsRouteCommands`, `ANALYTICS_ROUTE_VARIANTS` | `fleet/analytics/analytics-route.commands.ts` | |
| `ScheduleRouteCommands`, `SCHEDULE_ROUTE_VARIANTS` | `fleet/schedules/schedule-route.commands.ts` | |
| `RepoConfigRouteCommands`, `REPO_CONFIG_ROUTE_VARIANTS` | `fleet/repo-config/repo-config-route.commands.ts` | |
| `ProjectRouteCommands`, `PROJECT_ROUTE_VARIANTS` | `projects/project-route.commands.ts` | |
| `AgentRouteCommands`, `AGENT_ROUTE_VARIANTS` | `agents/agent-route.commands.ts` | |
| `SkillSourceRouteCommands`, `SKILL_SOURCE_ROUTE_VARIANTS` | `skills/skill-source-route.commands.ts` | |
| `WebhookRouteCommands`, `WEBHOOK_ROUTE_VARIANTS` | `webhook/webhook-route.commands.ts` | |
| `VcsRouteCommands`, `VCS_ROUTE_VARIANTS` | `vcs/vcs-route.commands.ts` | |
| `TicketRouteCommands`, `TICKET_ROUTE_VARIANTS` | `tickets/ticket-route.commands.ts` | |
| `LabelRouteCommands`, `LABEL_ROUTE_VARIANTS` | `labels/label-route.commands.ts` | |
| `TicketLinkRouteCommands`, `TICKET_LINK_ROUTE_VARIANTS` | `ticket-links/ticket-link-route.commands.ts` | |
| `CommentRouteCommands`, `COMMENT_ROUTE_VARIANTS` | `comments/comment-route.commands.ts` | |
| `CommentsService.resolveCommentProject` | `comments/comments.service.ts` | the comment's project id, membership-checked |
| `KbDocumentDeletion` | `rag/kb-document-deletion.service.ts` | `preflight`, `delete` |
| `KbRouteCommands`, `KB_ROUTE_VARIANTS` | `rag/kb-route.commands.ts` | |

### The gated routes

Each row is one `routeCommand` registered by the story's commands class. "Scope" is the `projectId` passed to `ApprovalRouteGate.run` (`null` = global). The run calls the service the handler calls today, with `principal` the rebuilt `UserPrincipal | AgentPrincipal`. A route whose handler answers no body has a run that returns `null`, and its handler returns `undefined` on `executed` (204 or the route's status, as today). Every other run answers what the service answers, and the handler answers `JsonResponse.Ok(outcome.result)`. Every body-returning command declares `toResult: (result) => result`, so `ApprovalRequest.result` holds the body the route answers (the services already answer DTOs or plain objects); a no-body command declares no `toResult` and stores `null`. The KB command's run answers `{ deleted: true }`.

| Story | Route | Key | Scope | Variant | Input | Run |
|:--|:--|:--|:--|:--|:--|:--|
| US-002 | `POST /fleet/budgets` | `fleet.budget.create` | null | `rest:fleet-budgets.create` | `parseBody(CreateBudgetPolicyDto, input)` | `budgets.create(principal.id, { kind: 'admin' }, dto)` |
| US-002 | `PATCH /fleet/budgets/:id` | `fleet.budget.update` | null | `rest:fleet-budgets.update` | `{ id, patch: parseBody(UpdateBudgetPolicyDto, …) }` | `budgets.update(principal.id, { kind: 'admin' }, id, patch)` |
| US-002 | `DELETE /fleet/budgets/:id` | `fleet.budget.delete` | null | `rest:fleet-budgets.delete` | `{ id }` | `budgets.remove(principal.id, { kind: 'admin' }, id)` |
| US-002 | `POST /fleet/budgets/:id/resume` | `fleet.budget.resume` | null | `rest:fleet-budgets.resume` | `{ id, body: parseBody(ResumeBudgetPolicyDto, …) }` | `budgets.resume(principal.id, { kind: 'admin' }, id, body.amountUsd)` |
| US-002 | `POST /projects/:slug/fleet/budgets` | `fleet.budget.create` | project | `rest:project-fleet-budgets.create` | `{ projectId, policy: parseBody(CreateBudgetPolicyDto, …) }` | `budgets.create(principal.id, { kind: 'project', projectId }, policy)` |
| US-002 | `PATCH /projects/:slug/fleet/budgets/:id` | `fleet.budget.update` | project | `rest:project-fleet-budgets.update` | `{ projectId, id, patch }` | `budgets.update(principal.id, { kind: 'project', projectId }, id, patch)` |
| US-002 | `DELETE /projects/:slug/fleet/budgets/:id` | `fleet.budget.delete` | project | `rest:project-fleet-budgets.delete` | `{ projectId, id }` | `budgets.remove(…, { kind: 'project', projectId }, id)` |
| US-002 | `POST /projects/:slug/fleet/budgets/:id/resume` | `fleet.budget.resume` | project | `rest:project-fleet-budgets.resume` | `{ projectId, id, body }` | `budgets.resume(…, { kind: 'project', projectId }, id, body.amountUsd)` |
| US-003 | `POST /fleet/repos` | `fleet.repo.create` | null | `rest:fleet-repos.create` | `parseBody(CreateFleetRepoDto, input)` | `repos.create(principal.id, dto)` |
| US-003 | `DELETE /fleet/repos/:id` | `fleet.repo.delete` | null | `rest:fleet-repos.delete` | `{ id }` | `repos.remove(principal.id, id)` |
| US-003 | `POST /fleet/repos/:id/check` | `fleet.repo.check` | null | `rest:fleet-repos.check` | `{ id }` | `repos.check(id)` |
| US-003 | `PATCH /fleet/runners/:id` | `fleet.runner.update` | null | `rest:fleet-runners.update` | `{ id, patch: parseBody(UpdateRunnerDto, …) }` | `runners.update(principal.id, id, patch)` |
| US-003 | `DELETE /fleet/runners/:id` | `fleet.runner.delete` | null | `rest:fleet-runners.delete` | `{ id }` | `runners.remove(principal.id, id)` |
| US-003 | `DELETE /fleet/analytics` | `fleet.analytics.delete` | null | `rest:fleet-analytics.delete` | `{ before, projectId?, confirm }`: `parseBody(DeleteAnalyticsQuery, { before, projectId })` merged with `parseBody(DeleteAnalyticsBody, { confirm })` | `analytics.deleteRows(principal.id, input, new Date())` |
| US-004 | `DELETE /projects/:slug/fleet/schedules/:id` | `fleet.schedule.delete` | project | `rest:project-fleet-schedules.delete` | `{ projectId, id }` | `schedules.remove(principal.id, projectId, id, canAdminister)`, `canAdminister` computed as above |
| US-004 | `POST /projects/:slug/fleet/repos/:repoId/drift-checks` | `fleet.repo.drift.check` | project | `rest:project-repo-config.drift-check` | `{ projectId, repoId }` | `configJobs.submitDrift(principal.id, projectId, repoId)` |
| US-005 | `DELETE /projects/:slug` | `project.delete` | project | `rest:projects.delete` | `{ slug }` | `projects.softDelete(slug)` |
| US-005 | `DELETE /agents/:slug` | `agent.delete` | null | `rest:agents.delete` | `{ slug }` | `agents.remove(slug)` |
| US-005 | `DELETE /admin/skills/sources/:id` | `skill.source.delete` | null | `rest:admin-skill-sources.delete` | `{ id }` | `skills.deleteSource(id)` |
| US-006 | `DELETE /projects/:slug/webhooks/:id` | `webhook.delete` | project | `rest:project-webhooks.delete` | `{ projectId, id }` | `webhooks.removeForProject(projectId, id)` |
| US-006 | `DELETE /webhooks/:id` | `webhook.delete` | null | `rest:webhooks.delete` | `{ id }` | `webhooks.remove(id)` |
| US-006 | `DELETE /projects/:slug/vcs` | `vcs.connection.delete` | project | `rest:vcs.delete` | `{ projectId }` | `vcs.delete(projectId)` |
| US-006 | `POST /projects/:slug/vcs/test` | `vcs.connection.test` | project | `rest:vcs.test` | `{ projectId }` | `vcs.testConnection(projectId, key)`; `key` is `vcsConfig.encryptionKey` read at run time, and a missing key throws `ValidationAppException({}, 'vcs')` |
| US-007 | `DELETE /projects/:slug/tickets/:ref` | `ticket.delete` | project | `rest:tickets.delete` | `{ slug, ref }` | `tickets.softDelete(slug, ref, principal)` |
| US-007 | `DELETE /projects/:slug/labels/:id` | `label.delete` | project | `rest:labels.delete` | `{ slug, id }` | `labels.delete(slug, id, principal)` |
| US-007 | `DELETE /projects/:slug/tickets/:ref/labels/:labelId` | `ticket.label.remove` | project | `rest:ticket-labels.remove` | `{ slug, ref, labelId }` | `labels.removeFromTicket(slug, ref, labelId, principal)` |
| US-007 | `DELETE /projects/:slug/tickets/:ref/links/:linkId` | `ticket.link.remove` | project | `rest:ticket-links.remove` | `{ slug, ref, linkId }` | `ticketLinks.remove(slug, ref, linkId, principal)` |
| US-008 | `DELETE /comments/:id` | `comment.delete` | the comment's project (`resolveCommentProject`) | `rest:comments.delete` | `{ id }` | `comments.delete(id, principal)` |
| US-009 | `DELETE /projects/:slug/kb/documents/:sourceId` | `kb.document.delete` | project | `rest:kb-documents.delete` | `{ projectId, sourceId, source? }` (`source` validated by `DeleteKbDocumentQuery`) | `kbDeletion.delete(principal, projectId, sourceId, source)`, answering `{ deleted: true }` |

- The id members of every input are read with `parseRouteInput`. A body member is read with `parseBody` of the route's DTO; a missing body member is parsed as `{}`.
- A missing or malformed `before` is refused with 400 by the global validation pipe before the handler runs, so no request opens; the handler passes `parseQuery(DeleteAnalyticsQuery, raw)` into the input as today. The run's `deleteRows` refuses a `confirm` that names neither the project's slug nor `ALL` (today's 400, now a `failed` request).
- The VCS test handler checks `vcsConfig.encryptionKey` before the gate (400 `vcs` as today). The VCS delete handler no longer reads `projectsService.findBySlug`: the scope and input use `@CurrentProject()`.
- The project webhook delete handler no longer calls `webhookService.getProjectBySlug`: the scope and input use `@CurrentProject()`. A webhook of another project answers 404 `webhooks` from `removeForProject` when the command runs.
- The comment handler calls `resolveCommentProject(id, principal)` first, then gates with `projectId` its answer.
- The KB handler: `resolveProject(slug)` (404 `rag`), `kbDeletion.preflight(principal, project.id, sourceId, query.source)`, then the gate.

### Module wiring

| Story | Module | Gains | Controllers whose constructor gains `ApprovalRouteGate` |
|:--|:--|:--|:--|
| US-002 | `BudgetsModule` | `BudgetRouteCommands` | `FleetBudgetsController`, `ProjectFleetBudgetsController` |
| US-003 | `FleetReposModule` | `FleetRepoRouteCommands` | `FleetReposController` |
| US-003 | `RunnersModule` | `RunnerRouteCommands` | `RunnersController` |
| US-003 | `AnalyticsModule` | `AnalyticsRouteCommands` | `FleetAnalyticsController` |
| US-004 | `SchedulesModule` | `ScheduleRouteCommands` | `ProjectFleetSchedulesController` |
| US-004 | `RepoConfigModule` | `RepoConfigRouteCommands` | `ProjectRepoConfigController` |
| US-005 | `ProjectsModule` | `ProjectRouteCommands` | `ProjectsController` |
| US-005 | `AgentsModule` | `AgentRouteCommands` | `AgentsController` |
| US-005 | `SkillsModule` | `SkillSourceRouteCommands` | `AdminSkillsController` |
| US-006 | `WebhookModule` | `WebhookRouteCommands` | `WebhookController` |
| US-006 | `VcsModule` | `VcsRouteCommands` | `VcsController` |
| US-007 | `TicketsModule` | `TicketRouteCommands` | `TicketsController` |
| US-007 | `LabelsModule` | `LabelRouteCommands` | `LabelsController` |
| US-007 | `TicketLinksModule` | `TicketLinkRouteCommands` | `TicketLinksController` |
| US-008 | `CommentsModule` | `CommentRouteCommands` | `CommentsController` |
| US-009 | `RagModule` | `KbDocumentDeletion`, `KbRouteCommands` | `RagController` (also `KbDocumentDeletion`) |

Each module also imports `ApprovalEngineModule` and `AuthRepositoryModule` (unless it already does). Each gated handler gains `@ApprovalGated()`, keeps its `@Requires` and `@ApiResponse`s, and has the 5a shape:

```ts
const outcome = await this.routeGate.run<BudgetPolicyDto>({ key: 'fleet.budget.delete', variant: BUDGET_ROUTE_VARIANTS.globalDelete, projectId: null, input: { id } });
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return undefined;
```

### The allowlist (US-001, US-010)

- US-001:
  - `PendingGateFeature` becomes `'gate-high' | 'gate-secret' | 'gate-core-domains' | 'gate-fleet'`, and `isPendingGateFeature` accepts `gate-secret`;
  - the 6 secret-bearing rows are relabelled `gate-secret`;
  - `SECRET_GATE_ROUTES` holds exactly those 6 labels.
- The rollout rule (in `permission-contract.integration.spec.ts`), first match wins:
  1. a label in `SECRET_GATE_ROUTES` → `gate-secret`;
  2. a key whose default is not `none` → `gate-high`;
  3. all keys under `fleet.`, `thread.` or `testhook.` → `gate-fleet`;
  4. else `gate-core-domains`.
- US-002 to US-009: each drops its gated routes' rows.
- US-010:
  - `PendingGateFeature` becomes `'gate-secret' | 'gate-core-domains' | 'gate-fleet'`, and `isPendingGateFeature` refuses `gate-high`;
  - the rule keeps its `gate-high` branch, so a new high-risk route that is not gated produces an expected entry no allowlist value can match, and the test fails.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `parseRouteInput` on a non-object, an array, or a missing or empty named member | 400 `approvals.invalidInput` | US-001 |
| Agent without the route's key (or `.own` form) | 403 `permissions`, from the guard or the route gate; no request (one route per story pins it; every route takes the same guard and gate path) | US-002, US-005, US-007, US-009 |
| An approved write the service refuses when it runs (budget conflict or not paused, forge check failed, missing row, another project's webhook, a missing link) | Request `failed`, `{ error: 'execution-failed', name }` | US-002, US-003, US-006, US-007 |
| Analytics delete without `before` | 400 before the gate; no request | US-003 |
| Approved analytics delete whose `confirm` does not match | Request `failed` | US-003 |
| Approved schedule delete by a `.own` holder on someone else's schedule | Request `failed`; the schedule stays | US-004 |
| VCS test with no encryption key configured | 400 `vcs` before the gate; no request | US-006 |
| Comment delete on a missing comment or by a non-member | 404 `comments` before the gate; no request | US-008 |
| Approved comment delete by a `.own` holder on someone else's comment | Request `failed`; the comment stays | US-008 |
| KB delete on a row the caller may not delete | 403 `permissions` before the gate; no request | US-009 |
| KB delete whose row ownership changes before the approved run | Request `failed` (the run's preflight refuses) | US-009 |
| A high-risk write route that is neither gated nor allowlisted after US-010 | Contract test fails | US-010 |

### Integration

**Read-only, verified:**
- `ApprovalRouteGate.run({ key, variant, projectId, input, keyCheck? })`, `ApprovalPending`, `@ApprovalGated()`, `routeCommand(spec, loader)`, `parseBody(cls, raw)`, `ApprovalCommandRegistry.get(key, variant)` (5a).
- `PermissionRouteCommands` and `RolesController` (5a): the registration and handler pattern to mirror.
- `ApprovalGate.gate`: a USER actor executes at once (`satisfiedBy: 'human'`); an agent under the catalog default `agent` gets a pending request.
- `decideEligibility`: the root user (Owner, holding `*`) may approve an `agent`-mode request and contributes `human`.
- `BudgetsService.create/update/remove/resume(actorId, route: BudgetRoute, …)`, `BudgetRoute = { kind: 'admin' } | { kind: 'project'; projectId }`.
- `FleetReposService.create(actorId, dto)`, `.remove(actorId, id)`, `.check(id, now?)`; `RunnersService.update(actorId, id, dto)`, `.remove(actorId, id)`; `AnalyticsService.deleteRows(actorId, q: DeleteInput, now)`.
- `SchedulesService.remove(actorId, projectId, id, canAdminister)`; `ConfigJobsService.submitDrift(actorId, projectId, repoId)`.
- `ProjectsService.softDelete(slug)`; `AgentsService.remove(slug)`; `SkillsService.deleteSource(id)`.
- `WebhookService.removeForProject(projectId, id)`, `.remove(id)`; `VcsConnectionService.delete(projectId)`, `.testConnection(projectId, encryptionKey)`.
- `TicketsService.softDelete(slug, ref, principal)`; `LabelsService.delete(slug, id, principal)`, `.removeFromTicket(slug, ref, labelId, principal)`; `TicketLinksService.remove(slug, ref, linkId, principal)`; `CommentsService.delete(id, principal)`.
- `RagService.findSourceCreators(projectId, source, sourceId)`, `.deleteBySource(projectId, source, sourceId)`; `KB_DELETE_SOURCES`; `PermissionService.can`.
- Test helpers: `grantKeys`, `seedFleetHttpWorld`, `seedFleetHttpAgent`, `bootHttpApp`, `data`, `GlobalStubsModule`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `PendingGateFeature` | `'gate-high' \| 'gate-core-domains' \| 'gate-fleet'` | `'gate-secret' \| 'gate-core-domains' \| 'gate-fleet'` (after US-010) |
| `PENDING_GATE_ROUTES` | 35 `gate-high` rows | no `gate-high` rows; 6 `gate-secret` rows |
| `CommentsService.assertCommentProjectMembership` | private | unchanged; new public `resolveCommentProject(commentId, principal): Promise<string>` answers its `projectId` |
| `RagController.deleteDocument` | preflight, delete loop and audit inline | `resolveProject`, `KbDocumentDeletion.preflight`, gate |
| the 29 handlers | call the service | run the route gate |
| the 17 controllers' constructors | no gate | gain `ApprovalRouteGate` (and `KbDocumentDeletion` for `RagController`) |

## Out of Scope

- Gating the 6 secret-bearing routes (`POST /fleet/enrollments`, `POST /projects/:slug/vcs`, `PATCH /projects/:slug/vcs`, `POST /projects/:slug/vcs/webhook-secret/rotate`, `POST /projects/:slug/webhooks`, `PATCH /projects/:slug/webhooks/:id`): a later feature, `gate-secret`, which must keep secrets out of `ApprovalRequest.input` and `result`.
- Gating the medium-risk routes: `permissions-p3-approval-gate-core-domains` and `-gate-fleet`, as `PENDING_GATE_ROUTES` records.
- Running a service's domain checks (lookups, row ownership, conflicts) before a request opens, beyond the handler reads listed in Design. They run when the command runs.
- Assistant or MCP writes on these keys: they keep their primary command.
- Any change to `apps/web` or `apps/cli` (5a's CLI already handles 202).
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`.
- US-003 only: running the real forge check in tests; the fixtures stub it as `fleet-repos.integration.spec.ts` does.
- US-006 only: a real network call to a forge. The VCS test fixtures stub the provider's connection test (the method `VcsConnectionService.testConnection` calls), so AC-8 and AC-9 make no network call.
- `endpoint.e2e.spec.ts` coverage for every gated route: US-010 adds two representative 202 cases (labels, comments), as 5a did for its 12 routes; per-route coverage lives in each story's integration spec.
- US-006 only: deferring a VCS test whose encryption key is removed between the request and its approval beyond the `failed` outcome the run's check gives.

## Stories

1. **US-001: Route input parsing and the `gate-secret` label** — `Workdir: apps/api` — No dependencies. `parseRouteInput`, `gate-secret`, `SECRET_GATE_ROUTES`, the rule's secret branch, the gated-count lower bound.
2. **US-002: Gated budget routes** — `Workdir: apps/api` — Depends on US-001. `BudgetRouteCommands` and the 8 budget handlers.
3. **US-003: Gated fleet repo, runner and analytics routes** — `Workdir: apps/api` — Depends on US-001. `FleetRepoRouteCommands`, `RunnerRouteCommands`, `AnalyticsRouteCommands` and their 6 handlers.
4. **US-004: Gated schedule delete and drift checks** — `Workdir: apps/api` — Depends on US-001. `ScheduleRouteCommands`, `RepoConfigRouteCommands` and their 2 handlers.
5. **US-005: Gated project, agent and skill-source deletes** — `Workdir: apps/api` — Depends on US-001. `ProjectRouteCommands`, `AgentRouteCommands`, `SkillSourceRouteCommands` and their 3 handlers.
6. **US-006: Gated webhook deletes and VCS delete and test** — `Workdir: apps/api` — Depends on US-001. `WebhookRouteCommands`, `VcsRouteCommands` and their 4 handlers.
7. **US-007: Gated ticket, label and link removals** — `Workdir: apps/api` — Depends on US-001, US-005. `TicketRouteCommands`, `LabelRouteCommands`, `TicketLinkRouteCommands` and their 4 handlers. (Depends on US-005 because US-005 adds the `ApprovalRouteGate` double `project-membership.guard.routes.spec.ts` needs for `TicketsController`.)
8. **US-008: Gated comment delete** — `Workdir: apps/api` — Depends on US-001. `resolveCommentProject`, `CommentRouteCommands` and the handler.
9. **US-009: Gated KB document delete** — `Workdir: apps/api` — Depends on US-001, US-005. `KbDocumentDeletion`, `KbRouteCommands` and the handler.
10. **US-010: Closing `gate-high`: contract, OpenAPI and endpoint coverage** — `Workdir: apps/api` — Depends on US-002, US-003, US-004, US-005, US-006, US-007, US-008, US-009. `gate-high` leaves the type, exact count 41, `openapi.json` regenerated, endpoint 202 cases.

### Context Files

**US-001**
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/src/approvals/route/parse-body.ts`
- `apps/api/src/permissions/permission-route.commands.ts` (`parseIdInput`)

**US-002**
- `apps/api/src/permissions/permission-route.commands.ts` (the registration pattern)
- `apps/api/src/permissions/roles.controller.ts` (the gated handler pattern)
- `apps/api/src/fleet/budgets/budgets.service.ts`
- `apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts` (fixtures)
- `apps/api/test/integration/permissions/gated-role-routes.integration.spec.ts` (the gated-route test pattern)

**US-003**
- `apps/api/src/fleet/repos/fleet-repos.service.ts`
- `apps/api/src/fleet/runners/runners.service.ts`
- `apps/api/src/fleet/analytics/analytics.service.ts`
- `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts` (forge stub fixtures)
- `apps/api/test/integration/fleet/fleet-analytics-delete.integration.spec.ts` (fixtures)

**US-004**
- `apps/api/src/fleet/schedules/schedules.service.ts`
- `apps/api/src/fleet/repo-config/config-jobs.service.ts`
- `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts` (fixtures)
- `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts` (fixtures)
- `apps/api/src/permissions/permission-route.commands.ts`

**US-005**
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/skills/skills.service.ts`
- `apps/api/test/integration/skills/skill-source-update-delete.integration.spec.ts` (fixtures)
- `apps/api/test/integration/permissions/gated-role-routes.integration.spec.ts`

**US-006**
- `apps/api/src/webhook/webhook.service.ts`
- `apps/api/src/vcs/vcs-connection.service.ts`
- `apps/api/test/integration/vcs/vcs-permissions.integration.spec.ts` (fixtures)
- `apps/api/test/integration/webhook/webhook-permissions.integration.spec.ts` (fixtures)
- `apps/api/test/integration/permissions/gated-role-routes.integration.spec.ts`

**US-007**
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/labels/labels.service.ts`
- `apps/api/src/ticket-links/ticket-links.service.ts`
- `apps/api/test/integration/permissions/core-ticket-links.integration.spec.ts` (fixtures)
- `apps/api/test/integration/permissions/core-ticket-routes.integration.spec.ts` (fixtures)

**US-008**
- `apps/api/src/permissions/permission-route.commands.ts`
- `apps/api/src/permissions/roles.controller.ts`
- `apps/api/test/integration/permissions/gated-role-routes.integration.spec.ts`

**US-009**
- `apps/api/src/rag/rag.service.ts`
- `apps/api/src/rag/dto/delete-kb-document.query.ts`
- `apps/api/test/integration/permissions/gated-role-routes.integration.spec.ts`

**US-010**
- `apps/api/scripts/export-spec.cjs`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`

### Creates

**US-001**
- `apps/api/src/approvals/route/parse-route-input.ts`
- `apps/api/src/approvals/route/parse-route-input.spec.ts`

**US-002**
- `apps/api/src/fleet/budgets/budget-route.commands.ts`
- `apps/api/src/fleet/budgets/budget-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-budget-routes.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/repos/fleet-repo-route.commands.ts`
- `apps/api/src/fleet/repos/fleet-repo-route.commands.spec.ts`
- `apps/api/src/fleet/runners/runner-route.commands.ts`
- `apps/api/src/fleet/runners/runner-route.commands.spec.ts`
- `apps/api/src/fleet/analytics/analytics-route.commands.ts`
- `apps/api/src/fleet/analytics/analytics-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-fleet-admin-routes.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/schedules/schedule-route.commands.ts`
- `apps/api/src/fleet/schedules/schedule-route.commands.spec.ts`
- `apps/api/src/fleet/repo-config/repo-config-route.commands.ts`
- `apps/api/src/fleet/repo-config/repo-config-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-project-fleet-routes.integration.spec.ts`

**US-005**
- `apps/api/src/projects/project-route.commands.ts`
- `apps/api/src/projects/project-route.commands.spec.ts`
- `apps/api/src/agents/agent-route.commands.ts`
- `apps/api/src/agents/agent-route.commands.spec.ts`
- `apps/api/src/skills/skill-source-route.commands.ts`
- `apps/api/src/skills/skill-source-route.commands.spec.ts`
- `apps/api/test/integration/permissions/gated-admin-delete-routes.integration.spec.ts`

**US-006**
- `apps/api/src/webhook/webhook-route.commands.ts`
- `apps/api/src/webhook/webhook-route.commands.spec.ts`
- `apps/api/src/vcs/vcs-route.commands.ts`
- `apps/api/src/vcs/vcs-route.commands.spec.ts`
- `apps/api/test/integration/webhook/gated-webhook-vcs-routes.integration.spec.ts`

**US-007**
- `apps/api/src/tickets/ticket-route.commands.ts`
- `apps/api/src/tickets/ticket-route.commands.spec.ts`
- `apps/api/src/labels/label-route.commands.ts`
- `apps/api/src/labels/label-route.commands.spec.ts`
- `apps/api/src/ticket-links/ticket-link-route.commands.ts`
- `apps/api/src/ticket-links/ticket-link-route.commands.spec.ts`
- `apps/api/test/integration/tickets/gated-ticket-routes.integration.spec.ts`

**US-008**
- `apps/api/src/comments/comment-route.commands.ts`
- `apps/api/src/comments/comment-route.commands.spec.ts`
- `apps/api/test/integration/comments/gated-comment-routes.integration.spec.ts`

**US-009**
- `apps/api/src/rag/kb-document-deletion.service.ts`
- `apps/api/src/rag/kb-document-deletion.service.spec.ts`
- `apps/api/src/rag/kb-route.commands.ts`
- `apps/api/src/rag/kb-route.commands.spec.ts`
- `apps/api/test/integration/rag/gated-kb-document-routes.integration.spec.ts`

**US-010**

None: US-010 only changes existing files.

### Modifies

Controller unit specs: the gated handler's cases assert the `ApprovalRouteGate.run` call and the executed/pending mapping, and their service-call expectations move to the story's commands spec. A spec that only builds the controller adds an `ApprovalRouteGate` provider double (`{ run: vi.fn() }`) and changes no assertion. Existing tests where an agent succeeds on one of the 29 routes: `core-comments-labels-watchers.integration.spec.ts` AC-9 (US-008) and `enforce-fleet-config-knowledge.integration.spec.ts` AC-7 and AC-8 (US-004).

**US-001**
- `apps/api/src/permissions/pending-gate-routes.ts` — PendingGateFeature gains 'gate-secret'; the 6 secret-bearing rows are relabelled; SECRET_GATE_ROUTES exported
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the gate-secret cases
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the rollout rule checks SECRET_GATE_ROUTES first; AC-13's exact toHaveLength(12) becomes "at least 12" (US-010 restores an exact count)

**US-002**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the 8 budget rows
- `apps/api/src/fleet/budgets/budgets.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides BudgetRouteCommands
- `apps/api/src/fleet/budgets/budgets.module.spec.ts` — the module also resolves BudgetRouteCommands
- `apps/api/src/fleet/budgets/fleet-budgets.controller.ts` — constructor gains ApprovalRouteGate; create, update, remove, resume gated
- `apps/api/src/fleet/budgets/project-fleet-budgets.controller.ts` — the same, with projectId: ctx.project.id

**US-003**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the 6 rows of POST /fleet/repos, DELETE /fleet/repos/:id, POST /fleet/repos/:id/check, PATCH /fleet/runners/:id, DELETE /fleet/runners/:id, DELETE /fleet/analytics
- `apps/api/src/fleet/repos/fleet-repos.module.ts` — imports the engine and auth repository modules; provides FleetRepoRouteCommands
- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — constructor gains ApprovalRouteGate; create, remove, check gated
- `apps/api/src/fleet/runners/runners.module.ts` — imports the two modules; provides RunnerRouteCommands
- `apps/api/src/fleet/runners/runners.controller.ts` — constructor gains ApprovalRouteGate; update, remove gated
- `apps/api/src/fleet/analytics/analytics.module.ts` — imports the two modules; provides AnalyticsRouteCommands
- `apps/api/src/fleet/analytics/fleet-analytics.controller.ts` — constructor gains ApprovalRouteGate; remove gated after parseQuery

**US-004**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops DELETE /projects/:slug/fleet/schedules/:id and POST /projects/:slug/fleet/repos/:repoId/drift-checks
- `apps/api/src/fleet/schedules/schedules.module.ts` — imports the two modules; provides ScheduleRouteCommands
- `apps/api/src/fleet/schedules/schedules.module.spec.ts` — the module also resolves ScheduleRouteCommands
- `apps/api/src/fleet/schedules/project-fleet-schedules.controller.ts` — constructor gains ApprovalRouteGate; remove gated (its canAdminister call moves into the command)
- `apps/api/src/fleet/repo-config/repo-config.module.ts` — imports the two modules; provides RepoConfigRouteCommands
- `apps/api/src/fleet/repo-config/project-repo-config.controller.ts` — constructor gains ApprovalRouteGate; submitDrift gated
- `apps/api/test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts` — its AC-7 (a DEVELOPER agent queues a drift check, 201) now expects 202 with data.permissionKey fleet.repo.drift.check; its AC-8 approves that request as root, then asserts the created CONFIG_DRIFT job has requestedById the agent and requestedByType AGENT

**US-005**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops DELETE /projects/:slug, DELETE /agents/:slug, DELETE /admin/skills/sources/:id
- `apps/api/src/projects/projects.module.ts` — imports the two modules; provides ProjectRouteCommands
- `apps/api/src/projects/projects.module.spec.ts` — its testing module provides an ApprovalRouteGate double for ProjectsController; no assertion changes
- `apps/api/src/projects/projects.controller.ts` — constructor gains ApprovalRouteGate; remove gated with @CurrentProject()
- `apps/api/src/projects/projects.controller.spec.ts` — the remove cases assert the gate call (project.delete, rest:projects.delete, the project id, { slug }) instead of softDelete
- `apps/api/src/projects/projects-brief.routes.spec.ts` — provides an ApprovalRouteGate double; no assertion changes
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — provides an ApprovalRouteGate double (shared by its three controllers); no assertion changes
- `apps/api/test/unit/projects/projects-conflict-responses.spec.ts` — provides an ApprovalRouteGate double; no assertion changes
- `apps/api/src/agents/agents.module.ts` — imports the two modules; provides AgentRouteCommands
- `apps/api/src/agents/agents.controller.ts` — constructor gains ApprovalRouteGate; remove gated
- `apps/api/src/agents/agents.controller.spec.ts` — provides an ApprovalRouteGate double; no assertion changes
- `apps/api/src/agents/agents-create.routes.spec.ts` — provides an ApprovalRouteGate double; no assertion changes
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — provides an ApprovalRouteGate double; no assertion changes
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — provides an ApprovalRouteGate double; no assertion changes
- `apps/api/src/skills/skills.module.ts` — imports the two modules; provides SkillSourceRouteCommands
- `apps/api/src/skills/skills.module.spec.ts` — the module also resolves SkillSourceRouteCommands
- `apps/api/src/skills/admin-skills.controller.ts` — constructor gains ApprovalRouteGate; remove gated
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — its AC-10 (DELETE /projects/:slug is gate-high) now asserts PENDING_GATE_ROUTES has no entry for DELETE /projects/:slug, because this story gates that route

**US-006**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops DELETE /projects/:slug/webhooks/:id, DELETE /webhooks/:id, DELETE /projects/:slug/vcs, POST /projects/:slug/vcs/test
- `apps/api/src/webhook/webhook.module.ts` — imports the two modules; provides WebhookRouteCommands
- `apps/api/src/webhook/webhook.controller.ts` — constructor gains ApprovalRouteGate; removeByProject (with @CurrentProject()) and remove gated
- `apps/api/src/webhook/webhook-routes.spec.ts` — provides an ApprovalRouteGate double whose run executes the webhook write itself and answers { status: 'executed', result: null }: for variant rest:project-webhooks.delete it calls WebhookService.removeForProject(input.projectId, input.id), for rest:webhooks.delete WebhookService.remove(input.id), so its AC-6 and AC-9 (a user deletes a webhook, 204, row gone) keep their assertions
- `apps/api/src/vcs/vcs.module.ts` — imports the two modules; provides VcsRouteCommands
- `apps/api/src/vcs/vcs.module.spec.ts` — the module also resolves VcsRouteCommands
- `apps/api/src/vcs/vcs.controller.ts` — constructor gains ApprovalRouteGate; deleteConnection and testConnection gated with @CurrentProject()
- `apps/api/src/vcs/vcs.controller.spec.ts` — the deleteConnection and testConnection cases assert the gate call; the missing-encryption-key case still answers 400 before the gate
- `apps/api/test/integration/vcs/vcs-controller.spec.ts` — the same change for its deleteConnection and testConnection cases
- `apps/api/test/integration/vcs/vcs-manual-sync.spec.ts` — provides an ApprovalRouteGate double; no assertion changes

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops DELETE /projects/:slug/tickets/:ref, DELETE /projects/:slug/labels/:id, DELETE /projects/:slug/tickets/:ref/labels/:labelId, DELETE /projects/:slug/tickets/:ref/links/:linkId
- `apps/api/src/tickets/tickets.module.ts` — imports the two modules; provides TicketRouteCommands
- `apps/api/src/tickets/tickets.controller.ts` — constructor gains ApprovalRouteGate; softDelete gated
- `apps/api/src/tickets/tickets.controller.spec.ts` — new cases for the softDelete handler assert the gate call (key, variant, project id, input) and the executed/pending mapping; its existing cases call the unchanged helper methods and stay; it provides an ApprovalRouteGate double
- `apps/api/src/labels/labels.module.ts` — imports the two modules; provides LabelRouteCommands
- `apps/api/src/labels/labels.controller.ts` — constructor gains ApprovalRouteGate; deleteFromHttp and removeLabelFromHttp gated with @CurrentProject()
- `apps/api/src/labels/labels.controller.spec.ts` — new cases for the deleteFromHttp and removeLabelFromHttp handler assert the gate call (key, variant, project id, input) and the executed/pending mapping; its existing cases call the unchanged helper methods and stay; it provides an ApprovalRouteGate double
- `apps/api/src/ticket-links/ticket-links.module.ts` — imports the two modules; provides TicketLinkRouteCommands
- `apps/api/src/ticket-links/ticket-links.controller.ts` — constructor gains ApprovalRouteGate; remove gated with @CurrentProject()
- `apps/api/src/ticket-links/ticket-links.controller.spec.ts` — the remove cases assert the gate call
- `apps/api/test/integration/approvals/approval-variants.integration.spec.ts` — its probe constant VARIANT changes from rest:labels.delete to rest:variants-probe, because LabelRouteCommands now registers label.delete#rest:labels.delete in the booted app and a second register of that pair throws; every use of VARIANT follows the constant, and no other assertion changes

**US-008**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops DELETE /comments/:id
- `apps/api/src/comments/comments.module.ts` — imports the two modules; provides CommentRouteCommands
- `apps/api/src/comments/comments.service.ts` — public resolveCommentProject
- `apps/api/src/comments/comments.service.spec.ts` — the resolveCommentProject cases
- `apps/api/src/comments/comments.controller.ts` — constructor gains ApprovalRouteGate; deleteFromHttp resolves the project, then gates
- `apps/api/src/comments/comments.controller.spec.ts` — new cases for the deleteFromHttp handler assert the gate call (key, variant, project id, input) and the executed/pending mapping; its existing cases call the unchanged helper methods and stay; it provides an ApprovalRouteGate double
- `apps/api/test/integration/permissions/core-comments-labels-watchers.integration.spec.ts` — its AC-9 (an agent with only a roster row deletes its own comment, 204) now expects 202, and after the root user approves, the comment is gone

**US-009**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops DELETE /projects/:slug/kb/documents/:sourceId
- `apps/api/src/rag/rag.module.ts` — imports the two modules; provides KbDocumentDeletion and KbRouteCommands
- `apps/api/src/rag/rag.controller.ts` — constructor gains KbDocumentDeletion and ApprovalRouteGate; deleteDocument gated (its preflight, loop and audit move to KbDocumentDeletion)
- `apps/api/src/rag/rag.controller.spec.ts` — the deleteDocument cases: the handler cases assert preflight then the gate call; the ownership, source and audit cases move to kb-document-deletion.service.spec.ts
- `apps/api/src/rag/kb-documents-membership.routes.spec.ts` — provides KbDocumentDeletion and ApprovalRouteGate doubles; no assertion changes
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — provides a KbDocumentDeletion double whose preflight answers [] (the gate double is US-005's); its kb DELETE refusal case still expects 403 and no deleteBySource
- `apps/api/test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts` — provides KbDocumentDeletion and ApprovalRouteGate doubles; no assertion changes
- `apps/api/test/integration/rag/rag-api-project-id-validation.integration.spec.ts` — provides KbDocumentDeletion and ApprovalRouteGate doubles; no assertion changes

**US-010**
- `apps/api/src/permissions/pending-gate-routes.ts` — PendingGateFeature drops 'gate-high'; isPendingGateFeature refuses it
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the stale-pending-gate-route case's literal map uses 'gate-secret' instead of 'gate-high' (the union no longer has it)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — AC-13 asserts exactly 41 gated routes
- `openapi.json` — regenerated with bun run api:export-spec from the repo root; the 29 gated operations gain a 202 response and nothing else changes
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — gatedOperations lists the 41 gated operations; its AC-4 asserts exactly those plus the reindex operation carry a 202
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the 202 cases below

### Seams

- US-001 → US-002 to US-009: `parseRouteInput` is used by every commands class; US-003 AC-15, US-007 AC-12 and US-009 AC-11 pin invalid input through a story's own command `parse`.
- 5a → US-002 to US-009: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`, `routeCommand`. Each story's first integration AC is a 202 through its route.
- US-008: `resolveCommentProject` → the comment handler. US-008 AC-3 (404 before the gate) and AC-1 (scope = the comment's project) cross it.
- US-009: `KbDocumentDeletion` → the handler and `KbRouteCommands`. US-009 AC-4 (403 before the gate) and AC-6 (the deferred run re-checks) cross it.
- US-002 to US-009 → US-010: every gated route has left the allowlist; US-010 restores the exact count and regenerates `openapi.json`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `gated-role-routes.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token;
- `seedFleetHttpAgent` gives an agent and its API key;
- `grantKeys(db, agent, keys, projectId | null)` binds keys. An agent "holding a key in project P" is bound `['project.read', <the keys>]` in P, because `ProjectMembershipGuard` (and `resolveCommentProject`) refuse a caller without `project.read` in the project; an agent's baseline role holds only `agent.read`.

"Approve" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means the response status is 202 and `data` is the pending request summary. An agent's request in these ACs waits under the catalog default (`agent`); no policy is seeded unless an AC says so.

### US-001: Route input parsing and the `gate-secret` label

- AC-1 [unit] `parseRouteInput({ projectId: 'p1', id: 'b1', extra: 1 }, ['projectId', 'id'])` answers `{ projectId: 'p1', id: 'b1' }`.
- AC-2 [unit] `parseRouteInput({ projectId: 'p1' }, ['projectId', 'id'])` throws `ValidationAppException` with key `approvals.invalidInput`.
- AC-3 [unit] `parseRouteInput({ id: '' }, ['id'])` throws the same exception.
- AC-4 [unit] `parseRouteInput(['b1'], ['id'])` throws the same exception.
- AC-5 [unit] `parseRouteInput({ id: 7 }, ['id'])` throws the same exception.
- AC-6 [unit] `SECRET_GATE_ROUTES` holds exactly `POST /fleet/enrollments`, `POST /projects/:slug/vcs`, `PATCH /projects/:slug/vcs`, `POST /projects/:slug/vcs/webhook-secret/rotate`, `POST /projects/:slug/webhooks` and `PATCH /projects/:slug/webhooks/:id`.
- AC-7 [unit] `PENDING_GATE_ROUTES.get` answers `gate-secret` for each label in `SECRET_GATE_ROUTES`.
- AC-8 [integration] Over the booted app, `PENDING_GATE_ROUTES` equals the rollout rule's map (the secret list first, then the 5a derivation), sorted by label.

### US-002: Gated budget routes

The agent holds the budget keys globally (`grantKeys(db, agent, ['fleet.budget.create', 'fleet.budget.update', 'fleet.budget.delete', 'fleet.budget.resume'], null)`) for the global routes, and in project P for the project routes. Policy bodies are the valid ones `fleet-budgets-api.integration.spec.ts` sends.

- AC-1 [integration] `POST /api/fleet/budgets` by the agent with a valid global policy body answers 202 with `data.permissionKey` `fleet.budget.create` and `data.requiredMode` `agent`.
- AC-2 [integration] After approving AC-1's request, one global policy exists and the request's `result` matches `{ scopeType: 'global' }`.
- AC-3 [integration] `PATCH /api/fleet/budgets/:id` `{ amountUsd: 42 }` on a global policy by the agent answers 202, and after approval the policy's `amountUsd` is 42.
- AC-4 [integration] `DELETE /api/fleet/budgets/:id` on a global policy by the agent answers 202, and after approval the policy no longer exists.
- AC-5 [integration] `POST /api/fleet/budgets/:id/resume` on a paused global policy by the agent answers 202, and after approval the policy is not paused.
- AC-6 [integration] `POST /api/projects/:slug/fleet/budgets` by the agent with a valid project policy body answers 202 with `data.projectId` P, and after approval a project policy for P exists.
- AC-7 [integration] `PATCH /api/projects/:slug/fleet/budgets/:id` `{ amountUsd: 42 }` on a project policy answers 202, and after approval its `amountUsd` is 42.
- AC-8 [integration] `DELETE /api/projects/:slug/fleet/budgets/:id` on a project policy answers 202, and after approval it no longer exists.
- AC-9 [integration] `POST /api/projects/:slug/fleet/budgets/:id/resume` on a paused project policy answers 202, and after approval it is not paused.
- AC-10 [integration] An approved resume of a global policy that was resumed by root while the request waited settles `failed` with `result.error` `execution-failed`.
- AC-11 [integration] `POST /api/fleet/budgets` with the root token answers 201 with the policy, and no `ApprovalRequest` row exists.
- AC-12 [integration] `DELETE /api/fleet/budgets/:id` by an agent holding no budget key answers 403 with key `permissions`, and no `ApprovalRequest` row exists.
- AC-13 [unit] After `onModuleInit`, the registry answers commands for the 8 variants in `BUDGET_ROUTE_VARIANTS`, each under the key the routes table gives it.
- AC-14 [unit] The `rest:project-fleet-budgets.delete` command's run calls `budgets.remove(<principal id>, { kind: 'project', projectId: 'p1' }, 'b1')` for input `{ projectId: 'p1', id: 'b1' }`.
- AC-15 [unit] `BudgetsModule` compiles with `GlobalStubsModule` and resolves `BudgetRouteCommands`.

### US-003: Gated fleet repo, runner and analytics routes

The agent holds the route's key globally. Repo fixtures stub the forge check as `fleet-repos.integration.spec.ts` does; analytics fixtures follow `fleet-analytics-delete.integration.spec.ts`.

- AC-1 [integration] `POST /api/fleet/repos` by the agent with a valid body answers 202 with `data.permissionKey` `fleet.repo.create`, and no repo is registered yet.
- AC-2 [integration] After approving AC-1's request (the forge check passing), the repo is registered and the request is `executed`.
- AC-3 [integration] An approved repo create whose forge check fails when the command runs settles `failed`, and no repo is registered.
- AC-4 [integration] `DELETE /api/fleet/repos/:id` by the agent answers 202, and after approval the repo is unregistered.
- AC-5 [integration] `POST /api/fleet/repos/:id/check` by the agent answers 202, and after approval the request's `result` has `repoId` the repo's id and a boolean `reachable`.
- AC-6 [integration] `PATCH /api/fleet/runners/:id` `{ enabled: false }` by the agent answers 202, and after approval the runner is disabled.
- AC-7 [integration] `DELETE /api/fleet/runners/:id` by the agent answers 202, and after approval the runner no longer exists.
- AC-8 [integration] `DELETE /api/fleet/analytics?before=<instant>` with body `{ confirm: 'ALL' }` by the agent answers 202, and after approval the analytics rows dated before the instant are gone.
- AC-9 [integration] `DELETE /api/fleet/analytics` with no `before` by the agent answers 400, and no `ApprovalRequest` row exists.
- AC-10 [integration] An approved analytics delete for one project whose `confirm` is not that project's slug settles `failed`, and the rows remain.
- AC-11 [integration] `DELETE /api/fleet/runners/:id` with the root token answers 204, and no `ApprovalRequest` row exists.
- AC-12 [unit] After `onModuleInit`, the registry answers `fleet.repo.create`, `fleet.repo.delete` and `fleet.repo.check` commands for `rest:fleet-repos.create`, `.delete` and `.check`.
- AC-13 [unit] After `onModuleInit`, the registry answers `fleet.runner.update` and `fleet.runner.delete` commands for `rest:fleet-runners.update` and `.delete`.
- AC-14 [unit] After `onModuleInit`, the registry answers a `fleet.analytics.delete` command for `rest:fleet-analytics.delete`.
- AC-15 [unit] The `rest:fleet-analytics.delete` command's `parse({ before: '2026-01-01T00:00:00Z', extra: 1 })` throws `ValidationAppException` with key `approvals.invalidInput` (no `confirm`).

### US-004: Gated schedule delete and drift checks

Schedule fixtures follow `fleet-schedules-api.integration.spec.ts`; drift fixtures follow `fleet-repo-config-api.integration.spec.ts`. The agent holds the route's key in project P.

- AC-1 [integration] `DELETE /api/projects/:slug/fleet/schedules/:id` by an agent holding `fleet.schedule.delete` in P answers 202 with `data.permissionKey` `fleet.schedule.delete` and `data.projectId` P.
- AC-2 [integration] After approving AC-1's request, the schedule no longer exists.
- AC-3 [integration] `DELETE /api/projects/:slug/fleet/schedules/:id` by an agent holding only `fleet.schedule.delete.own` in P, on a schedule another user created, answers 202, and after approval the request is `failed` and the schedule remains.
- AC-4 [integration] The same route by that `.own` agent on a schedule it created answers 202, and after approval the schedule no longer exists.
- AC-5 [integration] `DELETE /api/projects/:slug/fleet/schedules/:id` with the root token answers 204, and no `ApprovalRequest` row exists.
- AC-6 [integration] `POST /api/projects/:slug/fleet/repos/:repoId/drift-checks` by an agent holding `fleet.repo.drift.check` in P answers 202 with `data.permissionKey` `fleet.repo.drift.check`.
- AC-7 [integration] After approving AC-6's request, a `CONFIG_DRIFT` job exists for the repo and the request's `result` is what the route answers today.
- AC-8 [integration] `POST /api/projects/:slug/fleet/repos/:repoId/drift-checks` with a project member user's token answers 201 (regression pin).
- AC-9 [unit] The `rest:project-fleet-schedules.delete` command's run, for a principal whose `permissions.can(principal, 'fleet.schedule.delete', { projectId: 'p1' })` answers `{ allowed: false }`, calls `schedules.remove(<principal id>, 'p1', 's1', false)`.
- AC-10 [unit] After `onModuleInit`, the registry answers a `fleet.schedule.delete` command for `rest:project-fleet-schedules.delete` and a `fleet.repo.drift.check` command for `rest:project-repo-config.drift-check`.
- AC-11 [unit] `SchedulesModule` compiles with `GlobalStubsModule` and resolves `ScheduleRouteCommands`.

### US-005: Gated project, agent and skill-source deletes

- AC-1 [integration] `DELETE /api/projects/:slug` by an agent holding `project.delete` in P answers 202 with `data.permissionKey` `project.delete` and `data.projectId` P.
- AC-2 [integration] After AC-1 the project is not deleted, and after approving the request the project is soft-deleted.
- AC-3 [integration] `DELETE /api/projects/:slug` with the root token answers 204, and no `ApprovalRequest` row exists.
- AC-4 [integration] `DELETE /api/agents/:slug` of agent X by an agent holding global `agent.delete` answers 202, and after approval agent X's `Agent` row no longer exists (the delete is a hard delete).
- AC-5 [integration] The executed request of AC-4 has a `result` matching `{ slug: <X's slug> }`.
- AC-6 [integration] `DELETE /api/agents/:slug` with the root token answers 200, and no `ApprovalRequest` row exists.
- AC-7 [integration] `DELETE /api/admin/skills/sources/:id` by an agent holding global `skill.source.delete` answers 202, and after approval the source no longer exists.
- AC-8 [integration] An approved skill-source delete whose source was deleted by root while the request waited settles `failed`.
- AC-9 [integration] `DELETE /api/agents/:slug` by an agent holding no `agent.delete` answers 403 with key `permissions`, and no `ApprovalRequest` row exists.
- AC-10 [unit] After `onModuleInit`, the registry answers commands for `rest:projects.delete` (`project.delete`), `rest:agents.delete` (`agent.delete`) and `rest:admin-skill-sources.delete` (`skill.source.delete`).
- AC-11 [unit] The `rest:projects.delete` command's run calls `projects.softDelete('alpha')` for input `{ slug: 'alpha' }`.
- AC-12 [unit] `SkillsModule` compiles with `GlobalStubsModule` and resolves `SkillSourceRouteCommands`.
- AC-13 [unit] `PENDING_GATE_ROUTES` has no entry for `DELETE /projects/:slug`.

### US-006: Gated webhook deletes and VCS delete and test

VCS fixtures follow `vcs-permissions.integration.spec.ts` (a project with a connection and the encryption key configured); webhook fixtures follow `webhook-permissions.integration.spec.ts`.

- AC-1 [integration] `DELETE /api/projects/:slug/webhooks/:id` by an agent holding `webhook.delete` in P answers 202 with `data.permissionKey` `webhook.delete`, and after approval the webhook no longer exists.
- AC-2 [integration] `DELETE /api/projects/:slug/webhooks/:id` for a webhook of another project, by that agent, answers 202, and after approval the request is `failed` and the other project's webhook remains.
- AC-3 [integration] `DELETE /api/webhooks/:id` by an agent holding global `webhook.delete` answers 202 with `data.projectId` null, and after approval the webhook no longer exists.
- AC-4 [integration] `DELETE /api/projects/:slug/webhooks/:id` with the root token answers 204, and no `ApprovalRequest` row exists.
- AC-5 [integration] `DELETE /api/projects/:slug/vcs` by an agent holding `vcs.connection.delete` in P answers 202, and after approval the project has no VCS connection.
- AC-6 [integration] `POST /api/projects/:slug/vcs/test` by an agent holding `vcs.connection.test` in P answers 202 with `data.permissionKey` `vcs.connection.test`.
- AC-7 [integration] The pending request of AC-6 has `input` equal to `{ projectId: P }` (no encryption key or token is frozen).
- AC-8 [integration] After approving AC-6's request, it is `executed` and its `result` has the fields `TestConnectionResultDto` declares.
- AC-9 [integration] `POST /api/projects/:slug/vcs/test` with the root token answers 201 (the route has no `@HttpCode`, so Nest's POST default applies, unchanged) with the test result, and no `ApprovalRequest` row exists.
- AC-10 [unit] `VcsController.testConnection` with no encryption key configured throws `ValidationAppException` with key `vcs` and never calls `routeGate.run`.
- AC-11 [unit] The `rest:vcs.test` command's run, with `vcsConfig.encryptionKey` `'k1'`, calls `vcs.testConnection('p1', 'k1')` for input `{ projectId: 'p1' }`.
- AC-12 [unit] The `rest:vcs.test` command's run, with no encryption key configured, throws `ValidationAppException` with key `vcs`.
- AC-13 [unit] After `onModuleInit`, the registry answers `webhook.delete` commands for `rest:project-webhooks.delete` and `rest:webhooks.delete`, and `vcs.connection.delete` and `vcs.connection.test` commands for `rest:vcs.delete` and `rest:vcs.test`.
- AC-14 [unit] `VcsModule` compiles with `GlobalStubsModule` and resolves `VcsRouteCommands`.

### US-007: Gated ticket, label and link removals

The agent holds the route's key in project P.

- AC-1 [integration] `DELETE /api/projects/:slug/tickets/:ref` by an agent holding `ticket.delete` in P answers 202 with `data.permissionKey` `ticket.delete`, and the ticket is not deleted.
- AC-2 [integration] After approving AC-1's request, the ticket is soft-deleted and the request's `result` matches `{ ref: <the ref> }`.
- AC-3 [integration] `DELETE /api/projects/:slug/labels/:id` by an agent holding `label.delete` in P answers 202, and after approval the label no longer exists.
- AC-4 [integration] `DELETE /api/projects/:slug/tickets/:ref/labels/:labelId` by an agent holding `ticket.label.remove` in P answers 202, and after approval the ticket no longer carries the label.
- AC-5 [integration] `DELETE /api/projects/:slug/tickets/:ref/links/:linkId` by an agent holding `ticket.link.remove` in P answers 202, and after approval the link no longer exists.
- AC-6 [integration] `DELETE /api/projects/:slug/tickets/:ref/links/:linkId` by an agent holding only `ticket.link.remove.own` in P, on a link another user created, answers 202, and after approval the request is `failed` and the link remains.
- AC-7 [integration] `DELETE /api/projects/:slug/tickets/:ref/links/missing` by an agent holding `ticket.link.remove` answers 202, and after approval the request is `failed`.
- AC-8 [integration] `DELETE /api/projects/:slug/labels/:id` with the root token answers 204, and no `ApprovalRequest` row exists.
- AC-9 [integration] (regression pin, `core-ticket-routes.integration.spec.ts` AC-8) An agent with a Developer role is refused by `DELETE …/tickets/:ref` with 403 `permissions`, and no `ApprovalRequest` row exists.
- AC-10 [unit] After `onModuleInit`, the registry answers commands for `rest:tickets.delete` (`ticket.delete`), `rest:labels.delete` (`label.delete`), `rest:ticket-labels.remove` (`ticket.label.remove`) and `rest:ticket-links.remove` (`ticket.link.remove`).
- AC-11 [unit] The `rest:ticket-labels.remove` command's run calls `labels.removeFromTicket('alpha', 'AL-1', 'l1', <principal>)` for input `{ slug: 'alpha', ref: 'AL-1', labelId: 'l1' }`.
- AC-12 [unit] The `rest:ticket-links.remove` command's `parse({ slug: 'alpha', ref: 'AL-1' })` throws `ValidationAppException` with key `approvals.invalidInput`.

### US-008: Gated comment delete

- AC-1 [integration] `DELETE /api/comments/:id` by an agent holding `comment.delete` in P, on a comment in P, answers 202 with `data.permissionKey` `comment.delete` and `data.projectId` P.
- AC-2 [integration] After approving AC-1's request, the comment no longer exists.
- AC-3 [integration] `DELETE /api/comments/missing` by that agent answers 404 with key `comments`, and no `ApprovalRequest` row exists.
- AC-4 [integration] `DELETE /api/comments/:id` by an agent holding only `comment.delete.own` in P, on a comment another user wrote, answers 202, and after approval the request is `failed` and the comment remains.
- AC-5 [integration] `DELETE /api/comments/:id` with the root token answers 204, and no `ApprovalRequest` row exists.
- AC-6 [integration] (updated existing test, `core-comments-labels-watchers.integration.spec.ts` AC-9) An agent with only a roster row deleting its own comment answers 202, and after the root user approves, the comment is gone.
- AC-7 [unit] `resolveCommentProject(id, principal)` for a comment whose ticket is in project `p1`, with a principal the membership check admits, answers `'p1'`.
- AC-8 [unit] `resolveCommentProject` for a comment whose ticket is soft-deleted throws `NotFoundAppException` with key `comments`.
- AC-9 [unit] `resolveCommentProject` for a principal the membership check refuses with `ForbiddenAppException` throws `NotFoundAppException` with key `comments`.
- AC-10 [unit] `CommentsController.deleteFromHttp('c1', principal)` calls `routeGate.run` with `{ key: 'comment.delete', variant: 'rest:comments.delete', projectId: <resolveCommentProject's answer>, input: { id: 'c1' } }`.
- AC-11 [unit] After `onModuleInit`, the registry answers a `comment.delete` command for `rest:comments.delete`.

### US-009: Gated KB document delete

- AC-1 [integration] `DELETE /api/projects/:slug/kb/documents/:sourceId` by an agent holding `kb.document.delete` in P answers 202 with `data.permissionKey` `kb.document.delete`, and the rows remain.
- AC-2 [integration] After approving AC-1's request, the `doc` and `manual` rows of that `sourceId` are gone and the request's `result` is `{ deleted: true }`.
- AC-3 [integration] One `kb.document.delete` audit entry per deleted source is recorded by AC-2's run, with `actorType` `AGENT` and `approvalRequestId` the request.
- AC-4 [integration] The same route by an agent holding only `kb.document.delete.own`, on rows another user created, answers 403 with key `permissions`, and no `ApprovalRequest` row exists.
- AC-5 [integration] The same route for an unknown project slug answers 404 with key `rag`, and no `ApprovalRequest` row exists.
- AC-6 [integration] An approved delete by a `.own` agent whose matching rows were replaced by another user's rows while the request waited settles `failed`, and those rows remain.
- AC-7 [integration] The same route with the root token answers 200 with `{ deleted: true }`, and no `ApprovalRequest` row exists.
- AC-8 [unit] `KbDocumentDeletion.preflight` with `source` absent reads the creators of both user sources and checks each creator with `permissions.can(principal, 'kb.document.delete', { projectId, resource: { createdBy } })`.
- AC-9 [unit] `KbDocumentDeletion.delete` calls `deleteBySource` only after every preflight check passed, and never when one refuses.
- AC-10 [unit] `KbDocumentDeletion.delete` writes no audit entry for a source with no matching rows.
- AC-11 [unit] After `onModuleInit`, the registry answers a `kb.document.delete` command for `rest:kb-documents.delete`, whose `parse({ projectId: 'p1', sourceId: 's1', source: 'web' })` throws `ValidationAppException` with key `approvals.invalidInput`.

### US-010: Closing `gate-high`: contract, OpenAPI and endpoint coverage

- AC-1 [unit] No value of `PENDING_GATE_ROUTES` is `gate-high`.
- AC-2 [integration] Over the booted app, the collected routes contain exactly 41 gated routes.
- AC-3 [integration] Over the booted app, `findContractViolations` reports no violation.
- AC-4 [unit] `openapi.json`'s `delete /api/projects/{slug}` operation has a `202` response.
- AC-5 [unit] `openapi.json`'s `delete /api/fleet/budgets/{id}` operation has a `202` response.
- AC-6 [unit] `openapi.json`'s `delete /api/projects/{slug}/kb/documents/{sourceId}` operation has a `202` response.
- AC-7 [unit] `openapi.json`'s `post /api/fleet/enrollments` operation has no `202` response.
- AC-8 [unit] The operations of `openapi.json` with a `202` response are exactly the 41 gated ones plus `post /api/projects/{slug}/knowledge/repos/{repoId}/reindex`.
- AC-9 [integration] In `endpoint.e2e.spec.ts`, `DELETE /api/projects/:slug/labels/:id` with the key of an agent granted `label.delete` in the project answers exactly 202.
- AC-10 [integration] In `endpoint.e2e.spec.ts`, `DELETE /api/comments/:id` on its own comment, with the key of an agent granted `comment.delete.own` in the project, answers exactly 202.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-4 to AC-8 live in `src/approvals/approval-openapi.contract.spec.ts`.
