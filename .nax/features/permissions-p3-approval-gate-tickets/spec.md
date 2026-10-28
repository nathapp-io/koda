# SPEC: Permissions P3e-3 — Gating the Ticket, Comment, Label and Project REST Routes

## Summary

This feature routes the medium-risk REST writes of tickets, comments, labels, links, projects, members, invites and ticket watching through the route gate that `permissions-p3-approval-gate-core` (5a) shipped and `permissions-p3-approval-gate-high` (5b) applied to the high-risk keys.
- **21 routes are gated:**
  - tickets: create, update, assign, and the transitions verify, start, fix, verify-fix, close and reject;
  - comments: create on a ticket, update;
  - labels: create, update, assign to a ticket; ticket links: add;
  - projects: create, update; project members: add; project invites: cancel;
  - ticket watching: watch, unwatch.
- **Nothing waits under the shipped defaults.** Every key here is `medium` with catalog default `none`, so the gate executes at once and stores no request. A request waits only when an approval policy names the key (for example a project policy `ticket.* → agent` for agents). That is the point of the feature: any policy now applies on REST the same way it does for assistant and MCP writes.
- **Two invite routes are deferred to `gate-secret`.** `POST /projects/:slug/invites` and `POST /projects/:slug/invites/:id/resend` answer a raw invite token once (in `invitePath`), which a deferred request would store in `ApprovalRequest.result` for deciders to read. They move from `gate-core-domains` to `gate-secret`, as the 6 secret-bearing high-risk routes did.
- **Issue #346 is fixed here.** A VCS connection test approved under 5b settles `failed` when background polling writes the connection row during the provider call, because settlement compares the whole record. It now compares only what the test depends on.
- **The contract counts 62 gated routes** after this feature (41 + 21), and `openapi.json` shows `202` on each.

This is the third part of feature 5 of P3 (`p3-approval-gate`) in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). Closes #346.

## Motivation

5a gated the permission routes and 5b the high-risk ones. The medium-risk writes still bypass the engine on REST: a project owner who sets `ticket.* → agent` for agents makes the assistant and MCP tools wait, while the same agent calling `POST /projects/:slug/tickets` or `koda ticket create` writes at once. `PENDING_GATE_ROUTES` lists 48 such routes under `gate-core-domains`.

**Rulings that bind this feature** (user):
- 2026-10-26 and 2026-10-28 (as in 5a and 5b): every approvable REST write route is gated, split by risk; the deferred run is the command registry; a human acting directly satisfies any mode; secret-bearing routes are deferred to `gate-secret`.
- 2026-10-28: the 48 `gate-core-domains` routes are split in two features. This one (5c-1) takes tickets, comments, labels, links, projects, members, invites and watching. 5c-2 takes agents, admin users, skill sources, project skills, memory, KB, context, code-intel, VCS sync and the outbox retry.
- 2026-10-28: #346 is bundled into this spec.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The two token-answering invite routes are `gate-secret`.** This applies the 5b ruling ("a route whose answer is a token or secret shown once") to `POST /projects/:slug/invites` (its `INVITED` outcome carries `invitePath` with the raw token) and `POST /projects/:slug/invites/:id/resend` (it rotates the token and answers it). `DELETE /projects/:slug/invites/:id` answers nothing secret and is gated here.
- **Request checks the handler makes before its service call stay before the gate**, so they answer as today and open no request:
  - the comment-body check of verify, fix, verify-fix, close and reject (`requireCommentBody`, 400 `tickets`);
  - the comment's project lookup of `PATCH /comments/:id` (`resolveCommentProject`, 404 `comments`), which the gate needs for its scope;
  - the user-only check of watch and unwatch (`caller(principal)`, 403 `notifications`).

  Every check inside a service (edge keys, transitions, conflicts, row ownership) runs when the command runs, at once or after approval; a failing check settles the request `failed`. This is 5a's rule. Under a policy, an edge-key refusal or an invalid transition therefore answers 202 first and fails at execution.
- **verify-fix gates the key its `approve` flag needs.** The route accepts either verify-fix key (`mode: 'any'`). The handler gates `ticket.transition.verify-fix.approve` when `approve` is `true` (or `'true'`) and `ticket.transition.verify-fix.return` otherwise. Each key registers its own command under the same variant `rest:tickets.verify-fix`; the `.approve` command calls `verifyFix(…, true, …)` and the `.return` command `verifyFix(…, false, …)`, so the input carries no flag. A caller holding only the other key gets 403 `permissions` from the route gate (today the service's edge check answers the same 403).
- **A transition command answers the ticket.** The services answer `{ ticket, comment?, activity }`; the handler answers `result.ticket`. The command's run answers `result.ticket`, so `ApprovalRequest.result` and the executed body are the ticket the route answers today.
- **The link command keeps the 200/201 split.** `TicketLinksService.create` answers `{ status, link }` (200 for an existing link). The run answers that pair; on `executed` the handler sets `res.statusCode` to 200 when `status` is 200 and answers `link`, as today. `toResult` stores `link`.
- **Watch keeps its user-only rule in both places.** The handler checks `caller(principal)` before the gate; the command's run refuses a principal that is not a user with `ForbiddenAppException({}, 'notifications')` and calls the service with the user's id. An agent can never reach a watch request, and a user acting directly always executes, so these two routes never answer 202 in practice. They are gated so the contract has no approvable write route outside the engine.
- **The project create command takes the body only.** `POST /projects` is global (`projectId: null`) and its service takes no principal.
- **The frozen input is ids, slugs and the validated body.** An input never carries a request header or config. `DELETE /projects/:slug/invites/:id` has no `Accept-Language` dependency, so nothing is lost.
- **Each gating story removes its own `PENDING_GATE_ROUTES` rows**, as in 5b. US-001 relaxes the exact gated-route count to a lower bound (at least 41), and US-011 restores an exact count (62).
- **#346: settlement compares the tested target.** `prepareTestConnection` snapshots `{ id, provider, repoOwner, repoName, encryptedToken }` of the connection it tested, and settlement compares the same snapshot of the re-read row with `isDeepStrictEqual`. A missing row, a replaced row (new `id`), or a change to any of those fields throws `ValidationAppException({}, 'vcs')` as today. Changes to `lastSyncedAt`, `updatedAt`, `syncMode`, `pollingIntervalMs`, `allowedAuthors`, `webhookSecret` and `isActive` no longer fail it.
- **Only the HTTP handlers change**, as in 5b. The controllers' helper methods (`createTicket`, `updateTicket`, `assignTicket`, `verifyTicket`, …, `CommentsController.create`/`update`, `LabelsController.create`/`update`/`assignLabel`) and their spec cases stay.
- **Gated handlers keep their existing parameters, in order.** Unlike 5b, a handler keeps a `@Principal()` parameter it no longer reads (oxlint's `no-unused-vars` is off). A handler that needs the project and has no `@CurrentProject()` today appends `@CurrentProject() project: ProjectContext` as its last parameter: comments `createFromHttp`; labels `createFromHttp`, `updateFromHttp`, `assignLabelFromHttp`; projects `update`; members `add`; invites `cancel`. Ticket links `create` ends with the optional `@Res() res?`, so its `project` parameter goes before `res`, and its spec cases pass a project (US-007 Modifies). Route parameters always stay declared, so the OpenAPI document keeps every path parameter.
- **The gate key is the route's key, not the ticket's edge key.** Two inputs move a ticket along an edge another route owns: `PATCH …/tickets/:ref` with a `status` (gated under `ticket.update`; the service then checks the edge key), and `POST …/verify` on a VERIFY_FIX ticket (gated under `ticket.transition.verify`; the service closes it through the `verify-fix.approve` edge). A policy on the edge's key does not make these two wait; a policy on the route's key does. Gating them by the effective edge would need the ticket read before the gate and is out of scope.
- **`creatorRef` moves to its own file.** The private `creatorRef` of `ticket-links.controller.ts` moves unchanged to `ticket-links/creator-ref.ts` (exported); the controller and `TicketLinkRouteCommands` import it there. Importing it from the controller would make the commands file and the controller import each other.
- **`userOf` is the commands file's own guard.** `ticket-watch-route.commands.ts` defines `userOf(principal: UserPrincipal | AgentPrincipal): UserPrincipal`, which throws `ForbiddenAppException({}, 'notifications')` for an agent principal (the controller's private `caller` rule).
- **A test helper seeds the wait.** `seedWaitPolicy(db, key, projectId)` (in `approvals/test-helpers/approval-fixtures.ts`) upserts, on `selector`, the `ApprovalPolicy` row `{ selector: '<projectId|*>|<key>|type:AGENT', projectId, permissionPattern: key, principalType: 'AGENT', mode: 'agent', updatedByType: 'SYSTEM', updatedById: 'test' }` (the shape `assistant-direct-action.integration.spec.ts` writes inline) and answers `{ id }`. `selector` is unique, so an upsert lets two tests of one file seed the same key. The resolver reads policies per request (no cache), so no invalidation is needed.
- **Policy lifecycle in tests.** Each new integration file deletes every `ApprovalPolicy` row in `beforeEach` (with the request and decision rows), so an AC with no policy runs with none. The two `endpoint.e2e.spec.ts` cases (US-011) delete their policy row in a `finally`, as 5b's e2e case does, because that file is one sequential lifecycle and its later `POST …/labels` case expects 201.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `SECRET_GATE_ROUTES` | `permissions/pending-gate-routes.ts` | gains the 2 invite labels (8 in all) |
| `seedWaitPolicy(db, key, projectId)` | `approvals/test-helpers/approval-fixtures.ts` | upserts the agent wait policy row, answers `{ id }` |
| `creatorRef(principal)` | `ticket-links/creator-ref.ts` | moved from the controller, exported |
| `userOf(principal)` | `notifications/ticket-watch-route.commands.ts` | the user principal, or 403 `notifications` |
| `vcsTestTarget(connection)` | `vcs/vcs-connection.service.ts` (module function, exported; not the private method `testTarget`, which runs the provider call) | `{ id, provider, repoOwner, repoName, encryptedToken }` |
| `TicketRouteCommands`, `TICKET_ROUTE_VARIANTS` | `tickets/ticket-route.commands.ts` | gains create, update, assign, verify, start, fix, verifyFix, close, reject |
| `CommentRouteCommands`, `COMMENT_ROUTE_VARIANTS` | `comments/comment-route.commands.ts` | gains create, update |
| `LabelRouteCommands`, `LABEL_ROUTE_VARIANTS` | `labels/label-route.commands.ts` | gains create, update, assign |
| `TicketLinkRouteCommands`, `TICKET_LINK_ROUTE_VARIANTS` | `ticket-links/ticket-link-route.commands.ts` | gains add |
| `ProjectRouteCommands`, `PROJECT_ROUTE_VARIANTS` | `projects/project-route.commands.ts` | gains create, update |
| `MemberRouteCommands`, `MEMBER_ROUTE_VARIANTS` | `projects/members/member-route.commands.ts` | new |
| `InviteRouteCommands`, `INVITE_ROUTE_VARIANTS` | `projects/invites/invite-route.commands.ts` | new |
| `TicketWatchRouteCommands`, `TICKET_WATCH_ROUTE_VARIANTS` | `notifications/ticket-watch-route.commands.ts` | new |

### The gated routes

Each row is one `routeCommand`. "Scope" is the `projectId` passed to `ApprovalRouteGate.run` (`null` = global; "project" = `@CurrentProject()`'s id). The run calls the service the handler calls today, with `principal` the rebuilt `UserPrincipal | AgentPrincipal`. Every body-returning command declares `toResult: (result) => result` unless the row says otherwise; a no-body command declares none. On `executed` the handler answers `JsonResponse.Ok(outcome.result)` with the route's status, as today.

| Story | Route | Key | Scope | Variant | Input | Run |
|:--|:--|:--|:--|:--|:--|:--|
| US-003 | `POST /projects/:slug/tickets` | `ticket.create` | project | `rest:tickets.create` | `{ slug, ticket: parseBody(CreateTicketDto, …) }` | `tickets.create(slug, ticket, principal)` |
| US-003 | `PATCH /projects/:slug/tickets/:ref` | `ticket.update` | project | `rest:tickets.update` | `{ slug, ref, patch: parseBody(UpdateTicketDto, …) }` | `tickets.update(slug, ref, patch, principal)` |
| US-003 | `POST /projects/:slug/tickets/:ref/assign` | `ticket.assign` | project | `rest:tickets.assign` | `{ slug, ref, assignee: parseBody(AssignTicketDto, …) }` | `tickets.assign(slug, ref, assignee, principal)` |
| US-004 | `POST /projects/:slug/tickets/:ref/verify` | `ticket.transition.verify` | project | `rest:tickets.verify` | `{ slug, ref, body }` | `(await transitions.verify(slug, ref, body, principal)).ticket` |
| US-004 | `POST /projects/:slug/tickets/:ref/start` | `ticket.transition.start` | project | `rest:tickets.start` | `{ slug, ref }` | `(await transitions.start(slug, ref, principal)).ticket` |
| US-004 | `POST /projects/:slug/tickets/:ref/fix` | `ticket.transition.fix` | project | `rest:tickets.fix` | `{ slug, ref, body }` | `(await transitions.fix(slug, ref, body, principal)).ticket` |
| US-005 | `POST /projects/:slug/tickets/:ref/verify-fix` | `ticket.transition.verify-fix.approve` (when `approve`) | project | `rest:tickets.verify-fix` | `{ slug, ref, body }` | `(await transitions.verifyFix(slug, ref, body, true, principal)).ticket` |
| US-005 | (same route) | `ticket.transition.verify-fix.return` (otherwise) | project | `rest:tickets.verify-fix` | `{ slug, ref, body }` | `(await transitions.verifyFix(slug, ref, body, false, principal)).ticket` |
| US-005 | `POST /projects/:slug/tickets/:ref/close` | `ticket.transition.close` | project | `rest:tickets.close` | `{ slug, ref, body }` | `(await transitions.close(slug, ref, body, principal)).ticket` |
| US-005 | `POST /projects/:slug/tickets/:ref/reject` | `ticket.transition.reject` | project | `rest:tickets.reject` | `{ slug, ref, body }` | `(await transitions.reject(slug, ref, body, principal)).ticket` |
| US-006 | `POST /projects/:slug/tickets/:ref/comments` | `comment.create` | project | `rest:comments.create` | `{ slug, ref, comment: parseBody(CreateCommentDto, …) }` | `comments.create(slug, ref, comment, principal)` |
| US-006 | `PATCH /comments/:id` | `comment.update` | the comment's project (`resolveCommentProject`) | `rest:comments.update` | `{ id, patch: parseBody(UpdateCommentDto, …) }` | `comments.update(id, patch, principal)` |
| US-007 | `POST /projects/:slug/labels` | `label.create` | project | `rest:labels.create` | `{ slug, label: parseBody(CreateLabelDto, …) }` | `labels.create(slug, label, principal)` |
| US-007 | `PATCH /projects/:slug/labels/:id` | `label.update` | project | `rest:labels.update` | `{ slug, id, patch: parseBody(UpdateLabelDto, …) }` | `labels.update(slug, id, patch, principal)` |
| US-007 | `POST /projects/:slug/tickets/:ref/labels` | `ticket.label.assign` | project | `rest:ticket-labels.assign` | `{ slug, ref, assignment: parseBody(AssignLabelDto, …) }` | `labels.assignToTicket(slug, ref, assignment, principal)` |
| US-007 | `POST /projects/:slug/tickets/:ref/links` | `ticket.link.add` | project | `rest:ticket-links.add` | `{ slug, ref, link: parseBody(CreateTicketLinkDto, …) }` | `ticketLinks.create(slug, ref, link, creatorRef(principal))`, answering `{ status, link }`; `toResult: (r) => r.link` |
| US-008 | `POST /projects` | `project.create` | null | `rest:projects.create` | `parseBody(CreateProjectDto, input)` | `projects.create(dto)` |
| US-008 | `PATCH /projects/:slug` | `project.update` | project | `rest:projects.update` | `{ slug, patch: parseBody(UpdateProjectDto, …) }` | `projects.update(slug, patch)` |
| US-009 | `POST /projects/:slug/members` | `member.add` | project | `rest:project-members.add` | `{ slug, member: parseBody(AddMemberDto, …) }` | `members.add(slug, member, principal)` |
| US-009 | `DELETE /projects/:slug/invites/:id` | `invite.cancel` | project | `rest:project-invites.cancel` | `{ slug, id }` | `invites.cancel(slug, id, principal)`, answering `null` (no `toResult`); the handler answers `JsonResponse.Ok({})` on `executed`, as today |
| US-010 | `PUT /projects/:slug/tickets/:ref/watch` | `ticket.watch.set` | project | `rest:ticket-watch.set` | `{ projectId, ref }` | `watch.watch(projectId, ref, userOf(principal).id)` |
| US-010 | `DELETE /projects/:slug/tickets/:ref/watch` | `ticket.watch.unset` | project | `rest:ticket-watch.unset` | `{ projectId, ref }` | `watch.unwatch(projectId, ref, userOf(principal).id)` |

- Id and string members are read with `parseRouteInput` (5b). A body member is read with `parseBody` of the route's DTO; a missing body member is parsed as `{}`. The transition `body` member is a required non-empty string (`parseRouteInput(input, ['slug', 'ref', 'body'])`).
- The comment update handler calls `resolveCommentProject(id, principal)` first, then gates with `projectId` its answer (as the 5b delete handler does). `comment.update` is ownable, so the route gate accepts `comment.update.own`; the row-level check runs in the service.
- The verify-fix handler validates the body, reads `approve` as today, then gates `{ key: approve ? '…verify-fix.approve' : '…verify-fix.return', variant: 'rest:tickets.verify-fix', projectId, input: { slug, ref, body } }`.

### Module wiring

| Story | Module | Gains | Controllers whose constructor gains `ApprovalRouteGate` |
|:--|:--|:--|:--|
| US-003–005 | `TicketsModule` | `TicketRouteCommands` also injects `TicketTransitionsService` | none (it has the gate since 5b) |
| US-006 | `CommentsModule` | — | none |
| US-007 | `LabelsModule`, `TicketLinksModule` | — | none |
| US-008 | `ProjectsModule` | — | none |
| US-009 | `ProjectMembersModule` | imports `ApprovalEngineModule`, `AuthRepositoryModule`; provides `MemberRouteCommands` | `ProjectMembersController` |
| US-009 | `ProjectInvitesModule` | the same; provides `InviteRouteCommands` | `ProjectInvitesController` |
| US-010 | `NotificationsModule` | imports `AuthRepositoryModule` (it already imports `ApprovalEngineModule`); provides `TicketWatchRouteCommands` | `TicketWatchController` |

`AuthRepositoryModule` imports only `PrismaModule`, so no module cycle is added. Each gated handler gains `@ApprovalGated()`, keeps its `@Requires` and `@ApiResponse`s, and has the 5a shape:

```ts
const outcome = await this.routeGate.run<TicketResponseDto>({ key: 'ticket.create', variant: TICKET_ROUTE_VARIANTS.create, projectId: project.project.id, input: { slug, ticket: dto } });
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return JsonResponse.Ok(outcome.result);
```

### The allowlist (US-001, US-011)

- US-001: `SECRET_GATE_ROUTES` gains `POST /projects/:slug/invites` and `POST /projects/:slug/invites/:id/resend`, and their `PENDING_GATE_ROUTES` rows are relabelled `gate-secret`. The rollout rule in `expectedPendingGateRoutes` already checks `SECRET_GATE_ROUTES` first, so it needs no change.
- US-003 to US-010: each drops its gated routes' rows.
- US-011: the allowlist holds 25 `gate-core-domains`, 36 `gate-fleet` and 8 `gate-secret` rows.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| An agent under no policy (the shipped default) | Executes at once, no `ApprovalRequest` row | US-003 |
| Agent without the route's key (or `.own` form) | 403 `permissions`, from the guard or the route gate; no request | US-005, US-006 |
| An approved member add whose role grants keys the requester lacks | Request `failed` (the service's escalation check); no binding | US-009 |
| An approved cancel of an invite that was accepted or cancelled meanwhile | Request `failed` | US-009 |
| An approved label update of a label that belongs to another project | Request `failed` (the service's project check); the label is unchanged | US-007 |
| Transition with a blank body | 400 `tickets` before the gate; no request | US-004, US-005 |
| An approved write the service refuses when it runs (edge key missing, invalid transition, duplicate slug, a deleted ticket, someone else's comment for a `.own` holder) | Request `failed`, `{ error: 'execution-failed', name }` | US-003, US-004, US-006, US-007, US-008 |
| Comment update on a missing comment or by a non-member | 404 `comments` before the gate; no request | US-006 |
| Watch or unwatch by an agent | 403 `notifications` before the gate; no request | US-010 |
| VCS test whose connection row only had polling metadata written during the provider call | Settles with the provider's result (#346) | US-002 |
| VCS test whose target, token or row identity changed during the provider call | `ValidationAppException` `vcs`, as today | US-002 |
| An approvable write route that is neither gated nor allowlisted | Contract test fails (5a) | US-011 |

### Integration

**Read-only, verified:**
- `ApprovalRouteGate.run({ key, variant, projectId, input, keyCheck? })`, `ApprovalPending`, `@ApprovalGated()`, `routeCommand(spec, loader)` (with `toResult`), `parseBody`, `parseRouteInput` (5a, 5b).
- `ApprovalGate.gate`: under a `none` mode (no policy for these keys) the command executes at once and no request row is written; a USER actor executes at once under any mode.
- `ApprovalPolicyResolver.resolve` reads `ApprovalPolicy` candidates per call through its repository; `policySelector` gives `<projectId|*>|<pattern>|type:<TYPE>`.
- `TicketsService.create(slug, dto, principal)`, `.update(slug, ref, dto, principal)`, `.assign(slug, ref, input, principal?)`.
- `TicketTransitionsService.verify/fix/close/reject(slug, ref, body, principal)`, `.start(slug, ref, principal)`, `.verifyFix(slug, ref, body, approve, principal)`, each answering `{ ticket, … }`.
- `CommentsService.create(slug, ref, dto, principal)`, `.update(id, dto, principal)`, `.resolveCommentProject(id, principal)` (5b).
- `LabelsService.create(slug, dto, principal)`, `.update(slug, id, dto, principal)`, `.assignToTicket(slug, ref, dto, principal)`; `TicketLinksService.create(slug, ref, dto, creator)` answering `{ status, link }`.
- `ProjectsService.create(dto)`, `.update(slug, dto)`; `ProjectMembersService.add(slug, dto, principal)`; `ProjectInvitesService.cancel(slug, id, principal)`; `TicketWatchService.watch/unwatch(projectId, ref, userId)`.
- `VcsConnectionService.prepareTestConnection(projectId, encryptionKey)`, `testTarget`, `VcsRepository.findVcsConnectionByProjectId`; `GitHubProvider.prototype.testConnection` (the stub point of `gated-webhook-vcs-routes.integration.spec.ts`).
- Test helpers: `grantKeys`, `grantRole`, `seedFleetHttpWorld`, `seedFleetHttpAgent`, `bootHttpApp`, `data`, `resetThrottle`, `fixtureDb`, `GlobalStubsModule`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `SECRET_GATE_ROUTES` | 6 labels | 8 labels |
| `PENDING_GATE_ROUTES` | 48 `gate-core-domains`, 6 `gate-secret` | 25 `gate-core-domains`, 8 `gate-secret` |
| `prepareTestConnection` settlement | `isDeepStrictEqual(current, connection)` | `isDeepStrictEqual(current && vcsTestTarget(current), vcsTestTarget(connection))` |
| the 21 handlers | call the service | run the route gate |
| 3 controllers' constructors | no gate | gain `ApprovalRouteGate` |
| `creatorRef` | private function in `ticket-links.controller.ts` | exported from `ticket-links/creator-ref.ts`, unchanged |

## Out of Scope

- The other 25 `gate-core-domains` routes (5c-2) and the 36 `gate-fleet` routes (5d).
- Gating the 8 `gate-secret` routes, including the two invite routes moved here.
- Changing any catalog default: these keys stay `none`.
- Running a service's domain checks before a request opens, beyond the handler checks listed in Design.
- Assistant or MCP writes on these keys: they keep their primary command.
- Any change to `apps/web` or `apps/cli`.
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`.
- Gating `PATCH /projects/:slug/tickets/:ref` with a `status`, or `POST /projects/:slug/tickets/:ref/verify` on a VERIFY_FIX ticket, under the key of the edge the service takes: both are gated under the route's own key (Design).
- US-007 only: an approved assignment of another project's label to a ticket; the service's project check refuses it at execution as it does today, and no AC pins it.
- US-002 only: changing what `testTarget` checks, or moving the provider call inside the approval transaction.
- `endpoint.e2e.spec.ts` coverage for every gated route: US-011 adds two representative 202 cases.
- US-010 only: a 202 path for watch and unwatch, which no caller can reach (an agent is refused first, a user executes at once); their `openapi.json` operations still list `202`, as every gated route does.

## Stories

1. **US-001: The invite routes join `gate-secret`, and the wait-policy helper** — `Workdir: apps/api` — No dependencies.
2. **US-002: VCS test settlement compares the tested target (#346)** — `Workdir: apps/api` — No dependencies.
3. **US-003: Gated ticket create, update and assign** — `Workdir: apps/api` — Depends on US-001.
4. **US-004: Gated ticket verify, start and fix** — `Workdir: apps/api` — Depends on US-003 (same controller and commands class).
5. **US-005: Gated ticket verify-fix, close and reject** — `Workdir: apps/api` — Depends on US-004 (same files).
6. **US-006: Gated comment create and update** — `Workdir: apps/api` — Depends on US-001.
7. **US-007: Gated label create, update and assign, and ticket link add** — `Workdir: apps/api` — Depends on US-001.
8. **US-008: Gated project create and update** — `Workdir: apps/api` — Depends on US-001.
9. **US-009: Gated member add and invite cancel** — `Workdir: apps/api` — Depends on US-001.
10. **US-010: Gated ticket watch and unwatch** — `Workdir: apps/api` — Depends on US-001.
11. **US-011: Contract, OpenAPI and endpoint coverage** — `Workdir: apps/api` — Depends on US-002, US-005, US-006, US-007, US-008, US-009, US-010.

### Context Files

**US-001**
- `apps/api/src/permissions/pending-gate-routes.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/test/integration/fleet/assistant-direct-action.integration.spec.ts`

**US-002**
- `apps/api/src/vcs/vcs-connection.service.ts`
- `apps/api/src/vcs/vcs-route.commands.ts`

**US-003**
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/test/integration/tickets/gated-ticket-routes.integration.spec.ts`

**US-004**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/test/integration/tickets/gated-ticket-routes.integration.spec.ts`

**US-005**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/test/integration/tickets/gated-ticket-routes.integration.spec.ts`

**US-006**
- `apps/api/src/comments/comments.service.ts`
- `apps/api/test/integration/tickets/gated-ticket-routes.integration.spec.ts`

**US-007**
- `apps/api/src/labels/labels.service.ts`
- `apps/api/src/ticket-links/ticket-links.service.ts`
- `apps/api/test/integration/tickets/gated-ticket-routes.integration.spec.ts`

**US-008**
- `apps/api/src/projects/projects.service.ts`
- `apps/api/test/integration/permissions/gated-admin-delete-routes.integration.spec.ts`

**US-009**
- `apps/api/src/projects/members/project-members.service.ts`
- `apps/api/src/projects/invites/project-invites.service.ts`
- `apps/api/src/tickets/ticket-route.commands.ts`

**US-010**
- `apps/api/src/notifications/ticket-watch.service.ts`
- `apps/api/src/tickets/ticket-route.commands.ts`

**US-011**
- `apps/api/scripts/export-spec.cjs`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`

### Creates

**US-001**
- `apps/api/test/integration/approvals/seed-wait-policy.integration.spec.ts`

**US-002**

None: US-002 only changes existing files.

**US-003**
- `apps/api/test/integration/tickets/gated-ticket-write-routes.integration.spec.ts`

**US-004**
- `apps/api/test/integration/tickets/gated-ticket-transition-routes.integration.spec.ts`

**US-005**
- `apps/api/test/integration/tickets/gated-ticket-review-routes.integration.spec.ts`

**US-006**
- `apps/api/test/integration/comments/gated-comment-write-routes.integration.spec.ts`

**US-007**
- `apps/api/src/ticket-links/creator-ref.ts`
- `apps/api/src/ticket-links/creator-ref.spec.ts`
- `apps/api/test/integration/tickets/gated-label-link-routes.integration.spec.ts`

**US-008**
- `apps/api/test/integration/projects/gated-project-routes.integration.spec.ts`

**US-009**
- `apps/api/src/projects/members/member-route.commands.ts`
- `apps/api/src/projects/members/member-route.commands.spec.ts`
- `apps/api/src/projects/invites/invite-route.commands.ts`
- `apps/api/src/projects/invites/invite-route.commands.spec.ts`
- `apps/api/test/integration/projects/gated-member-invite-routes.integration.spec.ts`

**US-010**
- `apps/api/src/notifications/ticket-watch-route.commands.ts`
- `apps/api/src/notifications/ticket-watch-route.commands.spec.ts`
- `apps/api/test/integration/notifications/gated-ticket-watch-routes.integration.spec.ts`

**US-011**

None: US-011 only changes existing files.

### Modifies

Controller unit specs: a gated handler's cases assert the `ApprovalRouteGate.run` call and the executed/pending mapping (their gate double answers `{ status: 'executed', result }`), and the service call each one asserted moves to the story's commands spec. A spec that only builds the controller adds an `ApprovalRouteGate` provider double (`{ run: vi.fn() }`) and changes no assertion. Handlers keep their parameter lists, so no call shifts its arguments. No existing integration or e2e test has an agent write on these routes under a policy for the key, so none changes behaviour (the policies tests seed for `comment.create` are exercised through MCP only).

**US-001**
- `apps/api/src/permissions/pending-gate-routes.ts` — SECRET_GATE_ROUTES gains the two invite labels; their rows are relabelled gate-secret
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the SECRET_GATE_ROUTES case lists 8 labels
- `apps/api/src/approvals/test-helpers/approval-fixtures.ts` — seedWaitPolicy
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the "collects exactly 41 gated routes" case becomes "at least 41" (its title follows); US-011 restores an exact count

**US-002**
- `apps/api/src/vcs/vcs-connection.service.ts` — vcsTestTarget; settlement compares the snapshots
- `apps/api/src/vcs/vcs-connection.service.spec.ts` — the settlement cases below; the existing repoName-changed case stays
- `apps/api/test/integration/webhook/gated-webhook-vcs-routes.integration.spec.ts` — the polling-write regression case

**US-003**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/tickets, PATCH /projects/:slug/tickets/:ref, POST /projects/:slug/tickets/:ref/assign
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — its AC-11 (POST /projects/:slug/tickets is gate-core-domains) now asserts POST /memory is gate-core-domains
- `apps/api/src/tickets/ticket-route.commands.ts` — create, update, assign commands
- `apps/api/src/tickets/ticket-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/tickets/tickets.controller.ts` — create, update, assign gated
- `apps/api/src/tickets/tickets.controller.spec.ts` — the three controller.assign handler cases (about lines 526, 535, 545) assert the gate call; new cases for create and update; helper-method cases stay

**US-004**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the verify, start and fix rows
- `apps/api/src/tickets/ticket-route.commands.ts` — constructor gains TicketTransitionsService (after TicketsService); verify, start, fix commands
- `apps/api/src/tickets/ticket-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/tickets/tickets.controller.ts` — verify, start, fix gated after the body check
- `apps/api/src/tickets/tickets.controller.spec.ts` — the controller.start cases (about lines 601 and 659) and the controller.verify case (about line 646) assert the gate call

**US-005**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the verify-fix, close and reject rows
- `apps/api/src/tickets/ticket-route.commands.ts` — verify-fix (two keys), close, reject commands
- `apps/api/src/tickets/ticket-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/tickets/tickets.controller.ts` — verifyFix, close, reject gated after the body check
- `apps/api/src/tickets/tickets.controller.spec.ts` — the controller.close cases with a body (about lines 673, 681, 703) assert the gate call; the blank-body cases (verifyFix about line 636, close about lines 687 and 696) still throw before the gate and stay

**US-006**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/tickets/:ref/comments and PATCH /comments/:id
- `apps/api/src/comments/comment-route.commands.ts` — create, update commands
- `apps/api/src/comments/comment-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/comments/comments.controller.ts` — createFromHttp gated; updateFromHttp resolves the project, then gates
- `apps/api/src/comments/comments.controller.spec.ts` — new cases for createFromHttp and updateFromHttp; helper-method cases stay

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/labels, PATCH /projects/:slug/labels/:id, POST /projects/:slug/tickets/:ref/labels, POST /projects/:slug/tickets/:ref/links
- `apps/api/src/labels/label-route.commands.ts` — create, update, assign commands
- `apps/api/src/labels/label-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/labels/labels.controller.ts` — createFromHttp, updateFromHttp, assignLabelFromHttp gated
- `apps/api/src/labels/labels.controller.spec.ts` — new cases for the three handlers; helper-method cases stay
- `apps/api/src/ticket-links/ticket-link-route.commands.ts` — add command
- `apps/api/src/ticket-links/ticket-link-route.commands.spec.ts` — the new registration and run
- `apps/api/src/ticket-links/ticket-links.controller.ts` — creatorRef moves out to creator-ref.ts; create gated; the 200 status mapping reads the executed result
- `apps/api/src/ticket-links/ticket-links.controller.spec.ts` — the create cases (about lines 116-155) pass a project before `res`, assert the gate call and the 200/201 mapping; their service-call expectations move to the commands spec

**US-008**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects and PATCH /projects/:slug
- `apps/api/src/projects/project-route.commands.ts` — create, update commands
- `apps/api/src/projects/project-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/projects/projects.controller.ts` — create and update gated (update with @CurrentProject())
- `apps/api/src/projects/projects.controller.spec.ts` — the create (about line 175) and update (about line 257) cases assert the gate call instead of the service call
- `apps/api/src/projects/projects-brief.routes.spec.ts` — its ApprovalRouteGate double (about line 109) executes the real write: for variant rest:projects.update it calls ProjectsService.update(input.slug, input.patch) and answers { status: 'executed', result }, so the brief echo, stored-row and follow-up GET cases keep their assertions
- `apps/api/test/unit/projects/projects-conflict-responses.spec.ts` — its ApprovalRouteGate double (about line 99) executes the real write: rest:projects.create calls ProjectsService.create(input), rest:projects.update calls ProjectsService.update(input.slug, input.patch), each answering { status: 'executed', result } and letting a thrown exception propagate, so its 201/200/404/409 cases keep their assertions

**US-009**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/members and DELETE /projects/:slug/invites/:id
- `apps/api/src/projects/members/project-members.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides MemberRouteCommands
- `apps/api/src/projects/members/project-members.module.spec.ts` — its testing module imports GlobalStubsModule in place of the hand-rolled FakeGlobalsModule (GlobalStubsModule provides every stand-in it had, plus OutboxService, AfterCommitService and FLEET_CFG the engine needs); it also resolves MemberRouteCommands
- `apps/api/src/projects/members/project-members.controller.ts` — constructor gains ApprovalRouteGate; add gated
- `apps/api/src/projects/members/project-members.controller.spec.ts` — provides an ApprovalRouteGate double; the add cases assert the gate call
- `apps/api/src/projects/invites/project-invites.module.ts` — imports the two modules; provides InviteRouteCommands
- `apps/api/src/projects/invites/project-invites.module.spec.ts` — the module also resolves InviteRouteCommands
- `apps/api/src/projects/invites/project-invites.controller.ts` — constructor gains ApprovalRouteGate; cancel gated
- `apps/api/src/projects/invites/project-invites.controller.spec.ts` — provides an ApprovalRouteGate double; the cancel case (about line 57) asserts the gate call; the create case stays

**US-010**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PUT and DELETE /projects/:slug/tickets/:ref/watch
- `apps/api/src/notifications/notifications.module.ts` — imports AuthRepositoryModule; provides TicketWatchRouteCommands
- `apps/api/src/notifications/notifications.module.spec.ts` — the module also resolves TicketWatchRouteCommands
- `apps/api/src/notifications/ticket-watch.controller.ts` — constructor gains ApprovalRouteGate; watch and unwatch gated after caller()
- `apps/api/src/notifications/ticket-watch.controller.spec.ts` — provides an ApprovalRouteGate double; the user watch and unwatch cases (about lines 29-31) assert the gate call; the agent-refused case still throws before the gate

**US-011**
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — asserts exactly 62 gated routes (title updated)
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the allowlist counts per feature
- `openapi.json` — regenerated with bun run api:export-spec from the repo root; the 21 gated operations gain a 202 response
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — gatedOperations lists the 62 gated operations; its 202-set case asserts exactly those plus the reindex operation
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the two 202 cases below

### Seams

- US-001 → US-003 to US-009: `seedWaitPolicy` makes each story's 202 path reachable; each of those stories' first integration AC is a 202 under it. US-010 uses it to show an agent is refused first.
- 5a/5b → US-003 to US-010: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`, `routeCommand`, `parseRouteInput`, `resolveCommentProject`.
- US-003 → US-004 → US-005: one commands class and one controller; US-004 adds the `TicketTransitionsService` injection US-005 uses.
- US-002: `vcsTestTarget` → `prepareTestConnection` settlement → the 5b `rest:vcs.test` command; US-002 AC-5 crosses all three.
- US-007: `creatorRef` → the controller and `TicketLinkRouteCommands`; US-007 AC-6 (the link's creator is the agent) crosses it.
- US-003 to US-010 → US-011: every gated route has left the allowlist; US-011 restores the exact count and regenerates `openapi.json`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `gated-ticket-routes.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token and the users `dev` (developer on project `web`), `viewer` and `outsider`; `seedFleetHttpAgent` gives an agent and its API key;
- an agent "holding a key in project P" is bound `['project.read', <the keys>]` in P with `grantKeys`, followed by `PermissionCache.invalidate()`;
- "under a wait policy" means `seedWaitPolicy(db, <the route's key>, P)` (or `null` for a global key) ran in that test; each file deletes every `ApprovalPolicy`, `ApprovalDecision` and `ApprovalRequest` row in `beforeEach`.

Each AC is its own test with its own rows, per `.nax/rules/api-test-isolation.md`: names, slugs, emails and refs are unique per test, and "Approving AC-n's request" means the test repeats AC-n's call and approves the request it opened. "Approving" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means the response status is 202 and `data` is the pending request summary. "The agent's pending X" means X sent by that agent under a wait policy, which answered 202. Each AC is one assertion.

### US-001: The invite routes join `gate-secret`, and the wait-policy helper

- AC-1 [unit] `SECRET_GATE_ROUTES` holds exactly the 6 labels of 5b plus `POST /projects/:slug/invites` and `POST /projects/:slug/invites/:id/resend`.
- AC-2 [unit] `PENDING_GATE_ROUTES.get('POST /projects/:slug/invites/:id/resend')` answers `gate-secret`.
- AC-3 [unit] `PENDING_GATE_ROUTES.get('DELETE /projects/:slug/invites/:id')` answers `gate-core-domains`.
- AC-4 [integration] Over the booted app, `PENDING_GATE_ROUTES` equals `expectedPendingGateRoutes` of the collected routes.
- AC-5 [integration] In `seed-wait-policy.integration.spec.ts`, `seedWaitPolicy(db, 'label.create', P)` leaves one `ApprovalPolicy` row matching `{ selector: '<P>|label.create|type:AGENT', principalType: 'AGENT', mode: 'agent' }`.
- AC-6 [integration] Calling `seedWaitPolicy(db, 'label.create', P)` twice leaves exactly one row with that selector.
- AC-7 [integration] `seedWaitPolicy(db, 'project.create', null)` leaves a row matching `{ selector: '*|project.create|type:AGENT', projectId: null }`.

### US-002: VCS test settlement compares the tested target (#346)

- AC-1 [unit] The settlement callback of `prepareTestConnection` answers the provider's result when the re-read connection differs from the tested one only in `lastSyncedAt` and `updatedAt`.
- AC-2 [unit] The settlement callback throws `ValidationAppException` with key `vcs` when the re-read connection has a different `repoOwner`, `provider` or `encryptedToken` (one `it.each` case per field; the existing `repoName` case stays).
- AC-3 [unit] The settlement callback throws `ValidationAppException` with key `vcs` when the connection is gone.
- AC-4 [unit] The settlement callback throws `ValidationAppException` with key `vcs` when the connection was replaced by a row with another `id` and the same target.
- AC-5 [integration] In `gated-webhook-vcs-routes.integration.spec.ts`, with the `GitHubProvider.prototype.testConnection` stub writing a new `lastSyncedAt` to the connection row before answering `{ ok: true }`, approving an agent's pending `POST /api/projects/:slug/vcs/test` answers a decision whose request is `executed` with `result.ok` true.

### US-003: Gated ticket create, update and assign

The agent holds `ticket.create`, `ticket.update` and `ticket.assign` in P (no `ticket.transition.*` key).

- AC-1 [integration] `POST /api/projects/:slug/tickets` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'ticket.create', projectId: P }`.
- AC-2 [integration] Approving the agent's pending ticket create leaves one ticket with that title whose `createdByAgentId` is the agent.
- AC-3 [integration] Approving the agent's pending `PATCH /api/projects/:slug/tickets/:ref` `{ title: 'renamed' }` leaves the ticket titled `renamed`.
- AC-4 [integration] Approving the agent's pending `PATCH …/tickets/:ref` `{ status: 'IN_PROGRESS' }` on a CREATED ticket settles the request `failed` (the agent holds no edge key).
- AC-5 [integration] Approving the agent's pending `POST …/tickets/:ref/assign` `{ agentId: <the agent's id> }` leaves the ticket's `assignedToAgentId` the agent.
- AC-6 [integration] `POST /api/projects/:slug/tickets` by the agent with no policy seeded answers 201 and writes no `ApprovalRequest` row.
- AC-7 [integration] `POST /api/projects/:slug/tickets` with the root token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-8 [unit] After `onModuleInit`, the registry answers `ticket.create`, `ticket.update` and `ticket.assign` commands for `rest:tickets.create`, `rest:tickets.update` and `rest:tickets.assign`.
- AC-9 [unit] The `rest:tickets.assign` command's run calls `tickets.assign('alpha', 'AL-1', { userId: 'cuser1' }, <principal>)` for input `{ slug: 'alpha', ref: 'AL-1', assignee: { userId: 'cuser1' } }`.
- AC-10 [unit] `TicketsController.create` calls `routeGate.run` with `{ key: 'ticket.create', variant: 'rest:tickets.create', projectId: <the project id>, input: { slug, ticket: <the dto> } }`.

### US-004: Gated ticket verify, start and fix

The agent holds `ticket.transition.verify`, `ticket.transition.start` and `ticket.transition.fix` in P. Root creates each ticket and moves it to the needed status; each test seeds the wait policy of its route's key.

- AC-1 [integration] `POST /api/projects/:slug/tickets/:ref/verify` `{ body: 'ok' }` on a CREATED ticket by the agent answers 202 with `data.permissionKey` `ticket.transition.verify`.
- AC-2 [integration] After AC-1's request, before approval, the ticket is still CREATED.
- AC-3 [integration] Approving AC-1's request leaves the ticket VERIFIED with a comment whose body is `ok`.
- AC-4 [integration] Approving the agent's pending `POST …/start` on a VERIFIED ticket leaves it IN_PROGRESS.
- AC-5 [integration] Approving the agent's pending `POST …/fix` `{ body: 'fixed' }` on an IN_PROGRESS ticket leaves it VERIFY_FIX.
- AC-6 [integration] `POST …/verify` `{ body: '  ' }` by the agent under a wait policy answers 400 and writes no `ApprovalRequest` row.
- AC-7 [integration] Approving the agent's pending verify after root verified the ticket while it waited settles the request `failed`.
- AC-8 [unit] After `onModuleInit`, the registry answers commands for `rest:tickets.verify`, `rest:tickets.start` and `rest:tickets.fix` under their keys.
- AC-9 [unit] The `rest:tickets.verify` command's run calls `transitions.verify('alpha', 'AL-1', 'ok', <principal>)` and answers the `ticket` of its result.
- AC-10 [unit] The `rest:tickets.fix` command's `parse({ slug: 'alpha', ref: 'AL-1' })` throws `ValidationAppException` with key `approvals.invalidInput`.

### US-005: Gated ticket verify-fix, close and reject

Each test binds the agent the route's key in P and seeds its wait policy. Root creates each ticket and moves it to the needed status.

- AC-1 [integration] `POST …/verify-fix?approve=true` `{ body: 'good' }` on a VERIFY_FIX ticket by an agent holding `ticket.transition.verify-fix.approve` answers 202 with `data.permissionKey` `ticket.transition.verify-fix.approve`.
- AC-2 [integration] Approving AC-1's request leaves the ticket CLOSED.
- AC-3 [integration] `POST …/verify-fix` `{ body: 'redo' }` (no `approve`) by an agent holding `ticket.transition.verify-fix.return` answers 202 with `data.permissionKey` `ticket.transition.verify-fix.return`.
- AC-4 [integration] Approving AC-3's request leaves the ticket IN_PROGRESS.
- AC-5 [integration] `POST …/verify-fix?approve=true` by an agent holding only `ticket.transition.verify-fix.return` answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-6 [integration] Approving the agent's pending `POST …/close` `{ body: 'done' }` on an IN_PROGRESS ticket leaves it CLOSED.
- AC-7 [integration] Approving the agent's pending `POST …/reject` `{ body: 'no' }` on a CREATED ticket leaves it REJECTED.
- AC-8 [integration] `POST …/close` `{ body: '' }` by the agent under a wait policy answers 400 and writes no `ApprovalRequest` row.
- AC-9 [unit] After `onModuleInit`, the registry answers a `ticket.transition.verify-fix.approve` and a `ticket.transition.verify-fix.return` command for `rest:tickets.verify-fix`, and commands for `rest:tickets.close` and `rest:tickets.reject`.
- AC-10 [unit] The `.approve` command's run calls `transitions.verifyFix('alpha', 'AL-1', 'good', true, <principal>)`.
- AC-11 [unit] The `.return` command's run calls `transitions.verifyFix('alpha', 'AL-1', 'good', false, <principal>)`.
- AC-12 [unit] `TicketsController.verifyFix` gates `{ key: 'ticket.transition.verify-fix.approve', variant: 'rest:tickets.verify-fix', input: { slug, ref, body } }` for `approve` `'true'` and `true`, and the `.return` key with the same variant and input for `approve` `'false'` and undefined (one `it.each` row each).

### US-006: Gated comment create and update

The agent holds `comment.create` and `comment.update.own` in P. Its own comment is one it posted with no policy seeded (201).

- AC-1 [integration] `POST /api/projects/:slug/tickets/:ref/comments` `{ body: 'hi' }` by the agent under a wait policy answers 202 with `data.permissionKey` `comment.create`.
- AC-2 [integration] Approving AC-1's request leaves one comment on the ticket with body `hi` and `authorAgentId` the agent.
- AC-3 [integration] `PATCH /api/comments/:id` `{ body: 'edited' }` on the agent's own comment, under a wait policy for `comment.update`, answers 202 with `data.projectId` P.
- AC-4 [integration] Approving AC-3's request leaves the comment's body `edited`.
- AC-5 [integration] Approving the agent's pending `PATCH /api/comments/:id` on a comment root wrote settles the request `failed`, and that comment's body is unchanged.
- AC-6 [integration] `PATCH /api/comments/missing` by the agent answers 404 with key `comments` and writes no `ApprovalRequest` row.
- AC-7 [integration] `PATCH /api/comments/:id` on a comment in P by an agent with no binding in P answers 404 with key `comments` and writes no `ApprovalRequest` row.
- AC-8 [integration] `PATCH /api/comments/:id` by an agent holding only `project.read` in P answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-9 [integration] `POST …/comments` with the root token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-10 [unit] After `onModuleInit`, the registry answers a `comment.create` command for `rest:comments.create` and a `comment.update` command for `rest:comments.update`.
- AC-11 [unit] `CommentsController.updateFromHttp('c1', { body: 'x' }, principal)` calls `routeGate.run` with `{ key: 'comment.update', variant: 'rest:comments.update', projectId: <resolveCommentProject's answer>, input: { id: 'c1', patch: { body: 'x' } } }`.

### US-007: Gated label create, update and assign, and ticket link add

The agent holds `label.create`, `label.update`, `ticket.label.assign` and `ticket.link.add` in P.

- AC-1 [integration] `POST /api/projects/:slug/labels` `{ name: 'bug' }` by the agent under a wait policy answers 202 with `data.permissionKey` `label.create`.
- AC-2 [integration] Approving AC-1's request leaves a label `bug` in P.
- AC-3 [integration] Approving the agent's pending `PATCH /api/projects/:slug/labels/:id` `{ name: 'defect' }` leaves the label named `defect`.
- AC-4 [integration] Approving the agent's pending `PATCH /api/projects/:slug/labels/:id` for a label of another project settles the request `failed`, and that label's name is unchanged.
- AC-5 [integration] Approving the agent's pending `POST /api/projects/:slug/tickets/:ref/labels` `{ labelId }` leaves the ticket carrying the label.
- AC-6 [integration] Approving the agent's pending `POST /api/projects/:slug/tickets/:ref/links` `{ url }` leaves one link with that URL whose creator is the agent.
- AC-7 [integration] Approving the agent's pending link add after root deleted the ticket while it waited settles the request `failed`.
- AC-8 [integration] `POST …/links` with the root token for a URL already linked to the ticket answers 200 with that link and writes no `ApprovalRequest` row.
- AC-9 [unit] After `onModuleInit`, the registries answer commands for `rest:labels.create` (`label.create`), `rest:labels.update` (`label.update`), `rest:ticket-labels.assign` (`ticket.label.assign`) and `rest:ticket-links.add` (`ticket.link.add`).
- AC-10 [unit] `TicketLinksController.create` with an executed outcome whose result is `{ status: 200, link }` sets the reply's `statusCode` to 200 and answers `link`.
- AC-11 [unit] The `rest:ticket-links.add` command's `toResult({ status: 201, link })` answers `link`.
- AC-12 [unit] In `creator-ref.spec.ts`, `creatorRef` answers `{ type: 'AGENT', id }` for an agent principal and `{ type: 'USER', id }` for a user principal.

### US-008: Gated project create and update

- AC-1 [integration] `POST /api/projects` `{ name, slug, key }` by an agent holding global `project.create` under a global wait policy answers 202 with `data` matching `{ permissionKey: 'project.create', projectId: null }`.
- AC-2 [integration] After AC-1's request, before approval, no project has that slug.
- AC-3 [integration] Approving AC-1's request leaves one project with that slug.
- AC-4 [integration] Approving the agent's pending project create after root took the slug while it waited settles the request `failed`.
- AC-5 [integration] `PATCH /api/projects/:slug` `{ name: 'Renamed' }` by an agent holding `project.update` in P under a wait policy answers 202 with `data.projectId` P.
- AC-6 [integration] Approving AC-5's request leaves the project named `Renamed`.
- AC-7 [integration] `POST /api/projects` with the root token under a global wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-8 [unit] After `onModuleInit`, the registry answers commands for `rest:projects.create` (`project.create`), `rest:projects.update` (`project.update`) and `rest:projects.delete` (`project.delete`).
- AC-9 [unit] `ProjectsController.create(dto)` calls `routeGate.run` with `{ key: 'project.create', variant: 'rest:projects.create', projectId: null, input: dto }`.

### US-009: Gated member add and invite cancel

P is `web`. The member agent holds the `viewer` role in P (`grantRole` from `src/permissions/test-helpers/permission-fixtures`) plus `member.add`, so it holds every key the `viewer` role grants; the invite agent holds `invite.cancel` in P. Each test that adds a member first creates its own user with root's `POST /api/admin/users` (a unique email, role `MEMBER`). Root creates each pending invite with `POST /api/projects/<slug>/invites` `{ email: <a unique address with no account>, roleKey: 'viewer' }`.

- AC-1 [integration] `POST /api/projects/web/members` `{ email: <the test's user> }` by the member agent under a wait policy answers 202 with `data.permissionKey` `member.add`.
- AC-2 [integration] Approving AC-1's request makes the test's user a member of `web` with the `viewer` role.
- AC-3 [integration] Approving the member agent's pending add `{ email: <the test's user>, roleKey: 'developer' }` settles the request `failed` (the agent lacks the developer role's keys), and that user has no binding in `web`.
- AC-4 [integration] `DELETE /api/projects/web/invites/:id` on a pending invite by the invite agent under a wait policy answers 202 with `data.permissionKey` `invite.cancel`.
- AC-5 [integration] Approving AC-4's request leaves the invite cancelled and the request's `result` null.
- AC-6 [integration] Approving the invite agent's pending cancel after root cancelled the invite while it waited settles the request `failed`.
- AC-7 [integration] Approving the invite agent's pending `DELETE /api/projects/web/invites/:id` whose id is an invite of project `ops` settles the request `failed`, and that invite stays pending.
- AC-8 [integration] `DELETE /api/projects/web/invites/:id` with the root token answers 200 with `data` `{}` and writes no `ApprovalRequest` row.
- AC-9 [unit] The `rest:project-invites.cancel` command's run calls `invites.cancel('alpha', 'i1', <principal>)` for input `{ slug: 'alpha', id: 'i1' }` and answers `null`.
- AC-10 [unit] `ProjectMembersModule` compiled with `GlobalStubsModule` resolves `MemberRouteCommands`, and after init its registry answers a `member.add` command for `rest:project-members.add`.
- AC-11 [unit] `ProjectInvitesModule` compiled with `GlobalStubsModule` resolves `InviteRouteCommands`, and after init its registry answers an `invite.cancel` command for `rest:project-invites.cancel`.

### US-010: Gated ticket watch and unwatch

P is `web`; the user is `dev` (a developer on `web`, holding both watch keys). The agent holds `ticket.watch.set` and `ticket.watch.unset` in P.

- AC-1 [integration] `PUT /api/projects/web/tickets/:ref/watch` with `dev`'s token answers 200 with `data.watching` true and writes no `ApprovalRequest` row.
- AC-2 [integration] `DELETE /api/projects/web/tickets/:ref/watch` with `dev`'s token answers 200 with `data.watching` false.
- AC-3 [integration] `PUT …/watch` by the agent under a wait policy answers 403 with key `notifications` and writes no `ApprovalRequest` row.
- AC-4 [integration] `DELETE …/watch` by the agent under a wait policy answers 403 with key `notifications` and writes no `ApprovalRequest` row.
- AC-5 [unit] After `onModuleInit`, the registry answers commands for `rest:ticket-watch.set` (`ticket.watch.set`) and `rest:ticket-watch.unset` (`ticket.watch.unset`).
- AC-6 [unit] The `rest:ticket-watch.set` command's run for a user principal calls `watch.watch('p1', 'AL-1', <the user's id>)` for input `{ projectId: 'p1', ref: 'AL-1' }`.
- AC-7 [unit] The `rest:ticket-watch.set` command's run for an agent principal throws `ForbiddenAppException` with key `notifications` and never calls `watch.watch`.
- AC-8 [unit] `TicketWatchController.watch` calls `routeGate.run` with `{ key: 'ticket.watch.set', variant: 'rest:ticket-watch.set', projectId: <the project id>, input: { projectId, ref } }` for a user principal.
- AC-9 [unit] `NotificationsModule` compiles with `GlobalStubsModule` and resolves `TicketWatchRouteCommands`.

### US-011: Contract, OpenAPI and endpoint coverage

- AC-1 [integration] Over the booted app, the collected routes contain exactly 62 gated routes.
- AC-2 [integration] Over the booted app, `findContractViolations` reports no violation.
- AC-3 [unit] `PENDING_GATE_ROUTES` holds exactly 25 `gate-core-domains`, 36 `gate-fleet` and 8 `gate-secret` entries.
- AC-4 [unit] `openapi.json`'s `post /api/projects/{slug}/tickets` operation has a `202` response.
- AC-5 [unit] `openapi.json`'s `post /api/projects/{slug}/invites` operation has no `202` response.
- AC-6 [unit] The operations of `openapi.json` with a `202` response are exactly the 62 gated ones plus `post /api/projects/{slug}/knowledge/repos/{repoId}/reindex`.
- AC-7 [integration] In `endpoint.e2e.spec.ts`, `POST /api/projects/:slug/labels` with the key of an agent granted `label.create` in the project, under a wait policy deleted in a `finally`, answers exactly 202.
- AC-8 [integration] In `endpoint.e2e.spec.ts`, `PATCH /api/comments/:id` on the agent's own comment, with the key of an agent granted `comment.update.own` in the project, under a wait policy for `comment.update` deleted in a `finally`, answers exactly 202.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-4 to AC-6 live in `src/approvals/approval-openapi.contract.spec.ts`.
