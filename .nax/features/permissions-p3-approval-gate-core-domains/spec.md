# SPEC: Permissions P3e-4 — Gating the Agent, Admin, Skill, Memory, Code-Intel, VCS-Sync and KB REST Routes

## Summary

This feature finishes the `gate-core-domains` rollout. It routes the remaining medium-risk REST writes through the route gate that `permissions-p3-approval-gate-core` (5a) shipped and 5b and 5c-1 applied.
- **19 routes are gated:**
  - agents: update, update capabilities, and the project-agent status update;
  - admin: user update, outbox event retry;
  - skills: project skill enable and disable, skill source create and re-resolve;
  - code intelligence: commit index;
  - memory: create, record decision, extract;
  - VCS: sync one issue, sync all issues, sync PR states;
  - knowledge base: add document, import a graphify graph, optimize the table.
- **Six rows leave without being gated.**
  - Three answer or take a secret, so they move to `gate-secret`: `POST /agents` and `POST /agents/:slug/rotate-key` answer a raw API key, and `POST /admin/users` takes a plaintext temporary password that a deferred request would store in `ApprovalRequest.input`.
  - Three are reads sent as `POST` (`kb.search`, `context.query`, `retrieval.evaluate`). The design says reads are not approvable (§4), but the catalog only recognises a key ending in `.read`. Their keys become non-approvable, and their rows leave the allowlist.
- **Slow work runs outside the execution transaction.** An approved request runs its command inside one database transaction (design §4, "the domain write and `status = executed` commit in one transaction"), and that transaction has Prisma's default 5-second timeout. Eight routes call GitHub, run embeddings or write LanceDB, so their commands declare `prepare`: the slow part runs before the transaction, and the transaction does only the database write.
- **Nothing waits under the shipped defaults.** Every key here is `medium` with catalog default `none`. A request waits only when an approval policy names the key.
- **The contract counts 81 gated routes** after this feature (62 + 19). The allowlist holds only `gate-fleet` (36) and `gate-secret` (11) rows, and the `gate-core-domains` label is removed.

This is the fourth and last part of the `gate-core-domains` rollout of feature 5 of P3 (`p3-approval-gate`) in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine").

## Motivation

5a, 5b and 5c-1 gated 62 routes. The rest of the medium-risk writes still bypass the engine on REST: a policy `memory.* → agent` makes the assistant's `koda_add_memory` wait, while the same agent calling `POST /memory` writes at once. `PENDING_GATE_ROUTES` lists 25 such routes under `gate-core-domains`.

**Rulings that bind this feature** (user):
- 2026-10-26 and 2026-10-28 (as in 5a to 5c-1): every approvable REST write route is gated; the deferred run is the command registry; a human acting directly satisfies any mode; secret-bearing routes are deferred to `gate-secret`.
- 2026-10-28: the 48 `gate-core-domains` routes are split in two features; 5c-1 took the ticket domain, this one (5c-2) takes the rest.
- 2026-10-29: the routes with slow external work split it from the write: the slow part runs in the command's `prepare`, outside the execution transaction, as 5b's VCS test does.
- 2026-10-29: graphify import and KB optimize run their LanceDB work in `prepare` too, although it is a write (see Design).
- 2026-10-29: this is one feature, not two.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Three routes move to `gate-secret`.** This applies the 5b ruling ("a route whose answer is a token or secret shown once") to `POST /agents` and `POST /agents/:slug/rotate-key`, which answer `apiKey` in clear, and extends it to an input secret: `POST /admin/users` carries `password`, which `ApprovalRequest.input` would store as plain JSON for deciders to read.
- **Three POST reads become non-approvable.** `catalog.ts` gains `READ_ACTION_KEYS = new Set(['kb.search', 'context.query', 'retrieval.evaluate'])`. `isReadKey(key)` answers true for a key whose last segment is `read` or that is in this set, so these keys become risk `low` and `approvable: false`, as design §4 says ("Reads are not approvable"). No role changes: the role matrix grants keys, not risks. A policy naming one of these keys is refused by policy validation from then on, as for any non-approvable key.
- **Request checks the handler makes today stay before the gate**, so they answer as today and open no request:
  - the encryption-key check of the three sync handlers (400 `vcs`);
  - the roster check and the key-or-self check of `PATCH /projects/:slug/agents/:agentSlug` (404 / 403 `projectAgents`, 403 `permissions`);
  - the `graphifyEnabled` check (400 `rag.graphifyDisabled`) and the empty-nodes answer of graphify import.

  Every other check (membership, attribution, replace checks, conflicts, dedup) runs inside the command, at once or after approval; a failing check settles the request `failed`. This is 5a's rule.
- **An agent's own update is never gated.** `PATCH /projects/:slug/agents/:agentSlug` lets an agent update itself without `agent.update` (graceful OFFLINE shutdown), and a policy on `agent.update` must never make that wait. After the roster check, the handler tests self first: an agent principal whose slug is `agentSlug` calls `agentsService.update` directly, whatever keys it holds, and the handler does not ask `can`. Any other caller is asked `permissions.can(principal, 'agent.update')` (403 `permissions` when denied, as today) and is then gated with `keyCheck: false`, because the handler already proved the key.
- **The project-agent update is global.** Its key `agent.update` is a global key, so it gates with `projectId: null`, as today's handler asks the key "without a project context". Its command re-checks the roster when it runs, through `AgentsService.updateRosteredAgent(projectSlug, agentSlug, dto)` (new), which throws `NotFoundAppException({}, 'projectAgents')` when the agent is no longer on the roster and otherwise calls `update(agentSlug, dto)`.
- **Auth-cache invalidation waits for the commit.** `AgentsService.update`, `.updateCapabilities` and `.removeById` (5b's deferred `agent.delete` runs it) evict the agent's auth cache (`agentAuthProvider.invalidateByTag`), and `UsersAdminService.update` evicts the user's (`cache.invalidate`), right after their write returns. Inside the execution transaction that is before the commit, so a concurrent request can re-cache the old state for the cache TTL: a disabled user or a deleted agent keeps authenticating. Each now hands the eviction to `AfterCommitService.defer(task)` (exported by the global `PermissionsModule`), and runs it at once when `defer` answers false (no scope open: the immediate path). The approval execution opens the scope (`afterCommit.scope`), so a deferred write's eviction runs after its commit.
- **The outbox retry is gated, but agents cannot reach it.** `AdminController` keeps its class-level `JwtAuthGuard`, a passport JWT guard that refuses an agent API key with 401, so only users call these routes and a user always executes at once. The route is gated so the contract has no approvable write route outside the engine, as 5c-1 did for ticket watching. Widening the outbox routes to agents is out of scope.
- **The three sync handlers gain the project.** `VcsController.syncIssue`, `.syncAll` and `.syncPr` have no `@CurrentProject()` today; each appends `@CurrentProject() ctx: ProjectContext` as its last parameter and gates with `projectId: ctx.project.id`.
- **Memory writes move to a service first.** `MemoryController` holds the write logic of its three write routes (membership and key check, attribution, the all-or-nothing replace pre-check of extract, DECISION filtering). US-006 moves it unchanged into `MemoryWriteService` (`memory/memory-write.service.ts`) with `create(principal, dto)`, `recordDecision(principal, dto)` and `extract(principal, event)`; the handlers call them. US-007 then gates the handlers, and the commands call the same methods.
- **The extract guard moves with the logic.** `extractFromEvent`'s `if (!projectId) return { items: [] }` moves unchanged into `MemoryWriteService.extract`; it is unreachable over HTTP (`ExtractEventDto.projectId` is required), so the gated handler always has the body's project id.
- **Memory gates in the body's project.** The memory keys are `any`-scope and every write names its project in the body (`projectId`, required), so each memory route gates with `projectId: <body projectId>`.
- **The KB add logic moves to a service.** `RagController.addDocument` holds the replace check, the index call and the audit entry. US-011 moves them into `KbDocumentAddition` (`rag/kb-document-addition.service.ts`), as 5b moved deletion into `KbDocumentDeletion`.
- **The code-intel audit callback moves into the command.** `CodeIntelController.indexCommit` passes `astIndexService.indexCommit` an `onIndexed` callback that records the audit entry. The command's run passes the same callback, so the entry is still written once, inside the indexing write.
- **`prepare` splits slow work from the write.** `ApprovalExecutionService` runs `prepare` before the execution transaction, then the callback it returns inside it, and re-checks the actor's key in between. The immediate path (no policy, or a human) calls `run`, which does both at once as the handler does today. The split per route:

  | Route | `prepare` (outside the transaction) | callback (inside the transaction) |
  |:--|:--|:--|
  | skill source create | parse the URL, refuse an existing source, resolve the source on GitHub | re-check that the source does not exist and that no other source owns a resolved skill name, then store it with its audit entry |
  | skill source update | read the source, resolve it on GitHub | re-read the source (404 when gone), re-check name owners, then replace its skills (or mark it `RESOLVE_FAILED`) with its audit entry |
  | sync one issue | read the connection, decrypt the token, fetch the issue | re-read the connection and compare `vcsTestTarget` (5c-1), then `syncIssue` |
  | sync all issues | read the connection, fetch and filter all issues | re-read the connection and compare `vcsTestTarget` and `allowedAuthors`, then sync every issue, all or nothing |
  | sync PR states | read the connection and the project's active PR links, fetch each PR's status | re-read the connection and compare `vcsTestTarget`, then write every changed PR state, all or nothing |
  | KB add | embed the content | the replace check, the LanceDB write and the audit entry |
  | graphify import | the whole import (`RagService.importGraphify`) | the audit entry |
  | KB optimize | `RagService.optimizeTable` | the audit entry |

- **A deferred sync is all or nothing.** Today `fullSync` and `syncPrStatus` catch each item's failure and continue. Inside the execution transaction that cannot work: a failed nested write poisons the transaction, and the poisoned commit leaves the request `approved` instead of `failed`. The deferred callbacks therefore let the first item failure propagate, so the transaction rolls back and the request settles `failed`. That covers every swallowing site: the per-issue catch of `fullSync`, the per-link catch of `syncPrStatus`, the catch around its 404-close write, and the catch in `handleMergedPrAutoTransition` (which gains a `{ rethrow }` option). A PR whose status fetch failed in `prepare` also fails the deferred apply. The immediate path keeps today's per-item behaviour.
- **PR link extraction runs after commit.** `syncPrStatus` starts `extractLinksFromPr` without awaiting it. Inside the execution transaction that background work would write through a closed transaction client. The deferred command returns the extraction targets in its result and starts them from `afterCommit` (the engine's after-commit hook, run once the execution transaction committed). `RouteCommandSpec` gains an optional `afterCommit(principal, input, result)` that `routeCommand` maps to `ApprovalCommand.afterCommit`. The immediate path starts them as today.
- **Graphify and optimize do their LanceDB work in `prepare`.** Their slow part is the write itself, in a store the transaction cannot roll back. Graphify's `diffAndApply` also stages its writes for crash recovery (stale marks in Postgres, then LanceDB deletions, then the graph write); inside the execution transaction a failure would roll back the stale marks but keep the deletions, so those nodes would never be re-indexed. So `prepare` runs the import or the optimize exactly as the immediate path does, and the callback writes only the audit entry and answers the result. The doc comment of `ApprovalCommand.prepare` is amended: it may also run work in a store the execution transaction cannot roll back, when that work keeps its own consistency. If the actor's key is revoked between approval and execution, the import has already happened when the request settles `permission-revoked` (ruled 2026-10-29).
- **The frozen input is ids, slugs and the validated body.** An input never carries a request header, a decrypted token or config.
- **Each gating story removes its own `PENDING_GATE_ROUTES` rows**, as in 5c-1. US-001 relaxes the exact gated-route count to a lower bound (at least 62) and the allowlist count case to the `gate-fleet` and `gate-secret` labels; US-013 restores both exactly.
- **`gate-core-domains` leaves the `PendingGateFeature` type in US-013.** `expectedPendingGateRoutes` still answers `'gate-core-domains'` for a new ungated non-fleet approvable write, so such a route fails the contract, as `'gate-high'` does since 5b.
- **Only the HTTP handlers change.** Controller helper methods (`createAgent`, `updateAgent`, `updateAgentCapabilities`, …) and their spec cases stay. Gated handlers keep their parameters, in order; the only handlers that gain a parameter are the three sync handlers (above).

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `READ_ACTION_KEYS` | `permissions/catalog.ts` (exported) | `kb.search`, `context.query`, `retrieval.evaluate` |
| `SECRET_GATE_ROUTES` | `permissions/pending-gate-routes.ts` | gains 3 labels (11 in all) |
| `AgentsService.updateRosteredAgent(projectSlug, agentSlug, dto)` | `agents/agents.service.ts` | roster re-check, then `update` |
| `AgentRouteCommands`, `AGENT_ROUTE_VARIANTS` | `agents/agent-route.commands.ts` | gains `update`, `updateCapabilities` |
| `ProjectRouteCommands`, `PROJECT_ROUTE_VARIANTS` | `projects/project-route.commands.ts` | gains `updateAgent` |
| `UserRouteCommands`, `USER_ROUTE_VARIANTS` | `users/user-route.commands.ts` | new: `update` |
| `OutboxRouteCommands`, `OUTBOX_ROUTE_VARIANTS` | `outbox/outbox-route.commands.ts` | new: `retry` |
| `ProjectSkillRouteCommands`, `PROJECT_SKILL_ROUTE_VARIANTS` | `skills/project-skill-route.commands.ts` | new: `enable`, `disable` |
| `CodeIntelRouteCommands`, `CODE_INTEL_ROUTE_VARIANTS` | `code-intel/code-intel-route.commands.ts` | new: `index` |
| `MemoryWriteService` | `memory/memory-write.service.ts` | new: `create`, `recordDecision`, `extract` |
| `MemoryRouteCommands`, `MEMORY_ROUTE_VARIANTS` | `memory/memory-route.commands.ts` | new: `create`, `recordDecision`, `extract` |
| `VcsManualSync` | `vcs/vcs-manual-sync.service.ts` | new: `syncIssue`/`prepareSyncIssue`, `syncAll`/`prepareSyncAll`, `syncPr`/`prepareSyncPr` |
| `VcsRouteCommands`, `VCS_ROUTE_VARIANTS` | `vcs/vcs-route.commands.ts` | gains `syncIssue`, `syncAll`, `syncPr` |
| `SkillsService.prepareCreateSource`, `.prepareUpdateSource` | `skills/skills.service.ts` | new; `createSource`/`updateSource` become `(await prepare…(…))()` |
| `SkillSourceRouteCommands`, `SKILL_SOURCE_ROUTE_VARIANTS` | `skills/skill-source-route.commands.ts` | gains `create`, `update` |
| `KbDocumentAddition` | `rag/kb-document-addition.service.ts` | new: `add`, `prepare` |
| `KbRouteCommands`, `KB_ROUTE_VARIANTS` | `rag/kb-route.commands.ts` | gains `add`, `graphifyImport`, `optimize` |
| `RouteCommandSpec.afterCommit` | `approvals/route/route-command.ts` | new optional member |

### The gated routes

Each row is one `routeCommand`. "Scope" is the `projectId` passed to `ApprovalRouteGate.run` (`null` = global; "project" = `@CurrentProject()`'s id). The run calls the service the handler calls today, with `principal` the rebuilt `UserPrincipal | AgentPrincipal`. Every body-returning command declares `toResult: (result) => result` unless the row says otherwise; a no-body command declares none. On `executed` the handler answers as today (`JsonResponse.Ok(outcome.result)`, or no body for the 204 and empty-200 routes).

| Story | Route | Key | Scope | Variant | Input | Run |
|:--|:--|:--|:--|:--|:--|:--|
| US-002 | `PATCH /agents/:slug` | `agent.update` | null | `rest:agents.update` | `{ slug, patch: parseBody(UpdateAgentDto, …) }` | `agents.update(slug, patch)` |
| US-002 | `PATCH /agents/:slug/update-capabilities` | `agent.capabilities.update` | null | `rest:agents.update-capabilities` | `{ slug, agentId, capabilities: parseBody(UpdateCapabilitiesDto, …) }` (the DTO of `agents/dto/update-capabilities.dto.ts`; the handler resolves `agentId` with `findBySlug` before gating, as 5b's `agent.delete` does, so a recreated slug is never retargeted) | `agents.updateCapabilities(agentId, capabilities)` |
| US-003 | `PATCH /projects/:slug/agents/:agentSlug` (key holders only) | `agent.update` | null, `keyCheck: false` | `rest:project-agents.update` | `{ slug, agentSlug, patch: parseBody(UpdateAgentDto, …) }` | `agents.updateRosteredAgent(slug, agentSlug, patch)` |
| US-004 | `PATCH /admin/users/:id` | `user.update` | null | `rest:admin-users.update` | `{ id, patch: parseBody(UpdateUserDto, …) }` | `users.update(principal.id, id, patch)` |
| US-004 | `POST /admin/outbox/:eventId/retry` | `outbox.retry` | null | `rest:admin-outbox.retry` | `{ eventId }` | `outboxAdmin.retry(eventId)`, answering `null` (no `toResult`) |
| US-005 | `PUT /projects/:slug/skills/:skillId` | `skill.project.enable` | project | `rest:project-skills.enable` | `{ slug, projectId, skillId }` | `ProjectSkillDto.fromDomain(await skills.enableProjectSkill(projectId, skillId, principal.id))` |
| US-005 | `DELETE /projects/:slug/skills/:skillId` | `skill.project.disable` | project | `rest:project-skills.disable` | `{ slug, projectId, skillId }` | `skills.disableProjectSkill(projectId, skillId)`, answering `null` |
| US-005 | `POST /code-intel/index` | `codeintel.index.write` | project (from the body's `projectSlug`) | `rest:code-intel.index` | `{ projectId, index: parseBody(IndexCommitDto, …) }` | `astIndex.indexCommit(index.repoId, index.commitHash, index.files, projectId, <the audit callback>)` |
| US-007 | `POST /memory` | `memory.create` | the body's `projectId` | `rest:memory.create` | `{ memory: parseBody(CreateMemoryDto, …) }` | `memoryWrites.create(principal, memory)` |
| US-007 | `POST /memory/decisions` | `memory.decision.record` | the body's `projectId` | `rest:memory.decisions.record` | `{ decision: parseBody(RecordDecisionDto, …) }` | `memoryWrites.recordDecision(principal, decision)` |
| US-007 | `POST /memory/extract` | `memory.extract` | the body's `projectId` | `rest:memory.extract` | `{ event: parseBody(ExtractEventDto, …) }` | `memoryWrites.extract(principal, event)` |
| US-008 | `POST /projects/:slug/vcs/sync/:issueNumber` | `vcs.sync.issue` | project | `rest:vcs.sync-issue` | `{ slug, projectId, issueNumber }` | `manualSync.syncIssue(slug, issueNumber)`; `prepare`: `manualSync.prepareSyncIssue(slug, issueNumber)` |
| US-008 | `POST /projects/:slug/vcs/sync` | `vcs.sync.all` | project | `rest:vcs.sync-all` | `{ slug, projectId }` | `manualSync.syncAll(slug)`; `prepare`: `manualSync.prepareSyncAll(slug)` |
| US-009 | `POST /projects/:slug/vcs/sync-pr` | `vcs.sync.pr` | project | `rest:vcs.sync-pr` | `{ slug, projectId }` | `manualSync.syncPr(slug)`; `prepare`: `manualSync.prepareSyncPr(slug)`; `afterCommit` starts the extraction targets; `toResult: (r) => ({ updated: r.updated })`; on `executed` the handler answers `JsonResponse.Ok({ updated: outcome.result.updated })`, as today |
| US-010 | `POST /admin/skills/sources` | `skill.source.create` | null | `rest:admin-skill-sources.create` | `{ source: parseBody(CreateSkillSourceDto, …) }` | `SkillSourceDto.fromDomain(await skills.createSource(source, principal))`; `prepare`: `skills.prepareCreateSource(source, principal)` mapped through `SkillSourceDto.fromDomain` |
| US-010 | `POST /admin/skills/sources/:id/update` | `skill.source.update` | null | `rest:admin-skill-sources.update` | `{ id }` | `SkillSourceDto.fromDomain(await skills.updateSource(id))`; `prepare`: `skills.prepareUpdateSource(id)`, mapped the same way |
| US-011 | `POST /projects/:slug/kb/documents` | `kb.document.add` | project | `rest:kb-documents.add` | `{ slug, projectId, document: parseBody(AddDocumentDto, …) }` | `kbAddition.add(principal, projectId, document)`; `prepare`: `kbAddition.prepare(principal, projectId, document)` |
| US-012 | `POST /projects/:slug/kb/import/graphify` | `kb.graphify.import` | project | `rest:kb.graphify-import` | `{ slug, projectId, graph: parseBody(ImportGraphifyDto, …) }` | import, then the audit entry; `prepare`: the import, answering a callback that records the audit entry |
| US-012 | `POST /projects/:slug/kb/optimize` | `kb.optimize` | project | `rest:kb.optimize` | `{ slug, projectId }` | optimize, then the audit entry; `prepare`: the optimize, answering a callback that records the audit entry |

- Id and string members are read with `parseRouteInput`; a body member with `parseBody` of the route's DTO (a missing body member is parsed as `{}`). `issueNumber` stays a string in the input and is parsed with `parseInt(…, 10)` by `VcsManualSync`, as the handler does today.
- `VcsManualSync` takes the project slug (the input carries it; the execution locks that slug to the request's project) and owns what the three sync handlers do today (find the project with `ProjectsService.findBySlug`, which answers the `key` the ticket refs need, check the encryption key, read the connection, build the provider, call `VcsSyncService` / `VcsPrSyncService`, shape the answer). The handlers keep only the encryption-key check, then gate. `syncIssue` still answers 409 (`HttpException('Issue already synced', CONFLICT)`) for an already-synced issue; a deferred one settles `failed`.
- `VcsSyncService` gains `syncIssues(project, issues, repo, auditKey, { isolate })`: `fullSync` calls it with `isolate: true` (today's per-issue catch), the deferred callback with `isolate: false` (the first error propagates). `VcsPrSyncService` gains `fetchPrStatuses(project, connection, encryptionKey)` (the active links, each with its PR's status, its 404, or its fetch error) and `applyPrStatuses(project, connection, encryptionKey, fetched, auditKey, { isolate })`, which answers `{ updated, skipped, extractions }`; `syncPrStatus` becomes fetch + apply with `isolate: true` and starts the extractions as today. Only `{ updated }` ever leaves the API: the stored result (`toResult`) and the executed body (the handler) both drop `skipped` and `extractions`.
- `AddDocumentDto`'s replace check, `findSourceCreators`, the index call and the audit entry move into `KbDocumentAddition`; `VectorStore.indexDocument(projectId, doc, vector?)` gains an optional precomputed vector (it embeds only when none is given), and `VectorStore.embedForIndex(content)` answers the vector `indexDocument` would compute (the zero vector on an embedding failure, as today), or `null` when no embedding service is present. On `null` the callback writes nothing and answers `{ indexed: false, sourceId }`, as the handler does today when `indexDocument` answers null.

### Module wiring

| Story | Module | Gains | Controllers whose constructor gains `ApprovalRouteGate` |
|:--|:--|:--|:--|
| US-002 | `AgentsModule` | — | none (it has the gate since 5b) |
| US-003 | `ProjectsModule` | — | none (it has the gate since 5b) |
| US-004 | `UsersModule` | imports `ApprovalEngineModule`, `AuthRepositoryModule`; provides `UserRouteCommands` | `AdminUsersController` |
| US-004 | `OutboxAdminModule` | the same; provides `OutboxRouteCommands` | `AdminController` |
| US-005 | `SkillsModule` | provides `ProjectSkillRouteCommands` (it imports the engine since 5b) | `ProjectSkillsController` |
| US-005 | `CodeIntelModule` | imports the two modules; provides `CodeIntelRouteCommands` | `CodeIntelController` |
| US-006 | `MemoryModule` | provides `MemoryWriteService` | none |
| US-007 | `MemoryModule` | imports the two modules; provides `MemoryRouteCommands` | `MemoryController` |
| US-008, US-009 | `VcsModule` | provides `VcsManualSync`; `VcsRouteCommands` injects it | none |
| US-010 | `SkillsModule` | — | none |
| US-011, US-012 | `RagModule` | provides `KbDocumentAddition`; `KbRouteCommands` injects it, `RagService` and `AuditRecorder` | none |

`AuthRepositoryModule` imports only `PrismaModule`, so no module cycle is added. Each gated handler gains `@ApprovalGated()`, keeps its `@Requires` and `@ApiResponse`s, and has the 5a shape:

```ts
const outcome = await this.routeGate.run<AgentResponseDto>({ key: 'agent.update', variant: AGENT_ROUTE_VARIANTS.update, projectId: null, input: { slug, patch: updateDto } });
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return JsonResponse.Ok(outcome.result);
```

A `prepare` command has the 5b `vcs.connection.test` shape:

```ts
this.commands.register(routeCommand<{ slug: string; projectId: string }, SyncAllResultDto>({
  key: 'vcs.sync.all', variant: VCS_ROUTE_VARIANTS.syncAll,
  parse: (input) => parseRouteInput(input, ['slug', 'projectId']),
  prepare: (_principal, input) => this.manualSync.prepareSyncAll(input.slug),
  run: (_principal, input) => this.manualSync.syncAll(input.slug),
  toResult: (result) => result,
}, this.loader));
```

### The allowlist (US-001, US-013)

- US-001: `SECRET_GATE_ROUTES` gains `POST /agents`, `POST /agents/:slug/rotate-key` and `POST /admin/users`, and their `PENDING_GATE_ROUTES` rows are relabelled `gate-secret`. The rows of `POST /context/:slug/query`, `POST /projects/:slug/kb/search` and `POST /projects/:slug/kb/evaluate/retrieval` are deleted (their keys are no longer approvable, so the contract would report them stale).
- US-002 to US-012: each drops its gated routes' rows.
- US-013: the allowlist holds 36 `gate-fleet` and 11 `gate-secret` rows, and nothing else.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| An agent under no policy (the shipped default) | Executes at once, no `ApprovalRequest` row | US-008, US-011 |
| A read route under a policy row for its key | Answers as today; no request | US-001 |
| Agent without the route's key | 403 `permissions` from the guard or the route gate; no request | US-004, US-007 |
| An agent updating itself under a policy on `agent.update`, whatever it holds | Executes at once, no request | US-003 |
| An approved capabilities update whose agent was deleted meanwhile | Request `failed` | US-002 |
| An approved project-agent update whose agent was deleted meanwhile | Request `failed` | US-003 |
| An approved user update that would disable the last active admin | Request `failed` (409 `users.lastAdmin` inside the service) | US-004 |
| An agent calling the outbox retry | 401 from `JwtAuthGuard`, as today; no request | US-004 |
| An approved deferred agent or user write | Its auth-cache eviction runs after the commit | US-002, US-004 |
| An approved memory write the replace check refuses | Request `failed`; nothing written | US-007 |
| Sync with no encryption key configured | 400 `vcs` before the gate; no request | US-008 |
| An approved sync whose connection target changed meanwhile | Request `failed` (`ValidationAppException` `vcs`) | US-008, US-009 |
| An approved PR sync whose merged-PR auto-transition or 404-close write fails | Request `failed`, nothing of it written | US-009 |
| An approved single-issue sync of an issue synced meanwhile | Request `failed` | US-008 |
| An approved full sync or PR sync with one failing item | Request `failed`, nothing of it written | US-008, US-009 |
| An approved skill source create whose source or skill name was taken meanwhile | Request `failed` | US-010 |
| GitHub resolve failure during an approved create | The source is stored `RESOLVE_FAILED`, as today; request `executed` | US-010 |
| An approved KB add that would replace another principal's row | Request `failed`; nothing written | US-011 |
| Graphify import on a project with graphify disabled | 400 `rag.graphifyDisabled` before the gate; no request | US-012 |
| A `prepare` that throws (provider down, resolve error other than `SkillResolveError`) | Request `failed` with `{ error: 'execution-failed', name }` | US-008, US-010, US-012 |
| A KB add with no embedding service | `{ indexed: false, sourceId }`, nothing written, as today | US-011 |
| An approvable write route that is neither gated nor allowlisted | Contract test fails (5a) | US-013 |

### Integration

**Read-only, verified:**
- `ApprovalRouteGate.run({ key, variant, projectId, input, keyCheck? })`, `ApprovalPending`, `@ApprovalGated()`, `routeCommand(spec, loader)`, `parseBody`, `parseRouteInput` (5a, 5b).
- `ApprovalExecutionService.executeOnce`: `prepare` runs before `txManager.run`; the callback runs inside it after `lockById`, the key re-check (`stillHoldsKey`, only when prepared) and `lockProjectSlug` (for a `rest:` variant whose input has `slug`); `afterCommit` runs after commit. A failed callback settles `failed` with `{ error: 'execution-failed', name }`.
- `ApprovalGate.gate`: under mode `none` the command's `execute` runs at once outside any execution transaction; a USER actor executes at once under any mode.
- `AgentsService.update(slug, dto)`, `.updateCapabilities(agentId, dto)`, `.findBySlug(slug)`, `.isOnProjectRosterBySlug(projectSlug, agentSlug)`.
- `UsersAdminService.update(actorId, userId, patch)`; `OutboxAdminService.retry(eventId)`.
- `SkillsService.enableProjectSkill(projectId, skillId, userId)`, `.disableProjectSkill(projectId, skillId)`, `.createSource(input, principal)`, `.updateSource(id)`; `SKILL_RESOLVER` (`GitHubSkillResolver.prototype.resolve`).
- `AstIndexService.indexCommit(repoId, commitHash, files, projectId, onIndexed?)`.
- `VcsSyncService.syncIssue(project, issue, syncMode, repo, auditKey)`, `.fullSync(project, connection, encryptionKey)`, `.filterByAllowedAuthors`; `VcsPrSyncService.syncPrStatus(project, connection, encryptionKey, auditKey)`; `VcsConnectionService.getFullByProject(projectId)`; `vcsTestTarget(connection)` (5c-1); `providerForConnection`, `decryptToken`; `GitHubProvider.prototype.fetchIssue`, `.fetchIssues`, `.getPullRequestStatus` (stub points).
- `RagService.importGraphify(projectId, nodes, links)`, `.optimizeTable(projectId)`, `.findSourceCreators`, `.indexDocument`; `VectorStore.indexDocument(projectId, doc)`.
- Test helpers: `seedWaitPolicy`, `grantKeys`, `grantRole`, `seedFleetHttpWorld`, `seedFleetHttpAgent`, `bootHttpApp`, `data`, `resetThrottle`, `fixtureDb`, `GlobalStubsModule`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `isReadKey` (catalog) | last segment `read` | last segment `read`, or in `READ_ACTION_KEYS` |
| `SECRET_GATE_ROUTES` | 8 labels | 11 labels |
| `PENDING_GATE_ROUTES` | 25 `gate-core-domains`, 36 `gate-fleet`, 8 `gate-secret` | 36 `gate-fleet`, 11 `gate-secret` |
| `PendingGateFeature` | `'gate-secret' \| 'gate-core-domains' \| 'gate-fleet'` | `'gate-secret' \| 'gate-fleet'` |
| `RouteCommandSpec` | no `afterCommit` | optional `afterCommit(principal, input, result)` |
| `ApprovalCommand.prepare` doc | "External read-only work" | also store work the transaction cannot roll back, when that work keeps its own consistency |
| `SkillsService.createSource` / `.updateSource` | resolve and store in one method | `(await this.prepareCreateSource(…))()` / `(await this.prepareUpdateSource(id))()` |
| `VcsSyncService.fullSync` | fetch and sync with a per-issue catch | fetch, then `syncIssues(…, { isolate: true })` |
| `VcsPrSyncService.syncPrStatus` | fetch and write per link | `fetchPrStatuses` then `applyPrStatuses(…, { isolate: true })`, starting the extractions |
| `VectorStore.indexDocument` | `(projectId, doc)`, always embeds | `(projectId, doc, vector?)`, embeds only when no vector is given |
| the 19 handlers | call the service | run the route gate |
| 5 controllers' constructors | no gate | gain `ApprovalRouteGate` |
| `MemoryController` constructor | extraction, repository, project access, permissions, write guard, audit | `MemoryWriteService` (US-006), then also `ApprovalRouteGate` (US-007) |

## Out of Scope

- The 36 `gate-fleet` routes (5d) and the 11 `gate-secret` routes, including the three moved here.
- Changing any catalog default: these keys stay `none`.
- Running a service's domain checks before a request opens, beyond the handler checks listed in Design.
- Assistant or MCP writes on these keys: they keep their primary command.
- Any change to `apps/web` or `apps/cli`.
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`: the read-key rule is code (`READ_ACTION_KEYS`), not an inventory column.
- Migrating stored approval policies whose pattern names `kb.search`, `context.query` or `retrieval.evaluate`: none ship by default, and the engine no longer consults them.
- Bounding the size of a frozen input: `IndexCommitDto.files`, `ImportGraphifyDto.nodes` and `AddDocumentDto.content` are stored whole in `ApprovalRequest.input` when a request waits.
- A transaction timeout other than Prisma's default for the execution transaction: the database writes of a deferred full sync, PR sync or code-intel index run inside it as they are.
- Per-item isolation of a deferred full sync or PR sync: a deferred one is all or nothing (Design).
- US-011 only: the FTS optimize strategy's `onInsert` call after a KB add still runs inside the callback; a counter-triggered optimize there is not moved to `prepare`.
- US-012 only: undoing an import or optimize that `prepare` ran when the request then settles `permission-revoked` (ruled 2026-10-29).
- US-009 only: retrying a failed link extraction; `afterCommit` failures are logged only, as the engine does for every command.
- US-010 only: a unique-violation race on a skill name inside a deferred update; it fails the request instead of answering 409 `skills.nameConflict`.
- `endpoint.e2e.spec.ts` coverage for every gated route: US-013 adds two representative 202 cases.
- US-004 only: agent access to the outbox admin routes (their class-level `JwtAuthGuard` refuses an API key); the retry route's 202 path is unreachable over REST, and its `openapi.json` operation still lists `202`, as every gated route does.
- Moving the other post-write cache evictions of `AgentsService` (`generateApiKey`, `rotateApiKey`, `remove`) after commit: none of them runs inside an execution transaction after this feature.

## Stories

1. **US-001: Secret routes join `gate-secret`, and POST reads stop being approvable** — `Workdir: apps/api` — No dependencies.
2. **US-002: Gated agent update and capabilities update, and auth-cache eviction after commit** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Gated project-agent update** — `Workdir: apps/api` — Depends on US-002 (same service and the shared `PENDING_GATE_ROUTES` rows).
4. **US-004: Gated admin user update and outbox retry** — `Workdir: apps/api` — Depends on US-001.
5. **US-005: Gated project skill enable and disable, and code-intel index** — `Workdir: apps/api` — Depends on US-001.
6. **US-006: Memory writes move to `MemoryWriteService`** — `Workdir: apps/api` — No dependencies.
7. **US-007: Gated memory create, decision and extract** — `Workdir: apps/api` — Depends on US-001, US-006.
8. **US-008: Gated single-issue and full VCS sync** — `Workdir: apps/api` — Depends on US-001.
9. **US-009: Gated VCS PR sync** — `Workdir: apps/api` — Depends on US-008 (same controller, commands class and service).
10. **US-010: Gated skill source create and re-resolve** — `Workdir: apps/api` — Depends on US-005 (same module).
11. **US-011: Gated KB document add** — `Workdir: apps/api` — Depends on US-001.
12. **US-012: Gated graphify import and KB optimize** — `Workdir: apps/api` — Depends on US-011 (same controller and commands class).
13. **US-013: Contract, OpenAPI and endpoint coverage** — `Workdir: apps/api` — Depends on US-003, US-004, US-007, US-009, US-010, US-012.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/src/approvals/approvable-keys.ts`

**US-002**
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/permissions/after-commit.service.ts`
- `apps/api/test/integration/projects/gated-project-routes.integration.spec.ts`

**US-003**
- `apps/api/src/projects/projects.controller.ts`
- `apps/api/src/agents/agents.service.ts`
- `apps/api/test/integration/projects/gated-project-routes.integration.spec.ts`

**US-004**
- `apps/api/src/users/users-admin.service.ts`
- `apps/api/src/outbox/outbox-admin.service.ts`
- `apps/api/test/integration/projects/gated-project-routes.integration.spec.ts`

**US-005**
- `apps/api/src/skills/skills.service.ts`
- `apps/api/src/code-intel/ast-index.service.ts`
- `apps/api/test/integration/audit/audit-code-intel.integration.spec.ts`

**US-006**
- `apps/api/src/memory/memory.controller.ts`
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts`

**US-007**
- `apps/api/src/memory/memory-write.service.ts` — created by US-006, gated here
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts`

**US-008**
- `apps/api/src/vcs/vcs-sync.service.ts`
- `apps/api/src/vcs/vcs-route.commands.ts`
- `apps/api/test/integration/webhook/gated-webhook-vcs-routes.integration.spec.ts`

**US-009**
- `apps/api/src/vcs/vcs-pr-sync.service.ts`
- `apps/api/src/approvals/approval-execution.service.ts`
- `apps/api/src/vcs/vcs-manual-sync.service.ts` — created by US-008; US-009 adds `syncPr` and `prepareSyncPr` and their cases in its spec

**US-010**
- `apps/api/src/skills/skills.service.ts`
- `apps/api/test/integration/audit/audit-skills.integration.spec.ts`

**US-011**
- `apps/api/src/rag/vector-store.service.ts`
- `apps/api/src/rag/kb-document-deletion.service.ts`
- `apps/api/test/integration/rag/gated-kb-document-routes.integration.spec.ts`

**US-012**
- `apps/api/src/rag/rag.service.ts`
- `apps/api/src/rag/incremental-graph-diff.service.ts`
- `apps/api/test/integration/rag/gated-kb-document-routes.integration.spec.ts`

**US-013**
- `apps/api/scripts/export-spec.cjs`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`

### Creates

**US-001**

None: US-001 only changes existing files.

**US-002**
- `apps/api/test/integration/agents/gated-agent-routes.integration.spec.ts`

**US-003**
- `apps/api/test/integration/projects/gated-project-agent-route.integration.spec.ts`

**US-004**
- `apps/api/src/users/user-route.commands.ts`
- `apps/api/src/users/user-route.commands.spec.ts`
- `apps/api/src/outbox/outbox-route.commands.ts`
- `apps/api/src/outbox/outbox-route.commands.spec.ts`
- `apps/api/test/integration/permissions/gated-admin-write-routes.integration.spec.ts`

**US-005**
- `apps/api/src/skills/project-skill-route.commands.ts`
- `apps/api/src/skills/project-skill-route.commands.spec.ts`
- `apps/api/src/code-intel/code-intel-route.commands.ts`
- `apps/api/src/code-intel/code-intel-route.commands.spec.ts`
- `apps/api/test/integration/skills/gated-project-skill-code-intel-routes.integration.spec.ts`

**US-006**
- `apps/api/src/memory/memory-write.service.ts`
- `apps/api/src/memory/memory-write.service.spec.ts`

**US-007**
- `apps/api/src/memory/memory-route.commands.ts`
- `apps/api/src/memory/memory-route.commands.spec.ts`
- `apps/api/test/integration/memory/gated-memory-routes.integration.spec.ts`

**US-008**
- `apps/api/src/vcs/vcs-manual-sync.service.ts`
- `apps/api/src/vcs/vcs-manual-sync.service.spec.ts`
- `apps/api/test/integration/vcs/gated-vcs-sync-routes.integration.spec.ts`

**US-009**
- `apps/api/test/integration/vcs/gated-vcs-pr-sync-route.integration.spec.ts`

**US-010**
- `apps/api/test/integration/skills/gated-skill-source-routes.integration.spec.ts`

**US-011**
- `apps/api/src/rag/kb-document-addition.service.ts`
- `apps/api/src/rag/kb-document-addition.service.spec.ts`
- `apps/api/test/integration/rag/gated-kb-add-route.integration.spec.ts`

**US-012**
- `apps/api/test/integration/rag/gated-kb-graphify-optimize-routes.integration.spec.ts`

**US-013**

None: US-013 only changes existing files.

### Modifies

Controller unit specs: a gated handler's cases assert the `ApprovalRouteGate.run` call and the executed/pending mapping (their gate double answers `{ status: 'executed', result }`), and the service call each one asserted moves to the story's commands spec or new service spec. A spec that only builds the controller adds an `ApprovalRouteGate` provider double (`{ run: vi.fn() }`) and changes no assertion. No existing integration or e2e test has an agent write on these routes under a policy for the key, so none changes behaviour: with no policy, a gated route executes at once and its audit entry still records mode `none`.

**US-001**
- `apps/api/src/permissions/catalog.ts` — READ_ACTION_KEYS (exported); isReadKey also answers true for its members
- `apps/api/src/permissions/catalog.spec.ts` — the "derives … for every catalog key" case's local isReadKey and expectedRisk treat READ_ACTION_KEYS members as reads (import READ_ACTION_KEYS), so its derivation matches the catalog
- `apps/api/src/permissions/pending-gate-routes.ts` — SECRET_GATE_ROUTES gains three labels; their rows are relabelled gate-secret; the three read rows are deleted
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — AC-6 lists 11 labels; AC-11 (POST /memory is gate-core-domains) now asserts POST /admin/users is gate-secret; the US-011 AC-3 counts case asserts only the gate-fleet (36) and gate-secret (11) counts, until US-013
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the "collects exactly 62 gated routes" case becomes "at least 62" (its title follows); US-013 restores an exact count

**US-002**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PATCH /agents/:slug and PATCH /agents/:slug/update-capabilities
- `apps/api/src/agents/agents.service.ts` — constructor gains AfterCommitService (after audit, before the two optional seams); update, updateCapabilities and removeById defer their auth-cache eviction
- `apps/api/src/agents/agents.service.spec.ts` — the deferred-eviction cases; its testing module provides AfterCommitService; existing eviction assertions still hold (no scope is open there, so the eviction runs at once)
- `apps/api/src/agents/agents-create.service.spec.ts` — its testing module (about lines 108-116) provides AfterCommitService (`new AfterCommitService()`); no assertion changes
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — the same (about lines 82-90); no assertion changes
- `apps/api/src/agents/agents-create.routes.spec.ts` — the same (about lines 227-235); no assertion changes
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — the same (about lines 136-166); no assertion changes
- `apps/api/src/agents/agents-audit.spec.ts` — the same (about lines 46-55); no assertion changes
- `apps/api/src/agents/agent-route.commands.ts` — update and updateCapabilities commands
- `apps/api/src/agents/agent-route.commands.spec.ts` — the new registrations and runs
- `apps/api/src/agents/agents.controller.ts` — update and updateCapabilities gated (updateCapabilities resolves the agent id before gating)
- `apps/api/src/agents/agents.controller.spec.ts` — new cases for the update and updateCapabilities handlers; helper-method cases stay

**US-003**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PATCH /projects/:slug/agents/:agentSlug
- `apps/api/src/agents/agents.service.ts` — updateRosteredAgent
- `apps/api/src/agents/agents.service.spec.ts` — the updateRosteredAgent cases
- `apps/api/src/projects/project-route.commands.ts` — constructor gains AgentsService (last); updateAgent command
- `apps/api/src/projects/project-route.commands.spec.ts` — the new registration and run; the constructor call gains the AgentsService double
- `apps/api/src/approvals/approval-execution.service.spec.ts` — its ProjectRouteCommands construction (about line 78) passes an AgentsService double as the 4th argument
- `apps/api/src/projects/projects.controller.ts` — updateProjectAgent tests self first (direct update, no can), else asks can and gates the key holder
- `apps/api/src/projects/projects.controller.spec.ts` — the updateProjectAgent cases whose caller holds the key (about lines 512 and 537) assert the gate call instead of agentsService.update; the self-path case (about lines 596-606, "H4 … OFFLINE without the key") asserts can is not called; every refusal case stays

**US-004**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PATCH /admin/users/:id and POST /admin/outbox/:eventId/retry
- `apps/api/src/users/users.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides UserRouteCommands
- `apps/api/src/users/users.module.spec.ts` — compiles with GlobalStubsModule and also resolves UserRouteCommands
- `apps/api/src/users/admin-users.controller.ts` — constructor gains ApprovalRouteGate; update gated
- `apps/api/src/users/users-admin.service.ts` — constructor gains AfterCommitService (last); update defers its auth-cache eviction
- `apps/api/src/users/users-admin.service.spec.ts` — its UsersAdminService construction passes an AfterCommitService; existing eviction assertions still hold (no scope open); the deferred-eviction case
- `apps/api/src/users/admin-users.controller.spec.ts` — constructs the controller with a gate double; the "passes the acting principal id to update" case asserts the gate call; its service expectation moves to user-route.commands.spec.ts
- `apps/api/src/outbox/outbox-admin.module.ts` — imports the two modules; provides OutboxRouteCommands
- `apps/api/src/outbox/admin.controller.ts` — constructor gains ApprovalRouteGate; retryOutboxEvent gated; the class keeps JwtAuthGuard
- `apps/api/src/outbox/admin.controller.spec.ts` — provides a gate double; the retry cases (about lines 118-145) assert the gate call and that a gate rejection propagates; their service expectations move to outbox-route.commands.spec.ts

**US-005**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops PUT and DELETE /projects/:slug/skills/:skillId and POST /code-intel/index
- `apps/api/src/skills/skills.module.ts` — provides ProjectSkillRouteCommands
- `apps/api/src/skills/project-skills.controller.ts` — constructor gains ApprovalRouteGate; enable and disable gated
- `apps/api/src/code-intel/code-intel.module.ts` — imports the two modules; provides CodeIntelRouteCommands
- `apps/api/src/code-intel/code-intel.module.spec.ts` — compiles with GlobalStubsModule and also resolves CodeIntelRouteCommands
- `apps/api/src/code-intel/code-intel.controller.ts` — constructor gains ApprovalRouteGate (last); indexCommit gated; the audit callback moves to the command
- `apps/api/src/code-intel/code-intel.controller.spec.ts` — the indexCommit cases assert the gate call; their indexCommit and audit expectations move to code-intel-route.commands.spec.ts
- `apps/api/src/code-intel/code-intel-search.controller.spec.ts` — its testing module builds CodeIntelController, so it provides an ApprovalRouteGate double; no assertion changes
- `apps/api/test/unit/code-intel/codeintel.controller.spec.ts` — the same; no assertion changes

**US-006**
- `apps/api/src/memory/memory.controller.ts` — constructor takes MemoryWriteService in place of the write collaborators (the controller has no other routes); the three write handlers call it
- `apps/api/src/memory/memory.module.ts` — provides MemoryWriteService
- `apps/api/src/memory/memory.module.spec.ts` — also resolves MemoryWriteService
- `apps/api/src/memory/memory.controller.spec.ts` — builds the controller with a real MemoryWriteService constructed from the spec's existing doubles, so every write case keeps its assertions

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /memory, POST /memory/decisions, POST /memory/extract
- `apps/api/src/memory/memory.module.ts` — imports ApprovalEngineModule and AuthRepositoryModule; provides MemoryRouteCommands
- `apps/api/src/memory/memory.module.spec.ts` — compiles with GlobalStubsModule and also resolves MemoryRouteCommands
- `apps/api/src/memory/memory.controller.ts` — constructor gains ApprovalRouteGate (last); the three write handlers gated
- `apps/api/src/memory/memory.controller.spec.ts` — the write cases go through a gate double that executes the real command run (it calls the matching MemoryWriteService method and answers { status: 'executed', result }, letting a thrown exception propagate), so they keep their assertions; new cases assert the gate call of each handler

**US-008**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/vcs/sync and POST /projects/:slug/vcs/sync/:issueNumber
- `apps/api/src/vcs/vcs-sync.service.ts` — syncIssues with an isolate option; fullSync calls it with isolate true
- `apps/api/src/vcs/vcs-sync.service.spec.ts` — the syncIssues isolate cases; the fullSync cases stay
- `apps/api/src/vcs/vcs.module.ts` — provides VcsManualSync
- `apps/api/src/vcs/vcs-route.commands.ts` — constructor gains VcsManualSync (last); syncIssue and syncAll commands
- `apps/api/src/vcs/vcs-route.commands.spec.ts` — the new registrations, runs and prepares; the constructor call gains the double
- `apps/api/src/vcs/vcs.controller.ts` — syncIssue and syncAll append @CurrentProject() ctx, keep the encryption-key check, then gate
- `apps/api/test/integration/vcs/vcs-manual-sync.spec.ts` — its syncIssue and syncAll cases (about lines 177-520) pass a project context, assert the gate call and the executed mapping; their provider, VcsSyncService and SyncResultDto expectations move to vcs-manual-sync.service.spec.ts
- `apps/api/src/vcs/vcs.controller.spec.ts` — the syncIssue and syncAll cases (about lines 270-345) pass a project context and assert the gate call and the executed mapping; the missing-key cases still throw before the gate; their provider and service expectations move to vcs-manual-sync.service.spec.ts

**US-009**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/vcs/sync-pr
- `apps/api/src/approvals/route/route-command.ts` — RouteCommandSpec.afterCommit, mapped to ApprovalCommand.afterCommit with the reloaded principal
- `apps/api/src/approvals/route/route-command.spec.ts` — the afterCommit mapping cases
- `apps/api/src/vcs/vcs-pr-sync.service.ts` — fetchPrStatuses and applyPrStatuses; syncPrStatus becomes fetch + apply with isolate true; handleMergedPrAutoTransition gains a rethrow option
- `apps/api/src/vcs/vcs-pr-sync.service.spec.ts` — the fetch/apply cases; the syncPrStatus cases stay
- `apps/api/src/vcs/vcs-route.commands.ts` — syncPr command with afterCommit
- `apps/api/src/vcs/vcs-route.commands.spec.ts` — its registration, prepare and afterCommit
- `apps/api/src/vcs/vcs.controller.ts` — syncPr appends @CurrentProject() ctx and is gated after the encryption-key check; it answers { updated } of the executed result
- `apps/api/src/vcs/vcs.controller.spec.ts` — the syncPr cases (about lines 345-360) pass a project context and assert the gate call; the missing-key case stays

**US-010**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /admin/skills/sources and POST /admin/skills/sources/:id/update
- `apps/api/src/skills/skills.service.ts` — prepareCreateSource and prepareUpdateSource; createSource and updateSource call them
- `apps/api/src/skills/skills.service.spec.ts` — the prepare cases (the resolve runs before the callback; the callback re-checks); the createSource and updateSource cases stay
- `apps/api/src/skills/skill-source-route.commands.ts` — create and update commands
- `apps/api/src/skills/skill-source-route.commands.spec.ts` — the new registrations, runs and prepares
- `apps/api/src/skills/admin-skills.controller.ts` — create and update gated
- `apps/api/src/approvals/route/admin-delete-controllers.spec.ts` — no assertion changes (it builds AdminSkillsController with a gate already)

**US-011**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/kb/documents
- `apps/api/src/rag/vector-store.service.ts` — embedForIndex; indexDocument takes an optional vector
- `apps/api/src/rag/vector-store.service.spec.ts` — the embedForIndex and precomputed-vector cases; the existing indexDocument cases stay
- `apps/api/src/rag/rag.service.ts` — indexDocument forwards the optional vector; embedForIndex
- `apps/api/src/rag/rag.module.ts` — provides KbDocumentAddition
- `apps/api/src/rag/kb-route.commands.ts` — constructor gains KbDocumentAddition (last: registry, deletion, loader, addition); add command
- `apps/api/src/rag/kb-route.commands.spec.ts` — the new registration, run and prepare; the constructor call gains the double
- `apps/api/src/rag/rag.controller.ts` — addDocument gated; its replace check, index call and audit move to KbDocumentAddition
- `apps/api/src/rag/rag.controller.spec.ts` — the addDocument cases (about lines 130-290) assert the gate call; their replace-check, index and audit expectations move to kb-document-addition.service.spec.ts
- `apps/api/src/rag/kb-documents-membership.routes.spec.ts` — its ApprovalRouteGate double (about line 112) executes the real write for variant rest:kb-documents.add (it calls KbDocumentAddition.add with the principal, input.projectId and input.document, answering { status: 'executed', result } and letting a thrown exception propagate), so the 201 and indexDocument cases (about lines 172-181 and 200-210) keep their assertions

**US-012**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /projects/:slug/kb/import/graphify and POST /projects/:slug/kb/optimize
- `apps/api/src/approvals/approval-command.registry.ts` — the prepare doc comment states the store-work allowance (Design); no code change
- `apps/api/src/rag/kb-route.commands.ts` — constructor gains RagService and AuditRecorder (last); graphifyImport and optimize commands
- `apps/api/src/rag/kb-route.commands.spec.ts` — the new registrations, runs and prepares; the constructor call gains the two doubles
- `apps/api/test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts` — its ApprovalRouteGate double (about line 553) executes the real import for variant rest:kb.graphify-import (it calls RagService.importGraphify(input.projectId, input.graph.nodes, input.graph.links ?? []) and answers { status: 'executed', result }), so the AC8 cases (about lines 565-610) keep their assertions
- `apps/api/src/rag/rag.controller.ts` — importGraphify and optimizeTable gated after their handler checks
- `apps/api/src/rag/rag.controller.spec.ts` — the importGraphify and optimizeTable cases (about lines 435-490) assert the gate call; the empty-nodes and graphify-disabled cases still answer before the gate; their service expectations move to kb-route.commands.spec.ts

**US-013**
- `apps/api/src/permissions/pending-gate-routes.ts` — PendingGateFeature and isPendingGateFeature drop gate-core-domains
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — asserts exactly 81 gated routes (title updated)
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the counts case asserts exactly { gate-fleet: 36, gate-secret: 11 }; a new case shows expectedPendingGateRoutes answers gate-core-domains for an ungated non-fleet approvable write; its typed 'gate-core-domains' fixture values (about lines 78 and 90) become a plain string map, so the spec type-checks without the label
- `openapi.json` — regenerated with bun run api:export-spec from the repo root; the 19 gated operations gain a 202 response
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — gatedOperations lists the 81 gated operations; its 202-set case asserts exactly those plus the reindex operation
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the two 202 cases below

### Seams

- US-001 → US-002 to US-012: `seedWaitPolicy` (5c-1) makes each story's 202 path reachable; the catalog change makes US-001's read routes answer 200 under a policy row.
- 5a/5b/5c-1 → US-002 to US-012: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`, `routeCommand`, `parseRouteInput`, `vcsTestTarget`.
- US-002 → US-003: one service (`AgentsService`), and the deferred eviction US-002 adds covers the project-agent update's `update` call.
- US-006 → US-007: `MemoryWriteService` is the run of every memory command; US-007 AC-2 (an approved create writes the item) crosses it.
- US-008 → US-009: `VcsManualSync` and `VcsRouteCommands`; US-009 adds `syncPr`.
- US-009: `RouteCommandSpec.afterCommit` → `ApprovalCommand.afterCommit` → `ApprovalExecutionService.followUp`; US-009 AC-4 (the approved sync starts the extraction after commit) crosses all three.
- US-005 → US-010: one module; US-010 extends the skill-source commands class 5b created.
- US-011 → US-012: one commands class and one controller.
- US-002 to US-012 → US-013: every gated route has left the allowlist; US-013 restores the exact counts and regenerates `openapi.json`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `gated-project-routes.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token and the users `dev` (developer on project `web`), `viewer` and `outsider`; `seedFleetHttpAgent` gives an agent and its API key;
- an agent "holding a key in project P" is bound `['project.read', <the keys>]` in P with `grantKeys`, followed by `PermissionCache.invalidate()`; "holding a global key" is the same binding with no project;
- "under a wait policy" means `seedWaitPolicy(db, <the route's key>, P)` (or `null` for a global key) ran in that test; each file deletes every `ApprovalPolicy`, `ApprovalDecision` and `ApprovalRequest` row in `beforeEach`.

Each AC is its own test with its own rows, per `.nax/rules/api-test-isolation.md`: names, slugs, emails and refs are unique per test, and "Approving AC-n's request" means the test repeats AC-n's call and approves the request it opened. "Approving" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means the response status is 202 and `data` is the pending request summary. "The agent's pending X" means X sent by that agent under a wait policy, which answered 202. The KB fixtures (US-011, US-012) boot with `EMBEDDING_PROVIDER=fake`, as `gated-kb-document-routes.integration.spec.ts` does. The VCS fixtures (US-008, US-009) set `VCS_ENCRYPTION_KEY` with `vi.stubEnv` before boot and seed the connection as `gated-webhook-vcs-routes.integration.spec.ts` does; a PR link satisfies `linkMatchesConnection` (`externalRef` `<owner>/<repo>#<n>`, `prNumber` n, `prState` `open`). Provider and resolver calls are stubbed on their prototypes (`GitHubProvider.prototype.fetchIssue`, `.fetchIssues`, `.getPullRequestStatus`, `GitHubSkillResolver.prototype.resolve`), as `gated-webhook-vcs-routes.integration.spec.ts` stubs `testConnection`. Each AC pins one behaviour; a tail such as "and writes no `ApprovalRequest` row" is part of the behaviour it follows (sizing ruling 2026-10-26: specs plan at their bullet counts). Every prototype stub and spy is restored in `afterEach` (`vi.restoreAllMocks()`), per `.nax/rules/api-test-isolation.md`.

### US-001: Secret routes join `gate-secret`, and POST reads stop being approvable

- AC-1 [unit] `SECRET_GATE_ROUTES` holds exactly the 8 labels of 5c-1 plus `POST /agents`, `POST /agents/:slug/rotate-key` and `POST /admin/users`.
- AC-2 [unit] `PENDING_GATE_ROUTES.get('POST /agents/:slug/rotate-key')` answers `gate-secret`.
- AC-3 [unit] `findCatalogEntry(key)` answers `risk` `low` and `approval` `{ approvable: false, floor: 'none', default: 'none' }` for each of `kb.search`, `context.query` and `retrieval.evaluate` (one `it.each` row each).
- AC-4 [unit] `findCatalogEntry('kb.document.add')?.approval.approvable` is still true.
- AC-5 [unit] `approvableKeys()` contains none of `kb.search`, `context.query` and `retrieval.evaluate`.
- AC-6 [unit] `PENDING_GATE_ROUTES.has(route)` is false for each of `POST /context/:slug/query`, `POST /projects/:slug/kb/search` and `POST /projects/:slug/kb/evaluate/retrieval` (one `it.each` row each).
- AC-7 [integration] Over the booted app, `PENDING_GATE_ROUTES` equals `expectedPendingGateRoutes` of the collected routes.
- AC-8 [integration] Over the booted app, `findContractViolations` reports no violation.

### US-002: Gated agent update and capabilities update, and auth-cache eviction after commit

The acting agent holds global `agent.update` and `agent.capabilities.update`. Each test creates its own target agent with `seedFleetHttpAgent`.

- AC-1 [integration] `PATCH /api/agents/<target>` `{ name: 'renamed' }` by the acting agent under a global wait policy answers 202 with `data` matching `{ permissionKey: 'agent.update', projectId: null }`.
- AC-2 [integration] Approving AC-1's request leaves the target agent named `renamed`.
- AC-3 [integration] `PATCH /api/agents/<target>/update-capabilities` `{ capabilities: ['ts'] }` under a global wait policy answers 202 with `data.permissionKey` `agent.capabilities.update`.
- AC-4 [integration] Approving AC-3's request leaves the target agent's capabilities exactly `['ts']`.
- AC-5 [integration] Approving the acting agent's pending capabilities update after root deleted the target agent while it waited settles the request `failed`.
- AC-6 [integration] `PATCH /api/agents/<target>` with the root token under a global wait policy answers 200 and writes no `ApprovalRequest` row.
- AC-7 [unit] After `onModuleInit`, the registry answers `agent.update` for `rest:agents.update` and `agent.capabilities.update` for `rest:agents.update-capabilities`.
- AC-8 [unit] `AgentsController.update('bot', { name: 'x' }, principal)` calls `routeGate.run` with `{ key: 'agent.update', variant: 'rest:agents.update', projectId: null, input: { slug: 'bot', patch: { name: 'x' } } }`.
- AC-9 [unit] The `rest:agents.update-capabilities` command's run calls `agents.updateCapabilities('a1', { capabilities: ['ts'] })` for input `{ slug: 'bot', agentId: 'a1', capabilities: { capabilities: ['ts'] } }`, and never calls `findBySlug`.
- AC-10 [unit] Inside `AfterCommitService.scope`, `AgentsService.update` calls `agentAuthProvider.invalidateByTag('AGENT:<id>')` only after the scope's callback has returned.
- AC-11 [unit] Outside any scope, `AgentsService.update` calls `agentAuthProvider.invalidateByTag('AGENT:<id>')` before it answers.
- AC-12 [unit] Inside `AfterCommitService.scope`, `AgentsService.removeById` calls `invalidateByTag` only after the scope's callback has returned.

### US-003: Gated project-agent update

The acting agent holds global `agent.update`. Each test creates its own target agent with `seedFleetHttpAgent` and binds it `['project.read']` in P (which puts it on P's roster).

- AC-1 [integration] `PATCH /api/projects/<P>/agents/<target>` `{ status: 'PAUSED' }` by the acting agent under a global wait policy for `agent.update` answers 202 with `data` matching `{ permissionKey: 'agent.update', projectId: null }`.
- AC-2 [integration] Approving AC-1's request leaves the target agent's status `PAUSED`.
- AC-3 [integration] Approving the acting agent's pending project-agent update after root deleted the target agent while it waited settles the request `failed`.
- AC-4 [integration] `PATCH /api/projects/<P>/agents/<target>` `{ status: 'OFFLINE' }` by the target agent itself (no `agent.update`) under a global wait policy answers 200 with `data.status` `OFFLINE` and writes no `ApprovalRequest` row.
- AC-5 [integration] The same self update by a target agent that also holds global `agent.update`, under a global wait policy, answers 200 and writes no `ApprovalRequest` row.
- AC-6 [integration] `PATCH /api/projects/<P>/agents/<target>` by an agent holding no `agent.update` that is not the target answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-7 [unit] After `onModuleInit`, the registry answers `agent.update` for `rest:project-agents.update`.
- AC-8 [unit] `ProjectsController.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, <a principal whose can is allowed>, <ctx>)` calls `routeGate.run` with `{ key: 'agent.update', variant: 'rest:project-agents.update', projectId: null, input: { slug: 'alpha', agentSlug: 'bot', patch: { status: 'PAUSED' } }, keyCheck: false }`.
- AC-9 [unit] `ProjectsController.updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE' }, <agent-a's principal>, <ctx>)` calls `agentsService.update('agent-a', { status: 'OFFLINE' })`, and never calls `permissions.can` or `routeGate.run`.
- AC-10 [unit] The `rest:project-agents.update` command's run calls `agents.updateRosteredAgent('alpha', 'bot', { status: 'PAUSED' })` for input `{ slug: 'alpha', agentSlug: 'bot', patch: { status: 'PAUSED' } }`.
- AC-11 [unit] `AgentsService.updateRosteredAgent('alpha', 'bot', dto)` throws `NotFoundAppException` with key `projectAgents` when `isOnProjectRosterBySlug` answers false, and never calls `update`.

### US-004: Gated admin user update and outbox retry

The acting agent holds global `user.update`. Each user test creates its own target user with root's `POST /api/admin/users`; each outbox test inserts its own `dead` outbox event row.

- AC-1 [integration] `PATCH /api/admin/users/<target>` `{ disabled: true }` by the agent under a global wait policy answers 202 with `data` matching `{ permissionKey: 'user.update', projectId: null }`.
- AC-2 [integration] Approving AC-1's request leaves the target user disabled.
- AC-3 [integration] Approving the agent's pending `{ disabled: true }` for the only active global admin settles the request `failed`, and that admin stays enabled.
- AC-4 [integration] `PATCH /api/admin/users/<target>` by an agent holding only `project.read` answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-5 [integration] `POST /api/admin/outbox/<event>/retry` with the root token under a global wait policy for `outbox.retry` answers 200, leaves the event `pending` and writes no `ApprovalRequest` row.
- AC-6 [integration] `POST /api/admin/outbox/<event>/retry` with an agent key holding global `outbox.retry` answers 401, as today.
- AC-7 [unit] `UsersModule` compiled with `GlobalStubsModule` resolves `UserRouteCommands`, and after init its registry answers a `user.update` command for `rest:admin-users.update`.
- AC-8 [unit] The `rest:admin-users.update` command's run for a user principal with id `u1` calls `users.update('u1', 'u2', { disabled: true })` for input `{ id: 'u2', patch: { disabled: true } }`.
- AC-9 [unit] After init, the outbox registry answers an `outbox.retry` command for `rest:admin-outbox.retry`, and its run calls `outboxAdmin.retry('dl-001')` and answers `null`.
- AC-10 [unit] `AdminController.retryOutboxEvent(principal, 'dl-001')` calls `routeGate.run` with `{ key: 'outbox.retry', variant: 'rest:admin-outbox.retry', projectId: null, input: { eventId: 'dl-001' } }`.
- AC-11 [unit] Inside `AfterCommitService.scope`, `UsersAdminService.update` evicts the user's auth-state cache only after the scope's callback has returned.

### US-005: Gated project skill enable and disable, and code-intel index

The agent holds `skill.project.enable`, `skill.project.disable` and `codeintel.index.write` in P. Each skill test registers its own catalog skill row; each index test uses its own `repoId`.

- AC-1 [integration] `PUT /api/projects/<P>/skills/<skill>` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'skill.project.enable', projectId: P }`.
- AC-2 [integration] Approving AC-1's request leaves the skill enabled for P.
- AC-3 [integration] Approving the agent's pending `DELETE /api/projects/<P>/skills/<skill>` on an enabled skill leaves it disabled for P.
- AC-4 [integration] Approving the agent's pending enable of a skill row deleted while it waited settles the request `failed`.
- AC-5 [integration] `POST /api/code-intel/index` `{ projectSlug: <P's slug>, repoId, commitHash, files: [<one TypeScript file declaring one function>] }` by the agent under a wait policy answers 202 with `data.permissionKey` `codeintel.index.write`.
- AC-6 [integration] Approving AC-5's request leaves at least one symbol stored for that `repoId` and commit.
- AC-7 [integration] Approving AC-5's request leaves exactly one `codeintel.index.write` audit entry for that `repoId`.
- AC-8 [integration] `PUT /api/projects/<P>/skills/<skill>` with the root token under a wait policy answers 200 and writes no `ApprovalRequest` row.
- AC-9 [unit] After init, the registries answer commands for `rest:project-skills.enable` (`skill.project.enable`), `rest:project-skills.disable` (`skill.project.disable`) and `rest:code-intel.index` (`codeintel.index.write`).
- AC-10 [unit] The `rest:project-skills.enable` command's run for a user principal with id `u1` calls `skills.enableProjectSkill('p1', 's1', 'u1')` for input `{ slug: 'alpha', projectId: 'p1', skillId: 's1' }`.
- AC-11 [unit] The `rest:code-intel.index` command's run calls `astIndex.indexCommit('r1', 'c1', <the files>, 'p1', <a callback>)`, and calling that callback with `{ symbolsIndexed: 2, filesIndexed: 1 }` records an audit entry with key `codeintel.index.write` and resource id `r1`.
- AC-12 [unit] `CodeIntelModule` compiled with `GlobalStubsModule` resolves `CodeIntelRouteCommands`.

### US-006: Memory writes move to `MemoryWriteService`

`MemoryWriteService` gets the controller's write collaborators (extraction, repository, project access, permissions, write guard, audit) and its private helpers (`assertMayWrite`, `mayAttribute`, `write`) unchanged.

- AC-1 [unit] `MemoryWriteService.create(principal, { projectId: 'p1', kind: 'DECISION', … })` throws `ValidationAppException` with key `memory` and writes nothing.
- AC-2 [unit] `MemoryWriteService.create` for a principal whose `can` of `memory.update` is denied writes the item with `ownerId` the principal's id, ignoring the body's `ownerId`.
- AC-3 [unit] `MemoryWriteService.recordDecision` for a principal whose `can` of `memory.update` is allowed records the decision with the body's `actorId`.
- AC-4 [unit] `MemoryWriteService.extract` drops every extracted item of kind `DECISION` before writing.
- AC-5 [unit] `MemoryWriteService.extract` throws `NotFoundAppException` with key `tickets` when the event's `ticketId` is not a live ticket of its project.
- AC-6 [unit] `MemoryWriteService.extract` throws `ForbiddenAppException` with key `permissions` and writes no item when the replace check refuses one extracted item.
- AC-7 [unit] `MemoryController.createMemory(dto, principal)` answers what `MemoryWriteService.create(principal, dto)` answers.
- AC-8 [unit] `MemoryModule` compiled with `GlobalStubsModule` resolves `MemoryWriteService`.

Verification note: the move changes no behaviour, so `permissions-memory-routes.integration.spec.ts` must pass unchanged; it is not edited.

### US-007: Gated memory create, decision and extract

The agent holds `memory.create`, `memory.decision.record` and `memory.extract` in P (a developer on P holds the same through its role).

- AC-1 [integration] `POST /api/memory` `{ projectId: P, kind: 'FACT', subject, predicate, object }` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'memory.create', projectId: P }`.
- AC-2 [integration] Approving AC-1's request leaves one active item with that subject and predicate whose `ownerId` is the agent.
- AC-3 [integration] Approving the agent's pending `POST /api/memory/decisions` `{ projectId: P, topic, decision }` leaves one active DECISION item for that topic.
- AC-4 [integration] Approving the agent's pending `POST /api/memory/extract` (a `ticket_event` `status_changed` event of a ticket of P) leaves one active FACT `ticket:<id> status` item.
- AC-5 [integration] Approving the agent's pending memory create whose key `dev` wrote an active item for while it waited settles the request `failed`, and `dev`'s item stays active.
- AC-6 [integration] `POST /api/memory` by an agent holding only `project.read` in P answers 403 with key `permissions` and writes no `ApprovalRequest` row.
- AC-7 [integration] `POST /api/memory` with `dev`'s token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-8 [unit] After init, the registry answers commands for `rest:memory.create` (`memory.create`), `rest:memory.decisions.record` (`memory.decision.record`) and `rest:memory.extract` (`memory.extract`).
- AC-9 [unit] The `rest:memory.create` command's run calls `memoryWrites.create(<principal>, <the parsed memory>)` for input `{ memory: { projectId: 'p1', kind: 'FACT', subject: 's', predicate: 'p' } }`.
- AC-10 [unit] `MemoryController.createMemory(dto, principal)` calls `routeGate.run` with `{ key: 'memory.create', variant: 'rest:memory.create', projectId: dto.projectId, input: { memory: dto } }`.

### US-008: Gated single-issue and full VCS sync

P has a GitHub VCS connection (seeded as `gated-webhook-vcs-routes.integration.spec.ts` seeds it). The agent holds `vcs.sync.issue` and `vcs.sync.all` in P.

- AC-1 [integration] `POST /api/projects/<P>/vcs/sync/7` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'vcs.sync.issue', projectId: P }`, and the `fetchIssue` stub was not called.
- AC-2 [integration] Approving AC-1's request, with `fetchIssue` answering issue 7, leaves one ticket of P whose external VCS id names issue 7.
- AC-3 [integration] Approving AC-1's request while the connection's `repoName` was changed between the `fetchIssue` call and the write (the stub writes it before answering) settles the request `failed`, and no ticket names issue 7.
- AC-4 [integration] Approving the agent's pending single-issue sync after issue 7 was synced while it waited settles the request `failed`.
- AC-5 [integration] Approving the agent's pending `POST …/vcs/sync`, with `fetchIssues` answering issues 8 and 9, leaves two tickets naming them, and the request `result.issuesSynced` 2.
- AC-6 [integration] Approving the agent's pending full sync while creating the ticket of issue 9 throws (`PrismaVcsRepository.prototype.createTicketFromIssue` stubbed to throw for it) settles the request `failed`, and no ticket names issue 8.
- AC-7 [integration] `POST …/vcs/sync` by the agent with no policy seeded, the same throwing stub and issues 8 and 9, answers 200 with `issuesSynced` 1.
- AC-8 [integration] `POST …/vcs/sync/7` with the root token under a wait policy answers 200 and writes no `ApprovalRequest` row.
- AC-9 [unit] After init, the registry answers commands for `rest:vcs.sync-issue` (`vcs.sync.issue`) and `rest:vcs.sync-all` (`vcs.sync.all`), each with a `prepare`.
- AC-10 [unit] `VcsSyncService.syncIssues(project, issues, repo, 'vcs.sync.all', { isolate: false })` rethrows the first issue's write error.
- AC-11 [unit] `VcsManualSync.prepareSyncAll('alpha')` calls `fetchIssues` once, and the callback it answers calls no provider method.
- AC-12 [unit] `VcsController.syncAll('alpha', <ctx>)` with no encryption key configured throws `ValidationAppException` with key `vcs` and never calls `routeGate.run`.
- AC-13 [integration] Approving the agent's pending full sync while the connection's `allowedAuthors` was changed between the `fetchIssues` call and the write (the stub writes it before answering) settles the request `failed`, and no ticket names issue 8.
- AC-14 [integration] Approving the agent's pending full sync while `fetchIssues` throws settles the request `failed` with `result.error` `execution-failed`.

### US-009: Gated VCS PR sync

P has a GitHub VCS connection and a ticket with a link to PR 12 in state `open`. AC-12's ticket is set `IN_PROGRESS` directly (the merged-PR auto-transition only runs for an `IN_PROGRESS` ticket). The agent holds `vcs.sync.pr` in P.

- AC-1 [integration] `POST /api/projects/<P>/vcs/sync-pr` by the agent under a wait policy answers 202 with `data.permissionKey` `vcs.sync.pr`.
- AC-2 [integration] Approving AC-1's request, with `getPullRequestStatus` answering PR 12 closed with branch `feat/x`, leaves the link's `prState` `closed`.
- AC-3 [integration] Approving AC-1's request leaves the request `result` exactly `{ updated: 1 }`.
- AC-4 [integration] Approving AC-1's request, with `getPullRequestStatus` answering PR 12 closed with branch `feat/x`, calls the `VcsLinkExtractorService.prototype.extractLinksFromPr` spy once, and the request is already `executed` when the spy runs.
- AC-5 [integration] Approving AC-1's request while `getPullRequestStatus` throws a non-404 error for one of two linked PRs settles the request `failed`, and neither link's `prState` changed.
- AC-6 [unit] `routeCommand` maps a spec's `afterCommit` to a command `afterCommit` that calls it with the reloaded principal, the input and the result.
- AC-7 [unit] `routeCommand` of a spec without `afterCommit` answers a command with no `afterCommit`.
- AC-8 [unit] `VcsPrSyncService.applyPrStatuses(…, { isolate: false })` rethrows the first link's write error.
- AC-9 [unit] `VcsPrSyncService.syncPrStatus` still counts a link whose status fetch threw a non-404 error as skipped and updates the others.
- AC-10 [unit] The `rest:vcs.sync-pr` command's `toResult({ updated: 1, skipped: 0, extractions: [<one>] })` answers `{ updated: 1 }`.
- AC-11 [integration] `POST /api/projects/<P>/vcs/sync-pr` with the root token, `getPullRequestStatus` answering PR 12 closed, answers 200 with `data` exactly `{ updated: 1 }`.
- AC-12 [integration] Approving AC-1's request, with `getPullRequestStatus` answering PR 12 merged and `PrismaVcsRepository.prototype.applyMergedPrTransition` stubbed to throw, settles the request `failed`, and the link's `prState` stays `open`.
- AC-13 [integration] Approving AC-1's request while the connection's `repoName` was changed between the `getPullRequestStatus` call and the write (the stub writes it before answering) settles the request `failed`, and the link's `prState` stays `open`.
- AC-14 [integration] Approving AC-1's request, with `getPullRequestStatus` throwing `NotFoundAppException` for PR 12 and `PrismaVcsRepository.prototype.updateTicketLinkWithPrState` stubbed to throw, settles the request `failed`, and the link's `prState` stays `open`.

### US-010: Gated skill source create and re-resolve

The agent holds global `skill.source.create` and `skill.source.update`. `GitHubSkillResolver.prototype.resolve` is stubbed per test with a unique skill name.

- AC-1 [integration] `POST /api/admin/skills/sources` `{ gitUrl, ref: 'main', path: 'skills' }` by the agent under a global wait policy answers 202 with `data` matching `{ permissionKey: 'skill.source.create', projectId: null }`, and `resolve` was not called.
- AC-2 [integration] Approving AC-1's request leaves one source with that URL in status `OK` carrying the stubbed skill.
- AC-3 [integration] Approving AC-1's request after root registered the same source while it waited settles the request `failed`.
- AC-4 [integration] Approving AC-1's request with `resolve` throwing `SkillResolveError('no_skills')` leaves the source stored with status `RESOLVE_FAILED` and the request `executed`.
- AC-5 [integration] Approving the agent's pending `POST /api/admin/skills/sources/<id>/update` leaves the source's skills the ones the stub answers.
- AC-6 [integration] Approving the agent's pending re-resolve after root deleted the source while it waited settles the request `failed`.
- AC-7 [integration] `POST /api/admin/skills/sources` with the root token under a global wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-8 [unit] `SkillsService.prepareCreateSource(input, principal)` calls `resolve` once, and the callback it answers calls `resolve` no more.
- AC-9 [unit] The callback of `prepareCreateSource` throws `ConflictAppException` with key `skills.sourceExists` when the source was stored after the prepare.
- AC-10 [unit] The callback of `prepareCreateSource` throws `ConflictAppException` with key `skills.nameConflict` when another source took a resolved skill name after the prepare.
- AC-11 [unit] The callback of `prepareUpdateSource(id)` throws `NotFoundAppException` with key `skills.sourceNotFound` when the source was deleted after the prepare.
- AC-12 [unit] The callback of `prepareUpdateSource(id)` throws `ConflictAppException` with key `skills.nameConflict` when another source took a resolved skill name after the prepare.
- AC-13 [unit] After init, the registry answers commands for `rest:admin-skill-sources.create` (`skill.source.create`) and `rest:admin-skill-sources.update` (`skill.source.update`), each with a `prepare`.
- AC-14 [integration] Approving AC-1's request with `resolve` throwing a plain `Error` settles the request `failed` with `result.error` `execution-failed`, and no source with that URL is stored.

### US-011: Gated KB document add

The agent holds `kb.document.add` in P. `VectorStore.prototype.embedForIndex` is spied so a test can count embeddings.

- AC-1 [integration] `POST /api/projects/<P>/kb/documents` `{ source: 'manual', sourceId, content: 'hello' }` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'kb.document.add', projectId: P }`.
- AC-2 [integration] After AC-1's request, before approval, the knowledge base of P lists no document with that `sourceId`.
- AC-3 [integration] Approving AC-1's request leaves one document with that `sourceId` whose creator is the agent.
- AC-4 [integration] Approving AC-1's request calls `embedForIndex` exactly once.
- AC-5 [integration] Approving the agent's pending add of a `sourceId` whose row root wrote while it waited settles the request `failed`, and root's row stays.
- AC-6 [integration] `POST …/kb/documents` by the agent with no policy seeded answers 201 with `data.indexed` true and writes no `ApprovalRequest` row.
- AC-7 [unit] `KbDocumentAddition.prepare(principal, 'p1', dto)` embeds the content, and the callback it answers calls `indexDocument('p1', <the doc>, <that vector>)`.
- AC-8 [unit] The callback throws `ForbiddenAppException` with key `permissions` and indexes nothing when the pair has a row of another creator and the principal may not delete any row.
- AC-9 [unit] `VectorStore.indexDocument(projectId, doc, vector)` stores the given vector and never calls `embed`.
- AC-10 [unit] With `embedForIndex` answering `null` (no embedding service), the callback that `KbDocumentAddition.prepare` answers indexes nothing and answers `{ indexed: false, sourceId }`.
- AC-11 [unit] `RagController.addDocument('alpha', dto, principal)` calls `routeGate.run` with `{ key: 'kb.document.add', variant: 'rest:kb-documents.add', projectId: <alpha's id>, input: { slug: 'alpha', projectId: <alpha's id>, document: dto } }`.

### US-012: Gated graphify import and KB optimize

P has graphify enabled. The agent holds `kb.graphify.import` and `kb.optimize` in P.

- AC-1 [integration] `POST /api/projects/<P>/kb/import/graphify` `{ nodes: [<one node>], links: [] }` by the agent under a wait policy answers 202 with `data.permissionKey` `kb.graphify.import`.
- AC-2 [integration] Approving AC-1's request leaves the node's document in P's knowledge base and the request `result.imported` 1.
- AC-3 [integration] Approving AC-1's request leaves exactly one `kb.graphify.import` audit entry for P.
- AC-4 [integration] `POST …/kb/import/graphify` on a project with graphify disabled by the agent under a wait policy answers 400 with key `rag.graphifyDisabled` and writes no `ApprovalRequest` row.
- AC-5 [integration] Approving the agent's pending `POST /api/projects/<P>/kb/optimize` leaves the request `executed` with `result` `{ optimized: true }`.
- AC-6 [integration] Approving the agent's pending optimize while `RagService.prototype.optimizeTable` throws settles the request `failed` and writes no `kb.optimize` audit entry.
- AC-7 [unit] The `rest:kb.graphify-import` command's `prepare` calls `ragService.importGraphify('p1', nodes, links)`, and the callback it answers records the `kb.graphify.import` audit entry and answers the import result without calling `importGraphify` again.
- AC-8 [unit] The `rest:kb.optimize` command's run calls `ragService.optimizeTable('p1')` and records one `kb.optimize` audit entry.
- AC-9 [unit] `RagController.importGraphify('alpha', { nodes: [], links: [] })` answers `{ imported: 0, cleared: 0 }` and never calls `routeGate.run`.
- AC-10 [unit] After init, the registry answers commands for `rest:kb.graphify-import` (`kb.graphify.import`) and `rest:kb.optimize` (`kb.optimize`), each with a `prepare`.

### US-013: Contract, OpenAPI and endpoint coverage

- AC-1 [integration] Over the booted app, the collected routes contain exactly 81 gated routes.
- AC-2 [integration] Over the booted app, `findContractViolations` reports no violation.
- AC-3 [unit] `PENDING_GATE_ROUTES` holds exactly 36 `gate-fleet` and 11 `gate-secret` entries and nothing else.
- AC-4 [unit] `expectedPendingGateRoutes` over one ungated `POST /x` route requiring `ticket.create` answers `[['POST /x', 'gate-core-domains']]`, which `findContractViolations` with the shipped `PENDING_GATE_ROUTES` reports as `ungated-approvable-write`.
- AC-5 [unit] `openapi.json`'s `post /api/memory` operation has a `202` response.
- AC-6 [unit] `openapi.json`'s `post /api/agents` operation has no `202` response.
- AC-7 [unit] `openapi.json`'s `post /api/projects/{slug}/kb/search` operation has no `202` response.
- AC-8 [unit] The operations of `openapi.json` with a `202` response are exactly the 81 gated ones plus `post /api/projects/{slug}/knowledge/repos/{repoId}/reindex`.
- AC-9 [integration] In `endpoint.e2e.spec.ts`, `PUT /api/projects/:slug/skills/:skillId` with the key of an agent granted `skill.project.enable` in the project, under a wait policy deleted in a `finally`, answers exactly 202.
- AC-10 [integration] In `endpoint.e2e.spec.ts`, `POST /api/memory` with the key of an agent granted `memory.create` in the project, under a wait policy deleted in a `finally`, answers exactly 202.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass, which also proves `gate-core-domains` left `PendingGateFeature`. AC-5 to AC-8 live in `src/approvals/approval-openapi.contract.spec.ts`.
