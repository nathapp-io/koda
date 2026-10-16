<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5b-1d-1 — Workspace Threads (Personal Thread Kind, Home Project, Creator-Only Routes, Runner Path)

## Summary

koda threads today are either bound to a repo (`REPO`) or to a project (`PROJECT`), and both are readable by every
member of their project. This feature adds a third kind, `WORKSPACE`: a personal thread that belongs to its creator
only, lives under top-level `/threads` API routes, and runs its sessions on a runner with no checkout, like a PROJECT
thread. Its jobs are booked to a **home project** chosen at creation (S5b-R13), but no project thread route, project
thread events stream or runner tool call ever serves a WORKSPACE thread to anyone but its creator.

This is feature 1d-1 of fleet S5b (umbrella design `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md`,
§2 rulings S5b-R7, R9, R12, R13; §10 row 4). Row 4 is split in two (ruling 1d-D1 below): this feature ships the thread
kind end to end in the API and the runner; feature 1d-2 `fleet-s5b-workspace-tools` adds the web `/threads` pages, the
`project` argument on koda tools and the `koda_my_projects` tool. A WORKSPACE session in this feature has no koda tools.

## Motivation

The koda assistant must answer questions across projects ("which projects have pending tickets?"). A PROJECT thread
cannot: it is readable by every member of its project (S5a visibility), so it must never carry another project's data
(S5b-R12). Today `ChatThreadKind` is `'REPO' | 'PROJECT'` (`packages/fleet-protocol/src/threads.ts:15`) and every thread
route is project-scoped (`apps/api/src/fleet/threads/threads.controller.ts:20`, `ProjectMembershipGuard`): there is no
place for a thread that only its creator may read. The transcript itself is safe from the job-log routes already — a
THREAD job uploads only a `thread` stream (`apps/runner/src/logs/log-shipper.ts:94`), and `LOG_STREAMS`
(`apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts:1`) never serves it — so this feature needs no log change.

## Design

### Rulings that bind every story

User, 2026-10-15 (umbrella): S5b-R7 (WORKSPACE tools take a validated `project` argument — delivered in 1d-2), S5b-R9
(placement capabilities, no protocol bump), S5b-R12 (WORKSPACE threads: creator-only list/read/act, top-level
`/threads`), S5b-R13 (anchor repo and home project are bookkeeping only; the runner never clones, fetches or touches the
anchor; no git token).

Drafting calls (spec author, 2026-10-16; the user asked to skip the questions):

- **1d-D1 split.** Umbrella row 4 does not fit seven stories. This feature: API + runner. Feature 1d-2
  `fleet-s5b-workspace-tools`: web pages, the `project` tool argument (S5b-R7), the per-kind descriptor catalog and
  `koda_my_projects`. Until 1d-2, a WORKSPACE ASSIGN carries no `kodaTools` and the runner tool route refuses a
  WORKSPACE job.
- **1d-D2 creator-only, admins included.** Only `ChatThread.createdById` can list, read, send to, command, archive or
  stream a WORKSPACE thread through a thread route. A global ADMIN who is not the creator gets 404, as anyone else does
  (S5b-R12).
- **1d-D3 home project.** The *reachable* projects of a user are `ProjectsService.findAllForPrincipal(principal)`
  (non-deleted; a global ADMIN reaches every project). A project can *host* the user's jobs when the user's ability for
  it — `KodaCaslAbilityFactory.createForUser(withProjectRole(principal, role))`, with `role` from
  `ProjectAccessService.resolveMembership` — can `CREATE` `FleetJob` (DEVELOPER and above; a global ADMIN everywhere).
  - Default (body has no `homeProject`): the first reachable project, ordered by `createdAt` ascending then `id`
    ascending, that has a `ProjectMember` row for the user (`ProjectAccessService.findMembershipRole` not null — so a
    global ADMIN's default is one of the projects they actually belong to, not the oldest project on the system), can
    host the user's jobs, and has a fleet repo (`IFleetRepoRepository.findAnchor` not null). None → 409
    `threads.noFleetRepo`.
  - Explicit `homeProject` slug: not a reachable project's slug (unknown, deleted, or not a member) → 404 `projects`;
    reachable but cannot host the user's jobs → 403 `threads.homeProjectAccess`; no fleet repo → 409
    `threads.noFleetRepo`. Unknown and unreachable answer the same 404, so the route is no project-existence oracle.
  - `ChatThread.projectId` stores the home project. It never changes.
- **1d-D4 capability.** A runner advertises `workspaceThreads: true`; WORKSPACE THREAD jobs are placed only on such
  runners (misfit `workspace_threads`, recoverable). This keeps a WORKSPACE ASSIGN off runners that predate the kind and
  would refuse it with `invalid thread kind`.
- **1d-D5 the session job.** A WORKSPACE THREAD job uses the home project's anchor repo (S5b-R13) as `repoId` and the
  anchor's `defaultBranch` as `ref`, `feature` = `thread-<threadId>`; budget gate keys use the home project and the
  anchor, as a PROJECT thread does. The skills snapshot is the home project's. A WORKSPACE turn gets no project brief and
  no repository context.
- **1d-D6 no koda tools, no project code.** A WORKSPACE ASSIGN never carries `kodaTools` or `projectRepos`, its session
  never shows the "koda tools unavailable" notice, and `POST /fleet/runner/jobs/:jobId/tools/:name` answers 409
  `fleet.notThreadJob` for a WORKSPACE thread's job (1d-2 lifts this with the `project` argument).
- **1d-D7 project thread surfaces never expose a WORKSPACE thread.** Every project-scoped thread lookup excludes kind
  `WORKSPACE` (404 `threads.notFound`) and the project thread events stream answers 404. The THREAD job itself stays
  visible in its home project's job lists, job detail, dashboards, analytics, budgets and activity, and the home
  project's job operators can cancel it (S5b-R13 accepts that bookkeeping; none of those surfaces carries transcript
  text).
- **1d-D8 no git token.** A git-token request without `repoId` for a WORKSPACE THREAD job is refused with reason
  `repo_not_assigned`; the anchor's token is never minted for it.
- **1d-D9 send re-checks the home project.** Every send re-runs the 1d-D3 host check on `thread.projectId`: the project
  must still be reachable (not deleted, still a member unless global ADMIN) and able to host the creator's jobs, else 403
  `threads.homeProjectAccess`. The check runs before the send transaction (as the REPO path's repository context does);
  a demotion that lands between the check and the commit is not detected for that one send.
- **1d-D10 thread scope.** The thread repository takes a `ThreadScope` instead of a bare `projectId` for every lookup it
  shares between the two route families (worked type below).
- The kill switch is unchanged: `FLEET_THREADS_ENABLED` gates WORKSPACE threads exactly as it gates the other kinds.

### Integration

This feature changes the symbols below. Each baseline exists only to locate the code; it is never the interface to
implement.

**Protocol package** (`packages/fleet-protocol/src/threads.ts`, `index.ts`; US-001, additive only)

- `ChatThreadKind` / `CHAT_THREAD_KINDS` (`threads.ts:15-16`) — Baseline: `'REPO' | 'PROJECT'`. Target:
  `export type ChatThreadKind = 'REPO' | 'PROJECT' | 'WORKSPACE'` and
  `export const CHAT_THREAD_KINDS = ['REPO', 'PROJECT', 'WORKSPACE'] as const`. `ThreadAssign.kind` (`threads.ts:71`)
  keeps its type name; its doc gains "WORKSPACE: a personal thread, no checkout, no project repositories".
- `RunnerCapabilities` (`index.ts:76-87`) — Target: gains `workspaceThreads?: true` ("Fleet S5b 1d: the runner hosts
  WORKSPACE threads with no checkout. Absent on older runners.").

**API contract and data** (US-001)

- `CHAT_THREAD_KINDS` mirror (`apps/api/src/fleet/common/thread-jobs.ts:13`) — Target: `['REPO', 'PROJECT', 'WORKSPACE']`.
- `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts:121-168`) — Target: accepts
  `workspaceThreads`, strict like `projectThreads` (`:141`): only exactly `true`; any other present value fails with
  reason `workspaceThreads`; the parsed result has `workspaceThreads: true` only when the report had it.
- `RunnerSummaryDto` (`apps/api/src/fleet/runners/dto/runner-summary.dto.ts:26-57`) — Target: gains
  `workspaceThreads: boolean`, true iff `protocolVersion >= THREAD_MIN_PROTOCOL_VERSION` and the stored capabilities have
  `workspaceThreads === true` (same shape as `hasProjectThreads`).
- `ChatThreadRecord` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts:69-82`) — Baseline: no `projectId`.
  Target: gains `projectId: string` (the thread's project; for WORKSPACE, the home project) and
  `homeProject?: { slug: string; name: string }` (set only by workspace-scope reads, US-002). `mapThread`
  (`prisma-chat-thread.repository.ts:469-481`) emits `projectId` from the row. `ThreadDto` (`dto/thread.dto.ts:8-31`)
  gains `@ApiProperty() projectId: string`.
- `mapThreadKind` (`prisma-chat-thread.repository.ts:33`) — Baseline: `PROJECT` maps to `PROJECT`, anything else to
  `REPO`. Target: `PROJECT` and `WORKSPACE` map to themselves, anything else to `REPO`.
- `ThreadDto.kind` (`dto/thread.dto.ts:11`) — Target: enum `['REPO', 'PROJECT', 'WORKSPACE']`. `CreateThreadDto.kind`
  (`:89`) stays `['REPO', 'PROJECT']`: the project create route never creates a WORKSPACE thread
  (`validateCreateThread` keeps refusing it with reason `kind`).
- `repoThreadFields` (`chat-thread.domain.ts:18-30`) — Target: also throws `threads.notRepoThread` for
  `kind === 'WORKSPACE'` (defensive: the create paths never give a WORKSPACE row repo fields).
- `ChatThread` (`apps/api/prisma/schema.prisma`, model `ChatThread`) — Target: the `kind` comment reads
  `// REPO | PROJECT | WORKSPACE`; gains `@@index([createdById, kind, lastActivityAt])`. New migration
  `apps/api/prisma/migrations/20261022090000_chat_thread_workspace/migration.sql` (sorts after the latest,
  `20261021091000_knowledge_project_patterns`) creating index `ChatThread_createdById_kind_lastActivityAt_idx`. No
  column change: `kind` is already a `String` column.

**Thread scope** (US-002)

- `ThreadScope` — new, in `chat-thread.domain.ts`:

  ```ts
  /** Which threads a lookup may see: a project's REPO and PROJECT threads, or one user's WORKSPACE threads. */
  export type ThreadScope = { kind: 'project'; projectId: string } | { kind: 'workspace'; userId: string };
  ```

  The repository turns it into a Prisma `where` fragment: `project` → `{ projectId, kind: { not: 'WORKSPACE' } }`;
  `workspace` → `{ createdById: userId, kind: 'WORKSPACE' }`. A `workspace`-scope `list` or `get` also reads each
  thread's home project (`project: { select: { slug: true, name: true } }`, soft-deleted projects included) into
  `homeProject`.
- `ChatThreadRepository` (`chat-thread.domain.ts:93-107`) and `PrismaChatThreadRepository` — Baseline: `list(projectId,
  …)`, `get(projectId, id)`, `updateCap(projectId, …)`, `command(projectId, …)`, `archive(projectId, …)`,
  `sendMessage({ projectId, … })`. Target: each takes `scope: ThreadScope` in place of `projectId` (`sendMessage`'s
  input field becomes `scope`), and every `chatThread.findFirst` / `findMany` inside them filters by the scope fragment
  (both the pre-lock and the under-lock reads). `publish(projectId, …)` and `discard(projectId, …)` keep `projectId`;
  their thread reads gain `kind: { not: 'WORKSPACE' }`. `sendRefusalOf(projectId, thread)`, `handoff`, `messages`,
  `archivedThreadIds` are unchanged.
- `ThreadsService` (`threads.service.ts`) — public signatures unchanged; each call into the repository passes
  `{ kind: 'project', projectId }`.
- `ThreadEventsGuard` (`thread-events.controller.ts:26-56`) — Target: the thread read also requires
  `kind !== 'WORKSPACE'`; a WORKSPACE thread answers `NotFoundAppException({}, 'threads.notFound')` before a stream slot
  is acquired.
- `IFleetJobRepository.findThreadTokenScope` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:249`,
  `prisma-fleet-job.repository.ts:216-223`) — Baseline: returns kind `'PROJECT'` or `'REPO'`. Target: returns
  `{ kind: ChatThreadKind; action: string } | null`, with `WORKSPACE` when the thread row says `WORKSPACE`.
- Test helper `seedThreadJobFor` (`apps/api/test/helpers/thread-fixtures.ts:40-62`) — Target: `SeedThreadOptions` gains
  optional `kind`, `createdById` and `projectId`; a `WORKSPACE` or `PROJECT` seed writes null `repoId`, `baseRef`,
  `feature` and `specPath` on the thread (the job keeps `world.repoId` as its anchor). Defaults keep today's REPO seed.

**Workspace create** (US-003)

- `validateCreateWorkspaceThread(value: CreateWorkspaceThreadInput): NormalizedCreateWorkspaceThread` — new, in
  `thread-input.ts`:

  ```ts
  export interface CreateWorkspaceThreadInput { kind?: ChatThreadKind; repoId?: string; feature?: string; baseRef?: string; homeProject?: string; title: string; maxCostUsd?: number; backend: ThreadBackend }
  export interface NormalizedCreateWorkspaceThread { kind: 'WORKSPACE'; homeProject?: string; title: string; maxCostUsd: string; backend: ThreadBackend & { kind: 'native' } }
  ```

  Checks, in order, first failure wins: `kind` (absent or `WORKSPACE`, else reason `kind`); any of `repoId`, `feature`,
  `baseRef` present (not undefined, not null) → reason `workspaceFields`; `homeProject` absent or null means "default",
  otherwise it must be a string of 1 to 100 characters, else reason `homeProject`; then the same `title`, `maxCostUsd`
  (default 5) and `backend` checks as `validateCreateThread`, and a backend of kind `acp` → reason `backend`. All
  failures are `ValidationAppException({ reason }, 'threads.input')` (400).
- `CreateWorkspaceThreadDto` (`dto/workspace-thread.dto.ts`, new) — every field (`kind`, `repoId`, `feature`, `baseRef`,
  `homeProject`, `title`, `maxCostUsd`, `backend`) carries `@Allow()` as `CreateThreadDto` does (`thread.dto.ts:89-95`),
  so the global whitelisting pipe keeps `repoId` / `feature` / `baseRef` for the validator to refuse.
- `WorkspaceThreadsService` — new, `apps/api/src/fleet/threads/workspace-threads.service.ts`, provided by
  `ThreadsModule`. `create(principal: UserPrincipal, input: CreateWorkspaceThreadInput): Promise<ChatThreadRecord>`:
  kill switch (409 `threads.disabled`), validation, home-project resolution (1d-D3), then
  `ChatThreadRepository.create({ kind: 'WORKSPACE', projectId: home.id, repoId: null, baseRef: null, feature: null, … })`
  with `skills = SkillsService.snapshotForProject(home.id)`; the result carries `homeProject` = the home project's
  `{ slug, name }`. `ThreadsModule` imports `ProjectsModule` (for `ProjectsService`; no module cycle — no module behind
  `ProjectsModule` imports a fleet module) beside the `AuthModule` it already imports for `KodaCaslAbilityFactory`.
- `WorkspaceThreadDto` (`dto/workspace-thread.dto.ts`) — `ThreadDto` plus
  `@ApiProperty() homeProject: { slug: string; name: string }`.
- `WorkspaceThreadsController` — new, `apps/api/src/fleet/threads/workspace-threads.controller.ts`,
  `@Controller('threads')`, with `@ApiTags('fleet threads')`, `@ApiBearerAuth()`, and `@ApiOperation` / `@ApiResponse`
  on every route (`api-controllers.md`). Every route answers 403 `threads.principal` to a non-user principal (as
  `ThreadsController.assertUser`). `POST /threads` → 201 `WorkspaceThreadDto`.
- i18n (`apps/api/src/i18n/{en,zh}/threads.json`): new key `homeProjectAccess`.

**Workspace read routes and events** (US-004)

- `WorkspaceThreadsService.list(userId, status, skip, take)`, `get(userId, id)` (adds `sendRefusal` and `handoff` as
  `ThreadsService.get` does), `messages(userId, id, afterSeq, limit)` — all through `{ kind: 'workspace', userId }`; a
  miss answers 404 `threads.notFound`.
- Routes: `GET /threads` (query `status`, `page`, `size` validated exactly as `ThreadsController.list`, same 400
  reasons) → `{ items: WorkspaceThreadDto[]; threadsEnabled: boolean }`; `GET /threads/:id` →
  `WorkspaceThreadDetailDto` (`ThreadDetailDto` fields plus `homeProject`); `GET /threads/:id/messages` (same `afterSeq`
  / `limit` rules as the project route).
- `WorkspaceThreadEventsGuard` and `WorkspaceThreadEventsController` — new, `workspace-thread-events.controller.ts`,
  `@Controller('threads/:id/events')`, mirroring `ThreadEventsGuard` / `ThreadEventsController`
  (`thread-events.controller.ts`): a non-user principal → 403 `threads.principal`; a thread that is not this user's
  WORKSPACE thread → 404 `threads.notFound`, checked before a stream slot is acquired; `stillAllowed` re-reads the
  principal and allows the stream while it is not revoked. No project membership check.
- `ThreadsModule` (`threads.module.ts:19-23`) — Target: `controllers` gain `WorkspaceThreadsController` and
  `WorkspaceThreadEventsController`; `providers` gain `WorkspaceThreadsService` and `WorkspaceThreadEventsGuard`.

**Workspace turns** (US-005)

- `WorkspaceThreadsService.sendMessage(principal, id, input)`: validates the body as `ThreadsService.sendMessage` does
  (400 `threads.input`, reason `message`), reads the thread through the workspace scope (404), runs the 1d-D9 host check
  on `thread.projectId`, then calls `ChatThreadRepository.sendMessage({ scope: { kind: 'workspace', userId }, …,
  repoContext: undefined })`. It never calls `ProjectBriefService.resolveRepoContext`.
- `updateCap`, `stop`, `endSession`, `answer`, `archive` — the `ThreadsService` equivalents through the workspace
  scope; `archive` passes `canArchive: false` (creator only, 1d-D2). Routes: `POST /threads/:id/messages` (201, or 200
  for a deduplicated `clientMessageId`), `PATCH /threads/:id`, `POST /threads/:id/stop`, `POST /threads/:id/end-session`,
  `POST /threads/:id/answer`, `POST /threads/:id/archive`, with the status codes of their project counterparts.
- `jobTargetFor` (`prisma-chat-thread.repository.ts:411-429`) — Target: a `WORKSPACE` thread resolves
  `anchorRepoFor(thread.projectId)` (409 `threads.noFleetRepo` when null) and returns `repoId` = anchor id, `ref` =
  anchor `defaultBranch`, `instructions` = `buildWorkspaceThreadInstructions({ skills })`. No project row or brief read.
- `sendRefusalFor` (`:333-352`) — Target: the anchor branch applies to `WORKSPACE` as it does to `PROJECT`.
- `buildWorkspaceThreadInstructions(input: { skills: ThreadSkillSource[] }): string` — new, in `thread-instructions.ts`:

  ```ts
  export function buildWorkspaceThreadInstructions(input: { skills: ThreadSkillSource[] }): string {
    const lines = [
      'You are a brainstorming partner in a koda workspace thread. This thread belongs to no project and no repository.',
      'Ask one question at a time. You have no repository, no shell, no web access and no koda tools; do not claim facts about projects, tickets or code you cannot see.',
    ];
    return [...lines, ...skillLines(input.skills)].join('\n');
  }
  ```

**ASSIGN, placement, token, tool route and notices** (US-006)

- `findThreadAssign` (`prisma-fleet-job.repository.ts:224-240`) — Target: `kind` is `WORKSPACE` when the row says
  `WORKSPACE`, `PROJECT` when it says `PROJECT`, otherwise `REPO`; `feature` keeps `thread.feature ?? thread-<threadId>`.
- `firstMisfit` THREAD branch (`apps/api/src/fleet/jobs/placement-rules.ts:118-124`) — Target: right after the
  `project_threads` check, a job whose `thread.kind` is `WORKSPACE` on a runner whose `capabilities.workspaceThreads !==
  true` returns the new `MisfitReason` `'workspace_threads'`. Not in `PERMANENT_MISFITS`. Added to `MisfitReason`
  (`:13`), `PlacementMisfitDto.reason` (`jobs/dto/fleet-job.dto.ts:129`) and the dashboard list
  (`dashboard/dashboard.types.ts:111`).
- `withKodaTools` (`apps/api/src/fleet/jobs/placement.service.ts:223-226`) — Target: returns the thread unchanged when
  `thread.kind === 'WORKSPACE'` (1d-D6). `attachProjectRepos` (`:211-214`) already attaches only for `PROJECT`.
- Sync git tokens (`apps/api/src/fleet/sync/sync.service.ts:137-140`) — Target: a request without `repoId` for a THREAD
  job whose `findThreadTokenScope` answers `WORKSPACE` pushes `{ jobId, reason: 'repo_not_assigned' }` to
  `gitTokenErrors` and mints nothing.
- `RunnerToolService.call` (`apps/api/src/fleet/assistant/runner-tool.service.ts:44-52`) — Target: after the
  `fleet.notThreadJob` check, a job whose `findThreadTokenScope` answers `WORKSPACE` throws
  `ConflictAppException({}, 'fleet.notThreadJob')` (409); its `jobs` dependency gains `findThreadTokenScope`.
- `sessionNotices` (`apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts:477-490`) — Target: a
  `WORKSPACE` thread never gets `kodaToolsUnavailableOn`.

**Runner** (US-007)

- `parseAssign` thread block (`apps/runner/src/supervisor/assign-parser.ts:213-216`, `:248`) — Target: accepts kind
  `WORKSPACE`; a `WORKSPACE` block with an action other than `SESSION` returns `{ ok: false, detail: 'invalid thread
  action' }`; `projectRepos` / `projectReposUnavailable` on a `WORKSPACE` block return `{ ok: false, detail: 'invalid
  project repos' }` (unchanged rule: only `PROJECT` may carry them).
- Capability probe (`apps/runner/src/capabilities/nax-probe.ts:156-175`) — Target: the report gains
  `workspaceThreads: true`.
- `ThreadJobRun.run` (`apps/runner/src/thread/thread-job-run.ts:274`) — Target: `thread.kind === 'WORKSPACE'` takes
  the same `runProject` path as `PROJECT` (no credentials, no worktree, scratch dir `threadScratchDir(homeDir,
  threadId)`, skill tools only — `projectCodeTools` yields nothing without `projectRepos`).
- `command('THREAD_PUBLISH', …)` (`:890`) — Target: also answers `{ result: 'rejected', detail: 'not_repo_thread' }`
  for a `WORKSPACE` run.

Symbols this feature reads but does not change: `THREAD_MIN_PROTOCOL_VERSION` (`threads/thread-send-rules.ts:9`),
`IFleetRepoRepository.findAnchor` (`repos/domain/fleet-repo.domain.ts`), `ProjectsService.findAllForPrincipal`
(`apps/api/src/projects/projects.service.ts:80-90`), `ProjectAccessService.resolveMembership` /
`findMembershipRole` (`projects/project-access.service.ts:45-80`), `withProjectRole` (`projects/project-context.ts`),
`SkillsService.snapshotForProject`, `LiveStreamRegistry`, `ThreadEventBus`, `createLiveStream`, `skillLines`
(same-file helper in `thread-instructions.ts`).

Patterns to follow: strict capability parsing — `projectThreads` (`capabilities-core.ts:141`); runner summary flag —
`hasProjectThreads` (`runner-summary.dto.ts:26-30`); placement misfit — `project_threads` (`placement-rules.ts:123`);
project create permission check — `ThreadsController.create` (`threads.controller.ts:29-37`); SSE guard and stream —
`ThreadEventsGuard` (and `apps/api/test/helpers/sse-client.ts` for HTTP-level stream tests); migration tests —
`scratchSchemaBefore` / `applyMigration` (`apps/api/test/helpers/migration-schema.ts`); route e2e coverage —
`apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Project thread route (`get`, `messages`, send, cap, commands, archive, publish, discard, plan, run) on a WORKSPACE thread id | 404 `threads.notFound` | US-002 |
| Project thread events stream on a WORKSPACE thread | 404 `threads.notFound` | US-002 |
| `POST /threads` with kind other than `WORKSPACE` | 400 `threads.input`, reason `kind` | US-003 |
| `POST /threads` with `repoId`, `feature` or `baseRef` | 400 `threads.input`, reason `workspaceFields` | US-003 |
| `POST /threads` with a non-string or over-long `homeProject` | 400 `threads.input`, reason `homeProject` | US-003 |
| `POST /threads` with an ACP backend | 400 `threads.input`, reason `backend` | US-003 |
| `POST /threads` while threads are disabled | 409 `threads.disabled` | US-003 |
| `POST /threads` with no eligible default home project | 409 `threads.noFleetRepo` | US-003 |
| `POST /threads` naming a reachable project the creator cannot create fleet jobs in | 403 `threads.homeProjectAccess` | US-003 |
| `POST /threads` naming a project with no fleet repo | 409 `threads.noFleetRepo` | US-003 |
| `POST /threads` naming an unknown or unreachable project | 404 `projects` | US-003 |
| Any `/threads` route called by an agent or runner principal | 403 `threads.principal` | US-004 |
| `/threads/:id` routes for a thread that is not the caller's WORKSPACE thread (other user, admin, or another kind) | 404 `threads.notFound` | US-004, US-005 |
| `/threads/:id/events` for a thread that is not the caller's WORKSPACE thread | 404 `threads.notFound`, no stream slot used | US-004 |
| Send after the creator lost `CREATE FleetJob` on the home project, was removed from it, or it was deleted | 403 `threads.homeProjectAccess`; no message written | US-005 |
| Send after the home project lost its last fleet repo | 409 `threads.noFleetRepo`; no job created | US-005 |
| WORKSPACE THREAD job with no runner advertising `workspaceThreads` | job stays QUEUED; misfit `workspace_threads` | US-006 |
| Git token request (no `repoId`) for a WORKSPACE THREAD job | `gitTokenErrors` reason `repo_not_assigned`; nothing minted | US-006 |
| Runner tool call for a WORKSPACE THREAD job | 409 `fleet.notThreadJob` | US-006 |
| WORKSPACE ASSIGN with a non-SESSION action, or with project repositories | ASSIGN refused, `invalid thread action` / `invalid project repos` | US-007 |
| `THREAD_PUBLISH` to a WORKSPACE run | ack `rejected`, detail `not_repo_thread` | US-007 |

## Out of Scope

- Web pages for WORKSPACE threads (`/threads` list, new and detail pages, nav and command-palette entries): feature 1d-2 `fleet-s5b-workspace-tools`; this feature ships the API and the runner only.
- koda tools in WORKSPACE threads — the `project` tool argument (S5b-R7), a per-kind descriptor catalog and the `koda_my_projects` tool — are feature 1d-2; a WORKSPACE session in this feature gets no koda tools and the runner tool route refuses its job.
- Refusing a `project` argument on koda tools in REPO and PROJECT threads (S5b-R7) is feature 1d-2.
- Project code mirrors or code tools for WORKSPACE threads: a WORKSPACE session never reads any repository.
- ACP backends for WORKSPACE threads: refused at creation.
- `write_doc`, Publish, Discard, Plan and Run for WORKSPACE threads: no `/threads/:id/publish`, `discard`, `plan` or `run` routes exist.
- Visibility of WORKSPACE threads through any thread route to anyone but their creator, global admins included (S5b-R12, 1d-D2).
- Changing a WORKSPACE thread's home project after creation, or converting a thread between kinds.
- Hiding a WORKSPACE thread's THREAD job from the home project's job lists, job detail, job events, bundle route, dashboards, analytics, budgets or activity, or stopping the home project's job operators from cancelling it (S5b-R13 bookkeeping; none of these carries transcript text).
- Changes to the job-log routes: a THREAD job's transcript is uploaded as the `thread` stream, which `LOG_STREAMS` never serves.
- Hiding the home project's slug and name from the creator's own `/threads` responses after the creator leaves that project.
- A database check constraint for the kind rule (1a-R4 still applies: the create paths enforce it).
- A `FLEET_PROTOCOL_VERSION` bump; the additions are optional fields gated by the `workspaceThreads` capability.
- Notifications, emails or activity feed entries specific to WORKSPACE threads.
- A Playwright journey; this feature has no web change.
- US-005 only: budget pauses scoped to the home project or its anchor repo also stop WORKSPACE threads; this coupling is accepted (S5b-R13).
- US-005 only: a demotion that commits between the 1d-D9 host check and the send transaction is not detected for that one send.
- US-003 only: rate limiting of `POST /threads` beyond the API's global throttler.

## Stories

1. **US-001: Workspace kind contract, runner capability and index** — `Workdir: apps/api` — No dependencies.
2. **US-002: Thread scope; project thread surfaces never expose a WORKSPACE thread** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Create WORKSPACE threads with a home project** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: WORKSPACE read routes and events stream** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: WORKSPACE turns, commands and the session job** — `Workdir: apps/api` — Depends on US-004.
6. **US-006: WORKSPACE ASSIGN, placement, git tokens, tool route and notices** — `Workdir: apps/api` — Depends on US-005.
7. **US-007: Runner accepts and runs WORKSPACE sessions** — `Workdir: apps/runner` — Depends on US-001.

US-001 also edits `packages/fleet-protocol/src/threads.ts` and `packages/fleet-protocol/src/index.ts`. Its changes are
additive (a new union member and a new optional capability), so `bun run type-check` at the repo root passes for every
package after it. US-002 changes the thread repository's method signatures and owns every compile site that calls them
(`ThreadsService`), so the `apps/api` type-check passes after US-002. Every story that changes the API contract
(US-001, US-003, US-004, US-005, US-006) regenerates the committed `openapi.json` with `bun run api:export-spec` from the
repo root.

### Context Files

**US-001**

- `packages/fleet-protocol/src/threads.ts` — `ChatThreadKind`, `CHAT_THREAD_KINDS`, `ThreadAssign.kind`
- `apps/api/src/fleet/common/capabilities-core.ts` — strict `projectThreads` parsing to mirror
- `apps/api/src/fleet/runners/dto/runner-summary.dto.ts` — `hasProjectThreads`, `RunnerSummaryDto`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `mapThreadKind`, `mapThread`
- `apps/api/test/helpers/migration-schema.ts` — `scratchSchemaBefore`, `applyMigration`

**US-002**

- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRepository`, gains `ThreadScope`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — the scoped reads in `list`, `get`, `updateCap`, `command`, `archive`, `sendMessage`, `publish`, `discard`
- `apps/api/src/fleet/threads/thread-events.controller.ts` — `ThreadEventsGuard`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadTokenScope`
- `apps/api/src/fleet/threads/threads.service.ts` — callers that now pass a project scope

**US-003**

- `apps/api/src/fleet/threads/thread-input.ts` — `validateCreateThread` checks to mirror
- `apps/api/src/fleet/threads/threads.service.ts` — `create` (PROJECT branch: anchor lookup, skills snapshot)
- `apps/api/src/fleet/threads/threads.controller.ts` — `assertUser`, `create` permission check
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`
- `apps/api/src/fleet/threads/threads.module.ts` — module wiring

**US-004**

- `apps/api/src/fleet/threads/workspace-threads.service.ts` — created by US-003, extended here
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — created by US-003, extended here
- `apps/api/src/fleet/threads/threads.controller.ts` — `list` query validation, `get`, `messages` to mirror
- `apps/api/src/fleet/threads/thread-events.controller.ts` — `ThreadEventsGuard`, `ThreadEventsController` to mirror
- `apps/api/test/helpers/sse-client.ts` — HTTP-level stream client

**US-005**

- `apps/api/src/fleet/threads/workspace-threads.service.ts` — created by US-003, extended here
- `apps/api/src/fleet/threads/threads.service.ts` — `sendMessage`, `updateCap`, `stop`, `endSession`, `answer`, `archive` to mirror
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `jobTargetFor`, `sendRefusalFor`, `anchorRepoFor`
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildProjectThreadInstructions`, `skillLines`
- `apps/api/test/helpers/thread-fixtures.ts` — `seedThreadJobFor` (extended by US-002)

**US-006**

- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`
- `apps/api/src/fleet/jobs/placement-rules.ts` — `firstMisfit`, `MisfitReason`, `PERMANENT_MISFITS`
- `apps/api/src/fleet/jobs/placement.service.ts` — `placeJob`, `withKodaTools`, `attachProjectRepos`
- `apps/api/src/fleet/sync/sync.service.ts` — git token request handling
- `apps/api/src/fleet/assistant/runner-tool.service.ts` — `RunnerToolService.call`

**US-007**

- `apps/runner/src/supervisor/assign-parser.ts` — thread block kind and action rules
- `apps/runner/src/thread/thread-job-run.ts` — `run` kind branch, `runProject`, `command`
- `apps/runner/src/capabilities/nax-probe.ts` — capability report
- `apps/runner/src/thread/tools/index.ts` — `buildProjectThreadTools`
- `apps/runner/src/thread/thread-paths.ts` — `threadScratchDir`

### Creates

**US-001**

- `apps/api/prisma/migrations/20261022090000_chat_thread_workspace/migration.sql` — the `(createdById, kind, lastActivityAt)` index

**US-003**

- `apps/api/src/fleet/threads/workspace-threads.service.ts` — `WorkspaceThreadsService`
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — `WorkspaceThreadsController`
- `apps/api/src/fleet/threads/dto/workspace-thread.dto.ts` — `CreateWorkspaceThreadDto`, `WorkspaceThreadDto`, `WorkspaceThreadDetailDto`, `WorkspaceThreadListDto`

**US-004**

- `apps/api/src/fleet/threads/workspace-thread-events.controller.ts` — `WorkspaceThreadEventsGuard`, `WorkspaceThreadEventsController`

### Modifies

**US-001**

- `apps/api/src/fleet/common/thread-jobs.spec.ts` — the test at `:32-34` asserts `pkg.CHAT_THREAD_KINDS` equals `['REPO', 'PROJECT']`; it becomes `['REPO', 'PROJECT', 'WORKSPACE']`. The deep-equality test above it is unchanged.
- `apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts` — the exact-object `toEqual` at `:14` pins the DTO's field set; it gains `workspaceThreads: false` (the fixture's capabilities do not advertise it). Every other assertion is unchanged.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the sorted key list of `RunnerSummaryDto` at `:39-42` gains `workspaceThreads`. Other assertions are unchanged.
- `apps/api/test/integration/fleet/runner-views.integration.spec.ts` — the exact sorted key list at `:80` of a GET /projects/:slug/fleet/runners record gains `workspaceThreads`. Other assertions are unchanged.
- `openapi.json` — regenerated with `bun run api:export-spec`: `RunnerSummaryDto.workspaceThreads`, `ThreadDto.projectId`, `ThreadDto.kind` gains `WORKSPACE`.

**US-002**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — calls that pass a bare project id — `repo.get('P', 'T')`, `repo.command('P', 'T', 'U', …)` and the `sendMessage({ projectId: … })` inputs — become `{ kind: 'project', projectId: 'P' }` scopes (ruling 1d-D10); expectations on the Prisma `where` of those reads gain `kind: { not: 'WORKSPACE' }`. The behaviour each test asserts is unchanged.
- `apps/api/src/fleet/threads/threads.service.spec.ts` — the typed `ChatThreadRecord` literal at `:17` gains `projectId`; the assertions at `:346` (`sendMessage` called with `projectId: 'p1'`) and `:373` (`get` called with `('p1', 't1')`) become `scope: { kind: 'project', projectId: 'p1' }` and `get({ kind: 'project', projectId: 'p1' }, 't1')`. The service's public signatures are unchanged.
- `apps/api/test/helpers/thread-fixtures.ts` — `seedThreadJobFor` gains the optional `kind`, `createdById` and `projectId` seed options described in Design; existing callers keep today's REPO seed.

**US-003**

- `apps/api/src/fleet/threads/threads.module.spec.ts` — gains resolution of `WorkspaceThreadsService` and `WorkspaceThreadsController`; existing assertions are unchanged.
- `openapi.json` — regenerated with `bun run api:export-spec`: POST /api/threads, `CreateWorkspaceThreadDto`, `WorkspaceThreadDto`.

**US-004**

- `apps/api/src/fleet/threads/threads.module.spec.ts` — gains resolution of `WorkspaceThreadEventsGuard` and `WorkspaceThreadEventsController`; existing assertions are unchanged.
- `openapi.json` — regenerated with `bun run api:export-spec`: GET /api/threads, GET /api/threads/{id}, GET /api/threads/{id}/messages, `WorkspaceThreadDetailDto`, `WorkspaceThreadListDto`.

**US-005**

- `openapi.json` — regenerated with `bun run api:export-spec`: POST /api/threads/{id}/messages, PATCH /api/threads/{id}, POST /api/threads/{id}/stop, `end-session`, `answer` and `archive`.

**US-006**

- `apps/api/src/fleet/assistant/runner-tool.service.spec.ts` — its `jobs` stub implements the methods `RunnerToolService` used before; it gains `findThreadTokenScope` (returning a `PROJECT` scope by default), because `call` now consults it. Assertions are unchanged.
- `openapi.json` — regenerated with `bun run api:export-spec`: `PlacementMisfitDto.reason` and `AttentionReasonDto` gain `workspace_threads`.

**US-007**

- `apps/runner/src/capabilities/nax-probe.spec.ts` — the exact report `toEqual` at `:85-97` pins the capability keys; it gains `workspaceThreads: true`. The warnings and nax-call assertions after it are unchanged.

### Seams

- US-002 → US-003, US-004, US-005: `ThreadScope` and the scoped repository methods. Every workspace route reaches the repository through `{ kind: 'workspace', userId }`; US-004 AC-5 and US-005 AC-5 prove a non-creator's request misses through the HTTP routes.
- US-003 → US-004: the module wiring of the workspace controllers is proven by HTTP requests (US-004 AC-11, AC-12, AC-13), not only by the module spec.
- US-003 → US-005 / US-006: a thread created by `POST /threads` is the one US-005 AC-1 sends to and US-006 AC-9 / AC-10 place; both enter at the HTTP route.
- US-002 → US-006: `findThreadTokenScope` answering `WORKSPACE` is consumed by the sync git-token path (US-006 AC-7) and the runner tool route (US-006 AC-8).
- US-001 → US-007: the protocol's `WORKSPACE` member of `ChatThreadKind` is what the runner's parser accepts (US-007 AC-1).

## Acceptance Criteria

### US-001: Workspace kind contract, runner capability and index (`Workdir: apps/api`)

1. [unit] The API mirror `CHAT_THREAD_KINDS` imported from `apps/api/src/fleet/common/thread-jobs.ts` equals `['REPO', 'PROJECT', 'WORKSPACE']`.
2. [unit] The `CHAT_THREAD_KINDS` exported by `@nathapp/fleet-protocol` equals `['REPO', 'PROJECT', 'WORKSPACE']`.
3. [unit] `parseCapabilitiesCore` given a valid report with `workspaceThreads: true` returns a result whose `workspaceThreads` is `true`.
4. [unit] `parseCapabilitiesCore` given a valid report without `workspaceThreads` returns a result with no `workspaceThreads` key.
5. [unit] `parseCapabilitiesCore` given a valid report with `workspaceThreads: 'yes'` fails with reason `workspaceThreads`.
6. [unit] `RunnerSummaryDto.from` for a runner at protocol version 4 whose stored capabilities have `workspaceThreads: true` returns `workspaceThreads: true`.
7. [unit] `RunnerSummaryDto.from` for a runner at protocol version 3 whose stored capabilities have `workspaceThreads: true` returns `workspaceThreads: false`.
8. [unit] `PrismaChatThreadRepository.create` returns a record whose `kind` is `'WORKSPACE'` when the stored row's `kind` is `'WORKSPACE'`.
9. [unit] `PrismaChatThreadRepository.create` returns a record whose `projectId` equals the stored row's `projectId`.
10. [unit] `repoThreadFields` given `{ kind: 'WORKSPACE', repoId: 'r1', baseRef: 'main', feature: 'f', specPath: 's' }` throws a `ConflictAppException` with key `threads.notRepoThread`.
11. [unit] The generated OpenAPI document's `ThreadDto.kind` enum contains `WORKSPACE`.
12. [integration] Applying migration `20261022090000_chat_thread_workspace` to the schema before it creates an index named `ChatThread_createdById_kind_lastActivityAt_idx` on `ChatThread` over the columns `createdById`, `kind`, `lastActivityAt` in that order.

### US-002: Thread scope; project thread surfaces never expose a WORKSPACE thread (`Workdir: apps/api`)

1. [integration] With a WORKSPACE thread and a PROJECT thread both stored with `projectId` P, `PrismaChatThreadRepository.list({ kind: 'project', projectId: P }, undefined, 0, 20)` returns the PROJECT thread and not the WORKSPACE thread.
2. [integration] `PrismaChatThreadRepository.get({ kind: 'project', projectId: P }, id)` returns null for a WORKSPACE thread stored with `projectId` P.
3. [integration] `PrismaChatThreadRepository.get({ kind: 'workspace', userId: U }, id)` returns the WORKSPACE thread whose `createdById` is U, with `homeProject` equal to its project's `slug` and `name`.
4. [integration] `PrismaChatThreadRepository.get({ kind: 'workspace', userId: V }, id)` returns null for a WORKSPACE thread whose `createdById` is U.
5. [integration] `PrismaChatThreadRepository.get({ kind: 'workspace', userId: U }, id)` returns null for a PROJECT thread whose `createdById` is U.
6. [integration] `PrismaChatThreadRepository.list({ kind: 'workspace', userId: U }, undefined, 0, 20)` returns only U's WORKSPACE threads, ordered by `lastActivityAt` descending.
7. [integration] `GET /projects/:slug/threads` by the creator of a WORKSPACE thread whose home project is `:slug` returns no item with that thread's id.
8. [integration] `GET /projects/:slug/threads/:id` for that WORKSPACE thread, requested by its creator who is an ADMIN member of the project, answers 404 with key `threads.notFound`.
9. [integration] `POST /projects/:slug/threads/:id/messages` for that WORKSPACE thread, sent by its creator, answers 404 and creates no `ChatMessage` row.
10. [integration] `POST /projects/:slug/threads/:id/publish` for that WORKSPACE thread, sent by its creator, answers 404 with key `threads.notFound`.
11. [integration] `GET /projects/:slug/threads/:id/events` for that WORKSPACE thread, opened by its creator, answers 404.
12. [unit] `PrismaFleetJobRepository.findThreadTokenScope(jobId)` for the SESSION turn of a thread whose row has `kind: 'WORKSPACE'` returns `{ kind: 'WORKSPACE', action: 'SESSION' }`.

### US-003: Create WORKSPACE threads with a home project (`Workdir: apps/api`)

1. [unit] `validateCreateWorkspaceThread` given `kind: 'PROJECT'` throws `ValidationAppException` with key `threads.input` and reason `kind`.
2. [unit] `validateCreateWorkspaceThread` given `repoId: 'r1'` throws `ValidationAppException` with reason `workspaceFields`.
3. [unit] `validateCreateWorkspaceThread` given a backend `{ kind: 'acp', agent: 'claude' }` throws `ValidationAppException` with reason `backend`.
4. [unit] `validateCreateWorkspaceThread` given `homeProject: 42` throws `ValidationAppException` with reason `homeProject`.
5. [integration] `POST /threads` with body `{ "title": "t", "backend": { "kind": "native" }, "repoId": "r1" }` answers 400 with key `threads.input` and reason `workspaceFields`.
6. [integration] `POST /threads` with no `homeProject`, by a user who is a DEVELOPER of project A (created first, with a fleet repo) and of project B (with a fleet repo), answers 201 with `homeProject.slug` equal to A's slug.
7. [integration] The `ChatThread` row created by that request has `kind` `WORKSPACE` and `projectId` equal to A's id.
8. [integration] `POST /threads` with no `homeProject`, by a DEVELOPER of an older project A with no fleet repo and of project B with a fleet repo, answers 201 with `homeProject.slug` equal to B's slug.
9. [integration] `POST /threads` with no `homeProject`, by a user who is a VIEWER of an older project A (with a fleet repo) and a DEVELOPER of project B (with a fleet repo), answers 201 with `homeProject.slug` equal to B's slug.
10. [integration] `POST /threads` with no `homeProject`, by a global ADMIN who has no `ProjectMember` row in any project while a project with a fleet repo exists, answers 409 with key `threads.noFleetRepo`.
11. [integration] `POST /threads` with `homeProject` naming a project where the user is a VIEWER answers 403 with key `threads.homeProjectAccess`.
12. [integration] `POST /threads` with `homeProject` naming a project where the user is a DEVELOPER but which has no fleet repo answers 409 with key `threads.noFleetRepo`.
13. [integration] `POST /threads` with `homeProject` naming an existing project the user is not a member of answers 404.
14. [integration] `POST /threads` with `homeProject` naming a slug that matches no project answers 404.
15. [integration] `POST /threads` while `FLEET_THREADS_ENABLED` is off answers 409 with key `threads.disabled`.

### US-004: WORKSPACE read routes and events stream (`Workdir: apps/api`)

1. [integration] `GET /threads` by user U returns U's WORKSPACE threads and none of U's REPO or PROJECT threads.
2. [integration] `GET /threads` by user U returns no WORKSPACE thread created by another user.
3. [integration] Each item of `GET /threads` carries `homeProject` with the `slug` and `name` of the thread's home project.
4. [integration] `GET /threads?size=101` answers 400 with key `threads.input` and reason `size`.
5. [integration] `GET /threads/:id` by a global ADMIN who did not create the WORKSPACE thread answers 404 with key `threads.notFound`.
6. [integration] `GET /threads/:id` by the creator answers 200 with `kind: 'WORKSPACE'` and `handoff` equal to `{ plan: null, run: null }`.
7. [integration] `GET /threads/:id` by the creator of a PROJECT thread, using that PROJECT thread's id, answers 404 with key `threads.notFound`.
8. [integration] `GET /threads/:id/messages` by the creator returns the thread's messages in `seq` order.
9. [integration] `GET /threads/:id/messages` by another user answers 404 with key `threads.notFound`.
10. [integration] `GET /threads` called with an agent API key answers 403 with key `threads.principal`.
11. [integration] `POST /threads` called with an agent API key answers 403 with key `threads.principal`.
12. [integration] `GET /threads/:id/events` opened by the creator answers 200 with content type `text/event-stream`.
13. [integration] `GET /threads/:id/events` opened by a user who did not create the WORKSPACE thread answers 404, and that user can still open the configured maximum number of other streams afterwards (no stream slot was consumed).

### US-005: WORKSPACE turns, commands and the session job (`Workdir: apps/api`)

1. [integration] `POST /threads/:id/messages` by the creator of a WORKSPACE thread answers 201 and creates a THREAD `FleetJob` whose `projectId` is the home project's id.
2. [integration] That THREAD `FleetJob`'s `repoId` is the home project's oldest fleet repo.
3. [integration] The `FleetThreadTurn` of that job has `instructions` that start with `You are a brainstorming partner in a koda workspace thread.`
4. [unit] `buildWorkspaceThreadInstructions({ skills: [] })` returns text containing `This thread belongs to no project and no repository.` and containing no `koda_` tool name.
5. [integration] `POST /threads/:id/messages` by a user who did not create the WORKSPACE thread answers 404 with key `threads.notFound` and creates no `ChatMessage` row.
6. [integration] `POST /threads/:id/messages` by the creator after the creator was changed to VIEWER on the home project answers 403 with key `threads.homeProjectAccess` and creates no `ChatMessage` row.
7. [integration] `POST /threads/:id/messages` by the creator after the creator was removed from the home project answers 403 with key `threads.homeProjectAccess`.
8. [integration] `POST /threads/:id/messages` by a global ADMIN creator after the home project was soft-deleted answers 403 with key `threads.homeProjectAccess`.
9. [integration] `POST /threads/:id/messages` by the creator after the home project's only fleet repo was deleted answers 409 with key `threads.noFleetRepo` and creates no THREAD job.
10. [unit] `WorkspaceThreadsService.sendMessage` never calls `ProjectBriefService.resolveRepoContext` and passes `repoContext: undefined` to `ChatThreadRepository.sendMessage`.
11. [integration] `PATCH /threads/:id` with `{ "maxCostUsd": 7 }` by the creator answers 200 with `maxCostUsd` `"7"`.
12. [integration] `POST /threads/:id/end-session` by the creator while the thread has no live session answers 409 with key `threads.noSession`.
13. [integration] `POST /threads/:id/stop` by a user who did not create the WORKSPACE thread answers 404 with key `threads.notFound`.
14. [integration] `POST /threads/:id/archive` by the creator answers 200, and a following `GET /threads/:id` shows `status: 'ARCHIVED'`.
15. [integration] `POST /threads/:id/archive` by a global ADMIN who did not create the thread answers 404 with key `threads.notFound`.

### US-006: WORKSPACE ASSIGN, placement, git tokens, tool route and notices (`Workdir: apps/api`)

1. [unit] `PrismaFleetJobRepository.findThreadAssign(jobId)` for the THREAD job of a thread whose row has `kind: 'WORKSPACE'` returns `kind: 'WORKSPACE'` and `feature: 'thread-<threadId>'`.
2. [unit] `firstMisfit` for a WORKSPACE THREAD job on an otherwise fitting runner whose capabilities lack `workspaceThreads` returns `'workspace_threads'`.
3. [unit] `firstMisfit` for the same job on a runner whose capabilities have `workspaceThreads: true` and `projectThreads: true` returns no misfit.
4. [unit] `PERMANENT_MISFITS.has('workspace_threads')` returns `false`, so a WORKSPACE THREAD job that fits no runner is left `QUEUED` rather than cancelled.
5. [unit] The generated OpenAPI document's `PlacementMisfitDto` and `AttentionReasonDto` reason enums both contain `workspace_threads`.
6. [unit] The ASSIGN payload `PlacementService` builds for a WORKSPACE SESSION turn on a runner advertising `kodaTools: true` and `projectCode: true` has a `thread` block with neither `kodaTools` nor `projectRepos`.
7. [integration] A runner sync carrying a git-token request without `repoId` for a held WORKSPACE THREAD job answers `gitTokenErrors` containing `{ jobId, reason: 'repo_not_assigned' }` and no git token for that job.
8. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_search_tickets` from the runner holding a RUNNING WORKSPACE THREAD job answers 409 with key `fleet.notThreadJob`.
9. [unit] Thread ingest records no `kodaToolsUnavailableOn` on the session of a WORKSPACE thread whose runner does not advertise `kodaTools`.
10. [integration] After `POST /threads/:id/messages` creates a WORKSPACE THREAD job while the only enabled online runner advertises `projectThreads` but not `workspaceThreads`, `PlacementService.placeJob(jobId)` leaves the job `QUEUED` and returns a misfit list that includes `workspace_threads` for that runner.
11. [integration] After `POST /threads/:id/messages` creates a WORKSPACE THREAD job while an enabled online runner advertises `workspaceThreads`, `projectThreads` and the thread's native model, the job is `ASSIGNED` to that runner and the ASSIGN's `thread.kind` is `WORKSPACE`.

### US-007: Runner accepts and runs WORKSPACE sessions (`Workdir: apps/runner`)

1. [unit] `parseAssign` for a THREAD ASSIGN whose `thread` block has `kind: 'WORKSPACE'` and `action: 'SESSION'` returns `ok: true` with `assign.thread.kind` equal to `'WORKSPACE'`.
2. [unit] `parseAssign` for a `thread` block with `kind: 'WORKSPACE'` and `action: 'PUBLISH'` returns `{ ok: false, detail: 'invalid thread action' }`.
3. [unit] `parseAssign` for a `thread` block with `kind: 'WORKSPACE'` that carries `projectRepos` returns `{ ok: false, detail: 'invalid project repos' }`.
4. [unit] The capability report the nax probe produces has `workspaceThreads: true`.
5. [unit] `ThreadJobRun.run` for a WORKSPACE SESSION never calls `host.credentials.acquire`.
6. [unit] `ThreadJobRun.run` for a WORKSPACE SESSION opens the session with `worktree` equal to `threadScratchDir(homeDir, threadId)`.
7. [unit] `ThreadJobRun.run` for a WORKSPACE SESSION with no koda tools on the ASSIGN opens the session with exactly the tools named `load_skill` and `read_skill_file`.
8. [unit] `command('THREAD_PUBLISH', …)` on a running WORKSPACE session returns `{ result: 'rejected', detail: 'not_repo_thread' }`.
