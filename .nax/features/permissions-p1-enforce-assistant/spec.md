# SPEC: Permissions P1e — Enforce Permission Keys on Threads, Assistant Tools, the Knowledge Base and Memory

## Summary

This feature moves authorization on the assistant surface of `apps/api` onto permission keys checked by `PermissionService.can`:
- **Threads.** The project thread routes (`/projects/:slug/threads/*`) and the workspace thread routes (`/threads/*`) lose their user-only refusal, their CASL `CREATE FleetJob` checks and the hard-coded creator-only rule. Each declares its catalog key with `@Requires`. Thread writes are ownable keys, so role data decides who may act on whose thread: Developer holds the `.own` keys, and Project Admin the any-row keys.
- **Agents can own threads.** A thread records its creator's type, so an agent can create and drive a thread like a user. A turn runs as the principal that sent the message starting it, so its tools check that principal's own keys (never borrowed from the thread's creator).
- **Assistant and MCP tools.** Each of the 23 koda tools declares one catalog key. The executor checks it with `PermissionService.can` for the project the call acts in, and when an approved action is re-checked. MCP `tools/list` lists only the tools whose key the calling agent holds somewhere.
- **Knowledge base.** KB rows are replaced and deleted by `(source, source_id)`, not by `source_id` alone (review C/SEC-1). The REST routes write only the user sources `doc` and `manual`, and record the creator, so `kb.document.delete.own` works.
- **Memory.** Memory rows record their owner's type. Replacing another principal's memory item needs `memory.update`; your own needs `memory.update.own` (review C/SEC-2). Memory writes need Developer-level keys, and an extracted ticket must belong to the project.

This is the fifth of eight features implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), enforce-core (PR #313), enforce-fleet (PR #314), **enforce-assistant**, enforce-integrations, cleanup, and web in parallel. The design doc's phasing section lists five features and predates three splits; enforce-fleet's scoping (2026-10-20) moved threads, the assistant and MCP tools, the knowledge base and memory into this feature.

## Motivation

After `permissions-p1-enforce-fleet`, the core and fleet routes check permission keys, but the assistant surface still decides through the legacy mechanisms:
- Thread routes refuse every non-user principal (`threads.principal`) and check CASL `CREATE FleetJob`. Thread writes are creator-only against the creator's id, whatever the creator's current role, so a creator demoted to Viewer keeps full control of the thread (review B/SEC-2).
- The 23 assistant tools declare `{ kind: 'member' }` or a CASL `{ kind: 'ability' }`, and the same tools serve thread users and MCP agents. So an agent reaches over MCP what a role would refuse it, and a Viewer can propose writes.
- A KB write replaces rows by `source_id` alone, so any agent or Developer can overwrite rows owned by the ticket indexer or the code graph (review C/SEC-1).
- Any member, Viewer too, can write memory, and a memory write silently supersedes another principal's item (review C/SEC-2).

**Rulings that bind this feature** (user, 2026-10-20):
- **One feature.**
- **Threads are open to agents.** `ChatThread` records its creator's type, and its user foreign key is dropped, as enforce-fleet did for `FleetJob` and `JobSchedule`.
- **Role data decides who may act on another principal's thread.** Every thread write key is ownable. The any-row key lets its holder act on any thread of the project, and the `.own` key only on threads the caller created. No creator-only rule is hard-coded. The seeded roles stay as design Appendix A has them.
- **KB REST writes the user sources `doc` and `manual`.** `ticket` rows are written only by the ticket indexer, and `code` rows only by the code-graph writers (the incremental graph diff and the `POST …/kb/import/graphify` route, which keeps its own key `kb.graphify.import`).
- **No approval change.** This feature changes permission checks only. Who approves is policy, which P3 delivers. The approval seam `approvalModeFor` keeps its code defaults, keyed by the actor (see Design).

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-enforce-core/spec.md` and `.nax/features/permissions-p1-enforce-fleet/spec.md` ("Rulings that bind every story") unless this spec says otherwise. In short:
   - `PermissionsModule` is `@Global()`.
   - A refused key answers 403 `new ForbiddenAppException({}, 'permissions')` (message `permissions.403`, already present).
   - `RequiresGuard` runs after `ProjectMembershipGuard` in one `@UseGuards(ProjectMembershipGuard, RequiresGuard)` call. On a route that has no `:slug`, `RequiresGuard` runs alone.
   - `enforcedBy: 'service'` moves the key check into the handler or service.
   - A route holding only `X.own` passes `RequiresGuard` (reason `not-owner`), and the handler decides on the row it loaded.
   - DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app.
2. **Order of checks** is enforce-core's:
   1. authentication;
   2. project resolution and access (404 project, 403 `projects`);
   3. the route key (403 `permissions`);
   4. input validation;
   5. lookups (404s);
   6. row-level key checks (403 `permissions`);
   7. domain rules (409s, 400s).

   The first failing step decides the response.
3. **Only key refusals change their code.** A refusal that a key replaces answers 403 `permissions` instead of today's code, which was `threads.principal`, `threads.notCreator`, `threads.homeProjectAccess`, `projects` from a CASL check, Nest's generic 403 from `@RequiredPermission`. Unchanged:
   - `ProjectMembershipGuard`'s 403 `projects`;
   - `assertProjectMembership`'s 403 on the memory body routes;
   - every 404;
   - every non-permission refusal, for example `threads.disabled`, `threads.archived` and `threads.noSession`.
4. **No principal-type refusal is left on a route this feature migrates**; the key decides. Runner principals still never pass: `PermissionService.can` refuses them. The two thread event streams (SSE) keep their JWT requirement, which is an authentication mode, not a principal-type rule.
5. **The approval seam is unchanged except for its actor input.** `approvalModeFor(origin, tool, actor)` answers `human` for a thread call by a user (today's behaviour) and `none` for every other call: an MCP call (today's) and a thread call by an agent, which gets the same answer as that agent's MCP call. P3 replaces the body with stored policy. No new approval path is added.
6. **Project rules.** `.nax/rules/api-core.md` and `.nax/rules/api-auth.md` already describe `@Requires` and `RequiresGuard`. Follow them over older guidance.
7. **`api-testing.md` endpoint e2e rule, ruled as for enforce-core:** the integration ACs pin the route-level allow and refuse cases. Only existing `endpoint.e2e.spec.ts` cases that a correct implementation breaks are edited (see Modifies).

### Seeded role behaviour this feature exposes (design Appendix A, unchanged)

Following Appendix A, these principals change behaviour. This is accepted and not a regression to fix:
- Viewer, Reviewer, Verifier, Triager and Approver hold `kb.read`, `memory.read` and `timeline.read` through `*.read`, but not `kb.search`, `retrieval.evaluate`, `kb.graphify.import`, `kb.document.add` or any memory write.
- A legacy role-less `AgentProject` roster row maps to `viewer` (enforce-core), so it loses KB search and memory writes.
- Only Project Admin (through `*`) holds `kb.optimize`, `kb.graphify.import` and `retrieval.evaluate`. Today `kb.optimize` is global-admin only; it widens to Project Admin.
- `fleet.approval.decide.assistant` is not checked. An `assistant_action` approval is still decided by the thread's creator, with the action's own key re-checked at approve (design §4, "confirming one's own request needs only the action's own key").

### Threads record their creator's type

**Schema.** One Prisma migration, `apps/api/prisma/migrations/20261031090000_thread_creator_type/migration.sql`:
- `ChatThread` gains `createdByType String @default("USER")`.
- Its `createdBy User @relation("ChatThreadCreatedBy", ...)` and `User.chatThreadsCreated` are removed, so the foreign key `ChatThread_createdById_fkey` is dropped.
- `ChatMessage` gains `authorType String?`; its `author User? @relation("ChatMessageAuthor", ...)` and `User.chatMessagesAuthored` are removed, so the foreign key `ChatMessage_authorUserId_fkey` is dropped (an agent sends messages too). Only `findCallContext` reads `ChatThread.createdBy` (rewritten below); no code reads `ChatMessage.author`.
- Existing rows default to `USER` (`ChatThread`) and stay null (`ChatMessage.authorType`). The index `[createdById, kind, lastActivityAt]` stays. The column `authorUserId` keeps its name.

**Writes and reads.**
- `ChatThreadRecord` gains an optional `createdByType?: 'USER' | 'AGENT'`. An absent value means a user, so existing fixtures stay valid. The row mapper always sets it.
- `PrismaChatThreadRepository.create` stores `createdByType: actorTypeFor(input.createdById)`, using the action context from `apps/api/src/action-context/action-context.ts`. The repository `create` input and the two service `create` calls are unchanged, so an agent's request (whose context the global interceptor sets) creates an `AGENT` thread.
- `PrismaChatThreadRepository.sendMessage` stores the user message with `authorUserId: input.userId` (the sender, as today) and `authorType: actorTypeFor(input.userId)`.
- **A thread job runs as its requester.** The thread job insert in `PrismaChatThreadRepository.createThreadJob` takes the requester as a new last parameter `requester: { id: string; type: 'USER' | 'AGENT' }` and sets `requestedById: requester.id` and `requestedByType: requester.type` (it no longer copies `thread.createdById`). A SESSION job's requester is the message's sender (`input.userId`, typed with `actorTypeFor(input.userId)`); a PUBLISH or DISCARD job's requester is the caller of `publish` or `discard`. So an agent's thread job is an agent-requested job, and enforce-fleet's readers already handle that: no outcome notification, PR attribution by agent name, and `responsibleUserOf` answering null.

**Tool calls of an agent's thread.**
- `ToolCallContext.creator` (`apps/api/src/fleet/assistant/assistant-tool-call.domain.ts`) becomes a union:
  - `{ type: 'USER'; id; email; role; disabled }`;
  - `{ type: 'AGENT'; id; slug; status }`.
- A `creator` whose `type` is `'AGENT'` is an agent; any other value, or none, is a user, so existing `creator` fixtures without `type` stay valid.
- `PrismaAssistantToolCallRepository.findCallContext` selects the THREAD job's `requestedById` and `requestedByType` (the turn's requester, not the thread's creator), then reads the `User` row or the `Agent` row. It answers null when the requester row is gone. The field keeps its name `creator` (so existing fixtures stay valid) and holds the job's requester.
- `AssistantToolExecutor.execute` builds the caller from the creator: the `userPrincipal(creator)` it builds today for a user, or a new `agentPrincipal(creator)` for an agent. `agentPrincipal` has `actorType: 'agent'`, `id`, `name` and `slug` (the slug), `status`, `agentRoles: []`, `capabilities: []`, `blacklisted: status === 'PAUSED'`, `revoked: false`, `authorities: []` and `extra: { slug }`. An agent caller has `disabled: false`, because an agent's status is liveness, not access (enforce-fleet ruling).
- **The tool runs inside the requester's action context.** Thread tool calls arrive on the runner route, which the interceptor leaves outside any context, so `execute` runs `run` inside `runWithActor({ type: <'USER' or 'AGENT'>, id: creator.id }, ...)` (`creator` holds the job's requester). `executeAction` (the approve path) runs the tool inside `runWithActor` for the action's requester the same way. So `actorTypeFor` in the services a tool calls (for example `FleetJobsService.dispatch`) records the requester's type.
- `approvalModeFor(origin, tool, actor: 'user' | 'agent')` (`apps/api/src/fleet/assistant/actions/approval-policy.ts`) answers `'human'` when `origin.kind === 'thread' && actor === 'user'`, and `'none'` otherwise. The executor passes the caller principal's type. So a write tool in an agent's thread runs at once through the existing `directWrite` path, recorded with `actorType: 'agent'` and `origin: 'thread'` (and, as for MCP today, no `threadId`).

### Thread route keys

`G` means `RequiresGuard` checks the key. `G + S` means the guard passes a `.own` holder, and the handler computes `canOperate = (await permissions.can(principal, <key>, { projectId })).allowed`: true only for an any-row holder. It passes the flag to the service or repository, which keeps the creator compare when the flag is false. The compare's refusal becomes 403 `permissions` (was `threads.notCreator`).

**Project threads.** `ThreadsController`, `@UseGuards(ProjectMembershipGuard, RequiresGuard)`; `assertUser` and every CASL check are removed. `ThreadsController` gains `PermissionService` as a constructor parameter, replacing `KodaCaslAbilityFactory` in the same position.

| Route | Key | Mode |
|:--|:--|:--|
| `POST /projects/:slug/threads` | `thread.create` | G |
| `GET …/threads`, `GET …/threads/:id`, `GET …/threads/:id/messages` | `thread.read` | G |
| `PATCH …/threads/:id` | `thread.cap.update` | G + S |
| `POST …/:id/plan` | `thread.plan` and `fleet.job.dispatch` (`mode: 'all'`) | G + S (on `thread.plan`) |
| `POST …/:id/run` | `thread.run` and `fleet.job.dispatch` | G + S (on `thread.run`) |
| `POST …/:id/stop` | `thread.stop` | G + S |
| `POST …/:id/end-session` | `thread.end-session` | G + S |
| `POST …/:id/answer` | `thread.answer` | G + S |
| `POST …/:id/archive` | `thread.archive` | G + S (replaces `ctx.role === 'ADMIN'`) |
| `POST …/:id/publish` | `thread.publish` | G + S |
| `POST …/:id/discard` | `thread.discard` | G + S |
| `POST …/:id/messages` | `thread.message.send` | G + S |

- **Repository and service signatures** (the creator-compare sites):
  - `ChatThreadRepository.updateCap`, `command`, `publish` and `discard` gain an optional last parameter `canOperate = false`.
  - `sendMessage`'s input gains an optional `canOperate?: boolean` (absent is false).
  - The workspace call sites in `WorkspaceThreadsService` are not changed by this: they pass no flag, so the creator compare applies there (the workspace fence already limits them to the caller's own thread).
  - `archive` keeps its `canArchive` parameter, now computed from `thread.archive`.
  - `ThreadsService.updateCap`, `stop`, `endSession`, `answer`, `publish`, `discard`, `sendMessage`, `plan` and `run` gain an optional last parameter `canOperate = false`.
  - `plan` and `run` replace `thread.createdById !== userId` with `!canOperate && thread.createdById !== userId`.
  - Each repository compare `x.createdById !== userId` becomes `!canOperate && x.createdById !== userId`, and its refusal becomes `new ForbiddenAppException({}, 'permissions')`.
- **A thread acted on by someone other than its creator** (an any-row key holder). Every turn runs as the principal that started it, never as the creator: a message that starts a SESSION job makes the sender the job's requester, so the turn's tools check the sender's keys, its writes are recorded as the sender's, and a write proposal waits for the sender's approval (the approval's `requestedById` is the proposing action's actor). A `plan` or `run` dispatches through `FleetJobsService.dispatch(<caller id>, ...)` as today, and a `publish` or `discard` job's requester is its caller. The message itself records its sender (`authorUserId`, `authorType`).
- **A live session belongs to its requester.** `sendMessage` refuses with 409 `new ConflictAppException({}, 'threads.sessionOtherPrincipal')`, before writing the message, when the thread's current job is a RUNNING SESSION job whose `requestedById` is not the sender. The sender must end the session first (`end-session`, which an any-row holder may do). New messages `threads.sessionOtherPrincipal.409` in `apps/api/src/i18n/en/threads.json` ("This thread's live session was started by someone else; end the session first") and `zh/threads.json` ("该会话由其他主体发起，请先结束会话").
- **Thread events (SSE).** `WorkspaceThreadEventsGuard` (`workspace-thread-events.controller.ts`) removes its `isUserPrincipal` refusal and is otherwise unchanged (owned-thread fence, JWT). `ThreadEventsGuard` (`thread-events.controller.ts`) removes its `isUserPrincipal` refusal, gains `PermissionService` as its last constructor parameter, and after the membership check refuses with 403 `permissions` when `can(principal, 'thread.read', { projectId })` is not allowed. The JWT check that follows is unchanged, so an agent (no JWT) is still refused with `live`.

**Workspace threads.** `WorkspaceThreadsController`: its `user(principal)` helper (the `threads.principal` refusal) is removed, and the handlers take `UserPrincipal | AgentPrincipal`. The workspace scope (`{ kind: 'workspace', userId }`, matched on `createdById`) still fences every workspace read and write to the caller's own threads: catalog scope `own`, 404 for anyone else's thread.

| Route | Key | Mode |
|:--|:--|:--|
| `POST /threads` | `thread.workspace.create` | G |
| `GET /threads`, `GET /threads/:id`, `GET /threads/:id/messages` | `thread.workspace.read` | G |
| `POST /threads/:id/messages` | `thread.workspace.message.send` | G |
| `POST /threads/:id/archive` | `thread.workspace.archive` | G |
| `PATCH /threads/:id` | `thread.cap.update` | S: `can(principal, key, { projectId: thread.projectId, resource: { createdBy: { type: thread.createdByType ?? 'USER', id: thread.createdById } } })` |
| `POST /threads/:id/stop`, `/end-session`, `/answer` | `thread.stop`, `thread.end-session`, `thread.answer` | S, as above |

- **Signatures.** `WorkspaceThreadsService.updateCap`, `stop`, `endSession` and `answer` take `principal: UserPrincipal | AgentPrincipal` in place of `userId`. Each validates its input first (400), then loads the owned thread (`requireOwnedThread`, 404), then checks the key (403), then calls the repository.
- The four S routes check the key in the thread's **home project**: Member, a global role, does not hold `thread.cap.update`, `thread.stop`, `thread.end-session` or `thread.answer`, and a Developer of the home project holds their `.own` forms. A refusal is 403 `permissions`. They pass no `canOperate` to the repository (false), because the workspace fence already limits them to the caller's own thread.
- **Hosting.** `WorkspaceThreadsService.canHost(projectId, principal)` answers `(await permissions.can(principal, 'thread.create', { projectId })).allowed`. It replaces the CASL `CREATE FleetJob` check, and `WorkspaceThreadsService` gains `PermissionService` in place of `KodaCaslAbilityFactory` (same constructor position). The `threads.homeProjectAccess` refusals of `create` and `sendMessage` become 403 `permissions`.
- `WorkspaceThreadsService.create`, `sendMessage` and `archive` take `UserPrincipal | AgentPrincipal`. `ProjectsService.findAllForPrincipal` already takes `KodaPrincipal`.
- **Default home for an agent.** `create` with no `homeProject` skips projects the caller only reaches as a global admin. For a user it keeps today's test (`access.findMembershipRole(project.id, principal.id)` not null). For an agent it uses `access.resolveMembership(project.id, principal)` and skips a project where it throws 403 (not on the roster). Then `canHost` and the anchor check apply as today.
- The seeded `agent` role holds no workspace thread key (Appendix A), so an agent gets 403 `permissions` from `POST /threads` unless a role grants it the keys.

### Assistant tool keys

`AssistantTool` (`apps/api/src/fleet/assistant/assistant-tool.types.ts`) gains a required `key: string`, a catalog key. `permission` stays declared and unread until `permissions-p1-cleanup` removes it.

| Tool | `key` |
|:--|:--|
| `koda_search_tickets`, `koda_get_ticket` | `ticket.read` |
| `koda_list_jobs`, `koda_get_job` | `fleet.job.read` |
| `koda_fleet_spend` | `fleet.analytics.read` |
| `koda_list_approvals` | `fleet.approval.read` |
| `koda_runner_status` | `fleet.runner.read` |
| `koda_job_log_excerpt` | `fleet.job.logs.read` |
| `koda_memory_search` | `memory.read` |
| `koda_timeline` | `timeline.read` |
| `koda_kb_search` | `kb.search` |
| `koda_get_doc` | `kb.read` |
| `koda_get_action` | `assistant.action.read` (implicit) |
| `koda_my_projects` | `project.read` (workspace tool: the listing is the caller's reachable projects, as today) |
| `koda_add_comment` | `comment.create` |
| `koda_create_tickets` | `ticket.create` |
| `koda_update_ticket` | `ticket.update`; a `status` change also needs `ticket.transition.start` |
| `koda_link_tickets` | `ticket.link.add` |
| `koda_add_memory` | `memory.create` |
| `koda_record_decision` | `memory.decision.record` |
| `koda_dispatch_job` | `fleet.job.dispatch` |
| `koda_requeue_job` | `fleet.job.requeue` |
| `koda_cancel_job` | `fleet.job.cancel` |

**Executor.** `AssistantToolExecutor`'s fourth constructor parameter, `KodaCaslAbilityFactory`, is replaced by `PermissionService` (the CASL blocks are its only use).
- **Call path.** In `execParsed`, after membership resolves, the CASL block is replaced: `const decision = await permissions.can(scope.actor, tool.key, { projectId: scope.id })`. A decision that is not allowed answers the refusal `forbidden: <tool> needs <key> on <slug>`, outcome `forbidden`, with `projectId` the project. Implicit keys pass (`can` answers `implicit`). Workspace-scope tools (`koda_my_projects`) take no key check.
- **Approve re-check.** `actionScope`, used by `checkAction` and `executeAction`, replaces its CASL block with the same `can(actor, tool.key, { projectId: action.projectId })`. A refusal answers null (`forbidden`).
- **`koda_update_ticket`.** The preview's status check calls `permissions.can(ctx.actor, 'ticket.transition.start', { projectId: ctx.projectId })` through a new `ToolContext.can(key): Promise<boolean>` that the executor fills from `PermissionService`. A refusal throws `new ToolForbiddenError('ticket.transition.start')`, which the executor words as `forbidden: koda_update_ticket needs ticket.transition.start on <slug>`. `TicketTransitionsService.assertTransitionPermission` is no longer called (cleanup removes it). The execute path's `ForbiddenAppException` text becomes `forbidden: <ref> needs ticket.transition.start`.
- `ToolContext` gains `can(key: string): Promise<boolean>`, answering `(await permissions.can(actor, key, { projectId })).allowed` for the context's actor and project. Both context builders fill it: `execTool` (a call) and `actionContext` (an approved action).

### MCP `tools/list`

- `McpController.serve` computes, before `handler.fetch`, the set of tool names the agent may see: a tool is visible when its `key` is implicit, or when `projectIdsWithKey(principal, key)` answers `{ all: true }` or a non-empty `projectIds`. It passes the set in `authInfo.extra.visibleTools`.
- `kodaMcpToolRegistrations(executor, principal, visible: ReadonlySet<string>)` registers only the descriptors in `visible`, in catalog order. A call to an unregistered tool gets the MCP SDK's unknown-tool error.
- `koda_my_projects` (workspace scope) is always visible.
- A visible tool called for a project where the agent lacks its key still answers the executor's `forbidden` refusal.

### KB rows by `(source, source_id)`

**Store.**
- `LanceTableManager.addRecord` deletes the rows matching `source = '<source>' AND source_id = '<sourceId>'` before adding, when both values pass `isSafeFilterValue`. It no longer matches `source_id` alone.
- `VectorStore.deleteBySource(projectId, source, sourceId)` and `RagService.deleteBySource(projectId, source, sourceId)` gain `source` as their second parameter and delete only `source = … AND source_id = …`. An unsafe value in either throws `ValidationAppException`, as today.
- Callers:
  - `KbTicketLifecycleSubscriber` passes `'ticket'`;
  - `IncrementalGraphDiffService` passes `'code'`;
  - `RagController.deleteDocument` (US-006) calls `deleteBySource(project.id, 'doc', sourceId)` then `deleteBySource(project.id, 'manual', sourceId)`, so the route keeps deleting the user rows of that id and still answers 200; US-007 adds the `source` query, the key and the ownership check on top.
- `IndexDocumentInput` (`apps/api/src/rag/rag.service.ts`) gains an optional `createdBy?: { type: 'USER' | 'AGENT'; id: string }`. `VectorStore.indexDocument` first removes any caller-supplied `metadata.kodaCreatedBy`, then stores `createdBy` there when it is given. An absent `createdBy` stores no `kodaCreatedBy`, so the row has no creator: it is a system row.
- New `VectorStore.findSourceCreators(projectId, source, sourceId): Promise<Array<{ type: 'USER' | 'AGENT'; id: string } | null>>`, also exposed as `RagService.findSourceCreators`. It answers one entry per matching row (null for a row with no `kodaCreatedBy`) and an empty array when nothing matches. It reads through the table query the existing reads use. A `source` or `sourceId` that fails `isSafeFilterValue` throws `ValidationAppException`, before any read; so the add and delete routes answer 400 for such an id before any write.

**REST routes.** `RagController` (`apps/api/src/rag/rag.controller.ts`) and `RetrievalController` (`apps/api/src/retrieval/retrieval.controller.ts`) use `@UseGuards(ProjectMembershipGuard, RequiresGuard)`. `RagController`'s `@ProjectRoles` and `@RequiredPermission` decorators are removed; `RetrievalController` has neither and only gains `RequiresGuard`. `addDocument` and `deleteDocument` take `@Principal() principal: KodaPrincipal` (they now read it for `createdBy` and ownership), so they leave the #145 no-principal list.

| Route | Key | Mode |
|:--|:--|:--|
| `POST /projects/:slug/kb/documents` | `kb.document.add` | G, plus the replace check (S) |
| `GET …/kb/documents` | `kb.read` | G |
| `DELETE …/kb/documents/:sourceId` | `kb.document.delete` | G + S (ownership) |
| `POST …/kb/search` | `kb.search` | G |
| `POST …/kb/import/graphify` | `kb.graphify.import` | G |
| `POST …/kb/optimize` | `kb.optimize` | G |
| `POST …/kb/evaluate/retrieval` | `retrieval.evaluate` | G |

- **Add.**
  - `AddDocumentDto.source` accepts only `'doc'` and `'manual'`; `'ticket'` and `'code'` answer 400 (class-validator).
  - The controller passes `createdBy` from the principal (`USER` or `AGENT`).
  - **Replace check:** before indexing, it reads `findSourceCreators(project, source, sourceId)`. When any matching row's creator is not the caller (including a null creator), the caller must hold the any-row `kb.document.delete`, `can(principal, 'kb.document.delete', { projectId })` allowed with no resource; otherwise 403 `permissions` and nothing is written. When every matching row is the caller's own, or none exists, no delete key is needed.
- **Delete.**
  - `DELETE …/kb/documents/:sourceId` takes an optional query `source`, `doc` or `manual`; any other value answers 400.
  - With no `source`, the route deletes both user sources.
  - For each source deleted, every matching row must pass `can(principal, 'kb.document.delete', { projectId, resource: { createdBy } })`; one refusal answers 403 `permissions`, and nothing is deleted.
  - With no matching row, the route answers 200, as today.
- The web `KbAddDocumentDialog` offers `ticket` and the CLI `kb add --source` accepts `ticket`; after this feature those answer 400. Their default sources (`manual`, `doc`) are unaffected.

### Memory ownership

**Schema.** One Prisma migration, `apps/api/prisma/migrations/20261031090100_memory_owner_type/migration.sql`: `MemoryItem` gains `ownerType String?`. Null means a system owner or an unknown one. The migration backfills existing rows: `ownerType = 'USER'` where `ownerId` is a `User` id, `'AGENT'` where it is an `Agent` id, null otherwise.
- `MemoryItem` and `MemoryItemInput` (`apps/api/src/memory/memory-item-repository.ts`) gain an optional `ownerType?: 'USER' | 'AGENT' | null`, which `upsert` stores and the mapper reads.

**The replace rule.** New `MemoryWriteGuard` (`apps/api/src/memory/memory-write.guard.ts`, `@Injectable()`, provided and exported by `MemoryModule`):

```ts
export class MemoryReplaceRefusedError extends Error {
  constructor(readonly itemId: string) { super(`memory:${itemId}`); this.name = 'MemoryReplaceRefusedError'; }
}

/** Whether the principal may supersede this active item: `memory.update` with the item's owner as the resource. */
mayReplace(principal: KodaPrincipal, projectId: string, existing: MemoryItem): Promise<boolean>;
/** The check `upsert` runs inside its transaction: throws MemoryReplaceRefusedError(existing.id) when mayReplace answers false. */
replaceCheck(principal: KodaPrincipal, projectId: string): (existing: MemoryItem) => Promise<void>;
/** For previews and pre-checks: reads findActive and throws MemoryReplaceRefusedError when an active item exists that the principal may not replace. */
assertMayReplace(principal: KodaPrincipal, projectId: string, key: { kind: string; subject: string; predicate: string }): Promise<void>;
```

- `mayReplace` checks `PermissionService.can(principal, 'memory.update', { projectId, resource: { createdBy } })`, where `createdBy` is `{ type: existing.ownerType, id: existing.ownerId }` when both are set and null otherwise.
- So Developer (`memory.update.own`) replaces only its own items, Project Admin (`memory.update`) any item, and a system item (null owner) only an any-row holder.
- **Atomic.** `PrismaMemoryItemRepository.upsert(item, options?: { beforeSupersede?: (existing: MemoryItem) => Promise<void> })` calls `beforeSupersede` inside its existing transaction, after reading the active item and before superseding it (not on the identical-restatement no-op path). A throw rolls the transaction back, so nothing is written. Every principal-driven memory write passes `replaceCheck`; system writers pass nothing.
- The REST routes map `MemoryReplaceRefusedError` to 403 `permissions`.

**Routes.** `MemoryController` gains `PermissionService` and `MemoryWriteGuard`. `MemoryReadController` and `TimelineController` change only their guards (`RequiresGuard` needs no constructor parameter); their constructors are unchanged.

| Route | Key | Mode |
|:--|:--|:--|
| `GET /projects/:slug/memory` | `memory.read` | G (`@UseGuards(ProjectMembershipGuard, RequiresGuard)` replaces `assertProjectMembership`) |
| `GET /projects/:slug/timeline` | `timeline.read` | G (same) |
| `POST /memory` | `memory.create` | S: after `assertProjectMembership(input.projectId)`, `can(principal, 'memory.create', { projectId })`, then `upsert` with `replaceCheck` |
| `POST /memory/decisions` | `memory.decision.record` | S: same order, then `ExtractionService.recordDecision` with `replaceCheck` |
| `POST /memory/extract` | `memory.extract` | S: same order; the ticket check; then `assertMayReplace` for **every** extracted item before any is written (all or nothing), then each `upsert` with `replaceCheck` |

- **Owner attribution.**
  - Today's global-admin override (`input.ownerId` on `POST /memory`, `decision.actorId` on `POST /memory/decisions`) is allowed when `can(principal, 'memory.update')` with no project is allowed, which needs a global grant. It replaces `principal.role === 'ADMIN'`.
  - An attributed owner other than the caller is stored with `ownerType` null. Every other write stores the caller's type (`USER` or `AGENT`).
  - `ExtractionService.recordDecision(input, repository, options?)` gains `input.ownerType?: 'USER' | 'AGENT' | null` (stored on the item) and an optional third `options: { beforeSupersede? }` it passes to `upsert`; with no `options` it calls `repository.upsert(item)` with one argument, as today. The decisions route passes `ownerType` (the caller's type when `actorId` is the caller's id, null otherwise) and `replaceCheck`.
- The extract pre-check is best-effort: it stops the common case before any write, and each `upsert`'s in-transaction `replaceCheck` still refuses a supersede that a concurrent write made forbidden (an earlier item of the same request may then already be written).
- **Extract ticket check.** When `event.ticketId` is set, `POST /memory/extract` answers 404 (`new NotFoundAppException({}, 'tickets')`) unless a non-deleted ticket with that id belongs to `event.projectId`. It reads through a new `PrismaMemoryItemRepository.ticketInProject(projectId: string, ticketId: string): Promise<boolean>` (a non-deleted `Ticket` row with that id and project), because `MemoryModule` does not import the tickets module (the same cross-table read `prisma-canonical-state.repository.ts` already makes; ruled acceptable here).
- **Tools.** `addMemoryTool` and `recordDecisionTool` take `MemoryWriteGuard` in their deps (`{ memory, guard }` and `{ memory, extraction, guard }`).
  - The preview calls `guard.assertMayReplace(ctx.actor, ctx.projectId, <key>)` and maps `MemoryReplaceRefusedError` to `new ToolForbiddenError('memory.update')`, which the executor words `forbidden: <tool> needs memory.update on <slug>`.
  - Execute writes with `guard.replaceCheck(ctx.actor, ctx.projectId)` and maps `MemoryReplaceRefusedError` to `new ToolActionError('forbidden: memory:<itemId> needs memory.update')`.
  - Both store `ownerType` from the actor (`'USER'` or `'AGENT'`).
- The outbox subscriber and the governance processor are system writers: they keep writing with no key check and store `ownerType` null.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A route key the caller does not hold | 403 `permissions`; the handler does not run |
| Acting on another principal's project thread with only the `.own` key | 403 `permissions`; nothing is written and no command is created |
| A Project Admin stopping another user's live thread turn | 200; a `THREAD_STOP_TURN` command is created |
| A workspace thread of someone else | 404 `threads.notFound` (unchanged fence) |
| Hosting a workspace thread in a project without `thread.create` | 403 `permissions` |
| A thread tool whose key the creator lacks in the call's project | The tool answers `forbidden: <tool> needs <key> on <slug>`; nothing runs |
| Approving an action whose requester lost the tool's key | 403 `projects` from the decide (unchanged path; `checkAction` answers `forbidden`); nothing is written |
| A write tool in an agent's thread | Runs at once (`none`), recorded as an `EXECUTED` action with `actorType` `agent` and origin `thread` |
| A THREAD job whose requesting agent was deleted | `findCallContext` answers null, so the tool call answers 404 `fleet.jobs` (as for a missing context today) |
| A message from someone other than the requester of the thread's live session | 409 `threads.sessionOtherPrincipal`; no message is stored and no command is created |
| An MCP tool whose key the agent holds nowhere | Not listed by `tools/list`; calling it gets the SDK's unknown-tool error |
| KB add with source `ticket` or `code` | 400; nothing is indexed |
| KB add over another principal's row without the any-row delete key | 403 `permissions`; the existing row is kept |
| KB delete of a row the caller did not create, with only `.own` | 403 `permissions`; nothing is deleted |
| A memory write that would supersede an item the caller may not replace | 403 `permissions`; nothing is written |
| Memory extract for a ticket of another project | 404 `tickets`; nothing is written |
| Memory extract where one extracted item would supersede an item the caller may not replace | 403 `permissions`; no item of that request is written |
| KB add, delete or creator read with a `sourceId` that fails `isSafeFilterValue` | 400 (`ValidationAppException`); nothing is written or deleted |

### Integration

Symbols this feature **reads** (verified at `06d0ab51`):
- `PermissionService.can(principal, key, { projectId?, resource? })`, `projectIdsWithKey(principal, key)`: `apps/api/src/permissions/permission.service.ts`
- `Requires`, `REQUIRES_METADATA`: `apps/api/src/permissions/requires.decorator.ts`. `RequiresGuard`: `apps/api/src/permissions/requires.guard.ts`
- `findCatalogEntry`: `apps/api/src/permissions/catalog.ts`. `SystemRoleSeeder`.
- `actorTypeFor`, `runWithActor`: `apps/api/src/action-context/action-context.ts`
- `ProjectMembershipGuard`, `@CurrentProject()`, `ProjectContext`, `ProjectAccessService.assertProjectMembership`, `resolveMembership`: `apps/api/src/projects/`
- `KodaPrincipal`, `UserPrincipal`, `AgentPrincipal`, `isAgentPrincipal`: `apps/api/src/auth/principal/koda-principal.types.ts`
- `PrismaMemoryItemRepository.findActive`, `upsert`: `apps/api/src/memory/prisma-memory-item.repository.ts`
- `isSafeFilterValue`: `apps/api/src/rag/`
- `ProjectsService.findAllForPrincipal(principal: KodaPrincipal)`: `apps/api/src/projects/projects.service.ts`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `ChatThread` (schema) | `createdBy` relation to `User` | `createdByType`, no relation |
| `ChatThreadRecord`, repository `create` input | no creator type | optional `createdByType` |
| `ChatThreadRepository.updateCap`, `command`, `publish`, `discard`, `sendMessage` | creator compare, 403 `threads.notCreator` | `canOperate` flag, 403 `permissions` |
| `ThreadsService` writes, `plan`, `run` | creator compare | `canOperate` last parameter |
| `ThreadsController` | `assertUser`, CASL, `ctx.role` | `@Requires`, `PermissionService` |
| `WorkspaceThreadsController`, `WorkspaceThreadsService` | user-only, CASL `canHost` | keys, `PermissionService`, `UserPrincipal \| AgentPrincipal` |
| `ThreadEventsGuard` | user-only | `thread.read` key |
| `ToolCallContext.creator`, `findCallContext` | user only | `USER` / `AGENT` union |
| `approvalModeFor(origin, tool)` | origin only | `(origin, tool, actor)` |
| `AssistantTool` | `permission` | plus `key` |
| `ToolContext` | no `can` | `can(key)` |
| `AssistantToolExecutor` | `KodaCaslAbilityFactory` (4th parameter), CASL checks | `PermissionService` in its place; key checks; `runWithActor` around tool runs |
| `kodaMcpToolRegistrations(executor, principal)`, `McpController.serve` | every tool | `visible` set |
| `LanceTableManager.addRecord`, `deleteBySource` (vector store, rag service) | by `source_id` | by `(source, source_id)` |
| `IndexDocumentInput` | no creator | optional `createdBy` |
| `VectorStore`, `RagService` | no creator read | plus `findSourceCreators` |
| `AddDocumentDto.source` | four sources | `doc`, `manual` |
| `RagController`, `RetrievalController` | `@ProjectRoles`, `@RequiredPermission` | `@Requires` |
| `MemoryItem` (schema), `MemoryItemInput` | no owner type | `ownerType` |
| `PrismaMemoryItemRepository` | memory reads and writes | plus `ticketInProject(projectId, ticketId)` |
| `MemoryController`, `MemoryReadController`, `TimelineController` | membership only | keys, `MemoryWriteGuard` |
| `addMemoryTool`, `recordDecisionTool` deps | repository only | plus `MemoryWriteGuard` |
| `PrismaMemoryItemRepository.upsert(item)` | no hook | `upsert(item, { beforeSupersede? })` |
| `ExtractionService.recordDecision(input, repository)` | no owner type | `input.ownerType`, optional `options` |
| `ChatMessage` (schema) | `author` relation to `User` | `authorType`, no relation |
| `WorkspaceThreadEventsGuard` | user-only | JWT only |

## Out of Scope

- Any approval change is out of scope (P3). This includes a stored approval policy, a non-creator decide path for `assistant_action` approvals, and checking `fleet.approval.decide.assistant`. `approvalModeFor` gains only the actor input.
- Recording the acting principal on thread commands (stop, end-session, answer, archive, publish, discard, cap) other than through the fleet activity rows is out of scope (P2 action context).
- Narrowing which principals may start a turn on another principal's thread is out of scope; role data decides (`thread.message.send` any-row), and the turn runs with the sender's own keys.
- `koda_get_action` in an agent's thread cannot read the direct actions of that thread, because direct actions are stored with no `threadId` (as MCP's are); linking them is out of scope.
- Making the KB replace and delete checks atomic with the LanceDB write is out of scope; a concurrent write between the creator read and the write can still replace a row (LanceDB has no transaction here).
- `createdByType` appears in thread responses because the controllers return the record; documenting it in the DTOs and OpenAPI is out of scope (`permissions-p1-web`).
- Regenerating the CLI client (`bun run generate`) for the KB source enum and the DELETE `source` query is out of scope (a CLI follow-up); this feature regenerates `openapi.json` only.
- Opening the thread event streams (SSE) to agents is out of scope; they keep their JWT requirement, so an agent is refused with `live`.
- Letting an any-row holder read or act on another principal's workspace thread is out of scope; workspace threads stay fenced to their creator.
- Removing `AssistantTool.permission`, `ToolPermission`, `TicketTransitionsService.assertTransitionPermission`, `KodaCaslAbilityFactory` and the other legacy mechanisms is out of scope (`permissions-p1-cleanup`).
- Migrating the vcs, webhook, skills, code-intel, context and ci-webhook routes is out of scope (`permissions-p1-enforce-integrations`).
- Rewriting existing KB rows to add `kodaCreatedBy`, or existing memory rows to add `ownerType`, is out of scope; old rows have no creator and only an any-row holder replaces or deletes them.
- Removing the `ticket` source option from the web `KbAddDocumentDialog` (`permissions-p1-web`) and from the CLI `kb add --source` (a CLI follow-up) is out of scope; until then choosing `ticket` answers 400.
- The catalog contract test and the full role allow/deny matrix test are out of scope (`permissions-p1-cleanup`).
- Web changes are out of scope (`permissions-p1-web`).
- New `endpoint.e2e.spec.ts` cases for the migrated routes are out of scope; the integration ACs pin the allow and refuse cases.
- US-004 only: `koda_cancel_job` needs `fleet.job.cancel`; letting a job's requester cancel its own job through the tool without the key (the REST rule) is out of scope.
- US-005 only: per-project filtering inside `tools/list` is out of scope; a tool is listed when the agent holds its key in at least one project.

## Stories

1. **US-001: Threads record their creator's type, and a thread job runs its tools as its requester** — `Workdir: apps/api` — No dependencies. Adds the `thread_creator_type` migration (`ChatThread.createdByType`, `ChatMessage.authorType`, both user foreign keys dropped), `actorTypeFor` at the repository's thread create and message insert, the `requester` parameter of `createThreadJob` (the sender or caller), the requester union in `findCallContext` (read from the job), `agentPrincipal` and `runWithActor` in the executor, and the actor input of `approvalModeFor`.
2. **US-002: Project thread routes check keys, and ownership comes from the keys** — `Workdir: apps/api` — Depends on US-001. Moves the fourteen project thread routes onto `@Requires`, removes `assertUser` and the CASL checks, adds `canOperate` to the repository and service writes, and checks `thread.read` in `ThreadEventsGuard`. A message from someone other than the requester of the thread's live session answers 409 `threads.sessionOtherPrincipal`.
3. **US-003: Workspace thread routes check keys** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the ten workspace thread routes onto keys, checks the four home-project keys in the service, replaces `canHost` with `thread.create`, and accepts agent principals.
4. **US-004: Assistant tools check their key** — `Workdir: apps/api` — Depends on US-001. Adds `key` to the 23 tools, `can` to `ToolContext`, and `PermissionService` to the executor; replaces the CASL checks in the call path, in `actionScope` and in `koda_update_ticket`'s preview.
5. **US-005: MCP `tools/list` lists only the tools whose key the agent holds** — `Workdir: apps/api` — Depends on US-004. Computes the visible set in `McpController` and registers only those tools.
6. **US-006: KB rows are replaced and deleted by `(source, source_id)` and record their creator** — `Workdir: apps/api` — No dependencies. Changes `addRecord`, `deleteBySource` and their callers (including `RagController.deleteDocument`'s call site), adds `createdBy` and `findSourceCreators`.
7. **US-007: KB routes check keys and ownership** — `Workdir: apps/api` — Depends on US-006. Moves the seven KB routes onto `@Requires`, restricts the add sources, and adds the replace and delete ownership checks.
8. **US-008: Memory routes check keys, and memory items have owners** — `Workdir: apps/api` — Depends on US-004. Adds the `memory_owner_type` migration, `MemoryWriteGuard`, the keys on the five memory and timeline routes, the extract ticket check, the attribution rule, and the replace check in `koda_add_memory` and `koda_record_decision`.

This is one capability, enforcing keys on the assistant surface, at eight stories; the user confirmed it as one feature on 2026-10-20.

### Context Files

**US-001**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `create` and the thread job insert
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRecord`, the repository interface
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — `findCallContext`
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `execute`, `userPrincipal`, `writeTool`
- `apps/api/src/fleet/assistant/actions/approval-policy.ts` — `approvalModeFor`

**US-002**
- `apps/api/src/fleet/threads/threads.controller.ts` — the project thread routes
- `apps/api/src/fleet/threads/threads.service.ts` — the thread writes, `plan`, `run`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — the creator compares
- `apps/api/src/fleet/threads/thread-events.controller.ts` — `ThreadEventsGuard`
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes use

**US-003**
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — the workspace routes
- `apps/api/src/fleet/threads/workspace-threads.service.ts` — `canHost`, `create`, `sendMessage`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — the workspace scope
- `apps/api/src/permissions/permission.service.ts` — `can`

**US-004**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `execParsed`, `actionScope`, `execTool`
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `AssistantTool`, `ToolContext`
- `apps/api/src/fleet/assistant/tools/update-ticket-tool.ts` — the status preview
- `apps/api/src/fleet/assistant/assistant.module.ts` — the tool registry wiring
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — the tool names

**US-005**
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — `serve`
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.ts` — `kodaMcpToolRegistrations`
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `mcpToolDescriptors`
- `apps/api/src/permissions/permission.service.ts` — `projectIdsWithKey`

**US-006**
- `apps/api/src/rag/lance-table-manager.ts` — `addRecord`
- `apps/api/src/rag/vector-store.service.ts` — `indexDocument`, `deleteBySource`, the table queries
- `apps/api/src/rag/rag.service.ts` — `IndexDocumentInput`, `deleteBySource`
- `apps/api/src/rag/kb-ticket-lifecycle.subscriber.ts` — the ticket delete
- `apps/api/src/rag/incremental-graph-diff.service.ts` — the code-node delete

**US-007**
- `apps/api/src/rag/rag.controller.ts` — the KB routes
- `apps/api/src/retrieval/retrieval.controller.ts` — the evaluate route
- `apps/api/src/rag/dto/add-document.dto.ts` — the source list
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes use

**US-008**
- `apps/api/src/memory/memory.controller.ts` — the memory write routes
- `apps/api/src/fleet/assistant/tools/memory-write-tools.ts` — builds the two memory tools; injects `MemoryWriteGuard`
- `apps/api/src/memory/timeline.controller.ts` — the timeline route
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findActive`, `upsert`, the mapper
- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts` — the memory tool

### Creates

**US-001**
- `apps/api/prisma/migrations/20261031090000_thread_creator_type/migration.sql`

**US-008**
- `apps/api/prisma/migrations/20261031090100_memory_owner_type/migration.sql`
- `apps/api/src/memory/memory-write.guard.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/assistant/actions/approval-policy.spec.ts` — its thread and WORKSPACE-thread cases call approvalModeFor(origin, 'koda_add_comment') with two arguments and expect 'human'. The replacing invariant: approvalModeFor(origin, tool, 'user') answers 'human' for a thread origin, a thread origin with actor 'agent' and an MCP origin answer 'none', and every other case is unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.direct.spec.ts` — it asserts approvalModeFor is called once with (caller.origin, call.name). The replacing invariant: approvalModeFor is called once, before the preview, with (caller.origin, call.name, <the caller principal's type>), and every other assertion is unchanged.

**US-002**
- `apps/api/src/fleet/threads/threads.service.spec.ts` — its non-creator run case expects threads.notCreator, and its discard case asserts exactly three call arguments. The replacing invariant: a non-creator run with canOperate false answers 403 permissions; discard forwards (projectId, threadId, userId, canOperate); every other case is unchanged.
- `apps/api/src/fleet/threads/prisma-chat-thread.discard.spec.ts` — its AC-7 case expects threads.notCreator when a non-creator discards. The replacing invariant: a non-creator discard with canOperate false answers 403 permissions and creates no job; the creator discard and the threads.notFound fence are unchanged.
- `apps/api/test/integration/fleet/thread-publish.integration.spec.ts` — its AC-13 case expects a viewer's publish to answer 403 with the "Only the thread creator" message. The replacing invariant: the viewer's publish answers 403 with error code permissions (route key thread.publish) and creates no job or command.
- `apps/api/test/integration/fleet/thread-discard.integration.spec.ts` — its AC-7 case expects a viewer's discard to answer 403 with the "Only the thread creator" message. The replacing invariant: the viewer's discard answers 403 with error code permissions and creates no job.
- `apps/api/test/e2e/fleet/thread-send-guards.e2e.spec.ts` — its US-005 AC3 case expects a developer who is not the creator to be refused with the "Only the thread creator can perform this action" message. The replacing invariant: that send answers 403 with error code permissions and stores no message.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — its thread cases expect threads.principal for an agent POST /projects/:slug/threads, projects for the developer-downgraded plan, threads.notCreator for non-creator run, stop and archive, and (US-003) threads.principal for an agent POST and GET /api/threads. The replacing invariant: each of those refusals answers 403 with error code permissions (an agent with a developer binding in the project gets 201 from the project thread create); every other case and status code is unchanged.

**US-003**
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — it passes a KodaCaslAbilityFactory double where PermissionService now goes, and its explicit VIEWER home case expects threads.homeProjectAccess. The replacing invariant: canHost asks a PermissionService double for thread.create; a refused explicit home answers 403 permissions; the repository call arguments and every other case are unchanged.
- `apps/api/src/fleet/threads/workspace-thread-events.controller.spec.ts` — its "refuses a non-user principal with 403 threads.principal" case expects that refusal. The replacing invariant: the case is removed (the guard refuses no principal type; an agent without a JWT is refused with live); every other case is unchanged.
- `apps/api/src/fleet/threads/workspace-threads.controller.spec.ts` — its testing module provides only WorkspaceThreadsService, and the controller's RequiresGuard now needs PermissionService. The replacing invariant: the module also provides a PermissionService stub; the repoId 400 validation case is unchanged.
- `apps/api/src/fleet/threads/workspace-turns.spec.ts` — its membership-refusal case expects threads.homeProjectAccess. The replacing invariant: a refusal during send answers 403 permissions and writes nothing; every other case is unchanged.
- `apps/api/test/integration/fleet/workspace-read.integration.spec.ts` — its agent GET /api/threads and POST /api/threads cases expect the "Only users can access chat threads" message. The replacing invariant: both answer 403 with error code permissions for an agent with no workspace thread key; the user cases are unchanged.
- `apps/api/test/integration/fleet/workspace-turns.integration.spec.ts` — its VIEWER and null-membership cases and its soft-deleted-home case expect the threads.homeProjectAccess message. The replacing invariant: both answer 403 with error code permissions and store no chat message.
- `apps/api/test/integration/fleet/workspace-create.integration.spec.ts` — its AC-11 case expects the threads.homeProjectAccess message for an explicit VIEWER home. The replacing invariant: the explicit VIEWER home answers 403 with error code permissions and creates no thread.

**US-004**
- `apps/api/src/fleet/assistant/assistant-tool.executor.direct.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double that allows the tool keys is the fourth argument; every other assertion (including the US-001 approvalModeFor call) is unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument and its AC-13 cases assert the CASL createForUser and can calls. The replacing invariant: the executor gets a PermissionService double as its fourth argument, in place of the KodaCaslAbilityFactory double; checkAction answers 'forbidden' when can(requester, tool.key, { projectId }) is refused; CASL is not consulted; every other assertion is unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.actor.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double that allows the tool keys is the fourth argument, in place of the KodaCaslAbilityFactory double; the actor and origin assertions are unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.caller.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double that allows the tool keys is the fourth argument, in place of the KodaCaslAbilityFactory double; the caller assertions are unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.workspace.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double that allows the tool keys is the fourth argument, in place of the KodaCaslAbilityFactory double; the workspace-scope assertions are unchanged.
- `apps/api/src/fleet/assistant/tools/kb-tools.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double allowing kb.search and kb.read is the fourth argument, in place of the KodaCaslAbilityFactory double; the KB answers are unchanged.
- `apps/api/src/fleet/assistant/tools/workspace-tools.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double is the fourth argument, in place of the KodaCaslAbilityFactory double; koda_my_projects answers the same list.
- `apps/api/src/fleet/assistant/write-tool-errors.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double that allows the tool keys is the fourth argument, in place of the KodaCaslAbilityFactory double; the error wording of non-key refusals is unchanged.
- `apps/api/src/fleet/assistant/actions/action-result-masking.spec.ts` — it passes a KodaCaslAbilityFactory double as the executor's fourth argument. The replacing invariant: a PermissionService double that allows the tool keys is the fourth argument, in place of the KodaCaslAbilityFactory double; the masking assertions are unchanged.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.spec.ts` — its realExecutor passes a KodaCaslAbilityFactory double as the executor's fourth argument, so the executeAction cases fail in actionScope. The replacing invariant: realExecutor passes a PermissionService double as the fourth argument, in place of the KodaCaslAbilityFactory double and the approve re-checks the action's key through it; the threads.notCreator decide case and the other refusal codes are unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.registry.spec.ts` — its fake tools declare permission but no key, which the AssistantTool type now requires. The replacing invariant: each fake tool also declares a catalog key; the registry assertions are unchanged.
- `apps/api/src/fleet/assistant/tools/update-ticket-tool.spec.ts` — its fixture ctx has no can, its AC-6 case expects need 'transition Ticket', and its AC-12 case expects the text 'forbidden: KODA-1 needs transition Ticket'. The replacing invariant: the fixture ctx has can; ctx.can('ticket.transition.start') answering false drives the refusal with ToolForbiddenError need 'ticket.transition.start' and the execute text 'forbidden: KODA-1 needs ticket.transition.start'; the AC-5 case (assertTransitionPermission not called) is unchanged.
- `apps/api/test/integration/fleet/assistant-tool-executor.integration.spec.ts` — its fake tool declares permission only and no key, and AC-12 expects the first run to answer ok. The replacing invariant: the fake tool declares a key the test principal holds, so the first run answers ok and the replay cases are unchanged; the AC-16 membership refusal is unchanged.
- `apps/api/test/integration/fleet/assistant-link-tickets-tool.integration.spec.ts` — its AC-15 case has a viewer-created thread propose koda_link_tickets and expects a PENDING action. The replacing invariant: that call answers 'forbidden: koda_link_tickets needs ticket.link.add on web' and stores no action; the developer-created cases are unchanged.
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — its AC-10/11 case expects 'forbidden: koda_dispatch_job needs create FleetJob on web'. The replacing invariant: the refusal reads 'forbidden: koda_dispatch_job needs fleet.job.dispatch on web'; every other case is unchanged.

**US-005**
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — its AC-5 case expects tools/list to equal every descriptor name for a roster-only agent, and its AC-10/11 dispatch case uses that roster-only agent, for which koda_dispatch_job is no longer listed. The replacing invariant: tools/list lists only the tools whose key the agent holds in some project; the AC-10/11 agent also holds a developer binding in a second project, so the tool is listed and the call for web still answers 'forbidden: koda_dispatch_job needs fleet.job.dispatch on web'; the koda_add_comment cases are unchanged.
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.spec.ts` — its kodaMcpToolRegistrations(executor, principal) calls pass no visible set. The replacing invariant: kodaMcpToolRegistrations(executor, principal, visible) registers only the descriptors in visible, in catalog order; with the full name set every existing assertion holds.
- `apps/api/src/fleet/assistant/mcp/mcp.controller.routes.spec.ts` — its module provides only AssistantToolExecutor, and its AC-5 and Express-shaped cases expect every descriptor from tools/list. The replacing invariant: the module also provides a PermissionService stub; tools/list answers the visible set the stub produces; the 409, 403, initialize and 405 cases are unchanged.

**US-006**
- `apps/api/src/rag/vector-store.filter-guard.spec.ts` — it calls deleteBySource('proj-1', sourceId) with two arguments and expects a source_id-only filter. The replacing invariant: deleteBySource('proj-1', source, id) resolves and filters on source and source_id together; the unsafe-value ValidationAppException case is unchanged.
- `apps/api/src/rag/vector-store.service.spec.ts` — its write-serialisation case calls deleteBySource('test-project', 'ticket-001'). The replacing invariant: the call is deleteBySource('test-project', 'ticket', 'ticket-001'), with the same one-write-in-flight and delete counts.
- `apps/api/src/rag/kb-ticket-lifecycle.subscriber.spec.ts` — it expects deleteBySource('proj-1', 'tick-1'). The replacing invariant: it expects deleteBySource('proj-1', 'ticket', 'tick-1'); the call counts are unchanged.
- `apps/api/src/rag/incremental-graph-diff.service.spec.ts` — it expects deleteBySource(projectId, 'node-2'). The replacing invariant: it expects deleteBySource(projectId, 'code', 'node-2'); the call counts and order are unchanged.
- `apps/api/src/rag/rag.controller.ts` — deleteDocument calls ragService.deleteBySource(project.id, sourceId) with two arguments. The replacing invariant: it calls deleteBySource(project.id, 'doc', sourceId) and deleteBySource(project.id, 'manual', sourceId) and still answers 200 { deleted: true }; every other handler is unchanged (US-007 adds keys).
- `apps/api/src/rag/rag.controller.spec.ts` — its "deletes by sourceId" case expects deleteBySource('proj-1', 'doc-1'). The replacing invariant: the delete calls deleteBySource('proj-1', 'doc', 'doc-1') and deleteBySource('proj-1', 'manual', 'doc-1') and never with 'ticket' or 'code'; every other case is unchanged.
- `apps/api/test/integration/rag/lance-table-manager.integration.spec.ts` — it calls vectorStore.deleteBySource(projectId, 'doc-b') and deleteBySource(projectId, 'doc-d') with two arguments. The replacing invariant: each call passes the indexed row's source as the second argument and the id third; the row-count assertions are unchanged.
- `apps/api/test/integration/rag/rag.integration.spec.ts` — its "deleteBySource removes documents by sourceId" case calls ragService.deleteBySource(projectId, 'ticket-to-delete'). The replacing invariant: it calls deleteBySource(projectId, <the indexed row's source>, 'ticket-to-delete') and the row is gone.
- `apps/api/test/integration/rag/rag-project-id-validation.integration.spec.ts` — its deleteBySource projectId-validation cases call ragService.deleteBySource(projectId, 'source-id') with two arguments. The replacing invariant: they call deleteBySource(projectId, 'manual', 'source-id') and still expect ForbiddenAppException for the empty, malformed and unknown project ids.

**US-007**
- `apps/api/src/rag/rag.controller.spec.ts` — its module provides no PermissionService for the new RequiresGuard, and its delete case calls deleteDocument without the principal and source query. The replacing invariant: the module provides a PermissionService stub; a delete with no source query still deletes the doc and manual rows (US-006 behaviour) once the ownership check passes; every other case is unchanged.
- `apps/api/src/rag/kb-documents-membership.routes.spec.ts` — its RagService stub has only indexDocument and its module has no PermissionService. The replacing invariant: the stub also has findSourceCreators answering [], the module provides PermissionService; the VIEWER and non-member refusals are unchanged.
- `apps/api/src/rag/no-principal-params.spec.ts` — its HANDLERS list includes addDocument and deleteDocument, which now read the principal (createdBy and ownership). The replacing invariant: those two handlers leave the list (they take @Principal()), and the other five handlers keep the no-custom-decorator check.
- `apps/api/src/retrieval/retrieval.controller.spec.ts` — its module provides no PermissionService for the new RequiresGuard. The replacing invariant: the module provides a PermissionService stub; the delegation and not-found cases are unchanged.
- `apps/api/src/retrieval/retrieval-membership.routes.spec.ts` — its DEVELOPER and VIEWER cases expect 200 from the evaluate route, and its module lacks PermissionService. The replacing invariant: the module provides PermissionService; a project admin gets 200, a developer and a viewer get 403 permissions; the unknown slug 404 and non-member 403 projects are unchanged.
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — its PermissionService stub allows every key (so the AC12 VIEWER kb write reaches the handler) and its RagService stub lacks findSourceCreators. The replacing invariant: the stub refuses kb.document.add for a viewer and allows it for a developer, the RagService stub has findSourceCreators answering []; the other cases are unchanged.
- `apps/api/test/integration/rag/rag-api-project-id-validation.integration.spec.ts` — its module provides no PermissionService, so RagController's RequiresGuard fails DI. The replacing invariant: the module provides PermissionService; the route and slug assertions are unchanged.
- `apps/api/test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts` — its AC2 cases accept 'code' and 'ticket' through AddDocumentDto. The replacing invariant: AddDocumentDto accepts doc and manual and rejects ticket and code; the invalid-source list and the IndexDocumentInput type case are unchanged.
- `apps/api/test/e2e/hybrid-retriever.e2e.spec.ts` — its beforeAll posts a ticket source over REST and expects 201. The replacing invariant: the ticket fixture is seeded through RagService.indexDocument and the REST posts use doc or manual; the search assertions are unchanged.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — its matrix row for POST /api/projects/:slug/kb/import/graphify uses a DEVELOPER member and expects a status other than 403. The replacing invariant: that row's member is a project admin (Developer does not hold kb.graphify.import); the other matrix rows are unchanged.

**US-008**
- `apps/api/src/memory/memory.controller.spec.ts` — its module provides MemoryController without PermissionService or MemoryWriteGuard; its upsert assertions expect a single argument; its recordDecision assertion expects an exact two-argument call. The replacing invariant: the module provides a PermissionService stub that allows every key except the global (no-project) memory.update, and a MemoryWriteGuard stub whose replaceCheck answers a function; upsert is called with the same item (plus ownerType) and a second argument holding beforeSupersede; recordDecision is called with the same input plus ownerType and a third options argument; the H12 attribution cases and the membership 403 cases are unchanged.
- `apps/api/src/memory/memory-read.controller.spec.ts` — its AC8 cases expect getMemory to call assertProjectMembership and throw projects. The replacing invariant: the handler no longer calls assertProjectMembership (ProjectMembershipGuard and RequiresGuard decide access); the AC1 page cases are unchanged.
- `apps/api/src/memory/timeline.controller.spec.ts` — its module provides no PermissionService and its membership cases expect the handler to call assertProjectMembership. The replacing invariant: the module provides a PermissionService stub; an admitted caller gets events; the non-member refusal belongs to the guard.
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — addMemoryTool({ memory }) has no MemoryWriteGuard dependency and its AC-7 case asserts the exact single-argument upsert call. The replacing invariant: the deps are { memory, guard } with a guard that allows; upsert is called with the same fields plus ownerType 'USER' and a second argument holding beforeSupersede; every other case is unchanged.
- `apps/api/src/fleet/assistant/tools/origin-tools.spec.ts` — its AC-10 and AC-11 cases build addMemoryTool({ memory }) and recordDecisionTool({ memory, extraction }) with no guard, so execute calls a missing guard. The replacing invariant: both deps also carry a MemoryWriteGuard stub that allows; the origin assertions are unchanged.
- `apps/api/src/fleet/assistant/tools/record-decision-tool.spec.ts` — recordDecisionTool has no guard dependency and its AC-6 case asserts the exact recordDecision call. The replacing invariant: the deps include a guard that allows; recordDecision is called with the same input plus ownerType 'USER' for a user actor and a third options argument holding beforeSupersede; every other case is unchanged.
- `openapi.json` — it records the KB AddDocumentDto source enum and the DELETE /projects/:slug/kb/documents/:sourceId query parameters, which US-007 changes. The replacing invariant: it is regenerated with bun run api:export-spec after the last route change, and the contract tests still find the thread and KB paths.

### Seams

- **US-001 → US-002, US-004:** `createdByType` and the agent caller are reached from real routes and the runner tool route. An agent's `POST /projects/p1/threads` stores `createdByType` `'AGENT'` (US-002 AC 3), a tool call of that thread's job through `POST /fleet/runner/jobs/<jobId>/tools/<name>` runs as the agent (US-004 AC 9), and its dispatch is recorded as the agent's (US-004 AC 14, through `runWithActor`).
- **US-002 → US-003:** the repository's `canOperate` flag defaults to false at the workspace call sites (US-003 ACs 6-8).
- **US-004 → US-005, US-008:** `AssistantTool.key` is read by `tools/list` (US-005 ACs 1-3), and the executor's `forbidden: <tool> needs <key> on <slug>` wording carries the memory tools' `ToolForbiddenError('memory.update')` (US-008 AC 14). `ToolContext.can` is reached from `koda_update_ticket`'s preview through a real thread tool call (US-004 AC 13).
- **US-006 → US-007:** `findSourceCreators`, `createdBy` and the `(source, source_id)` delete are reached from `POST` and `DELETE /projects/p1/kb/documents` (US-007 ACs 3-8).
- **US-008:** `MemoryWriteGuard.replaceCheck` is reached from `POST /memory` (ACs 4-7) and `POST /memory/extract` (AC 15), and `assertMayReplace` from `koda_add_memory` through the executor (AC 14).
- **Every route story** has, at the HTTP route, a refusal AC with error code `permissions` and an allow AC for a principal the legacy check refused or a binding-only principal.

## Acceptance Criteria

Fixture wording follows enforce-core and enforce-fleet:
- "a user whose only source in `p1` is a `<role>` binding" means a user with that `RoleBinding` in project `p1`, no `ProjectMember` row and no global admin role.
- "an agent whose only source in `p1` is a `<role>` binding" means an agent with that `RoleBinding` in `p1` and an `AgentProject` row in `p1`.
- "a custom role holding only `X`" is a `Role` row with scope `PROJECT`, `system` false and permissions `['X']`.

DB-backed tests seed the system roles first. Agent project scoping is on. Thread tests enable threads (`threadsEnabled`) and give `p1` an anchor fleet repo.

### US-001: Threads record their creator's type, and an agent's thread runs its tools as the agent (`Workdir: apps/api`)

1. [integration] `ThreadsService.create(p1, agentId, <valid PROJECT thread input>)` called inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` stores a `ChatThread` row with `createdById` the agent's id and `createdByType` `'AGENT'`.
2. [integration] `ThreadsService.create(p1, userId, <valid PROJECT thread input>)` called outside any context stores `createdByType` `'USER'`.
3. [integration] `ThreadsService.sendMessage(p1, <thread created by the agent>, agentId, <valid message>)` called inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` creates a THREAD `FleetJob` with `requestedById` the agent's id and `requestedByType` `'AGENT'`.
4. [integration] `PrismaAssistantToolCallRepository.findCallContext(<jobId of a THREAD job whose requestedByType is 'AGENT'>)` answers `creator` `{ type: 'AGENT', id, slug, status }` with the requesting agent's values.
5. [integration] `findCallContext(<jobId of a user's thread>)` answers `creator` with `type` `'USER'` and the user's `id`, `email`, `role` and `disabled`.
6. [integration] `findCallContext` for a THREAD job whose `requestedByType` is `'AGENT'` and whose requesting `Agent` row was deleted answers null.
7. [unit] `approvalModeFor({ kind: 'thread', ... }, 'koda_add_comment', 'user')` returns `'human'`, `approvalModeFor({ kind: 'thread', ... }, 'koda_add_comment', 'agent')` returns `'none'`, and `approvalModeFor({ kind: 'mcp' }, 'koda_add_comment', 'agent')` returns `'none'`.
8. [unit] `AssistantToolExecutor.execute` for a call whose `findCallContext` answers an `AGENT` creator runs the tool with `ctx.actor.actorType` `'agent'` and `ctx.actor.id` the agent's id.
9. [unit] `AssistantToolExecutor.execute` of the write tool `koda_add_comment` for an `AGENT` creator in a PROJECT thread calls the action proposer's `recordDirect` with `actorType` `'agent'` and `origin` `'thread'`, and never calls `propose`.
10. [unit] `AssistantToolExecutor.execute` of `koda_add_comment` for a `USER` creator in a PROJECT thread calls `propose` and never calls `recordDirect`.
11. [unit] `AssistantToolExecutor.execute` for a call whose `findCallContext` answers an `AGENT` creator with id `a1` runs the tool's `execute` with `currentActor()` returning `{ type: 'AGENT', id: 'a1' }`.
12. [integration] That same agent's `sendMessage` stores the user `ChatMessage` with `authorUserId` the agent's id and `authorType` `'AGENT'`.

### US-002: Project thread routes check keys, and ownership comes from the keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/threads` with a valid PROJECT thread body, and no thread is created.
2. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/threads` with a valid PROJECT thread body.
3. [integration] An agent whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/threads` with a valid PROJECT thread body, and the row has `createdByType` `'AGENT'`.
4. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/threads`, from `GET /projects/p1/threads/<id>` and from `GET /projects/p1/threads/<id>/messages` for a thread another user created.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /projects/p1/threads/<id>/messages` with a valid message on another user's thread with no live session, and the created THREAD job has `requestedById` the admin's id.
6. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `PATCH /projects/p1/threads/<id>` with `{ maxCostUsd: 3 }` on a thread it created.
7. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `PATCH /projects/p1/threads/<id>` with `{ maxCostUsd: 3 }` on a thread another user created, and the cap is unchanged.
8. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/threads/<id>/messages` with a valid message on a thread another user created, and no message is stored.
9. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `POST /projects/p1/threads/<id>/stop` on another user's thread with a RUNNING thread job, and a `THREAD_STOP_TURN` command is created for that job.
10. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `POST /projects/p1/threads/<id>/archive` on another user's thread, and the thread becomes ARCHIVED.
11. [integration] A user whose only source in `p1` is a `project-admin` binding gets 409 with error code `threads.sessionOtherPrincipal` from `POST /projects/p1/threads/<id>/messages` with a valid message on another user's thread whose SESSION job is RUNNING, and no message is stored and no `THREAD_INPUT` command is created.
12. [integration] A user who created a thread in `p1` and whose only source in `p1` is now a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/threads/<id>/messages` with a valid message on that thread.
13. [integration] A user whose only source in `p1` is a binding of a custom role holding `thread.plan.own` and `thread.read` (and no `fleet.job.dispatch`) gets 403 with error code `permissions` from `POST /projects/p1/threads/<id>/plan` on its own REPO thread, and no job is created.
14. [unit] `ThreadEventsGuard.canActivate` for a project member whose `PermissionService.can(principal, 'thread.read', { projectId })` is refused throws a 403 with error code `permissions` before reading the JWT.
15. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /projects/p1/threads/<id>/plan` on another user's REPO thread whose spec is published and whose runner is set, and the created PLAN job has `requestedById` the admin's id.

### US-003: Workspace thread routes check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `developer` binding (and who holds the baseline `member` role) gets 201 from `POST /threads` with a valid body naming `homeProject` `p1`.
2. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /threads` with a valid body naming `homeProject` `p1`, and no thread is created.
3. [integration] An agent whose only source in `p1` is a `developer` binding (so it holds no `thread.workspace.create`) gets 403 with error code `permissions` from `POST /threads` with a valid body.
4. [integration] An agent bound globally to a custom GLOBAL role holding `thread.workspace.create`, `thread.workspace.read.own` and `thread.workspace.message.send.own`, and whose only source in `p1` is a `developer` binding, gets 201 from `POST /threads` naming `homeProject` `p1`, and the row has `createdByType` `'AGENT'`.
5. [integration] The thread creator of a workspace thread homed in `p1`, whose only source in `p1` is a `developer` binding, gets 200 from `GET /threads/<id>` and from `GET /threads/<id>/messages`.
6. [integration] The creator of a workspace thread homed in `p1`, whose only source in `p1` is a `developer` binding and whose thread has a RUNNING thread job, gets 200 from `POST /threads/<id>/stop`, and a `THREAD_STOP_TURN` command is created.
7. [integration] The creator of a workspace thread homed in `p1`, whose only source in `p1` is now a `viewer` binding, gets 403 with error code `permissions` from `PATCH /threads/<id>` with `{ maxCostUsd: 3 }`, and the cap is unchanged.
8. [integration] The creator of a workspace thread homed in `p1`, whose only source in `p1` is now a `viewer` binding, gets 403 with error code `permissions` from `POST /threads/<id>/messages` with a valid message, and no message is stored.
9. [integration] A global admin gets 404 with error code `threads.notFound` from `GET /threads/<id>` for another user's workspace thread.
10. [unit] `WorkspaceThreadsService.create` with no `homeProject`, for a principal whose reachable projects are `p1` (where `PermissionService.can(…, 'thread.create', { projectId: p1 })` is refused) and `p2` (where it is allowed), both with an anchor repo, homes the thread in `p2`.
11. [integration] An agent bound globally to a custom GLOBAL role holding `thread.workspace.create`, `thread.workspace.read.own` and `thread.workspace.message.send.own`, rostered with a `developer` binding in `p2` only, gets 201 from `POST /threads` with no `homeProject`, and the thread is homed in `p2`.

### US-004: Assistant tools check their key (`Workdir: apps/api`)

1. [unit] Every tool the `AssistantToolRegistry` holds has a `key` for which `findCatalogEntry(key)` is defined, and `koda_add_comment.key` is `'comment.create'`, `koda_dispatch_job.key` is `'fleet.job.dispatch'` and `koda_kb_search.key` is `'kb.search'`.
2. [integration] A tool call of `koda_search_tickets` from the thread job of a user whose only source in `p1` is a `viewer` binding answers content that lists the project's tickets and is not an error.
3. [integration] A tool call of `koda_add_comment` with a valid input from the thread job of a user whose only source in `p1` is a binding of a custom role holding `thread.message.send.own`, `thread.read` and `ticket.read` (and no `comment.create`) answers `forbidden: koda_add_comment needs comment.create on p1` with `isError` true, and no `PendingAction` is created.
4. [integration] A tool call of `koda_create_tickets` with a valid input from the thread job of a user whose only source in `p1` is a `developer` binding answers `pending <actionId>: awaiting user approval; do not retry`.
5. [integration] An MCP `tools/call` of `koda_dispatch_job` with a valid input naming `project` `p1`, by an agent whose only source in `p1` is a `viewer` binding and that has a `developer` binding in `p2` (so the tool is listed), answers `forbidden: koda_dispatch_job needs fleet.job.dispatch on p1`, and no job is created.
6. [integration] An MCP `tools/call` of `koda_dispatch_job` naming `project` `p1` with a valid input by an agent whose only source in `p1` is a `developer` binding creates a QUEUED job with `requestedById` the agent's id.
7. [unit] `koda_update_ticket`'s preview with `status` `IN_PROGRESS`, for a context whose `can('ticket.transition.start')` answers false, throws `ToolForbiddenError` with `need` `'ticket.transition.start'`.
8. [unit] `AssistantToolExecutor.checkAction` for a pending action whose requester's `PermissionService.can(actor, '<tool key>', { projectId: action.projectId })` is refused answers `'forbidden'`.
9. [integration] A tool call of `koda_get_ticket` through `POST /fleet/runner/jobs/<jobId>/tools/koda_get_ticket` from the thread job of an agent whose only source in `p1` is a `viewer` binding answers the ticket, and its `AssistantToolCall` row has `actorType` `'agent'` and `actorId` the agent's id.
10. [integration] A tool call of `koda_add_comment` with a valid input from the thread job of an agent whose only source in `p1` is a `developer` binding adds the comment at once, and a `PendingAction` row with `status` `EXECUTED`, `actorType` `'agent'` and `origin` `'thread'` is stored.
11. [integration] `POST /projects/p1/fleet/approvals/<id>/decide` with `{ decision: 'approve' }` by the thread's creator on a pending `assistant_action` approval of `koda_add_comment`, after the creator's only source in `p1` became a binding of a custom role holding `thread.read`, `ticket.read` and `fleet.approval.read` (no `comment.create`), answers 403 with error code `projects`, and no comment is created.
12. [integration] An MCP `tools/call` of `koda_get_action` naming `project` `p1` with an unknown action id, by an agent whose only source in `p1` is a roster row with no role entry, answers `not_found`, not a `forbidden` refusal (its key `assistant.action.read` is implicit).
13. [integration] A tool call of `koda_update_ticket` with `ref` a CREATED ticket of `p1` and `status` `IN_PROGRESS` from the thread job of a user whose only source in `p1` is a binding of a custom role holding `ticket.read`, `ticket.update`, `thread.read` and `thread.message.send.own` (no `ticket.transition.start`) answers `forbidden: koda_update_ticket needs ticket.transition.start on p1`, and no `PendingAction` is created.
14. [integration] A tool call of `koda_dispatch_job` with a valid input from the thread job of an agent whose only source in `p1` is a `developer` binding creates a QUEUED job with `requestedById` the agent's id and `requestedByType` `'AGENT'`.

### US-005: MCP `tools/list` lists only the tools whose key the agent holds (`Workdir: apps/api`)

1. [integration] MCP `tools/list` for an agent whose only source in `p1` is a `viewer` binding lists `koda_search_tickets` and `koda_list_jobs`, and does not list `koda_dispatch_job`, `koda_create_tickets` or `koda_add_memory`.
2. [integration] MCP `tools/list` for an agent whose only source in `p1` is a `developer` binding lists `koda_dispatch_job`, `koda_create_tickets` and `koda_add_memory`.
3. [integration] MCP `tools/list` for an agent with no binding, no roster row and no global role lists `koda_my_projects` and `koda_get_action`, and no project tool.
4. [integration] MCP `tools/call` of `koda_dispatch_job` by an agent whose only source in `p1` is a `viewer` binding answers the MCP SDK's unknown-tool error naming `koda_dispatch_job`, and no job is created.
5. [unit] `kodaMcpToolRegistrations(executor, principal, new Set(['koda_get_ticket']))` answers exactly one registration, named `koda_get_ticket`.
6. [integration] MCP `tools/list` for an agent with a global `admin` binding lists every MCP descriptor name.

### US-006: KB rows are replaced and deleted by `(source, source_id)` and record their creator (`Workdir: apps/api`)

1. [integration] After `VectorStore.indexDocument(p1, { source: 'ticket', sourceId: 's1', ... })` and `indexDocument(p1, { source: 'manual', sourceId: 's1', ... })`, `listDocuments(p1)` holds two rows with `sourceId` `s1`, one of each source.
2. [integration] Indexing `{ source: 'manual', sourceId: 's1', content: 'v2' }` over an existing `manual` `s1` row leaves one `manual` `s1` row with content `v2` and keeps the `ticket` `s1` row.
3. [integration] `VectorStore.deleteBySource(p1, 'manual', 's1')` removes the `manual` `s1` row and keeps the `ticket` `s1` row.
4. [integration] `indexDocument(p1, { source: 'doc', sourceId: 'd1', ..., createdBy: { type: 'AGENT', id: 'a1' }, metadata: { kodaCreatedBy: { type: 'USER', id: 'u9' } } })` followed by `findSourceCreators(p1, 'doc', 'd1')` answers `[{ type: 'AGENT', id: 'a1' }]`.
5. [integration] `findSourceCreators(p1, 'doc', 'd2')` for a row indexed with no `createdBy` answers `[null]`, and for a `(source, sourceId)` with no row answers `[]`.
6. [unit] `VectorStore.deleteBySource(p1, 'manual', "x' OR 1=1")` throws `ValidationAppException` and deletes nothing.
7. [unit] `KbTicketLifecycleSubscriber` handling a ticket deletion event for ticket `t1` in `p1` calls `RagService.deleteBySource(p1, 'ticket', 't1')`.
8. [unit] `IncrementalGraphDiffService` removing node `n1` of `p1` calls `VectorStore.deleteBySource(p1, 'code', 'n1')`.
9. [integration] `indexDocument(p1, { source: 'doc', sourceId: 'd3', ..., metadata: { kodaCreatedBy: { type: 'USER', id: 'u9' } } })` with no `createdBy` followed by `findSourceCreators(p1, 'doc', 'd3')` answers `[null]`.
10. [unit] `VectorStore.findSourceCreators(p1, 'doc', "x' OR 1=1")` throws `ValidationAppException` without querying the table.

### US-007: KB routes check keys and ownership (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/kb/documents` with `{ source: 'manual', sourceId: 'm1', content: 'x' }`, and gets 200 from `GET /projects/p1/kb/documents`.
2. [integration] A user whose only source in `p1` is a `developer` binding gets 400 from `POST /projects/p1/kb/documents` with `{ source: 'ticket', sourceId: 't1', content: 'x' }` and with `{ source: 'code', sourceId: 'c1', content: 'x' }`, and nothing is indexed.
3. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/kb/documents` with `{ source: 'doc', sourceId: 'd1', content: 'x' }`, and `findSourceCreators(p1, 'doc', 'd1')` answers that user.
4. [integration] A second user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/kb/documents` with `{ source: 'doc', sourceId: 'd1', content: 'y' }` over the first user's row, and the row keeps content `x`.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from that same replacing `POST`, and the row's content becomes `y`.
6. [integration] The developer who created `doc` `d1` gets 200 from `DELETE /projects/p1/kb/documents/d1`, and no `doc` or `manual` row with `sourceId` `d1` remains.
7. [integration] Another user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /projects/p1/kb/documents/d1?source=doc` on a row it did not create, and the row remains.
8. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `DELETE /projects/p1/kb/documents/t1?source=manual` while a `ticket` row `t1` exists, and the `ticket` row remains.
9. [integration] `DELETE /projects/p1/kb/documents/d1?source=ticket` by a `project-admin` user answers 400.
10. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/kb/search` with `{ query: 'x' }`, and a user whose only source in `p1` is a `developer` binding gets 200 from it.
11. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/kb/optimize`, and a user whose only source in `p1` is a `project-admin` binding gets 200 from it.
12. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/kb/evaluate/retrieval` with a valid body.
13. [integration] The developer who created `doc` `d1` gets 201 from `POST /projects/p1/kb/documents` with `{ source: 'doc', sourceId: 'd1', content: 'z' }`, and the row's content becomes `z`.
14. [integration] A user whose only source in `p1` is a `project-admin` binding gets 400 from `DELETE /projects/p1/kb/documents/x'y`, and no row is deleted.

### US-008: Memory routes check keys, and memory items have owners (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /memory` with a valid FACT item for `p1`, and no item is stored.
2. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /memory` with a valid FACT item for `p1`, and the stored item has `ownerId` that user and `ownerType` `'USER'`.
3. [integration] An agent whose only source in `p1` is a `developer` binding gets 201 from `POST /memory` with a valid FACT item for `p1`, and the stored item has `ownerType` `'AGENT'`.
4. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /memory` with a FACT whose `(kind, subject, predicate)` matches an active item another developer owns, and that item stays active.
5. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /memory` with a FACT whose key matches an active item it owns, and the old item becomes `superseded`.
6. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /memory` with a FACT whose key matches an active item another user owns, and the old item becomes `superseded`.
7. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /memory` with a FACT whose key matches an active item with `ownerType` null.
8. [integration] A user whose only source in `p1` is a `developer` binding gets 404 with error code `tickets` from `POST /memory/extract` with a `ticket_event` for `p1` whose `ticketId` is a ticket of `p2`, and no item is stored.
9. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /memory/decisions` with a valid decision for `p1`.
10. [integration] A user whose only source in `p1` is a `project-admin` binding, with no global role, gets 201 from `POST /memory` with `ownerId` another user's id, and the stored item has `ownerId` the caller's id.
11. [integration] A global admin gets 201 from `POST /memory` with `ownerId` another user's id, and the stored item has that `ownerId` and `ownerType` null.
12. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/memory` and from `GET /projects/p1/timeline`.
13. [integration] A user whose only source in `p1` is a binding of a custom role holding only `ticket.read` gets 403 with error code `permissions` from `GET /projects/p1/memory` and from `GET /projects/p1/timeline`.
14. [integration] An MCP `tools/call` of `koda_add_memory` naming `project` `p1` by an agent whose only source in `p1` is a `developer` binding, with a key matching an active item another principal owns, answers `forbidden: koda_add_memory needs memory.update on p1`, and the item stays active.
15. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /memory/extract` with a `ticket_event` for a ticket of `p1` whose extracted items include one that would supersede an active item another user owns, and no item of that request is stored.
