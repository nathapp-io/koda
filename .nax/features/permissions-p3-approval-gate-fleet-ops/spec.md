# SPEC: Permissions P3e-5 — Gating the Fleet Job, Schedule, Config-Edit, Ingest, Knowledge and Fleet-Decide REST Routes

## Summary

This feature starts the `gate-fleet` rollout. It routes the fleet operations writes through the route gate that `permissions-p3-approval-gate-core` (5a) shipped and 5b, 5c-1 and 5c-2 applied.
- **16 routes are gated:**
  - fleet jobs: dispatch, requeue, cancel, and unlinking a job from a ticket;
  - schedules: create, update, enable, disable;
  - repository config: submit an edit, submit a regenerate;
  - bundle ingest: backfill, rerun one job, rerun the outdated;
  - knowledge index: save the corpus patterns, queue a repository reindex;
  - fleet approvals: decide a fleet ask in a project.
- **Two test-hook rows leave without being gated.** `POST /fleet/test-hooks/schedules/:id/fire` and `PUT /fleet/test-hooks/repos/:repoId/nax-files` answer 404 unless the fleet test hooks are enabled, which production never does. Their keys `testhook.schedule.fire` and `testhook.nax-files.seed` become non-approvable, and their rows leave the allowlist.
- **Post-commit work leaves the execution transaction.** An approved request runs its command inside one database transaction. Three things the handlers do after their own write today would then run before that transaction commits:
  - the ticket auto-start of a RUN dispatch, which writes tickets and swallows its own failures;
  - the bundle-ingest drain kick;
  - the knowledge-index queue enqueue.

  The first is deferred through `AfterCommitService`. The other two are wake signals, deferred through `committedEffect` as the fleet's runner wakes already are. On the immediate path each runs at once, as today.
- **The regenerate's forge read runs outside the transaction.** It moves to a `prepare`, as 5b's drift check did.
- **The fleet decide mirrors the shipped `POST /approvals/:id/decisions`.** The request's command records the decision; the approved inner command runs after the outer commit.
- **Nothing waits under the shipped defaults.** Every key here is `medium` with catalog default `none`. A request waits only when an approval policy names the key.
- **The contract counts 97 gated routes** after this feature (81 + 16). The allowlist holds only the 18 thread rows under `gate-fleet` and the 11 `gate-secret` rows.

This is the first part of the `gate-fleet` rollout of feature 5 of P3 (`p3-approval-gate`) in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). The 18 thread routes follow in `permissions-p3-approval-gate-threads`.

## Motivation

5a to 5c-2 gated 81 routes. The fleet writes still bypass the engine on REST: a policy `fleet.job.dispatch → agent` makes the assistant's `koda_dispatch_job` wait, while the same agent calling `POST /projects/:slug/fleet/jobs` dispatches at once. `PENDING_GATE_ROUTES` lists 36 routes under `gate-fleet`.

**Rulings that bind this feature** (user):
- 2026-10-26 and 2026-10-28 (as in 5a to 5c-2): every approvable REST write route is gated; the deferred run is the command registry; a human acting directly satisfies any mode.
- 2026-10-29: `gate-fleet` is split in two features. This one (5d-1) takes the 18 non-thread routes; the 18 thread routes follow.
- 2026-10-29: the two test-hook keys become non-approvable instead of gated.
- 2026-10-29: the project fleet decide route mirrors 5a's `POST /approvals/:id/decisions` (variant `rest:approvals.decide`). It gates under the type key (`fleet.approval.decide.bash` for a `fleet.job.shell.escalate` ask, `fleet.approval.decide.budget` for a `fleet.budget.override` ask). Its command records the decision. The approved command runs from `afterCommit`, and `skipKeyRecheck` is set.
- 2026-10-29: the story list (9 stories) below.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The test-hook keys are non-approvable by name.** `catalog.ts` gains `TEST_HOOK_KEYS = new Set(['testhook.schedule.fire', 'testhook.nax-files.seed'])` (exported). `buildEntry` answers `approvable: false` (floor and default `none`) for a member. Its risk stays `medium`, because the rule is about reachability, not risk. No role changes. A policy naming one of these keys is refused by policy validation from then on, as for any non-approvable key.
- **Request checks the handler makes today stay before the gate**, so they answer as today and open no request:
  - the knowledge kill switch of the reindex (409 `knowledge.disabled`);
  - the patterns body parse (400 `knowledge.input`), which runs in the command's `parse`;
  - the fleet decide's steps 1 to 3 (visible ask, pending, eligibility) and its body translation (400 `fleet.approvalInput`, 409 `fleet.budgetNotPaused`, …);
  - the cancel's job lookup and ownership check (below).

  Every other check runs inside the command, at once or after approval; a failing check settles the request `failed`. This is 5a's rule.
- **Cancel keeps "a requester may cancel its own job".** `fleet.job.cancel` is not ownable: the route declares it `enforcedBy: 'service'`, and `FleetJobsService.cancel` lets the requester through without it. The handler first asks `FleetJobsService.requesterOf(projectId, id)` (new), for every caller. That method throws `NotFoundAppException({}, 'fleet.jobs')` for a job missing from the project, as today's 404. The handler then asks `permissions.can(principal, 'fleet.job.cancel', { projectId })`. When that is denied and the requester is not the caller, it throws `ForbiddenAppException({}, 'permissions')`, as today's 403. It then gates with `keyCheck: false`, because a requester holds no key to check. The command computes `canOperate` again at execution, as 5b's schedule delete computes `canAdminister`, and `FleetJobsService.cancel` re-checks requester-or-key. The engine's execution pre-check (`ApprovalExecutionService.precheck`) re-checks the actor's key for every command, not only prepared ones, so a requester without the key would settle `permission-revoked`. The cancel command therefore sets `skipKeyRecheck: true`: its run is its own authority, as 5a's decide is.
- **Any-row schedule authority is the requester's at execution.** `update`, `enable` and `disable` pass `canAdminister` today, computed in the handler. Their commands compute `permissions.can(principal, 'fleet.schedule.update', { projectId })` when they run, as `ScheduleRouteCommands` does for delete.
- **The dispatch's ticket auto-start runs after commit.** `FleetJobTicketEffects.onRunDispatched` starts each linked ticket and logs a failure instead of throwing ("C9 D452, after commit"). Inside the execution transaction, a swallowed failure poisons the transaction, and a start inside it is no longer after commit. The method now hands its start loop to `AfterCommitService.defer(task)`, and runs it at once when `defer` answers false (no scope: the immediate path). The approval execution opens the scope, so a deferred dispatch starts its tickets after its commit. This also covers the assistant's `koda_dispatch_job`, whose approved run already dispatches inside the execution transaction.
- **The ingest kick and the knowledge enqueue use `committedEffect`.** `BundleIngestService.kick()` and `KnowledgeIndexQueue.enqueue(repoId, 'admin')` start background work that reads the rows the route just wrote. Both are in-memory wake signals, like `RunnerNotifier.notify`. Each is wrapped in `committedEffect(() => …)` and called after the write's own `txManager.run` returns. The approval execution wraps its transaction in `withCommittedEffects`, so a deferred write queues the wake until the commit. On the immediate path there is no owning scope, so the wake runs at once, after the write committed, as today.
- **The ingest writes move to a service.** `FleetIngestController.queue()` holds the write, the activity row, the audit entry and the kick. US-006 moves them, unchanged, into `IngestRequeueService` (`fleet/ingest/ingest-requeue.service.ts`) with `backfill(actorId)`, `rerunJob(actorId, jobId)` and `rerunOutdated(actorId)`. `rerunJob` also takes over the job lookup (404 `fleet.jobs`). The commands call the same methods. The controller keeps only the list route's collaborator (`BUNDLE_INGEST_REPOSITORY`) and gains `ApprovalRouteGate`.
- **The knowledge writes move to a service.** `ProjectKnowledgeController.patterns` and `.reindex` hold the save, the pass queueing, the audit entry and the enqueue. US-007 moves them into `KnowledgeIndexAdmin` (`fleet/knowledge/knowledge-index-admin.service.ts`) with `savePatterns(projectId, patterns)` and `reindex(projectId, repoId)`. The controller loses `KnowledgeIndexQueue` and `AuditRecorder` and gains `ApprovalRouteGate`. It keeps the kill switch of the reindex (409 before the gate). `KnowledgeIndexAdmin.reindex` checks the kill switch again when it runs and throws `ConflictAppException({}, 'knowledge.disabled')`, so a reindex approved after indexing was switched off settles `failed` instead of recording a pass that `enqueue` silently drops.
- **The reindex answers 202 on both paths.** Its executed answer is `202 { queued: true }`, as today. A waiting request answers 202 with the pending summary, as every gated route does. A client tells them apart by the body. OpenAPI holds one response per status, so the handler drops its own `@ApiResponse({ status: 202, type: KnowledgeReindexResultDto })` and documents the executed body in its `@ApiOperation` summary; the documented 202 is `@ApprovalGated()`'s.
- **The regenerate splits like the drift check.** `ConfigJobsService.prepareRegenerate(actorId, projectId, repoId, body)` (new) reads the repository first (404 `fleet.repos`, as today), then validates the body, then lists its nax files on the forge. The callback it answers re-reads the repository: one changed since the prepare answers `ConflictAppException({}, 'fleet.repos')`, as `prepareDrift` does. The callback then creates the config job. `submitRegenerate` becomes `(await this.prepareRegenerate(…))()`.
- **The fleet decide gains step methods beside `decide`.** `ApprovalsService.decide` today does: steps 1 to 3, the body translation, `ApprovalDecisionService.decide` (record, then execute), and the reload. It stays exactly as it is, so the global `/fleet/approvals/:id/decide` route and its spec keep their behaviour. Four new methods share its private helpers (`findVisible`, `engineDecision`, `refusalOf`, `decideFailure`):
  - `checkDecide(caller, route, id, dto, now)` runs steps 1 to 3 and the translation, and answers `{ key, input }`. `key` is `fleet.approval.decide.bash` when the request's `permissionKey` is `fleet.job.shell.escalate`, else `fleet.approval.decide.budget`. `input` is `{ requestId, decision, comment, params? }`.
  - `recordDecide(principal, input)` calls `ApprovalDecisionService.recordDecision(requestId, decision, comment, now, params)`. It reloads the request (`queries.findById`) and builds the decider from `principal`, so it can map errors through `decideFailure(error, request, decider)` as `decide` does.
  - `executeDecided(principal, requestId)` calls `ApprovalExecutionService.execute(requestId)` with the same mapping.
  - `view(id)` reloads the ask and keeps the `job_ended` 409.

  `ApprovalsService` gains `ApprovalExecutionService` (last constructor parameter). The project handler runs `checkDecide`, then gates with `keyCheck: false`: eligibility was checked, and the type keys are metadata the guard does not enforce. On `executed` with `decision === 'approve'`, it runs `executeDecided`, then answers `view(id)`. The commands' `afterCommit` runs `ApprovalExecutionService.execute(requestId)` for an approve, as 5a's does.
- **A deferred job create that loses the active-job race fails the request.** `FleetJobsService.dispatch`, `.requeue` and `ConfigJobsService.create` catch `DuplicateActiveJobError`, then look up the winner "outside the failed transaction". Inside the execution transaction, that lookup runs in the aborted transaction, and the request settles `failed`. That is the right outcome; the 409 body's `activeJobId` is not reproduced (Out of Scope). 5b's drift check already behaves this way.
- **The frozen input is ids, slugs and the validated body.** Project-scoped inputs carry `slug`, so the execution locks the slug to the request's project (`lockProjectSlug`). Ingest inputs are global and carry only the job id.
- **Each gating story removes its own `PENDING_GATE_ROUTES` rows.** US-001 relaxes the exact gated-route count to a lower bound (at least 81), and the allowlist count case to the `gate-secret` count. US-009 restores both exactly.
- **Only the HTTP handlers change.** Gated handlers keep their parameters, in order.

### The gated routes

Each row is one `routeCommand`. "Scope" is the `projectId` passed to `ApprovalRouteGate.run` (`null` = global; "project" = `@CurrentProject()`'s id). The run is the service call the handler makes today, with `principal` the rebuilt `UserPrincipal | AgentPrincipal`. Every body-returning command declares `toResult: (result) => result` unless the row says otherwise; a no-body command declares none. On `executed` the handler answers as today (`JsonResponse.Ok(outcome.result)`, or no body for the 204 route).

| Story | Route | Key | Scope | Variant | Input | Run |
|:--|:--|:--|:--|:--|:--|:--|
| US-002 | `POST /projects/:slug/fleet/jobs` | `fleet.job.dispatch` | project | `rest:fleet-jobs.dispatch` | `{ slug, projectId, dispatch: parseBody(DispatchFleetJobDto, …) }` | `jobs.dispatch(principal.id, projectId, dispatch, { ticketActor: { principal, projectSlug: slug } })` |
| US-002 | `POST /projects/:slug/fleet/jobs/:id/requeue` | `fleet.job.requeue` | project | `rest:fleet-jobs.requeue` | `{ slug, projectId, id }` | `jobs.requeue(principal.id, projectId, id)` |
| US-003 | `POST /projects/:slug/fleet/jobs/:id/cancel` | `fleet.job.cancel` | project, `keyCheck: false` | `rest:fleet-jobs.cancel` | `{ slug, projectId, id }` | `jobs.cancel(principal.id, projectId, id, <can fleet.job.cancel at execution>)`; `skipKeyRecheck: true` |
| US-003 | `DELETE /projects/:slug/tickets/:ref/fleet-jobs/:jobId` | `fleet.ticket-job.unlink` | project | `rest:ticket-fleet-jobs.unlink` | `{ slug, projectId, ref, jobId }` | `fleetTickets.unlink(projectId, ref, jobId, principal.id)`, answering `null` |
| US-004 | `POST /projects/:slug/fleet/schedules` | `fleet.schedule.create` | project | `rest:project-fleet-schedules.create` | `{ slug, projectId, schedule: parseBody(CreateScheduleDto, …) }` | `schedules.create(principal.id, projectId, schedule)` |
| US-004 | `PATCH /projects/:slug/fleet/schedules/:id` | `fleet.schedule.update` | project | `rest:project-fleet-schedules.update` | `{ slug, projectId, id, patch: parseBody(UpdateScheduleDto, …) }` | `schedules.update(principal.id, projectId, id, patch, <can fleet.schedule.update at execution>)` |
| US-004 | `POST /projects/:slug/fleet/schedules/:id/enable` | `fleet.schedule.update` | project | `rest:project-fleet-schedules.enable` | `{ slug, projectId, id }` | `schedules.enable(principal.id, projectId, id, <can at execution>)` |
| US-004 | `POST /projects/:slug/fleet/schedules/:id/disable` | `fleet.schedule.update` | project | `rest:project-fleet-schedules.disable` | `{ slug, projectId, id }` | `schedules.disable(principal.id, projectId, id, <can at execution>)` |
| US-005 | `POST /projects/:slug/fleet/repos/:repoId/config-edits` | `fleet.job.config.edit` | project | `rest:project-repo-config.config-edit` | `{ slug, projectId, repoId, edit: parseBody(SubmitConfigEditDto, …) }` | `configJobs.submitEdit(principal.id, projectId, repoId, edit)` |
| US-005 | `POST /projects/:slug/fleet/repos/:repoId/config-edits/regenerate` | `fleet.job.config.edit` | project | `rest:project-repo-config.regenerate` | `{ slug, projectId, repoId, regenerate: parseBody(RegenerateConfigDto, …) }` | `configJobs.submitRegenerate(…)`; `prepare`: `configJobs.prepareRegenerate(principal.id, projectId, repoId, regenerate)` |
| US-006 | `POST /fleet/ingest/backfill` | `fleet.ingest.backfill` | null | `rest:fleet-ingest.backfill` | `{}` | `ingestRequeue.backfill(principal.id)` |
| US-006 | `POST /fleet/ingest/jobs/:jobId/rerun` | `fleet.ingest.rerun` | null | `rest:fleet-ingest.rerun-job` | `{ jobId }` | `ingestRequeue.rerunJob(principal.id, jobId)` |
| US-006 | `POST /fleet/ingest/rerun-outdated` | `fleet.ingest.rerun` | null | `rest:fleet-ingest.rerun-outdated` | `{}` | `ingestRequeue.rerunOutdated(principal.id)` |
| US-007 | `PUT /projects/:slug/knowledge/patterns` | `fleet.knowledge.patterns.update` | project | `rest:project-knowledge.patterns` | `{ slug, projectId, patterns }`: the body's `patterns`, parsed by the command's `parse` | `knowledgeAdmin.savePatterns(projectId, patterns)` |
| US-007 | `POST /projects/:slug/knowledge/repos/:repoId/reindex` | `fleet.knowledge.repo.reindex` | project | `rest:project-knowledge.reindex` | `{ slug, projectId, repoId }` | `knowledgeAdmin.reindex(projectId, repoId)` |
| US-008 | `POST /projects/:slug/fleet/approvals/:id/decide` | `fleet.approval.decide.bash` or `.budget` (by the ask) | project, `keyCheck: false` | `rest:project-fleet-approvals.decide` | `{ requestId, decision, comment, params? }` (from `checkDecide`) | `approvals.recordDecide(principal, input)`; `afterCommit`: execute the inner request on approve; `skipKeyRecheck: true`; `toResult: ApprovalRequestSummaryDto.from` |

- Id and string members are read with `parseRouteInput`; a body member with `parseBody` of the route's DTO (a missing body member is parsed as `{}`).
- The patterns command's `parse` reads `patterns` from its input: `null` stays `null`; anything else goes through `parseKnowledgePatterns`, and a refusal throws `ValidationAppException({ reason }, 'knowledge.input')`, as the handler's `acceptPatterns` does today. The handler passes `{ slug, projectId, patterns: body?.patterns }` as the input.
- `fleet.approval.decide.bash` and `fleet.approval.decide.budget` each register one command with the same variant and the same spec; they differ only in `key`.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `TEST_HOOK_KEYS` | `permissions/catalog.ts` (exported) | `testhook.schedule.fire`, `testhook.nax-files.seed` |
| `FleetJobRouteCommands`, `FLEET_JOB_ROUTE_VARIANTS` | `fleet/jobs/fleet-job-route.commands.ts` | new: `dispatch`, `requeue` (US-002), `cancel` (US-003) |
| `FleetJobsService.requesterOf(projectId, jobId)` | `fleet/jobs/fleet-jobs.service.ts` | new: the job's `requestedById`; 404 `fleet.jobs` when missing from the project |
| `TicketFleetJobRouteCommands`, `TICKET_FLEET_JOB_ROUTE_VARIANTS` | `fleet/tickets/ticket-fleet-job-route.commands.ts` | new: `unlink` |
| `SCHEDULE_ROUTE_VARIANTS` | `fleet/schedules/schedule-route.commands.ts` | gains `create`, `update`, `enable`, `disable` |
| `ConfigJobsService.prepareRegenerate` | `fleet/repo-config/config-jobs.service.ts` | new |
| `REPO_CONFIG_ROUTE_VARIANTS` | `fleet/repo-config/repo-config-route.commands.ts` | gains `configEdit`, `regenerate` |
| `IngestRequeueService` | `fleet/ingest/ingest-requeue.service.ts` | new: `backfill`, `rerunJob`, `rerunOutdated` |
| `IngestRouteCommands`, `INGEST_ROUTE_VARIANTS` | `fleet/ingest/ingest-route.commands.ts` | new: `backfill`, `rerunJob`, `rerunOutdated` |
| `KnowledgeIndexAdmin` | `fleet/knowledge/knowledge-index-admin.service.ts` | new: `savePatterns`, `reindex` |
| `KnowledgeRouteCommands`, `KNOWLEDGE_ROUTE_VARIANTS` | `fleet/knowledge/knowledge-route.commands.ts` | new: `patterns`, `reindex` |
| `ApprovalsService.checkDecide`, `.recordDecide`, `.executeDecided`, `.view` | `fleet/approvals/approvals.service.ts` | new, beside the unchanged `decide` |
| `FleetApprovalRouteCommands`, `FLEET_APPROVAL_ROUTE_VARIANTS` | `fleet/approvals/fleet-approval-route.commands.ts` | new: `decide` (two keys) |

### Module wiring

| Story | Module | Gains | Controllers whose constructor gains `ApprovalRouteGate` |
|:--|:--|:--|:--|
| US-002 | `FleetJobsModule` | imports `ApprovalEngineModule`, `AuthRepositoryModule`; provides `FleetJobRouteCommands` | `FleetJobsController` |
| US-003 | `FleetTicketsModule` | imports the two modules; provides `TicketFleetJobRouteCommands` | `TicketFleetJobsController` |
| US-004 | `SchedulesModule` | — (it has the engine and the commands class since 5b) | none (it has the gate since 5b) |
| US-005 | `RepoConfigModule` | — (it has both since 5b) | none (it has the gate since 5b) |
| US-006 | `IngestModule` | imports the two modules; provides `IngestRequeueService`, `IngestRouteCommands` | `FleetIngestController` |
| US-007 | `KnowledgeModule` | imports the two modules; provides `KnowledgeIndexAdmin`, `KnowledgeRouteCommands` | `ProjectKnowledgeController` |
| US-008 | `ApprovalsModule` | provides `FleetApprovalRouteCommands` (it imports the engine already); needs `AuthRepositoryModule` for `ActorPrincipalLoader` | `ProjectFleetApprovalsController` |

`ApprovalEngineModule` and `AuthRepositoryModule` import nothing that imports these fleet modules, so no module cycle is added. Each gated handler gains `@ApprovalGated()`, keeps its `@Requires`, `@HttpCode` and `@ApiResponse`s, and has the 5a shape:

```ts
const outcome = await this.routeGate.run<DispatchResultDto>({ key: 'fleet.job.requeue', variant: FLEET_JOB_ROUTE_VARIANTS.requeue, projectId: ctx.project.id, input: { slug: ctx.project.slug, projectId: ctx.project.id, id } });
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return JsonResponse.Ok(outcome.result);
```

A deferred-only wake has this shape (the ingest kick; the knowledge enqueue is the same):

```ts
const queued = await this.txManager.run(async () => { /* the write, the activity row, the audit entry, as today */ });
committedEffect(() => this.ingest.kick());
return { queued };
```

### The allowlist (US-001, US-009)

- US-001: the rows of `POST /fleet/test-hooks/schedules/:id/fire` and `PUT /fleet/test-hooks/repos/:repoId/nax-files` are deleted (their keys are no longer approvable, so the contract would report them stale).
- US-002 to US-008: each drops its gated routes' rows.
- US-009: the allowlist holds the 18 thread rows under `gate-fleet` and the 11 `gate-secret` rows, and nothing else.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| An agent under no policy (the shipped default) | Executes at once, no `ApprovalRequest` row | US-002, US-006 |
| A human under a policy for the key | Executes at once, no request | US-002, US-004, US-007 |
| A policy naming a test-hook key | Refused by policy validation (`pattern`) | US-001 |
| Agent without the route's key | 403 `permissions` from the guard; no request | US-004, US-006 |
| Cancel of another principal's job by an agent without `fleet.job.cancel` | 403 `permissions` before the gate; no request | US-003 |
| Cancel of a job missing from the project | 404 `fleet.jobs` before the gate; no request | US-003 |
| An approved dispatch whose repository + feature got an active job meanwhile | Request `failed`; no second job | US-002 |
| An approved RUN dispatch with linked tickets | The tickets start after the commit | US-002 |
| An approved cancel of a job that ended meanwhile | Request `failed` (409 `fleet.jobState` inside the service) | US-003 |
| An approved unlink whose link was removed meanwhile | Request `failed` | US-003 |
| An approved schedule update by an own-only agent on another owner's schedule | Request `failed` | US-004 |
| An approved regenerate whose repository changed meanwhile | Request `failed` (409 `fleet.repos` inside the callback) | US-005 |
| A regenerate `prepare` that throws (forge down) | Request `failed` with `{ error: 'execution-failed', name }` | US-005 |
| An approved rerun of a job deleted meanwhile | Request `failed` | US-006 |
| An approved ingest write | The drain kick runs after the commit | US-006 |
| Reindex while indexing is disabled | 409 `knowledge.disabled` before the gate; no request | US-007 |
| An approved reindex after indexing was switched off while it waited | Request `failed` (409 `knowledge.disabled` inside the service); no audit entry | US-007 |
| An approved rerun or reindex of a target missing when the request opened | Request `failed` (404 inside the service) | US-006, US-007 |
| An approved fleet decide whose ask expired meanwhile | Request `failed` (409 `fleet.approvalNotPending` inside the command) | US-008 |
| A patterns body the parser refuses | 400 `knowledge.input` before the gate; no request | US-007 |
| An approved reindex or patterns save | The enqueue runs after the commit | US-007 |
| A fleet decide by an ineligible caller | 403 `permissions` (or `fleet.approvalSelfDecide`) before the gate; no request | US-008 |
| A fleet decide on an ask already decided | 409 `fleet.approvalNotPending` before the gate; no request | US-008 |
| An approved fleet decide whose ask was decided meanwhile | Request `failed`; the ask keeps the other decision | US-008 |
| An approvable write route that is neither gated nor allowlisted | Contract test fails (5a) | US-009 |

### Integration

**Read-only, verified:**
- `ApprovalRouteGate.run({ key, variant, projectId, input, keyCheck? })`, `ApprovalPending`, `@ApprovalGated()`, `routeCommand(spec, loader)` (with `prepare`, `afterCommit`, `skipKeyRecheck`), `parseBody`, `parseRouteInput` (5a to 5c-2).
- `ApprovalExecutionService.executeOnce`: `prepare` runs before the transaction. The transaction is `afterCommit.scope(() => withCommittedEffects(() => txManager.run(…)))`. Inside it come the row lock, the key re-check (`stillHoldsKey`, only when prepared and not `skipKeyRecheck`; before the transaction, `precheck` re-checks the key for every command unless `skipKeyRecheck`), `lockProjectSlug` (for a `rest:` variant whose input has `slug`), then the callback or `execute`. `afterCommit` runs after commit, and its throw is only logged. A failed callback settles `failed` with `{ error: 'execution-failed', name }`.
- `ApprovalGate.gate`: under mode `none`, the command's `execute` runs at once, outside any scope or execution transaction; a USER actor executes at once under any mode.
- `txManager.run` joins an open transaction; `committedEffect(effect)` queues `effect` in the enclosing `withCommittedEffects`, else runs it at once (`common/committed-effects.ts`); `AfterCommitService.defer(task)` answers false outside a scope.
- `FleetJobsService.dispatch(actorId, projectId, dto, opts)`, `.requeue(actorId, projectId, jobId)`, `.cancel(actorId, projectId, jobId, canOperate)`.
- `FleetTicketsService.unlink(projectId, ref, jobId, actorId)`.
- `SchedulesService.create(actorId, projectId, dto)`, `.update(actorId, projectId, id, dto, canAdminister)`, `.enable(…, canAdminister)`, `.disable(…, canAdminister)`.
- `ConfigJobsService.submitEdit(actorId, projectId, repoId, body)`, `.prepareDrift` (the shape `prepareRegenerate` follows); `FLEET_REPO_FILES_READER` (`list(repo)`).
- `IBundleIngestRepository.backfill(parserVersion)`, `.rerunJob(jobId)`, `.rerunOutdated(parserVersion)`; `BundleIngestService.kick()`; `FleetActivityService.record`; `INGEST_PARSER_VERSION`.
- `KnowledgeIndexService.savePatterns(projectId, patterns)`, `.listProjectRepos(projectId)`, `.resolveProjectRepo(projectId, { repoId })`; `KnowledgeIndexQueue.enqueue(repoId, 'admin')`; `parseKnowledgePatterns(input)`.
- `ApprovalDecisionService.recordDecision(requestId, decision, comment, now, params)`; `ApprovalExecutionService.execute(requestId)`; `decideEligibility`; `ApprovalRequestSummaryDto.from`.
- Test helpers: `seedWaitPolicy`, `grantKeys`, `seedFleetHttpWorld`, `seedFleetHttpAgent`, `seedFleetAsk` (`test/helpers/fleet-ask-fixtures.ts`), `bootHttpApp`, `data`, `resetThrottle`, `fixtureDb`, `GlobalStubsModule`, `fleetConfig()`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `buildEntry` (catalog) | approvable when a role key, not low risk, not a read | also not in `TEST_HOOK_KEYS` |
| `PENDING_GATE_ROUTES` | 36 `gate-fleet`, 11 `gate-secret` | 18 `gate-fleet` (the thread routes), 11 `gate-secret` |
| `FleetJobTicketEffects` constructor | transitions, repo, events, txManager, audit | the same, then `AfterCommitService` |
| `FleetJobTicketEffects.onRunDispatched` | starts the tickets at once | defers the start loop when a scope is open, else runs it at once |
| `ConfigJobsService.submitRegenerate` | validate, list, create | `(await this.prepareRegenerate(…))()` |
| `ApprovalsService` constructor | store, queries, decisions, budgets, permissions | the same, then `ApprovalExecutionService` |
| `ApprovalsService` | `decide` only | `decide` unchanged, plus `checkDecide`, `recordDecide`, `executeDecided`, `view` |
| `FleetIngestController` constructor | repo, jobs, ingest, activity, txManager, audit | repo, `ApprovalRouteGate` |
| `ProjectKnowledgeController` constructor | search, index, config, queue, audit | search, index, config, `ApprovalRouteGate` |
| `FleetJobsController`, `TicketFleetJobsController`, `ProjectFleetApprovalsController` constructors | no gate | gain `ApprovalRouteGate` (last) |
| the 16 handlers | call the service | run the route gate |

## Out of Scope

- The 18 thread routes (`permissions-p3-approval-gate-threads`) and the 11 `gate-secret` routes.
- The global `POST /fleet/approvals/:id/decide`: it declares only the read key `fleet.approval.read`, which is not approvable, so it stays ungated; it keeps deciding through `ApprovalsService.decide`. A caller holding global `fleet.approval.read` and eligible to decide can still decide there at once, outside a `fleet.approval.decide.*` policy (designer's call; closing it is a later change).
- Regenerating `apps/cli/src/generated` for the new 202 responses: only `openapi.json` is regenerated, as in 5c-2.
- Changing any catalog default: these keys stay `none`.
- Running a service's domain checks before a request opens, beyond the handler checks listed in Design.
- Assistant or MCP writes on these keys: they keep their primary command.
- Any change to `apps/web` or `apps/cli`.
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`: the test-hook rule is code (`TEST_HOOK_KEYS`), not an inventory column.
- Reproducing the `activeJobId` of the 409 `fleet.jobs` / `fleet.configJobActive` body on a deferred job create that loses the active-job race: the request settles `failed` (Design).
- The activity rows of the ingest and job writes still record `actorType: 'USER'` for an agent actor, as today.
- A transaction timeout other than Prisma's default for the execution transaction: a deferred dispatch's placement and a deferred backfill run inside it as they are.
- Bounding the size of a frozen input: `DispatchFleetJobDto`, `SubmitConfigEditDto.edits` and the patterns list are stored whole in `ApprovalRequest.input` when a request waits.
- US-002 only: retrying a ticket auto-start that failed after commit; it is logged, as today.
- US-007 only: telling the reindex's executed 202 from its pending 202 by status code; the body tells them apart (Design).
- US-008 only: the inner request's execution failure after an approved outer decide is logged by `afterCommit`, as 5a's decide does; the outer request stays `executed`.
- `endpoint.e2e.spec.ts` coverage for every gated route: US-009 adds two representative 202 cases.

## Stories

1. **US-001: Test-hook keys stop being approvable** — `Workdir: apps/api` — No dependencies.
2. **US-002: Gated job dispatch and requeue, and the ticket auto-start after commit** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Gated job cancel and ticket-job unlink** — `Workdir: apps/api` — Depends on US-002 (same controller and commands class). US-003 extends `FleetJobRouteCommands` and its spec (both created by US-002) with the `cancel` command and its registration and run cases.
4. **US-004: Gated schedule create, update, enable and disable** — `Workdir: apps/api` — Depends on US-001.
5. **US-005: Gated config edit and regenerate** — `Workdir: apps/api` — Depends on US-001.
6. **US-006: Ingest writes move to `IngestRequeueService` and are gated** — `Workdir: apps/api` — Depends on US-001.
7. **US-007: Knowledge writes move to `KnowledgeIndexAdmin` and are gated** — `Workdir: apps/api` — Depends on US-001.
8. **US-008: Gated project fleet decide** — `Workdir: apps/api` — Depends on US-001.
9. **US-009: Contract, OpenAPI and endpoint coverage** — `Workdir: apps/api` — Depends on US-003, US-004, US-005, US-006, US-007, US-008.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/src/approvals/approvable-keys.ts`

**US-002**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`
- `apps/api/src/permissions/after-commit.service.ts`
- `apps/api/test/integration/fleet/gated-project-fleet-routes.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/jobs/fleet-job-route.commands.ts` — created by US-002, extended here
- `apps/api/src/fleet/tickets/fleet-tickets.service.ts`
- `apps/api/src/fleet/schedules/schedule-route.commands.ts`
- `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/schedules/schedules.service.ts`
- `apps/api/test/integration/fleet/gated-project-fleet-routes.integration.spec.ts`

**US-005**
- `apps/api/src/fleet/repo-config/config-jobs.service.ts`
- `apps/api/test/integration/fleet/gated-project-fleet-routes.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/common/committed-effects.ts`
- `apps/api/test/integration/fleet/fleet-ingest-api.integration.spec.ts`

**US-007**
- `apps/api/src/fleet/knowledge/knowledge-index.service.ts`
- `apps/api/src/fleet/knowledge/knowledge-index.queue.ts`
- `apps/api/test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts`

**US-008**
- `apps/api/src/approvals/approval-route.commands.ts`
- `apps/api/src/approvals/approval-decision.service.ts`
- `apps/api/test/integration/fleet/fleet-approvals-decide.integration.spec.ts`
- `apps/api/test/helpers/fleet-ask-fixtures.ts`

**US-009**
- `apps/api/scripts/export-spec.cjs`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`

### Creates

**US-001**

None: US-001 only changes existing files.

**US-002**
- `apps/api/src/fleet/jobs/fleet-job-route.commands.ts`
- `apps/api/src/fleet/jobs/fleet-job-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-fleet-job-routes.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/tickets/ticket-fleet-job-route.commands.ts`
- `apps/api/src/fleet/tickets/ticket-fleet-job-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-fleet-cancel-unlink-routes.integration.spec.ts`

**US-004**
- `apps/api/test/integration/fleet/gated-fleet-schedule-write-routes.integration.spec.ts`

**US-005**
- `apps/api/test/integration/fleet/gated-fleet-config-edit-routes.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/ingest/ingest-requeue.service.ts`
- `apps/api/src/fleet/ingest/ingest-requeue.service.spec.ts`
- `apps/api/src/fleet/ingest/ingest-route.commands.ts`
- `apps/api/src/fleet/ingest/ingest-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-fleet-ingest-routes.integration.spec.ts`

**US-007**
- `apps/api/src/fleet/knowledge/knowledge-index-admin.service.ts`
- `apps/api/src/fleet/knowledge/knowledge-index-admin.service.spec.ts`
- `apps/api/src/fleet/knowledge/knowledge-route.commands.ts`
- `apps/api/src/fleet/knowledge/knowledge-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-fleet-knowledge-routes.integration.spec.ts`

**US-008**
- `apps/api/src/fleet/approvals/fleet-approval-route.commands.ts`
- `apps/api/src/fleet/approvals/fleet-approval-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-fleet-approval-decide-route.integration.spec.ts`

**US-009**

None: US-009 only changes existing files.

### Modifies

Controller unit specs: a gated handler's cases assert the `ApprovalRouteGate.run` call and the executed/pending mapping (their gate double answers `{ status: 'executed', result }`), and the service call each one asserted moves to the story's commands spec or new service spec. No existing integration or e2e test has an agent write on these routes under a policy for the key, so none changes behaviour: with no policy, a gated route executes at once and its audit entry still records mode `none`.

**US-001**
- `apps/api/src/permissions/catalog.ts` — TEST_HOOK_KEYS (exported); buildEntry answers approvable false (floor and default none) for its members
- `apps/api/src/permissions/catalog.spec.ts` — the "derives … for every catalog key" case's local approvable rule also excludes TEST_HOOK_KEYS members (import TEST_HOOK_KEYS), so its derivation matches the catalog
- `apps/api/src/permissions/pending-gate-routes.ts` — the two test-hook rows are deleted
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the "AC-3: keeps exactly 36 fleet and 11 secret rollout assignments" case asserts only the gate-secret count (11), until US-009
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the "collects exactly 81 gated routes" case becomes "at least 81" (its title follows); US-009 restores an exact count

**US-002**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/fleet/jobs and POST /projects/:slug/fleet/jobs/:id/requeue
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides FleetJobRouteCommands
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` — constructor gains ApprovalRouteGate (last); dispatch and requeue gated
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — constructor gains AfterCommitService (last); onRunDispatched defers its start loop when a scope is open
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.spec.ts` — every construction (lines 20, 57 and 185) passes `new AfterCommitService()` as the 6th argument; existing start assertions still hold (no scope is open there); the deferred-start cases
- `apps/api/src/fleet/ingest/bundle-ingest.workflow.spec.ts` — its FleetJobTicketEffects construction (about line 119) passes `new AfterCommitService()` as the 6th argument; no assertion changes

**US-003**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/fleet/jobs/:id/cancel and DELETE /projects/:slug/tickets/:ref/fleet-jobs/:jobId
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — requesterOf
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — the requesterOf cases
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` — cancel checks the key or the requester, then gates with keyCheck false
- `apps/api/src/fleet/tickets/fleet-tickets.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides TicketFleetJobRouteCommands
- `apps/api/src/fleet/tickets/ticket-fleet-jobs.controller.ts` — constructor gains ApprovalRouteGate (last); unlink gated

**US-004**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/fleet/schedules, PATCH /projects/:slug/fleet/schedules/:id and POST …/:id/enable and …/:id/disable
- `apps/api/src/fleet/schedules/schedule-route.commands.ts` — create, update, enable and disable commands
- `apps/api/src/fleet/schedules/schedule-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/fleet/schedules/project-fleet-schedules.controller.ts` — create, update, enable and disable gated; the private canAdminister helper is removed (the commands compute it), and the constructor drops PermissionService (its only use)

**US-005**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/fleet/repos/:repoId/config-edits and POST …/config-edits/regenerate
- `apps/api/src/fleet/repo-config/config-jobs.service.ts` — prepareRegenerate; submitRegenerate runs it
- `apps/api/src/fleet/repo-config/config-jobs.service.spec.ts` — the prepareRegenerate cases; existing submitRegenerate assertions still hold
- `apps/api/src/fleet/repo-config/repo-config-route.commands.ts` — configEdit and regenerate commands
- `apps/api/src/fleet/repo-config/repo-config-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/fleet/repo-config/project-repo-config.controller.ts` — submitEdit and submitRegenerate gated
- `apps/api/src/fleet/repo-config/project-repo-config.controller.spec.ts` — gains the US-005 AC-11 case (the gate call); its route-metadata cases stay unchanged

**US-006**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /fleet/ingest/backfill, POST /fleet/ingest/jobs/:jobId/rerun and POST /fleet/ingest/rerun-outdated
- `apps/api/src/fleet/ingest/ingest.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides IngestRequeueService and IngestRouteCommands
- `apps/api/src/fleet/ingest/fleet-ingest.controller.ts` — constructor becomes (BUNDLE_INGEST_REPOSITORY, ApprovalRouteGate); the three write handlers gated; the private queue helper moves to IngestRequeueService

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PUT /projects/:slug/knowledge/patterns and POST /projects/:slug/knowledge/repos/:repoId/reindex
- `apps/api/src/fleet/knowledge/knowledge.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides KnowledgeIndexAdmin and KnowledgeRouteCommands
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — constructor becomes (search, index, config, ApprovalRouteGate); patterns and reindex gated; acceptPatterns and queuePasses move out; the reindex drops its own 202 `@ApiResponse`
- `apps/api/src/fleet/knowledge/project-knowledge.controller.spec.ts` — the controller construction (about line 91) passes a gate double instead of the queue and audit doubles; the patterns and reindex save/queue cases (about lines 328-460) move to knowledge-index-admin.service.spec.ts and knowledge-route.commands.spec.ts; the handler cases assert the gate call; the kill-switch reindex case stays (409 before the gate); the two HTTP `Test.createTestingModule` blocks (about lines 500 and 802, describes from about line 470 to the end) provide an `ApprovalRouteGate` double (`{ run: vi.fn() }`) instead of the queue and audit providers, and their HTTP reindex and patterns cases (about lines 682-785) assert the gate call instead of the save/queue, those behaviours now living in gated-fleet-knowledge-routes.integration.spec.ts and the new unit specs
- `apps/api/src/fleet/knowledge/knowledge.module.spec.ts` — also resolves KnowledgeIndexAdmin and KnowledgeRouteCommands

**US-008**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/fleet/approvals/:id/decide
- `apps/api/src/fleet/approvals/approvals.service.ts` — constructor gains ApprovalExecutionService (last); checkDecide, recordDecide, executeDecided and view beside the unchanged decide
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — its construction (about line 78) passes an ApprovalExecutionService double as the 6th argument; every existing decide assertion still holds (decide still calls `decisions.decide`); the new methods' cases add `recordDecision` to the decisions double
- `apps/api/src/fleet/approvals/approvals.module.ts` — imports AuthRepositoryModule; provides FleetApprovalRouteCommands
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts` — constructor gains ApprovalRouteGate (last); decide gated
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.spec.ts` — the construction (about line 19) passes a gate double; the decide cases assert checkDecide, the gate call and the executed mapping

**US-009**
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 97
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the counts case asserts 18 gate-fleet and 11 gate-secret entries and size 29
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — gatedOperations gains the 16 operations (the reindex among them); the reindexOperation constant and its spread are deleted, so the AC-8 case expects exactly gatedOperations
- `openapi.json` — regenerated: the 16 gated operations list 202
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — two 202 cases (US-009 AC-7, AC-8)

### Seams

- US-001 → US-002 to US-008: `seedWaitPolicy` makes each story's 202 path reachable.
- 5a to 5c-2 → US-002 to US-008: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`, `routeCommand` (with `prepare`, `afterCommit`, `skipKeyRecheck`), `parseRouteInput`.
- US-002 → US-003: one controller (`FleetJobsController`) and one commands class (`FleetJobRouteCommands`).
- US-002: `AfterCommitService.defer` → `ApprovalExecutionService` scope; US-002 AC-4 (the approved RUN dispatch starts its ticket) crosses both.
- US-006, US-007: `committedEffect` → `withCommittedEffects` in the execution; US-006 AC-4 and US-007 AC-4 cross it.
- US-008: `checkDecide` → `ApprovalRouteGate.run` → `recordDecide`, then `afterCommit` → `ApprovalExecutionService.execute`; US-008 AC-3 crosses all of it.
- US-002 to US-008 → US-009: every gated route has left the allowlist; US-009 restores the exact counts and regenerates `openapi.json`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `gated-project-fleet-routes.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token, the users `dev` (developer on project `web`, called P below), `viewer` and `outsider`, and the fleet repository `world.repoId` on P; `seedFleetHttpAgent` gives an agent and its API key;
- an agent "holding a key in P" is bound `['project.read', <the keys>]` in P with `grantKeys`, followed by `PermissionCache.invalidate()`; "holding a global key" is the same binding with no project;
- "under a wait policy" means `seedWaitPolicy(db, <the route's key>, <P's id>)` (or `null` for a global key) ran in that test; each file deletes every `ApprovalPolicy`, `ApprovalDecision` and `ApprovalRequest` row, and the fleet rows it writes, in `beforeEach`.

Each AC is its own test with its own rows, per `.nax/rules/api-test-isolation.md`: features, names and refs are unique per test, and "Approving AC-n's request" means the test repeats AC-n's call and approves the request it opened. "Approving" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means the response status is 202 and `data` is the pending request summary. "The agent's pending X" means X sent by that agent under a wait policy, which answered 202. A dispatch body is `{ repoId: world.repoId, command: 'RUN', feature: <unique>, maxCostUsd: 5 }` unless the AC says otherwise (a PLAN needs `planFrom`, `normalizeDispatch`). A linked job (US-003) is dispatched by root with that body and `ticketRefs: [<a ticket of P>]`. Each AC pins one behaviour; a tail such as "and writes no `ApprovalRequest` row" is part of the behaviour it follows (sizing ruling 2026-10-26: specs plan at their bullet counts). Every prototype stub and spy is restored in `afterEach` (`vi.restoreAllMocks()`), per `.nax/rules/api-test-isolation.md`.

### US-001: Test-hook keys stop being approvable

- AC-1 [unit] `findCatalogEntry(key)?.approval` equals `{ approvable: false, floor: 'none', default: 'none' }` for each of `testhook.schedule.fire` and `testhook.nax-files.seed` (one `it.each` row each).
- AC-2 [unit] `findCatalogEntry('testhook.schedule.fire')?.risk` is still `medium`.
- AC-3 [unit] `approvableKeys()` contains neither `testhook.schedule.fire` nor `testhook.nax-files.seed`.
- AC-4 [unit] `findCatalogEntry('fleet.ingest.backfill')?.approval.approvable` is still true.
- AC-5 [unit] `PENDING_GATE_ROUTES.has(route)` is false for each of `POST /fleet/test-hooks/schedules/:id/fire` and `PUT /fleet/test-hooks/repos/:repoId/nax-files` (one `it.each` row each).
- AC-6 [unit] `validateApprovalPolicy` for a policy whose `permissionPattern` is `testhook.schedule.fire` answers `pattern`.

### US-002: Gated job dispatch and requeue, and the ticket auto-start after commit

The agent holds `fleet.job.dispatch` and `fleet.job.requeue` in P.

- AC-1 [integration] `POST /api/projects/web/fleet/jobs` with a dispatch body by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'fleet.job.dispatch', projectId: <P's id> }`.
- AC-2 [integration] After AC-1's request, before approval, no `FleetJob` row with that feature exists.
- AC-3 [integration] Approving AC-1's request leaves exactly one `QUEUED` `FleetJob` with that feature whose `requestedById` is the agent's id, and the request's `result.job.id` is that job's id.
- AC-4 [integration] Approving the agent's pending `RUN` dispatch with `ticketRefs: [<a CREATED ticket of P>]` leaves that ticket `IN_PROGRESS`.
- AC-5 [integration] Approving the agent's pending dispatch after root dispatched the same repository and feature while it waited settles the request `failed`, and exactly one `FleetJob` with that feature exists.
- AC-6 [integration] `POST /api/projects/web/fleet/jobs` with the root token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-7 [integration] `POST /api/projects/web/fleet/jobs/<job>/requeue` for a `CANCELLED` job by the agent under a wait policy answers 202 with `data.permissionKey` `fleet.job.requeue`.
- AC-8 [integration] Approving AC-7's request leaves the job `QUEUED`.
- AC-9 [integration] The `ApprovalRequest` row AC-1 opened has `variant` `rest:fleet-jobs.dispatch` and an `input.dispatch.feature` equal to the sent feature.
- AC-10 [unit] After `onModuleInit`, the registry answers `fleet.job.dispatch` for `rest:fleet-jobs.dispatch` and `fleet.job.requeue` for `rest:fleet-jobs.requeue`.
- AC-11 [unit] The `rest:fleet-jobs.dispatch` command's run for a principal with id `a1` calls `jobs.dispatch('a1', 'p1', <the dto>, { ticketActor: { principal: <that principal>, projectSlug: 'web' } })` for input `{ slug: 'web', projectId: 'p1', dispatch: <the dto> }`.
- AC-12 [unit] The `rest:fleet-jobs.requeue` command's run for a principal with id `a1` calls `jobs.requeue('a1', 'p1', 'j1')` for input `{ slug: 'web', projectId: 'p1', id: 'j1' }`.
- AC-13 [unit] Inside `AfterCommitService.scope`, `FleetJobTicketEffects.onRunDispatched(actor, [<a CREATED ticket>])` calls `transitions.startForDispatch` only after the scope's callback has returned.
- AC-14 [unit] Outside any scope, `onRunDispatched(actor, [<a CREATED ticket>])` calls `transitions.startForDispatch` before it answers.
- AC-15 [integration] `POST /api/projects/web/fleet/jobs` by the agent with no policy seeded answers 201 and writes no `ApprovalRequest` row.

### US-003: Gated job cancel and ticket-job unlink

The keyed agent holds `fleet.job.cancel` and `fleet.ticket-job.unlink` in P. The requester agent holds `fleet.job.dispatch` in P and no `fleet.job.cancel`. Each cancel test inserts its own `QUEUED` job.

- AC-1 [integration] `POST /api/projects/web/fleet/jobs/<job>/cancel` by the keyed agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'fleet.job.cancel', projectId: <P's id> }`.
- AC-2 [integration] Approving AC-1's request leaves the job `CANCELLED`, and the request's `result.state` is `CANCELLED`.
- AC-3 [integration] `POST …/jobs/<job>/cancel` by the requester agent on a job it requested, under a wait policy, answers 202 with `data.permissionKey` `fleet.job.cancel`.
- AC-4 [integration] Approving AC-3's request leaves the job `CANCELLED`.
- AC-5 [integration] `POST …/jobs/<job>/cancel` by the requester agent on a job `dev` requested answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-6 [integration] `POST …/jobs/<unknown id>/cancel` by the keyed agent under a wait policy answers 404 with key `fleet.jobs` and writes no `ApprovalRequest` row.
- AC-7 [integration] Approving the keyed agent's pending cancel after root cancelled the same job while it waited settles the request `failed`.
- AC-8 [integration] `DELETE /api/projects/web/tickets/<ref>/fleet-jobs/<job>` on a linked job by the keyed agent under a wait policy answers 202 with `data.permissionKey` `fleet.ticket-job.unlink`.
- AC-9 [integration] Approving AC-8's request removes the ticket's link to that job.
- AC-10 [integration] The same `DELETE` with the root token under a wait policy answers 204 with an empty body and writes no `ApprovalRequest` row.
- AC-11 [unit] `FleetJobsService.requesterOf('p1', 'j1')` answers the job's `requestedById`, and throws `NotFoundAppException` with key `fleet.jobs` for a job of another project.
- AC-12 [unit] The `rest:fleet-jobs.cancel` command's run for a principal with id `a1` whose `permissions.can('fleet.job.cancel')` is denied calls `jobs.cancel('a1', 'p1', 'j1', false)` for input `{ slug: 'web', projectId: 'p1', id: 'j1' }`.
- AC-13 [unit] After `onModuleInit`, the registries answer `fleet.job.cancel` for `rest:fleet-jobs.cancel` (with `skipKeyRecheck` true) and `fleet.ticket-job.unlink` for `rest:ticket-fleet-jobs.unlink`.
- AC-14 [unit] The `rest:ticket-fleet-jobs.unlink` command's run for a principal with id `a1` calls `fleetTickets.unlink('p1', 'WEB-1', 'j1', 'a1')` and answers `null`.
- AC-15 [integration] Approving the keyed agent's pending unlink after root unlinked the same job while it waited settles the request `failed`.

### US-004: Gated schedule create, update, enable and disable

The keyed agent holds `fleet.schedule.create` and `fleet.schedule.update` in P. The own-only agent holds `fleet.schedule.update.own` in P. Each update test creates its own schedule as `dev` (`{ name, repoId: world.repoId, feature, cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 5 }`).

- AC-1 [integration] `POST /api/projects/web/fleet/schedules` by the keyed agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'fleet.schedule.create', projectId: <P's id> }`.
- AC-2 [integration] Approving AC-1's request leaves exactly one schedule with that name whose `createdById` is the agent's id.
- AC-3 [integration] `PATCH /api/projects/web/fleet/schedules/<schedule>` `{ maxCostUsd: 7 }` by the keyed agent under a wait policy answers 202 with `data.permissionKey` `fleet.schedule.update`.
- AC-4 [integration] Approving AC-3's request leaves the schedule's `maxCostUsd` 7.
- AC-5 [integration] Approving the keyed agent's pending `POST …/schedules/<schedule>/disable` leaves the schedule disabled.
- AC-6 [integration] Approving the keyed agent's pending `POST …/schedules/<schedule>/enable` on a disabled schedule leaves it enabled.
- AC-7 [integration] Approving the own-only agent's pending `PATCH …/schedules/<dev's schedule>` settles the request `failed`, and the schedule keeps its `maxCostUsd`.
- AC-8 [integration] `POST /api/projects/web/fleet/schedules` with the `dev` token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-9 [integration] `PATCH …/schedules/<schedule>` by an agent holding only `project.read` in P answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-10 [unit] After `onModuleInit`, the registry answers `fleet.schedule.create` for `rest:project-fleet-schedules.create`, and `fleet.schedule.update` for each of `rest:project-fleet-schedules.update`, `.enable` and `.disable`.
- AC-11 [unit] The `rest:project-fleet-schedules.update` command's run for a principal with id `a1` whose `permissions.can('fleet.schedule.update', { projectId: 'p1' })` is allowed calls `schedules.update('a1', 'p1', 's1', { maxCostUsd: 7 }, true)`.
- AC-12 [unit] The `rest:project-fleet-schedules.enable` command's run for a principal whose `can` is denied calls `schedules.enable(<its id>, 'p1', 's1', false)`.

### US-005: Gated config edit and regenerate

The agent holds `fleet.job.config.edit` in P. `FLEET_REPO_FILES_READER`'s `list` is spied in `beforeEach` to answer `{ baseSha: 'c'.repeat(40), defaultBranch: 'trunk', files: [] }` and restored in `afterEach`, so each test counts its own calls.

- AC-1 [integration] `POST /api/projects/web/fleet/repos/<repo>/config-edits` `{ edits: [<one valid edit>], prTitle: 'Edit', baseSha: 'c'.repeat(40) }` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'fleet.job.config.edit', projectId: <P's id> }`.
- AC-2 [integration] Approving AC-1's request leaves exactly one `CONFIG_EDIT` job on the repository whose `requestedById` is the agent's id.
- AC-3 [integration] `POST …/config-edits/regenerate` `{ prTitle: 'Regen' }` by the agent under a wait policy answers 202 with `data.permissionKey` `fleet.job.config.edit`.
- AC-4 [integration] After AC-3's request, before approval, the reader's `list` was not called.
- AC-5 [integration] Approving AC-3's request leaves exactly one `CONFIG_EDIT` job whose config edit has mode `regenerate` and base sha `'c'.repeat(40)`.
- AC-6 [integration] Approving the agent's pending regenerate while `list` rejects settles the request `failed` with `result.error` `execution-failed`, and no config job exists.
- AC-7 [integration] `POST …/config-edits` with the root token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-8 [unit] The callback of `ConfigJobsService.prepareRegenerate('a1', 'p1', 'r1', { prTitle: 'Regen' })` throws `ConflictAppException` with key `fleet.repos` when the repository changed after the prepare, and creates no job.
- AC-9 [unit] `prepareRegenerate` throws `NotFoundAppException` with key `fleet.repos` for a repository of another project, and never calls `list`.
- AC-10 [unit] After `onModuleInit`, the registry answers `fleet.job.config.edit` for `rest:project-repo-config.config-edit` (no `prepare`) and for `rest:project-repo-config.regenerate` (with a `prepare`).
- AC-11 [unit] `ProjectRepoConfigController.submitEdit('r1', body, <ctx of P>, principal)` calls `routeGate.run` with `{ key: 'fleet.job.config.edit', variant: 'rest:project-repo-config.config-edit', projectId: <P's id>, input: { slug: 'web', projectId: <P's id>, repoId: 'r1', edit: body } }`.

### US-006: Ingest writes move to `IngestRequeueService` and are gated

The agent holds global `fleet.ingest.backfill` and `fleet.ingest.rerun`. Each test seeds its own job with a bundle artifact, as `fleet-ingest-api.integration.spec.ts` does. `BundleIngestService.prototype.kick` is spied with `mockImplementation(() => undefined)`, so no drain runs.

- AC-1 [integration] `POST /api/fleet/ingest/backfill` by the agent under a global wait policy answers 202 with `data` matching `{ permissionKey: 'fleet.ingest.backfill', projectId: null }`.
- AC-2 [integration] After AC-1's request, before approval, the seeded artifact has no ingest row, and `kick` was not called.
- AC-3 [integration] Approving AC-1's request leaves one ingest row for the seeded artifact and the request `result` `{ queued: 1 }`.
- AC-4 [integration] Approving AC-1's request calls `kick` exactly once.
- AC-5 [integration] `POST /api/fleet/ingest/jobs/<job>/rerun` by the agent under a global wait policy answers 202 with `data.permissionKey` `fleet.ingest.rerun`.
- AC-6 [integration] Approving the agent's pending rerun of a job whose `FleetJob` row the test deleted while it waited settles the request `failed`.
- AC-7 [integration] Approving the agent's pending `POST /api/fleet/ingest/rerun-outdated` with one seeded `done` ingest row whose `parserVersion` is below `INGEST_PARSER_VERSION` leaves the request `executed` with `result` `{ queued: 1 }`.
- AC-8 [integration] `POST /api/fleet/ingest/backfill` with the root token under a global wait policy answers 201 and writes no `ApprovalRequest` row, and the agent's backfill with no policy seeded answers 201 and writes none either.
- AC-9 [integration] `POST /api/fleet/ingest/backfill` by an agent holding only `project.read` globally answers 403 with key `permissions`.
- AC-10 [unit] `IngestRequeueService.rerunJob('u1', 'missing')` throws `NotFoundAppException` with key `fleet.jobs` and writes nothing.
- AC-11 [unit] `IngestRequeueService.backfill('u1')` with the repository answering 0 records no audit entry and answers `{ queued: 0 }`.
- AC-12 [unit] Inside `withCommittedEffects`, `IngestRequeueService.backfill('u1')` calls `kick` only after the scope's callback has returned.
- AC-13 [unit] After `onModuleInit`, the registry answers `fleet.ingest.backfill` for `rest:fleet-ingest.backfill`, and `fleet.ingest.rerun` for `rest:fleet-ingest.rerun-job` and `rest:fleet-ingest.rerun-outdated`.
- AC-14 [unit] The `rest:fleet-ingest.rerun-job` command's run for a principal with id `a1` calls `ingestRequeue.rerunJob('a1', 'j1')` for input `{ jobId: 'j1' }`.

### US-007: Knowledge writes move to `KnowledgeIndexAdmin` and are gated

The agent holds `fleet.knowledge.patterns.update` and `fleet.knowledge.repo.reindex` in P. The reindex tests set `fleetConfig().knowledgeIndexEnabled = true` (restored in `afterEach`) and spy the app's `KnowledgeIndexQueue` instance's `enqueue` with `mockImplementation(() => undefined)`, as `enforce-fleet-config-knowledge.integration.spec.ts` does, so no index pass runs.

- AC-1 [integration] `POST /api/projects/web/knowledge/repos/<repo>/reindex` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'fleet.knowledge.repo.reindex', projectId: <P's id> }`.
- AC-2 [unit] Inside `withCommittedEffects`, `KnowledgeIndexAdmin.savePatterns('p1', null)` with indexing enabled and one project repository calls `enqueue` only after the scope's callback has returned.
- AC-3 [integration] Approving AC-1's request leaves exactly one `fleet.knowledge.repo.reindex` audit entry for the repository.
- AC-4 [integration] Approving AC-1's request calls `enqueue(<repo id>, 'admin')` exactly once.
- AC-5 [integration] `POST …/reindex` with indexing disabled by the agent under a wait policy answers 409 with key `knowledge.disabled` and writes no `ApprovalRequest` row.
- AC-6 [integration] `PUT /api/projects/web/knowledge/patterns` `{ patterns: ['docs/**/*.md'] }` by the agent under a wait policy answers 202 with `data.permissionKey` `fleet.knowledge.patterns.update`.
- AC-7 [integration] Approving AC-6's request leaves P's saved patterns exactly `['docs/**/*.md']`, and the request's `result.patterns` equals them.
- AC-8 [integration] `PUT …/knowledge/patterns` with a body the parser refuses by the agent under a wait policy answers 400 with key `knowledge.input` and writes no `ApprovalRequest` row.
- AC-9 [integration] `POST …/reindex` with the `dev` token under a wait policy answers 202 with `data` `{ queued: true }` and writes no `ApprovalRequest` row.
- AC-10 [unit] `KnowledgeIndexAdmin.reindex('p1', 'missing')` throws `NotFoundAppException` with key `knowledge.repoNotFound` and enqueues nothing, and `reindex('p1', 'r1')` with indexing disabled throws `ConflictAppException` with key `knowledge.disabled` and records no audit entry.
- AC-11 [unit] `KnowledgeIndexAdmin.reindex('p1', 'r1')` enqueues nothing when its audit entry rejects.
- AC-12 [unit] `KnowledgeIndexAdmin.savePatterns('p1', ['docs/**/*.md'])` with indexing disabled saves the list, enqueues nothing and answers `queued` 0.
- AC-13 [unit] `KnowledgeIndexAdmin.savePatterns('p1', null)` with indexing enabled and two project repositories enqueues each repository once with `'admin'` and answers `queued` 2.
- AC-14 [unit] After `onModuleInit`, the registry answers `fleet.knowledge.patterns.update` for `rest:project-knowledge.patterns` and `fleet.knowledge.repo.reindex` for `rest:project-knowledge.reindex`.
- AC-15 [unit] The `rest:project-knowledge.patterns` command's `parse` throws `ValidationAppException` with key `knowledge.input` for input `{ slug: 'web', projectId: 'p1', patterns: [''] }`, and keeps `patterns` `null` for input `{ slug: 'web', projectId: 'p1', patterns: null }`.

### US-008: Gated project fleet decide

Each test seeds its own pending bash ask with the job, runner and lease rows the `bashAsk` helper of `fleet-approvals-decide.integration.spec.ts` (about lines 70-95) writes, through `seedFleetAsk`. The asks carry `approverMustHoldAction: true`, so the agent holds `approval.decide` and `fleet.job.shell.escalate` in P. "The agent's pending deny" is `POST /api/projects/web/fleet/approvals/<ask>/decide` `{ decision: 'deny' }` by the agent under a wait policy for `fleet.approval.decide.bash`.

- AC-1 [integration] The agent's deny answers 202 with `data` matching `{ permissionKey: 'fleet.approval.decide.bash', projectId: <P's id> }`.
- AC-2 [integration] After AC-1's request, before approval, the ask's `ApprovalRequest` row is still `pending`.
- AC-3 [integration] Approving AC-1's request leaves the ask's `ApprovalRequest` row `rejected`.
- AC-4 [integration] Approving the agent's pending deny after root decided the same ask while it waited settles the outer request `failed`, and the ask keeps root's decision.
- AC-5 [integration] `POST …/approvals/<ask>/decide` `{ decision: 'deny' }` by an agent holding only `project.read` in P, under the same policy, answers 403 with key `permissions` and writes no new `ApprovalRequest` row.
- AC-6 [integration] `POST …/approvals/<a decided ask>/decide` by the agent under the same policy answers 409 with key `fleet.approvalNotPending` and writes no new `ApprovalRequest` row.
- AC-7 [integration] `POST …/approvals/<ask>/decide` `{ decision: 'deny' }` with the root token under the same policy answers 200, leaves the ask's `ApprovalRequest` row `rejected` and writes no new `ApprovalRequest` row.
- AC-8 [unit] `ApprovalsService.checkDecide(caller, route, id, { decision: 'deny' }, now)` for a pending bash ask the caller may decide answers `{ key: 'fleet.approval.decide.bash', input: { requestId: id, decision: 'reject', comment: null } }`.
- AC-9 [unit] `checkDecide` for a pending budget ask with `{ decision: 'keep_paused' }` answers `key` `fleet.approval.decide.budget`.
- AC-10 [unit] `ApprovalsService.recordDecide(principal, input)` maps an `ApprovalRequestNotPendingError` and an `ApprovalRequestExpiredError` from `recordDecision` each to `ConflictAppException` with key `fleet.approvalNotPending`.
- AC-11 [unit] After `onModuleInit`, the registry answers `fleet.approval.decide.bash` and `fleet.approval.decide.budget` for `rest:project-fleet-approvals.decide`, each with `skipKeyRecheck` true.
- AC-12 [unit] The command's `afterCommit` for input `{ requestId: 'r1', decision: 'approve', comment: null }` calls `execution.execute('r1')`; for `decision: 'reject'` it calls nothing.
- AC-13 [unit] With the `checkDecide` double answering `{ key: 'fleet.approval.decide.bash', input: { requestId: 'a1', decision: 'approve', comment: null } }`, `ProjectFleetApprovalsController.decide('a1', { decision: 'allow' }, <ctx of P>, principal)` with the gate answering `executed` calls `approvals.executeDecided(principal, 'a1')`, then answers `approvals.view('a1')`.
- AC-14 [unit] With the same `checkDecide` double, the handler calls `routeGate.run` with `{ key: 'fleet.approval.decide.bash', variant: 'rest:project-fleet-approvals.decide', projectId: <P's id>, input: { requestId: 'a1', decision: 'approve', comment: null }, keyCheck: false }`.

### US-009: Contract, OpenAPI and endpoint coverage

- AC-1 [integration] Over the booted app, the collected routes contain exactly 97 gated routes.
- AC-2 [integration] Over the booted app, `findContractViolations` reports no violation.
- AC-3 [unit] `PENDING_GATE_ROUTES` holds exactly 18 `gate-fleet` and 11 `gate-secret` entries and nothing else.
- AC-4 [unit] Every `gate-fleet` entry of `PENDING_GATE_ROUTES` is a route under `/threads` or `/projects/:slug/threads`.
- AC-5 [unit] `openapi.json`'s `post /api/projects/{slug}/fleet/jobs` operation has a `202` response.
- AC-6 [unit] The operations of `openapi.json` with a `202` response are exactly the 97 gated ones.
- AC-7 [integration] In `endpoint.e2e.spec.ts`, `POST /api/fleet/ingest/backfill` with the key of an agent granted global `fleet.ingest.backfill`, under a global wait policy deleted in a `finally`, answers exactly 202.
- AC-8 [integration] In `endpoint.e2e.spec.ts`, `PUT /api/projects/:slug/knowledge/patterns` with the key of an agent granted `fleet.knowledge.patterns.update` in the project, under a wait policy deleted in a `finally`, answers exactly 202.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-5 and AC-6 live in `src/approvals/approval-openapi.contract.spec.ts`.
