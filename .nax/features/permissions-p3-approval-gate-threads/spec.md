# SPEC: Permissions P3e-6 — Gating the Project and Workspace Thread REST Routes

## Summary

This feature finishes the `gate-fleet` rollout. It routes the 18 chat-thread writes through the route gate that `permissions-p3-approval-gate-core` (5a) shipped and 5b to 5d-1 applied.
- **18 routes are gated:**
  - project threads (11): create, cap update, plan, run, stop, end-session, answer, archive, publish, discard, send a message;
  - workspace threads (7): create, send a message, archive, cap update, stop, end-session, answer.
- **Post-commit work leaves the execution transaction.** Archiving a thread with a live job cancels that job after the archive commits ("the terminal transition may win after archive commits"). Inside the execution transaction that cancel would run before the commit. It is deferred through `AfterCommitService`, on both the project and the workspace archive. On the immediate path it runs at once, as today.
- **The project message send's repository read runs outside the transaction.** `ThreadsService.sendMessage` resolves the repository context (a GitHub read through `ProjectBriefService`) before the send transaction today (1c-D1). It moves to a `prepare`, as 5b's drift check and 5d-1's regenerate did.
- **Nothing waits under the shipped defaults.** Every key here is `medium` with catalog default `none`. A request waits only when an approval policy names the key.
- **The contract counts 115 gated routes** after this feature (97 + 18). The allowlist holds only the 11 `gate-secret` rows, and `PendingGateFeature` loses its `gate-fleet` member.

This is the second part of the `gate-fleet` rollout of feature 5 of P3 (`p3-approval-gate`) in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). The first part is `permissions-p3-approval-gate-fleet-ops` (5d-1, merged `e7c88083`).

## Motivation

5a to 5d-1 gated 97 routes. The thread writes still bypass the engine on REST: a policy `thread.message.send → agent` makes nothing wait, because no thread route asks the gate. `PENDING_GATE_ROUTES` lists the 18 thread routes under `gate-fleet`.

**Rulings that bind this feature** (user):
- 2026-10-26 and 2026-10-28 (as in 5a to 5d-1): every approvable REST write route is gated; the deferred run is the command registry; a human acting directly satisfies any mode.
- 2026-10-29: `gate-fleet` is split in two; this feature (5d-2) takes the 18 thread routes.
- 2026-10-29: the story list (9 stories) below.
- 2026-10-29: `POST /projects/:slug/threads/:id/plan` and `/run` gate under `thread.plan` and `thread.run` only. Both routes also require `fleet.job.dispatch`, but a policy naming `fleet.job.dispatch` does not make them wait (Out of Scope), as 5c-1's edge keys.
- 2026-10-29: the four workspace routes whose key check runs in the service (cap update, stop, end-session, answer) read the thread before the gate, gate in its home project, and set `skipKeyRecheck`, because the service re-checks the key at execution (5d-1's cancel).
- 2026-10-29: a message re-sent with the same `clientMessageId` while an earlier send of it waits opens a second request (an identical body folds into the first request through `findPendingDuplicate`; a second opens when the text differs); the second to execute answers the deduplicated message (Out of Scope).
- 2026-10-29: a deferred send, plan, run or discard places its job inside the execution transaction, as 5d-1's deferred dispatch does.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Request checks the handler makes today stay before the gate**, so they answer as today and open no request. The thread handlers make none today except `canOperate` (below); every check runs in the service, so it runs inside the command, at once or after approval, and a failing check settles the request `failed`. This is 5a's rule. The one addition is the workspace pre-read the scope needs (next bullet). It changes two orderings: `WorkspaceThreadsService.updateCap` and `.answer` validate their body (400 `threads.input`) before `requireOwnedThread` today, so a malformed body aimed at a thread that is not the caller's now answers 404 instead of 400; and on the caller's own thread under a wait policy, a malformed cap or answer body opens a request that settles `failed`.
- **The workspace scope reads the thread first where the key lives in the home project.** `PATCH /threads/:id`, `POST /threads/:id/stop`, `/end-session` and `/answer` declare `thread.cap.update`, `thread.stop`, `thread.end-session` and `thread.answer` with `enforcedBy: 'service'`; the service checks them in the thread's home project (`assertThreadKey`). Their handlers call `WorkspaceThreadsService.requireOwnedThread(principal.id, id)` (404 `threads.notFound` for a thread that is not the caller's workspace thread, as today), then gate with `projectId: thread.projectId`. `POST /threads`, `POST /threads/:id/messages` and `POST /threads/:id/archive` declare the workspace keys (`thread.workspace.*`, held globally by the Member role) and gate with `projectId: null`; they read nothing first.
- **`canOperate` is the requester's at execution.** The project handlers compute `canOperate` today with a private helper (`permissions.can(principal, <key>, { projectId })`). Each command computes it again when it runs, as 5d-1's schedule commands compute `canAdminister`. The helper and the controller's `PermissionService` leave `ThreadsController`, which gains `ApprovalRouteGate`.
- **The archive answers the archived thread from the command.** The project and workspace archive handlers answer `threads.get(…)` after the archive today. The archive commands run the archive and then the read, and answer the read, so a deferred archive stores the thread detail as its result.
- **The message send keeps its 200 for a duplicate.** The send commands answer the service's `{ message, jobId, deduplicated }`; `toResult` stores `{ message, jobId }`. On `executed`, the handler sets status 200 when `outcome.result.deduplicated`, then answers `{ message, jobId }`, as today.
- **The project send splits like the drift check.** `ThreadsService.prepareSendMessage(projectId, threadId, userId, input, canOperate)` (new) validates the input (400 `threads.input`), reads the thread and resolves its repository context, and answers a callback that calls the repository's `sendMessage({ …, repoContext, canOperate })` (`ChatThreadRepository`, not `ThreadsService.sendMessage`). `canOperate` is computed before the `prepare`; a grant downgraded from any-row to `.own` between the prepare and the transaction is not re-read (accepted: the in-transaction creator check still applies to a `.own` holder). `sendMessage` becomes `(await this.prepareSendMessage(…))()`. The send transaction re-reads the thread under its row lock, so no target re-check is added to the callback.
- **The archive cancel is deferred.** `ThreadsService.archive` and `WorkspaceThreadsService.archive` hand their `fleetJobs.cancel(…)` (with its `ConflictAppException` catch) to `AfterCommitService.defer(task)`, and run it at once when `defer` answers false. Both services gain `AfterCommitService` (last constructor parameter) and a `private readonly logger = new Logger(<the class>.name)` field. `AfterCommitService` is global (`PermissionsModule`). `AfterCommitService.scope` runs its tasks with no catch, and a throw there escapes the execution's commit, so the deferred task catches and logs every failure (Design snippet); the immediate path keeps today's behaviour (a non-conflict failure propagates). The commands do not use `routeCommand`'s `afterCommit` hook, because the cancel belongs to the service and must also run on the immediate path.
- **A deferred create that loses the unique feature race fails the request.** `ThreadsService.create` catches the `repo_feature` unique violation and throws 409 `threads.featureTaken`. Inside the execution transaction the violation aborts the transaction, and the request settles `failed`. 5d-1's deferred dispatch behaves the same way.
- **The frozen input is ids, slugs and the validated body.** Project inputs carry `slug`, so the execution locks the slug to the request's project (`lockProjectSlug`). Workspace inputs carry the thread id, and the body where there is one.
- **Each gating story removes its own `PENDING_GATE_ROUTES` rows.** US-001 relaxes the exact gated-route count to a lower bound (at least 97), and the allowlist count case to the `gate-secret` count. US-009 restores both exactly and removes the `gate-fleet` label.
- **Only the HTTP handlers change.** Gated handlers keep their parameters, in order.

### The gated routes

Each row is one `routeCommand`. "Scope" is the `projectId` passed to `ApprovalRouteGate.run` (`null` = global; "project" = `@CurrentProject()`'s id; "home" = the pre-read thread's `projectId`). The run is the service call the handler makes today, with `principal` the rebuilt `UserPrincipal | AgentPrincipal`, and `<canOperate>` = `(await permissions.can(principal, <the row's key>, { projectId })).allowed` at execution. Every body-returning command declares `toResult: (result) => result` unless the row says otherwise; a command whose route answers `{}` runs the service, answers `{}` and declares `toResult: (result) => result`. On `executed` the handler answers `JsonResponse.Ok(outcome.result)`.

| Story | Route | Key | Scope | Variant | Input | Run |
|:--|:--|:--|:--|:--|:--|:--|
| US-001 | `POST /projects/:slug/threads` | `thread.create` | project | `rest:threads.create` | `{ slug, projectId, thread: parseBody(CreateThreadDto, …) }` | `threads.create(projectId, principal.id, thread)` |
| US-001 | `PATCH /projects/:slug/threads/:id` | `thread.cap.update` | project | `rest:threads.update` | `{ slug, projectId, id, patch: parseBody(UpdateThreadDto, …) }` | `threads.updateCap(projectId, id, principal.id, patch.maxCostUsd, <canOperate>)` |
| US-001 | `POST /projects/:slug/threads/:id/archive` | `thread.archive` | project | `rest:threads.archive` | `{ slug, projectId, id }` | `threads.archive(projectId, id, principal.id, <canOperate>)`, then `threads.get(projectId, id)` |
| US-002 | `POST /projects/:slug/threads/:id/plan` | `thread.plan` | project | `rest:threads.plan` | `{ slug, projectId, id, plan: parseBody(PlanThreadDto, …) }` | `threads.plan(projectId, id, principal.id, plan, <canOperate>)` |
| US-002 | `POST /projects/:slug/threads/:id/run` | `thread.run` | project | `rest:threads.run` | `{ slug, projectId, id, run: parseBody(RunThreadDto, …) }` | `threads.run(projectId, id, principal.id, run, <canOperate>)` |
| US-003 | `POST /projects/:slug/threads/:id/stop` | `thread.stop` | project | `rest:threads.stop` | `{ slug, projectId, id }` | `threads.stop(projectId, id, principal.id, <canOperate>)`, answering `{}` |
| US-003 | `POST /projects/:slug/threads/:id/end-session` | `thread.end-session` | project | `rest:threads.end-session` | `{ slug, projectId, id }` | `threads.endSession(projectId, id, principal.id, <canOperate>)`, answering `{}` |
| US-003 | `POST /projects/:slug/threads/:id/answer` | `thread.answer` | project | `rest:threads.answer` | `{ slug, projectId, id, answer: parseBody(AnswerQuestionDto, …) }` | `threads.answer(projectId, id, principal.id, answer, <canOperate>)`, answering `{}` |
| US-004 | `POST /projects/:slug/threads/:id/publish` | `thread.publish` | project | `rest:threads.publish` | `{ slug, projectId, id }` | `threads.publish(projectId, id, principal.id, <canOperate>)` |
| US-004 | `POST /projects/:slug/threads/:id/discard` | `thread.discard` | project | `rest:threads.discard` | `{ slug, projectId, id }` | `threads.discard(projectId, id, principal.id, <canOperate>)` |
| US-005 | `POST /projects/:slug/threads/:id/messages` | `thread.message.send` | project | `rest:threads.message` | `{ slug, projectId, id, message: parseBody(SendMessageDto, …) }` | `prepare`: `threads.prepareSendMessage(projectId, id, principal.id, message, <canOperate>)`; run: `threads.sendMessage(…)` with the same arguments; `toResult`: `{ message, jobId }` |
| US-006 | `POST /threads` | `thread.workspace.create` | null | `rest:workspace-threads.create` | `{ thread: parseBody(CreateWorkspaceThreadDto, …) }` | `workspace.create(principal, thread)` |
| US-006 | `POST /threads/:id/archive` | `thread.workspace.archive` | null | `rest:workspace-threads.archive` | `{ id }` | `workspace.archive(principal, id)`, then `workspace.get(principal.id, id)` |
| US-007 | `PATCH /threads/:id` | `thread.cap.update` | home | `rest:workspace-threads.update` | `{ id, patch: parseBody(UpdateThreadDto, …) }` | `workspace.updateCap(principal, id, patch.maxCostUsd)`; `skipKeyRecheck: true` |
| US-007 | `POST /threads/:id/stop` | `thread.stop` | home | `rest:workspace-threads.stop` | `{ id }` | `workspace.stop(principal, id)`, answering `{}`; `skipKeyRecheck: true` |
| US-007 | `POST /threads/:id/end-session` | `thread.end-session` | home | `rest:workspace-threads.end-session` | `{ id }` | `workspace.endSession(principal, id)`, answering `{}`; `skipKeyRecheck: true` |
| US-007 | `POST /threads/:id/answer` | `thread.answer` | home | `rest:workspace-threads.answer` | `{ id, answer: parseBody(AnswerQuestionDto, …) }` | `workspace.answer(principal, id, answer)`, answering `{}`; `skipKeyRecheck: true` |
| US-008 | `POST /threads/:id/messages` | `thread.workspace.message.send` | null | `rest:workspace-threads.message` | `{ id, message: parseBody(SendMessageDto, …) }` | `workspace.sendMessage(principal, id, message)`; `toResult`: `{ message, jobId }` |

- Id and string members are read with `parseRouteInput`; a body member with `parseBody` of the route's DTO (a missing body member is parsed as `{}`).
- The project message command's `prepare` answers the service's callback; `run` (the immediate path's `execute`) calls `sendMessage`, which runs the same prepare and callback.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `ThreadRouteCommands`, `THREAD_ROUTE_VARIANTS` | `fleet/threads/thread-route.commands.ts` | new: `create`, `update`, `archive` (US-001); `plan`, `run` (US-002); `stop`, `endSession`, `answer` (US-003); `publish`, `discard` (US-004); `message` (US-005) |
| `WorkspaceThreadRouteCommands`, `WORKSPACE_THREAD_ROUTE_VARIANTS` | `fleet/threads/workspace-thread-route.commands.ts` | new: `create`, `archive` (US-006); `update`, `stop`, `endSession`, `answer` (US-007); `message` (US-008) |
| `ThreadsService.prepareSendMessage` | `fleet/threads/threads.service.ts` | new (US-005) |

### Module wiring

| Story | Module | Gains | Controllers whose constructor gains `ApprovalRouteGate` |
|:--|:--|:--|:--|
| US-001 | `ThreadsModule` | imports `ApprovalEngineModule`, `AuthRepositoryModule`; provides `ThreadRouteCommands` | `ThreadsController` (last; US-005 then drops `PermissionService`, leaving `(threads, routeGate)`) |
| US-006 | `ThreadsModule` | provides `WorkspaceThreadRouteCommands` | `WorkspaceThreadsController` (last) |

`ApprovalEngineModule` and `AuthRepositoryModule` import nothing that imports `ThreadsModule`, so no module cycle is added. `ThreadRouteCommands` and `WorkspaceThreadRouteCommands` take `ApprovalCommandRegistry`, the thread service, `PermissionService` (project only) and `ActorPrincipalLoader`, as `ScheduleRouteCommands` does. Each gated handler gains `@ApprovalGated()`, keeps its `@Requires`, `@HttpCode` and `@ApiResponse`s, and has the 5a shape:

```ts
const outcome = await this.routeGate.run<ChatThreadRecord>({ key: 'thread.cap.update', variant: THREAD_ROUTE_VARIANTS.update, projectId: ctx.project.id, input: { slug: ctx.project.slug, projectId: ctx.project.id, id, patch: dto } });
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return JsonResponse.Ok(outcome.result);
```

A workspace route that gates in the home project:

```ts
const thread = await this.threads.requireOwnedThread(principal.id, id);
const outcome = await this.routeGate.run<Record<string, never>>({ key: 'thread.stop', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.stop, projectId: thread.projectId, input: { id } });
```

The deferred archive cancel:

```ts
const cancel = async () => {
  try { await this.fleetJobs.cancel(userId, projectId, jobId, true); }
  catch (error) { if (!(error instanceof ConflictAppException)) throw error; }
};
// After commit the archive is done: a failed cancel is logged, never thrown out of the commit.
const deferred = () => cancel().catch((error: unknown) => this.logger.warn(`archive cancel of job ${jobId} failed: ${String(error)}`));
if (!this.afterCommit.defer(deferred)) await cancel();
```

### The allowlist (US-001, US-009)

- US-001 to US-008: each drops its gated routes' rows.
- US-009: the allowlist holds the 11 `gate-secret` rows, and nothing else; `PendingGateFeature` is `'gate-secret'` only.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| An agent under no policy (the shipped default) | Executes at once, no `ApprovalRequest` row | US-001, US-006 |
| A human under a policy for the key | Executes at once, no request | US-001, US-005, US-006 |
| Agent without the route's key | 403 `permissions` from the guard; no request | US-001 |
| An approved project create whose repository + feature got a thread meanwhile | Request `failed`; one thread with that feature | US-001 |
| An approved cap update, by an own-only agent, on another creator's thread | Request `failed`; the cap is unchanged | US-001 |
| An approved archive of a thread with a live job | The job's cancel is requested (`cancelRequestedAt`, a `CANCEL` command) after the commit | US-001 |
| An approved plan of a thread whose spec is not published | Request `failed` (409 `threads.notPublished` inside the service) | US-002 |
| An approved stop, end-session or answer on a thread with no live job | Request `failed` (inside the repository) | US-003 |
| An approved publish or discard whose runner went offline meanwhile | Request `failed` (409 `threads.runnerOffline` inside the repository) | US-004 |
| A project send whose `prepare` throws (repository context read failed) | Request `failed` with `{ error: 'execution-failed', name }` | US-005 |
| A project send body the service refuses | Immediate path: 400 `threads.input`, as today. Waiting: the `prepare` throws and the request settles `failed` | US-005 |
| An approved send whose `clientMessageId` was sent meanwhile | Request `executed`; `result.message` is the earlier message, `result.jobId` null | US-005 |
| An approved workspace archive of a thread with a live job | The job's cancel is requested after the commit | US-006 |
| A workspace route on another principal's thread | 404 `threads.notFound` (home-scoped routes before the gate; global routes inside the command) | US-006, US-007 |
| A workspace cap update or answer with a malformed body | Immediate: 400 `threads.input`, as today. Waiting: opens a request that settles `failed`. Another principal's thread: 404 `threads.notFound` before the body check | US-007 |
| An approved workspace stop after the agent lost `thread.stop` in the home project | Request `failed` (403 `permissions` inside the service) | US-007 |
| An approved workspace send after the agent lost `thread.create` in the home project | Request `failed` (403 `permissions` inside the service) | US-008 |
| An approvable write route that is neither gated nor allowlisted | Contract test fails (5a) | US-009 |

### Integration

**Read-only, verified:**
- `ApprovalRouteGate.run({ key, variant, projectId, input, keyCheck? })`, `ApprovalPending`, `@ApprovalGated()`, `routeCommand(spec, loader)` (with `prepare`, `skipKeyRecheck`, `toResult`), `parseBody`, `parseRouteInput` (5a to 5d-1).
- `ApprovalExecutionService.executeOnce`: `prepare` runs before the transaction. The transaction is `afterCommit.scope(() => withCommittedEffects(() => txManager.run(…)))`. Inside it come the row lock, the key re-check (unless `skipKeyRecheck`), `lockProjectSlug` (for a `rest:` variant whose input has `slug`), then the callback or `execute`. A failed callback settles `failed` with `{ error: 'execution-failed', name }`.
- `ApprovalGate.gate`: under mode `none`, the command's `execute` runs at once, outside any scope or execution transaction; a USER actor executes at once under any mode.
- `txManager.run` joins an open transaction; `RunnerNotifier.notify` already wraps its wake in `committedEffect`; `AfterCommitService.defer(task)` answers false outside a scope.
- `ThreadsService.create`, `.updateCap`, `.plan`, `.run`, `.stop`, `.endSession`, `.answer`, `.archive`, `.publish`, `.discard`, `.sendMessage`, `.get`; `ProjectBriefService.resolveRepoContext`.
- `WorkspaceThreadsService.create`, `.requireOwnedThread`, `.get`, `.updateCap`, `.stop`, `.endSession`, `.answer`, `.sendMessage`, `.archive`.
- `ChatThreadRepository.sendMessage` (its own retry loop and `placement.placeJob`), `.command`, `.archive`, `.publish`, `.discard`.
- Test helpers: `seedWaitPolicy`, `grantKeys` (`src/approvals/test-helpers/approval-fixtures.ts`), `seedFleetHttpWorld`, `seedFleetHttpAgent`, `FLEET_CAPS` (`test/helpers/fleet-fixtures.ts`), `bootHttpApp`, `data`, `resetThrottle`, `fixtureDb`, `GlobalStubsModule`; the `threadRow`, `runner` and `liveJob` fixtures of `test/integration/fleet/permissions-project-threads.integration.spec.ts` (about lines 109-138).

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `PENDING_GATE_ROUTES` | 18 `gate-fleet`, 11 `gate-secret` | 11 `gate-secret` |
| `PendingGateFeature` | `'gate-secret' \| 'gate-fleet'` | `'gate-secret'` |
| `ThreadsController` constructor | `(threads, permissions)` | `(threads, permissions, routeGate)` after US-001; `(threads, routeGate)` after US-005 |
| `WorkspaceThreadsController` constructor | `(threads)` | `(threads, routeGate)` |
| `ThreadsService` constructor | threads, repos, skills, config, fleetJobs, projectBrief | the same, then `AfterCommitService` |
| `WorkspaceThreadsService` constructor | threads, repos, skills, config, projects, access, permissions, fleetJobs | the same, then `AfterCommitService` |
| `ThreadsService.archive`, `WorkspaceThreadsService.archive` | cancel the live job at once | defer the cancel when a scope is open, else run it at once |
| `ThreadsService.sendMessage` | validate, read, resolve, send | `(await this.prepareSendMessage(…))()` |
| the 18 handlers | call the service | run the route gate |

## Out of Scope

- The 11 `gate-secret` routes.
- A policy naming `fleet.job.dispatch` on `POST /projects/:slug/threads/:id/plan` and `/run`: they gate under `thread.plan` and `thread.run` only (ruling 2026-10-29).
- Deduplicating waiting sends: a message re-sent with the same `clientMessageId` and a different text while a send of it waits opens a second request; an identical body folds into the first (ruling 2026-10-29).
- A transaction timeout other than Prisma's default for the execution transaction: a deferred send, plan, run, publish or discard places its job inside it (ruling 2026-10-29; publish places on its new-job branch as discard does).
- Regenerating `apps/cli/src/generated` for the new 202 responses: only `openapi.json` is regenerated, as in 5c-2 and 5d-1.
- Changing any catalog default: these keys stay `none`.
- Running a service's domain checks before a request opens, beyond the workspace pre-read in Design.
- Assistant or MCP thread writes: they keep their primary command.
- Any change to `apps/web` or `apps/cli`, or to the thread event (SSE) routes.
- Bounding the size of a frozen input: a message or answer text (up to 32 KiB) is stored whole in `ApprovalRequest.input` when a request waits.
- The activity rows of the send, discard and publish writes still record `actorType: 'USER'` for an agent actor, as today.
- Retrying an archive cancel that failed after commit; the deferred task logs it (Design).
- `endpoint.e2e.spec.ts` coverage for every gated route: US-009 adds two representative 202 cases.

## Stories

1. **US-001: Gated project thread create, cap update and archive, and the archive cancel after commit** — `Workdir: apps/api` — No dependencies.
2. **US-002: Gated project thread plan and run** — `Workdir: apps/api` — Depends on US-001. US-002 extends `ThreadRouteCommands` and its spec (both created by US-001) with the `plan` and `run` commands.
3. **US-003: Gated project thread stop, end-session and answer** — `Workdir: apps/api` — Depends on US-002 (same controller and commands class, extended as in US-002).
4. **US-004: Gated project thread publish and discard** — `Workdir: apps/api` — Depends on US-003 (same controller and commands class, extended as in US-002).
5. **US-005: Gated project message send, with the repository read in `prepare`** — `Workdir: apps/api` — Depends on US-004 (same controller and commands class, extended as in US-002).
6. **US-006: Gated workspace thread create and archive, and the archive cancel after commit** — `Workdir: apps/api` — Depends on US-001.
7. **US-007: Gated workspace cap update, stop, end-session and answer** — `Workdir: apps/api` — Depends on US-006. US-007 extends `WorkspaceThreadRouteCommands` and its spec (both created by US-006).
8. **US-008: Gated workspace message send** — `Workdir: apps/api` — Depends on US-007 (same controller and commands class, extended as in US-007).
9. **US-009: Contract, OpenAPI and endpoint coverage** — `Workdir: apps/api` — Depends on US-005, US-008.

### Context Files

**US-001**
- `apps/api/src/fleet/threads/threads.service.ts`
- `apps/api/src/fleet/schedules/schedule-route.commands.ts`
- `apps/api/src/permissions/after-commit.service.ts`
- `apps/api/test/integration/fleet/permissions-project-threads.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/threads/thread-route.commands.ts` — created by US-001, extended here
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`

**US-003**
- `apps/api/src/fleet/threads/thread-route.commands.ts` — created by US-001, extended here (with its spec)
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`

**US-004**
- `apps/api/src/fleet/threads/thread-route.commands.ts` — created by US-001, extended here (with its spec)
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`
- `apps/api/test/integration/fleet/thread-discard.integration.spec.ts`

**US-005**
- `apps/api/src/fleet/threads/thread-route.commands.ts` — created by US-001, extended here (with its spec)
- `apps/api/src/fleet/threads/project-brief.service.ts`
- `apps/api/src/fleet/repo-config/config-jobs.service.ts`
- `apps/api/test/integration/fleet/fleet-project-thread-send.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/threads/workspace-threads.service.ts`
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts`

**US-007**
- `apps/api/src/fleet/threads/workspace-thread-route.commands.ts` — created by US-006, extended here

**US-008**
- `apps/api/src/fleet/threads/workspace-thread-route.commands.ts` — created by US-006, extended here

**US-009**
- `apps/api/scripts/export-spec.cjs`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`

### Creates

**US-001**
- `apps/api/src/fleet/threads/thread-route.commands.ts`
- `apps/api/src/fleet/threads/thread-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-project-thread-routes.integration.spec.ts`

**US-002**
- `apps/api/test/integration/fleet/gated-thread-handoff-routes.integration.spec.ts`

**US-003**
- `apps/api/test/integration/fleet/gated-thread-session-routes.integration.spec.ts`

**US-004**
- `apps/api/test/integration/fleet/gated-thread-publish-discard-routes.integration.spec.ts`

**US-005**
- `apps/api/test/integration/fleet/gated-thread-message-route.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/threads/workspace-thread-route.commands.ts`
- `apps/api/src/fleet/threads/workspace-thread-route.commands.spec.ts`
- `apps/api/test/integration/fleet/gated-workspace-thread-routes.integration.spec.ts`

**US-007**
- `apps/api/test/integration/fleet/gated-workspace-thread-session-routes.integration.spec.ts`

**US-008**
- `apps/api/test/integration/fleet/gated-workspace-thread-message-route.integration.spec.ts`

**US-009**

None: US-009 only changes existing files.

### Modifies

US-002 to US-005 also extend `thread-route.commands.ts` and `thread-route.commands.spec.ts` (created by US-001), and US-007 and US-008 extend `workspace-thread-route.commands.ts` and its spec (created by US-006), with their own commands and the registration and run cases; they are not listed below because a story may not list a file an earlier story creates.

Controller unit specs: a gated handler's cases assert the `ApprovalRouteGate.run` call and the executed/pending mapping (their gate double answers `{ status: 'executed', result }`), and the service call each one asserted moves to the story's commands spec. No existing integration or e2e test has an agent write on these routes under a policy for the key, so none changes behaviour: with no policy, a gated route executes at once and its audit entry still records mode `none`.

**US-001**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/threads, PATCH /projects/:slug/threads/:id and POST /projects/:slug/threads/:id/archive
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the "AC-3: keeps exactly 18 fleet and 11 secret rollout assignments" case asserts only the gate-secret count (11), until US-009; the "AC-12: assigns project thread creation to gate-fleet" case is deleted (its row leaves in US-001)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the "collects exactly 97 gated routes" case becomes "at least 97" (its title follows); US-009 restores an exact count
- `apps/api/src/fleet/threads/threads.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides ThreadRouteCommands
- `apps/api/src/fleet/threads/threads.module.spec.ts` — also resolves ThreadRouteCommands
- `apps/api/src/fleet/threads/threads.controller.keys.spec.ts` — the constructor-dependency case expects `['ThreadsService', 'PermissionService', 'ApprovalRouteGate']`; its title no longer calls PermissionService the authorization dependency
- `apps/api/src/fleet/threads/threads.controller.ts` — constructor gains ApprovalRouteGate (last); create, update and archive gated; the private canOperate helper stays until US-005 removes its last use
- `apps/api/src/fleet/threads/threads.service.ts` — constructor gains AfterCommitService (last); archive defers its cancel when a scope is open
- `apps/api/src/fleet/threads/threads.service.spec.ts` — every construction (lines 29, 59, 86, 106, 125, 134, 149, 264, 321, 373, 440, 504 and 520) passes `new AfterCommitService()` as the 7th argument; existing assertions still hold (no scope is open there); the deferred-cancel cases

**US-002**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/threads/:id/plan and POST /projects/:slug/threads/:id/run
- `apps/api/src/fleet/threads/threads.controller.ts` — plan and run gated

**US-003**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/threads/:id/stop, …/end-session and …/answer
- `apps/api/src/fleet/threads/threads.controller.ts` — stop, end-session and answer gated

**US-004**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/threads/:id/publish and …/discard
- `apps/api/src/fleet/threads/threads.controller.ts` — publish and discard gated

**US-005**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/threads/:id/messages
- `apps/api/src/fleet/threads/threads.controller.ts` — sendMessage gated; the private canOperate helper is removed and the constructor drops PermissionService (no use is left), becoming (threads, ApprovalRouteGate)
- `apps/api/src/fleet/threads/threads.service.ts` — prepareSendMessage; sendMessage runs it
- `apps/api/src/fleet/threads/threads.service.spec.ts` — the prepareSendMessage cases; existing sendMessage assertions still hold
- `apps/api/src/fleet/threads/threads.controller.keys.spec.ts` — the constructor-dependency case expects `['ThreadsService', 'ApprovalRouteGate']`

**US-006**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /threads and POST /threads/:id/archive
- `apps/api/src/fleet/threads/threads.module.ts` — provides WorkspaceThreadRouteCommands
- `apps/api/src/fleet/threads/threads.module.spec.ts` — also resolves WorkspaceThreadRouteCommands
- `apps/api/src/fleet/threads/workspace-threads.controller.keys.spec.ts` — the constructor-dependency case expects `['WorkspaceThreadsService', 'ApprovalRouteGate']`
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — constructor gains ApprovalRouteGate (last); create and archive gated
- `apps/api/src/fleet/threads/workspace-threads.controller.spec.ts` — the testing module also provides an `ApprovalRouteGate` double whose `run` answers `{ status: 'executed', result: await <the service double>.create(principal, call.input.thread) }`, so the AC-5 body-whitelist case still answers 400
- `apps/api/src/fleet/threads/workspace-threads.service.ts` — constructor gains AfterCommitService (last); archive defers its cancel when a scope is open
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — both constructions (lines 52 and 147) pass `new AfterCommitService()` as the 9th argument; the deferred-cancel cases
- `apps/api/src/fleet/threads/workspace-turns.spec.ts` — every construction (lines 17, 58 and 72) passes `new AfterCommitService()` as the 9th argument; no assertion changes

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PATCH /threads/:id, POST /threads/:id/stop, …/end-session and …/answer
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — update, stop, end-session and answer read the owned thread, then gate in its home project

**US-008**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /threads/:id/messages
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — send gated

**US-009**
- `apps/api/src/permissions/pending-gate-routes.ts` — PendingGateFeature is 'gate-secret' only; isPendingGateFeature accepts only it
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 115
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the counts case asserts 11 gate-secret entries and size 11; the "AC-4: every fleet rollout route is a thread route" case is deleted (no gate-fleet entry is left)
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — gatedOperations gains the 18 operations; the 'AC-6: 202 responses exist on exactly the 97 gated operations' case's title and `toHaveLength(97)` become 115
- `openapi.json` — regenerated: the 18 gated operations list 202
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — two 202 cases (US-009 AC-6, AC-7)

### Seams

- 5a to 5d-1 → US-001 to US-008: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`, `routeCommand` (with `prepare`, `skipKeyRecheck`, `toResult`), `parseRouteInput`, `seedWaitPolicy`.
- US-001 → US-002 to US-005: one controller (`ThreadsController`) and one commands class (`ThreadRouteCommands`).
- US-006 → US-007, US-008: one controller (`WorkspaceThreadsController`) and one commands class (`WorkspaceThreadRouteCommands`).
- US-001, US-006: `AfterCommitService.defer` → `ApprovalExecutionService` scope; US-001 AC-6 and US-006 AC-5 cross both.
- US-005: `prepare` → `ProjectBriefService.resolveRepoContext` outside the transaction; US-005 AC-2 and AC-4 cross it.
- US-007: `requireOwnedThread` → `ApprovalRouteGate.run` in the home project → `assertThreadKey` at execution; US-007 AC-6 crosses all of it.
- US-001 to US-008 → US-009: every gated route has left the allowlist; US-009 restores the exact counts and regenerates `openapi.json`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `gated-fleet-job-routes.integration.spec.ts` and `permissions-project-threads.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token, the user `dev` (developer on project `web`, called P below) and the fleet repository `world.repoId` on P; `seedFleetHttpAgent` gives an agent and its API key, not rostered with `rosterFleetAgent` (it binds the developer role, which grants `thread.create` and `thread.*.own`); each agent holds only the `grantKeys` bindings its story names, so removing a binding removes the access;
- an agent "holding a key in P" is bound `['project.read', <the keys>]` in P with `grantKeys`, followed by `PermissionCache.invalidate()`; "holding a global key" is the same binding with no project;
- every file sets `fleetConfig().threadsEnabled = true` in `beforeAll` and restores it in `afterAll`;
- a "thread of X" is a `REPO` `ChatThread` row on `world.repoId` inserted directly with `createdById` X, and `createdByType: 'AGENT'` when X is an agent (the `threadRow` fixture shape); a "live job" is a `RUNNING` `THREAD` `FleetJob` with its `SESSION` turn on an online runner advertising `threadWrite` (the `runner` and `liveJob` fixture shapes); a "workspace thread of X" is the same row with `kind: 'WORKSPACE'`, no repository, base ref or feature, and `projectId` P;
- "under a wait policy" means `seedWaitPolicy(db, <the route's key>, <P's id>)` (or `null` for a global key) ran in that test; each file deletes every `ApprovalPolicy`, `ApprovalDecision` and `ApprovalRequest` row, and the thread and fleet rows it writes, in `beforeEach`.

Each AC is its own test with its own rows, per `.nax/rules/api-test-isolation.md`: features, titles and client message ids are unique per test, and "Approving AC-n's request" means the test repeats AC-n's call and approves the request it opened. "Approving" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means the response status is 202 and `data` is the pending request summary. "The agent's pending X" means X sent by that agent under a wait policy, which answered 202. Each AC pins one behaviour; a tail such as "and writes no `ApprovalRequest` row" is part of the behaviour it follows (sizing ruling 2026-10-26: specs plan at their bullet counts). Every prototype stub and spy is restored in `afterEach` (`vi.restoreAllMocks()`), per `.nax/rules/api-test-isolation.md`.

### US-001: Gated project thread create, cap update and archive, and the archive cancel after commit

The keyed agent holds `thread.create`, `thread.cap.update` and `thread.archive` in P. The own-only agent holds `thread.cap.update.own` in P. A create body is `{ kind: 'REPO', repoId: world.repoId, feature: <unique>, title: <unique>, backend: { kind: 'native', model: 'm1' } }`.

- AC-1 [integration] `POST /api/projects/web/threads` with a create body by the keyed agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'thread.create', projectId: <P's id> }`, and no `ChatThread` with that feature exists.
- AC-2 [integration] Approving AC-1's request leaves exactly one `ChatThread` with that feature whose `createdById` is the agent's id.
- AC-3 [integration] `PATCH /api/projects/web/threads/<a thread of dev>` `{ maxCostUsd: 7 }` by the keyed agent under a wait policy answers 202, and approving that request leaves the thread's `maxCostUsd` 7.
- AC-4 [integration] Approving the own-only agent's pending `PATCH …/threads/<a thread of dev>` `{ maxCostUsd: 7 }` settles the request `failed`, and the thread keeps its `maxCostUsd`.
- AC-5 [integration] `POST …/threads/<a thread of dev>/archive` by the keyed agent under a wait policy answers 202, and approving that request leaves the thread `ARCHIVED` and the request's `result.status` `ARCHIVED`.
- AC-6 [integration] Approving the keyed agent's pending archive of a thread of dev with a live job leaves that job's `cancelRequestedAt` set and one `CANCEL` `FleetCommand` for it.
- AC-7 [integration] `POST /api/projects/web/threads` with the `dev` token under a wait policy answers 201 and writes no `ApprovalRequest` row, and the keyed agent's create with no policy seeded answers 201 and writes none either.
- AC-8 [integration] `POST /api/projects/web/threads` by an agent holding only `project.read` in P answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-9 [unit] After `onModuleInit`, the registry answers `thread.create` for `rest:threads.create`, `thread.cap.update` for `rest:threads.update` and `thread.archive` for `rest:threads.archive`.
- AC-10 [unit] The `rest:threads.update` command's run for a principal with id `a1` whose `permissions.can('thread.cap.update', { projectId: 'p1' })` is denied calls `threads.updateCap('p1', 't1', 'a1', 7, false)` for input `{ slug: 'web', projectId: 'p1', id: 't1', patch: { maxCostUsd: 7 } }`.
- AC-11 [unit] Inside `AfterCommitService.scope`, `ThreadsService.archive('p1', 't1', 'u1', true)` with the repository answering job `j1` calls `fleetJobs.cancel('u1', 'p1', 'j1', true)` only after the scope's callback has returned; outside any scope it calls it before it answers.
- AC-12 [unit] `ThreadsController.update('t1', { maxCostUsd: 7 }, <ctx of P>, principal)` calls `routeGate.run` with `{ key: 'thread.cap.update', variant: 'rest:threads.update', projectId: <P's id>, input: { slug: 'web', projectId: <P's id>, id: 't1', patch: { maxCostUsd: 7 } } }` and answers the executed result.
- AC-13 [integration] Approving the keyed agent's pending create after the test inserted a `ChatThread` with the same repository and feature while it waited settles the request `failed`, and exactly one `ChatThread` has that feature.
- AC-14 [unit] Inside `AfterCommitService.scope`, `ThreadsService.archive('p1', 't1', 'u1', true)` with `fleetJobs.cancel` rejecting a non-conflict error resolves without throwing and calls the service's `logger.warn` once; outside any scope the same rejection propagates.

### US-002: Gated project thread plan and run

The agent holds `thread.plan`, `thread.run` and `fleet.job.dispatch` in P. A "plannable thread" is a thread of the agent with `specPublished: true` and `runnerId` an online runner. A completed plan is a `FleetJob` with `command: 'PLAN'`, the thread's `threadId`, `repoId` and `feature`, `planFrom` the thread's `specPath` and `state: 'COMPLETED'` (the fixture shape of `permissions-project-threads.integration.spec.ts`, about lines 405-412).

- AC-1 [integration] `POST /api/projects/web/threads/<a plannable thread>/plan` `{}` by the agent under a wait policy for `thread.plan` answers 202 with `data` matching `{ permissionKey: 'thread.plan', projectId: <P's id> }`, and no `PLAN` `FleetJob` exists for the thread.
- AC-2 [integration] Approving AC-1's request leaves exactly one `PLAN` `FleetJob` for the thread whose `requestedById` is the agent's id, and the request's `result.job.id` is its id.
- AC-3 [integration] Approving the agent's pending plan of a thread whose `specPublished` the test set false while it waited settles the request `failed`, and no `PLAN` job exists for it.
- AC-4 [integration] `POST …/threads/<thread>/run` `{}` on a plannable thread whose latest `PLAN` job is `COMPLETED`, by the agent under a wait policy for `thread.run`, answers 202 with `data.permissionKey` `thread.run`.
- AC-5 [integration] Approving AC-4's request leaves one `RUN` `FleetJob` for the thread.
- AC-6 [integration] `POST …/threads/<a plannable thread>/plan` by the agent under a wait policy for `fleet.job.dispatch` only answers 201 and writes no `ApprovalRequest` row.
- AC-7 [unit] After `onModuleInit`, the registry answers `thread.plan` for `rest:threads.plan` and `thread.run` for `rest:threads.run`.
- AC-8 [unit] The `rest:threads.run` command's run for a principal with id `a1` whose `can('thread.run')` is allowed calls `threads.run('p1', 't1', 'a1', { maxCostUsd: 3 }, true)` for input `{ slug: 'web', projectId: 'p1', id: 't1', run: { maxCostUsd: 3 } }`.

### US-003: Gated project thread stop, end-session and answer

The agent holds `thread.stop`, `thread.end-session` and `thread.answer` in P. Each test inserts its own thread of the agent with a live job whose `requestedById` is the agent's id and `requestedByType` is `'AGENT'` (the answer path refuses a session another principal started, `assertOwnLiveSession`); the answer tests insert the thread with `pendingQuestion: { requestId: 'q1' }` (`ChatThreadRepository.command` refuses an answer without it, 409 `threads.noQuestion`).

- AC-1 [integration] `POST /api/projects/web/threads/<thread>/stop` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'thread.stop', projectId: <P's id> }`, and no `THREAD_STOP_TURN` `FleetCommand` exists for the live job.
- AC-2 [integration] Approving AC-1's request leaves one `THREAD_STOP_TURN` `FleetCommand` for the live job, and the request's `result` is `{}`.
- AC-3 [integration] Approving the agent's pending `POST …/end-session` leaves one `THREAD_CLOSE` `FleetCommand` for the live job.
- AC-4 [integration] Approving the agent's pending `POST …/answer` `{ requestId: 'q1', text: 'yes' }` leaves one `THREAD_ANSWER` `FleetCommand` for the live job whose payload carries `requestId` `q1`.
- AC-5 [integration] Approving the agent's pending stop after the test set the live job `COMPLETED` while it waited settles the request `failed`.
- AC-6 [integration] `POST …/stop` with the root token under a wait policy answers 200 with `data` `{}` and writes no `ApprovalRequest` row.
- AC-7 [unit] After `onModuleInit`, the registry answers `thread.stop` for `rest:threads.stop`, `thread.end-session` for `rest:threads.end-session` and `thread.answer` for `rest:threads.answer`.
- AC-8 [unit] The `rest:threads.answer` command's run for a principal with id `a1` whose `can('thread.answer')` is denied calls `threads.answer('p1', 't1', 'a1', { requestId: 'q1', text: 'yes' }, false)` and answers `{}`.

### US-004: Gated project thread publish and discard

The agent holds `thread.publish` and `thread.discard` in P. Each test inserts its own thread of the agent with `runnerId` an online runner advertising `threadWrite`, as `thread-discard.integration.spec.ts` does. Publish pins only its 202 and command run (AC-4, AC-7): its executed path is the discard's path through the same repository shape, and `thread-publish.integration.spec.ts` keeps covering the publish itself.

- AC-1 [integration] `POST /api/projects/web/threads/<thread>/discard` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'thread.discard', projectId: <P's id> }`, and no `THREAD` `FleetJob` exists for the thread.
- AC-2 [integration] Approving AC-1's request leaves one `THREAD` `FleetJob` for the thread whose turn action is `DISCARD`, and the request's `result.jobId` is its id.
- AC-3 [integration] Approving the agent's pending discard after the test set the runner's `lastSeenAt` an hour back while it waited settles the request `failed`, and no `THREAD` job exists for the thread.
- AC-4 [integration] `POST …/threads/<thread>/publish` by the agent under a wait policy answers 202 with `data.permissionKey` `thread.publish`.
- AC-5 [integration] `POST …/discard` with the root token under a wait policy answers 200 and writes no `ApprovalRequest` row.
- AC-6 [unit] After `onModuleInit`, the registry answers `thread.publish` for `rest:threads.publish` and `thread.discard` for `rest:threads.discard`.
- AC-7 [unit] The `rest:threads.publish` command's run for a principal with id `a1` whose `can('thread.publish')` is allowed calls `threads.publish('p1', 't1', 'a1', true)`.

### US-005: Gated project message send, with the repository read in `prepare`

The agent holds `thread.message.send` in P. Each test inserts its own thread of the agent. `ProjectBriefService.prototype.resolveRepoContext` is spied in `beforeEach` to answer `'ctx'` and restored in `afterEach`, so each test counts its own calls. A send body is `{ text: 'hello', clientMessageId: <unique> }`.

- AC-1 [integration] `POST /api/projects/web/threads/<thread>/messages` with a send body by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'thread.message.send', projectId: <P's id> }`, and no `ChatMessage` with that client message id exists.
- AC-2 [integration] After AC-1's request, before approval, `resolveRepoContext` was not called.
- AC-3 [integration] Approving AC-1's request leaves one user `ChatMessage` with that client message id, and the request's `result.message.id` is its id.
- AC-4 [integration] Approving the agent's pending send while `resolveRepoContext` rejects settles the request `failed` with `result.error` `execution-failed`, and no `ChatMessage` with that client message id exists.
- AC-5 [integration] Approving the agent's pending send after the test deleted the wait policy and the agent sent the same client message id again (201) while it waited settles the request `executed` with `result.jobId` null, and exactly one `ChatMessage` with that client message id exists.
- AC-6 [integration] The same send with the root token under a wait policy answers 201 and writes no `ApprovalRequest` row; repeating it answers 200.
- AC-7 [unit] `ThreadsService.prepareSendMessage('p1', 't1', 'u1', { text: '', clientMessageId: 'c1' }, true)` throws `ValidationAppException` with key `threads.input` and never calls `resolveRepoContext`.
- AC-8 [unit] The callback of `prepareSendMessage('p1', 't1', 'u1', { text: 'hi', clientMessageId: 'c1' }, true)` calls `threads.sendMessage` with `repoContext` the resolved context and `canOperate` true; `resolveRepoContext` was called once, before the callback ran.
- AC-9 [unit] After `onModuleInit`, the registry answers `thread.message.send` for `rest:threads.message`, with a `prepare`.
- AC-10 [unit] The `rest:threads.message` command's `toResult` for `{ message: m, jobId: 'j1', deduplicated: false }` answers `{ message: m, jobId: 'j1' }`.

### US-006: Gated workspace thread create and archive, and the archive cancel after commit

The agent holds global `thread.workspace.create` and `thread.workspace.archive`, and `thread.create` in P. A workspace create body is `{ title: <unique>, backend: { kind: 'native', model: 'm1' }, homeProject: 'web' }`.

- AC-1 [integration] `POST /api/threads` with a workspace create body by the agent under a global wait policy for `thread.workspace.create` answers 202 with `data` matching `{ permissionKey: 'thread.workspace.create', projectId: null }`, and no `ChatThread` with that title exists.
- AC-2 [integration] Approving AC-1's request leaves exactly one `WORKSPACE` `ChatThread` with that title on P whose `createdById` is the agent's id.
- AC-3 [integration] `POST /api/threads/<a workspace thread of the agent>/archive` by the agent under a global wait policy answers 202, and approving that request leaves the thread `ARCHIVED`.
- AC-4 [integration] Approving the agent's pending archive of a workspace thread of `dev` settles the request `failed`, and the thread stays `ACTIVE`.
- AC-5 [integration] Approving the agent's pending archive of a workspace thread of the agent with a live job leaves that job's `cancelRequestedAt` set and one `CANCEL` `FleetCommand` for it.
- AC-6 [integration] `POST /api/threads` with the `dev` token under a global wait policy answers 201 and writes no `ApprovalRequest` row, and the agent's create with no policy seeded answers 201 and writes none either.
- AC-7 [unit] After `onModuleInit`, the registry answers `thread.workspace.create` for `rest:workspace-threads.create` and `thread.workspace.archive` for `rest:workspace-threads.archive`.
- AC-8 [unit] Inside `AfterCommitService.scope`, `WorkspaceThreadsService.archive(principal, 't1')` with the repository answering job `j1` calls `fleetJobs.cancel` only after the scope's callback has returned.
- AC-9 [unit] `WorkspaceThreadsController.create(body, principal)` calls `routeGate.run` with `{ key: 'thread.workspace.create', variant: 'rest:workspace-threads.create', projectId: null, input: { thread: body } }`.
- AC-10 [unit] Inside `AfterCommitService.scope`, `WorkspaceThreadsService.archive(principal, 't1')` with `fleetJobs.cancel` rejecting a non-conflict error resolves without throwing and calls the service's `logger.warn` once.

### US-007: Gated workspace cap update, stop, end-session and answer

The agent holds `thread.cap.update`, `thread.stop`, `thread.end-session` and `thread.answer` in P. Each test inserts its own workspace thread of the agent; the session tests add a live job whose `requestedById` is the agent's id and `requestedByType` is `'AGENT'`, and the answer tests insert the thread with `pendingQuestion: { requestId: 'q1' }`.

- AC-1 [integration] `PATCH /api/threads/<thread>` `{ maxCostUsd: 7 }` by the agent under a wait policy for `thread.cap.update` in P answers 202 with `data` matching `{ permissionKey: 'thread.cap.update', projectId: <P's id> }`.
- AC-2 [integration] Approving AC-1's request leaves the thread's `maxCostUsd` 7.
- AC-3 [integration] Approving the agent's pending `POST /api/threads/<thread>/stop` leaves one `THREAD_STOP_TURN` `FleetCommand` for the live job.
- AC-4 [integration] Approving the agent's pending `POST …/answer` `{ requestId: 'q1', text: 'yes' }` leaves one `THREAD_ANSWER` `FleetCommand` for the live job.
- AC-5 [integration] `POST /api/threads/<a workspace thread of dev>/stop` by the agent under the same policy answers 404 with key `threads.notFound` and writes no `ApprovalRequest` row.
- AC-6 [integration] Approving the agent's pending stop after the test removed its `thread.stop` binding in P while it waited settles the request `failed`, and no `THREAD_STOP_TURN` command exists for the live job.
- AC-7 [unit] After `onModuleInit`, the registry answers `thread.cap.update` for `rest:workspace-threads.update`, `thread.stop` for `.stop`, `thread.end-session` for `.end-session` and `thread.answer` for `.answer`, each with `skipKeyRecheck` true.
- AC-8 [unit] With `requireOwnedThread` answering `{ id: 't1', projectId: 'p1' }`, `WorkspaceThreadsController.stop('t1', principal)` calls `routeGate.run` with `{ key: 'thread.stop', variant: 'rest:workspace-threads.stop', projectId: 'p1', input: { id: 't1' } }`.
- AC-9 [integration] `PATCH /api/threads/<a workspace thread of dev>` `{}` by the agent under the same policy answers 404 with key `threads.notFound` and writes no `ApprovalRequest` row (the pre-read wins over the body check).

### US-008: Gated workspace message send

The agent holds global `thread.workspace.message.send` and `thread.create` in P. Each test inserts its own workspace thread of the agent. A send body is `{ text: 'hello', clientMessageId: <unique> }`.

- AC-1 [integration] `POST /api/threads/<thread>/messages` with a send body by the agent under a global wait policy answers 202 with `data` matching `{ permissionKey: 'thread.workspace.message.send', projectId: null }`, and no `ChatMessage` with that client message id exists.
- AC-2 [integration] Approving AC-1's request leaves one user `ChatMessage` with that client message id whose `authorUserId` is the agent's id.
- AC-3 [integration] Approving the agent's pending send after the test removed its `thread.create` binding in P while it waited settles the request `failed`, and no `ChatMessage` with that client message id exists.
- AC-4 [integration] The same send with the agent under no policy answers 201 and writes no `ApprovalRequest` row; repeating it answers 200.
- AC-5 [unit] After `onModuleInit`, the registry answers `thread.workspace.message.send` for `rest:workspace-threads.message`, with no `prepare`.
- AC-6 [unit] With the gate answering `{ status: 'executed', result: { message: m, jobId: null, deduplicated: true } }`, `WorkspaceThreadsController.send('t1', body, principal, response)` calls `response.status(200)` and answers `{ message: m, jobId: null }`.

### US-009: Contract, OpenAPI and endpoint coverage

- AC-1 [integration] Over the booted app, the collected routes contain exactly 115 gated routes.
- AC-2 [integration] Over the booted app, `findContractViolations` reports no violation.
- AC-3 [unit] `PENDING_GATE_ROUTES` holds exactly the 11 `gate-secret` entries and nothing else.
- AC-4 [unit] `openapi.json`'s `post /api/projects/{slug}/threads/{id}/messages` and `post /api/threads` operations each have a `202` response.
- AC-5 [unit] The operations of `openapi.json` with a `202` response are exactly the 115 gated ones.
- AC-6 [integration] In `endpoint.e2e.spec.ts`, `POST /api/projects/:slug/threads` with the key of an agent granted `thread.create` in the project, under a wait policy deleted in a `finally`, answers exactly 202.
- AC-7 [integration] In `endpoint.e2e.spec.ts`, `POST /api/threads` with the key of an agent granted global `thread.workspace.create`, under a global wait policy deleted in a `finally`, answers exactly 202.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-4 and AC-5 live in `src/approvals/approval-openapi.contract.spec.ts`.
