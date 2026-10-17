# SPEC: Fleet S5b-1d-2 — Workspace Tools (Project Argument, `koda_my_projects`, Web `/threads` Pages)

## Summary

Feature 1d-1 (`fleet-s5b-workspace-threads`, merged #292) shipped the WORKSPACE thread kind in the API and the runner
with no koda tools: a WORKSPACE ASSIGN carries no `kodaTools`, the runner tool route answers 409 `fleet.notThreadJob`
for a WORKSPACE job, and there are no web pages for it. This feature finishes umbrella row 4 (S5b-1d). A WORKSPACE
session gets the koda read tools, each with a required `project` argument the API resolves and checks against the
creator on every call (S5b-R7), plus a new `koda_my_projects` tool that lists the creator's projects with open ticket,
recent failed job and pending approval counts (S5b-R12). REPO and PROJECT threads keep their catalog unchanged and
now refuse a `project` argument. The web gains a personal `/threads` list, a new-thread page with a home-project
picker, and a thread detail page, reached from the sidebar's Workspace section and the command palette.

Umbrella design `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R7, R12, R13; §7; §10
row 4). Feature 1d-1 spec: `.nax/features/fleet-s5b-workspace-threads/spec.md` (rulings 1d-D1..D10; this feature lifts
1d-D6).

## Motivation

The point of a WORKSPACE thread is questions across projects ("which projects have pending tickets?"). After 1d-1 a
WORKSPACE session can only brainstorm: `withKodaTools` returns the thread unchanged for `WORKSPACE`
(`apps/api/src/fleet/jobs/placement.service.ts:224-227`), `RunnerToolService.call` refuses a WORKSPACE job
(`apps/api/src/fleet/assistant/runner-tool.service.ts:51`), and its instructions say it has no koda tools
(`apps/api/src/fleet/threads/thread-instructions.ts:53-59`). The koda tools are all project-scoped: the executor takes
the project from the job (`assistant-tool.executor.ts:107-110`), which for a WORKSPACE job is the home project, so
simply sending the existing catalog would silently answer every question about the home project only.

S5b-R7 also requires REPO and PROJECT threads to refuse a `project` argument. Today the tool parsers ignore unknown
keys (`tools/ticket-tools.ts:38-41`, `asRecord`), so a `project` key in a REPO thread is silently dropped.

Live check §9.99 (2026-10-17) confirmed 1d-1 on koda-wk; the only way to use a WORKSPACE thread today is the raw API.

## Design

### Rulings that bind every story

User, 2026-10-15 (umbrella): S5b-R7 (the executor owns the project scope; WORKSPACE tools take a validated `project`
argument checked against the creator on every call; REPO and PROJECT threads refuse it), S5b-R12 (WORKSPACE threads are
creator-only, top-level `/threads` page, `koda_my_projects` lists the creator's projects with open ticket, failed job
and pending approval counts), S5b-R13 (home project and anchor repo are bookkeeping only).

Drafting calls (spec author, 2026-10-17; the user asked to skip the questions):

- **1d2-D1 one feature, api + web, no runner change.** The runner already accepts `kodaTools` on any SESSION ASSIGN
  (`apps/runner/src/supervisor/assign-parser.ts:243-245`) and builds a proxy per descriptor (`thread-job-run.ts:552`,
  `kodaToolProxies`), and the WORKSPACE catalog (13 tools) is under `KODA_TOOL_LIMITS.maxTools` (32,
  `packages/fleet-protocol/src/threads.ts:36`). No protocol change; `FLEET_PROTOCOL_VERSION` stays 4.
- **1d2-D2 per-kind catalog.** `kodaToolDescriptorsFor(kind)` answers the descriptors an ASSIGN carries. REPO and
  PROJECT: exactly `KODA_TOOL_DESCRIPTORS`, unchanged. WORKSPACE: `koda_my_projects` first, then every descriptor of
  `KODA_TOOL_DESCRIPTORS` in order, each rewritten by `withProjectArgument`: a `project` property (the slug pattern
  `^[a-z0-9]+(-[a-z0-9]+)*$`, `maxLength` 100) is added to `inputSchema.properties`, `project` is prepended to
  `inputSchema.required`, and the description gains the sentence `In a workspace thread, name the project with
  \`project\` (a slug koda_my_projects lists).` The originals are never mutated.
- **1d2-D3 tool scope.** `AssistantTool` gains `scope?: 'project' | 'workspace'`; absent means `project`. Every existing
  tool stays project-scoped. `koda_my_projects` is the only workspace-scoped tool.
- **1d2-D4 the project argument (executor, S5b-R7).** The executor reads the thread kind from the call context
  (`ToolCallContext.kind`, absent reads as `REPO`, the column default). In order, after the existing disabled-creator
  check and before `tool.parse`:
  1. A workspace-scoped tool in a REPO or PROJECT thread → `invalid_input: <name> is only available in workspace
     threads`.
  2. An input that has its own `project` key, in a REPO or PROJECT thread, or for a workspace-scoped tool → `invalid_input:
     project`.
  3. WORKSPACE thread, project-scoped tool: `project` missing, not a string, or not matching the slug pattern →
     `invalid_input: project`, with no lookup.
  4. WORKSPACE thread, project-scoped tool: `ProjectAccessService.findProjectIdBySlug(project)` (deleted projects miss)
     then `resolveMembership(projectId, actor)`. An unknown slug, a deleted project and a project the creator is not a
     member of all answer the same `not_found: project` (no existence oracle). A global ADMIN reaches every project,
     as in the web project list and the 1d-D3 home-project rule.
  5. The input passed to `tool.parse` is a copy without the `project` key. The resolved project's id and slug become
     `ToolContext.projectId` / `projectSlug`, and the ability check uses the role `resolveMembership` answered there.
  An input that is not an object (null, an array, a scalar) has no `project` key: steps 2 and 3 treat it as absent, and
  `tool.parse` judges it as today. REPO and PROJECT threads keep today's path (project from the job, then `tool.parse`,
  then membership) once step 2 passes; a WORKSPACE project-scoped call resolves membership before `tool.parse` on
  purpose (steps 4-5), because the role answered for the resolved project is what the ability check needs. Membership
  is resolved on every call, never cached across calls.
- **1d2-D5 workspace-scoped execution.** A workspace-scoped tool in a WORKSPACE thread runs with no membership or ability
  check by the executor (it reads only what the creator can reach, by construction). Its `ToolContext.projectId` and
  `projectSlug` are the home project's, which the tool must not read, and `ctx.actor` is `userPrincipal(creator)` with
  no project role.
- **1d2-D6 audit.** `AssistantToolCall.projectId` is the resolved project for a WORKSPACE call that reached step 5, and
  the job's project (the home project) for every other call, including refusals at steps 1-4.
- **1d2-D7 `koda_my_projects`.** No input properties. The reachable projects are
  `ProjectsService.findAllForPrincipal(ctx.actor)` (non-deleted; member projects, or every project for a global ADMIN),
  ordered by slug ascending, the first 50. Per project, one line
  `<slug> open_tickets: <n> failed_jobs_7d: <n> pending_approvals: <n> /<slug>` and the project name under it through
  `ctx.data` (user-written text is fenced). Counts: open tickets = `Ticket` rows of the project with `deletedAt` null and
  `status` in `CREATED`, `VERIFIED`, `IN_PROGRESS`, `VERIFY_FIX`; failed jobs = `FleetJob` rows with `state` `FAILED` or
  `CRASHED` and `finishedAt` at or after `ctx.now` minus 7 days; pending approvals = `FleetApproval` rows with
  `status` `pending`. No reachable project → `no projects`. More than 50 → a last line `more: <n> projects not listed`.
  The counts come from one escape-hatch method, `findProjectCounts(projectIds, failedSince)`, on the existing
  `PrismaAssistantToolCallRepository` (which extends `AbstractPrismaRepository`, `.nax/rules/api-data.md:105-135`),
  exposed through a new interface `ProjectCountsReader` and token `PROJECT_COUNTS_READER` (`useExisting` the same
  class; both declared in `assistant-tool-call.domain.ts` next to `AssistantToolCallRepository`), as `findCallContext` is (1b-D6). It runs three `groupBy` reads keyed by `projectId` and answers a
  `Map<projectId, { openTickets, failedJobs7d, pendingApprovals }>` with zeros for projects that have no rows.
  `AssistantModule` imports `ProjectsModule` for `ProjectsService` (already in its graph through `MemoryModule`) and
  registers the `WorkspaceTools` provider, which registers `myProjectsTool` in `onModuleInit` like the other groups.
- **1d2-D8 the route.** `RunnerToolService.call` no longer refuses a WORKSPACE job; every other gate is unchanged.
- **1d2-D9 notice and instructions.** A WORKSPACE session on a runner without `kodaTools` records
  `kodaToolsUnavailableOn` as REPO and PROJECT sessions do (the 1d-1 exception is removed). The WORKSPACE instructions
  gain a koda tools line naming the `koda_my_projects` tool and the `project` argument; they still carry no project
  brief and no repository context.
- **1d2-D10 web routes.** `/threads` (list), `/threads/new`, `/threads/:id`. Nuxt static routes win over
  `pages/[project]`, so a project slugged `threads` is shadowed in the web, as `agents`, `admin` and `settings` already
  are. These pages render no breadcrumbs (the layout renders none outside a project, `layouts/default.vue:73-75`).
- **1d2-D11 web new page.** Fields: home project (a select whose first option `Automatic` sends no `homeProject`; the
  other options are the caller's projects from `GET /projects`), title, model, effort, max cost. Models come from the
  runner summaries of the selected project, or of the first listed project when `Automatic` is chosen
  (`useFleetDispatchOptions(slug)`; runner summaries are the same for every project), filtered to online, enabled
  runners advertising `workspaceThreads`. Native backends only (ACP is refused for WORKSPACE). With no projects listed, no runner summaries load and the model
  list is empty.
- **1d2-D12 web detail page.** Header, session controls (end session, raise cap, archive), the koda tools notice, the
  timeline and the composer. No action bar (publish, plan, run), no stale banner and no project-code notice: WORKSPACE
  threads have none of those. The creator is the only possible viewer, so `isCreator` is true whenever the thread
  loads. Job cards link into the home project (`/<homeProject.slug>/fleet/jobs/<id>`). The
  header's runner summaries load only after the thread has loaded, from `GET /projects/<homeProject.slug>/fleet/runners`
  through a runners-only read (not `useFleetDispatchOptions`, whose `load()` also reads the repo list).
- **1d2-D13 web live stream.** A Nitro route `server/api/threads/[id]/events.get.ts` proxies
  `/threads/:id/events` with the cookie, mirroring the project thread route (`server/api/projects/[slug]/threads/[id]/events.get.ts`):
  an invalid thread id answers 400 without calling the API, and a non-200 upstream status passes through.
- **1d2-D14 nav.** A `My threads` link (`nav.myThreads`, `MessagesSquare` icon) in the sidebar's Workspace section after
  Agents, and a palette command `my-threads` that navigates to `/threads` and is present with or without a project.
- The kill switch is unchanged: `FLEET_THREADS_ENABLED` off answers 409 `threads.disabled` on the tool route
  (`runner-tool.service.ts:46`) and the web list shows the disabled state from `threadsEnabled`.

### Integration

Symbols this feature only reads (verified 2026-10-17 at `059fc52d`):

- `KODA_TOOL_DESCRIPTORS` (`apps/api/src/fleet/assistant/koda-tool-descriptors.ts:291`) — REPO/PROJECT catalog, 12 tools.
- `KodaToolDescriptor` (`@nathapp/fleet-protocol`) — `{ name, description, inputSchema }`; `KODA_TOOL_LIMITS` (`threads.ts:36`).
- `ProjectAccessService.findProjectIdBySlug(slug): Promise<string>` (`projects/project-access.service.ts:23`) — throws
  `NotFoundAppException` for an unknown or deleted project.
- `ProjectAccessService.resolveMembership(projectId, principal): Promise<string | null>` (`:45`) — `ADMIN` for a global
  admin, the member role otherwise, `ForbiddenAppException` for a non-member.
- `ProjectsService.findAllForPrincipal(principal): Promise<ProjectDomain[]>` (`projects/projects.service.ts:80`).
- `withProjectRole` (`projects/project-context.ts`), `KodaCaslAbilityFactory.createForUser`.
- `ChatThreadKind` (`apps/api/src/fleet/common/thread-jobs.ts`, from the protocol).
- Web: `createThreadEventStream` (`lib/thread-event-stream.ts`), `openThreadLiveUpstream` and `LIVE_STREAM_HEADERS`
  (`server/utils/live-proxy.ts`), `useFleetDispatchOptions` (`composables/useFleetDispatchOptions.ts`), `apiPath`
  (`lib/api-path.ts`), `ThreadListTable`, `ThreadHeader`, `ThreadControls`, `ThreadKodaToolsNotice`, `ThreadTimeline`,
  `ThreadComposer`, `BackendPicker` (`components/fleet/threads/`), `composerState`, `isTurnRunning`, `sessionLabel`
  (`lib/thread-view.ts`).

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `withKodaTools` (`apps/api/src/fleet/jobs/placement.service.ts:224-227`). Baseline: returns the thread unchanged for
  `WORKSPACE`, else `{ ...thread, kodaTools: [...KODA_TOOL_DESCRIPTORS] }` for a SESSION on a `kodaTools` runner.
  Target: for any SESSION on a `kodaTools` runner returns `{ ...thread, kodaTools: [...kodaToolDescriptorsFor(thread.kind ?? 'REPO')] }`; unchanged otherwise.
- `ToolCallContext` (`assistant/assistant-tool-call.domain.ts:21-25`). Target: gains `kind?: ChatThreadKind`.
  `PrismaAssistantToolCallRepository.findCallContext` (`prisma-assistant-tool-call.repository.ts:62-72`) selects
  `thread.kind` and returns it.
- `AssistantTool` (`assistant/assistant-tool.types.ts:18-25`). Target: gains `scope?: 'project' | 'workspace'`.
- `AssistantToolExecutor.run` (`assistant/assistant-tool.executor.ts:78-123`). Target: the 1d2-D4 and 1d2-D5 steps
  between the disabled-creator check and `tool.parse`; `execute` records `projectId` per 1d2-D6.
- `RunnerToolService.call` (`assistant/runner-tool.service.ts:44-58`). Baseline: line 51 refuses a WORKSPACE job.
  Target: that line is removed, and `findThreadTokenScope` leaves the service's `jobs` `Pick`.
- `buildWorkspaceThreadInstructions` (`threads/thread-instructions.ts:53-59`). Baseline: says "no koda tools". Target:
  the second line no longer says the session has no koda tools, and a workspace koda tools line follows it (1d2-D9).
- `PrismaThreadIngestRepository.sessionNotices` (`threads/ingest/prisma-thread-ingest.repository.ts:477-489`). Baseline:
  skips `kodaToolsUnavailableOn` for `WORKSPACE`. Target: the WORKSPACE exception is removed.
- Web `ChatThreadKind` (`apps/web/lib/thread-types.ts:14`). Target: `'REPO' | 'PROJECT' | 'WORKSPACE'`. `ThreadDto` gains
  `homeProject?: { slug: string; name: string }`.
- Web `FleetRunnerSummary` (`apps/web/lib/fleet-types.ts:113`). Target: gains `workspaceThreads: boolean` (the API
  already sends it, `runner-summary.dto.ts:53`).
- Web `eligibleModels(runners, kind)` (`apps/web/lib/thread-create.ts:97-102`). Target: `WORKSPACE` keeps only runners
  with `workspaceThreads`; REPO and PROJECT unchanged.
- Web `ThreadControllerDeps` (`apps/web/lib/thread-controller.ts:33-41`). Target: gains optional `threadPath?: string`;
  when set it replaces the project path built at `:82`; `slug` stays for every existing caller.
- Web `ThreadListTable` (`components/fleet/threads/ThreadListTable.vue:10-15`). Target: gains optional
  `basePath?: string` for the row links (default `/<slug>/threads`), and shows the home project name where a REPO
  thread shows `feat/<feature>` for a WORKSPACE row. `slug` becomes optional when `basePath` is given. On `/threads`
  the page passes a `nameOf` that answers the signed-in user's name (every row is theirs).
- Web `ThreadHeader` (`components/fleet/threads/ThreadHeader.vue:21-23`). Target: a WORKSPACE thread shows its home
  project name where a REPO thread shows `feat/<feature>`.
- Web `server/utils/live-proxy.ts`. Target: gains `openWorkspaceThreadLiveUpstream(req: LiveUpstreamRequest & { apiInternalUrl: string; threadId: string })`, which refuses a thread id failing `THREAD_ID_PATTERN` with 400 `invalid thread id` and otherwise calls `openLiveUpstreamUrl` with `/threads/<id>/events` resolved by `resolveProxyTarget`.
- Web layout sidebar (`layouts/default.vue:182-197`) and `CommandPalette` (`components/CommandPalette.vue:26-30`) per 1d2-D14.

Worked skeleton for the per-kind catalog (novel shape: descriptors derived per thread kind):

```ts
export const PROJECT_ARGUMENT = { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 100,
  description: 'Slug of the project to act in, as koda_my_projects lists it' } as const;

export function withProjectArgument(d: KodaToolDescriptor): KodaToolDescriptor {
  const schema = d.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...d,
    description: `${d.description} In a workspace thread, name the project with \`project\` (a slug koda_my_projects lists).`,
    inputSchema: { ...d.inputSchema, properties: { project: PROJECT_ARGUMENT, ...(schema.properties ?? {}) },
      required: ['project', ...(schema.required ?? [])] },
  };
}

export function kodaToolDescriptorsFor(kind: ChatThreadKind): readonly KodaToolDescriptor[] {
  return kind === 'WORKSPACE' ? [KODA_MY_PROJECTS, ...KODA_TOOL_DESCRIPTORS.map(withProjectArgument)] : KODA_TOOL_DESCRIPTORS;
}
```

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| REPO or PROJECT thread tool call whose input has a `project` key | tool result `invalid_input: project`; tool not run | US-002 |
| WORKSPACE project-scoped call with `project` missing, not a string, or not a slug | `invalid_input: project`; no project lookup | US-002 |
| WORKSPACE project-scoped call naming an unknown, deleted or non-member project | `not_found: project` (one text for all three) | US-002 |
| WORKSPACE call the resolved role cannot perform (ability) | `forbidden: <tool> needs <action> <subject> on <slug>` (today's text, resolved slug) | US-002 |
| Workspace-scoped tool called in a REPO or PROJECT thread | `invalid_input: <name> is only available in workspace threads` | US-003 |
| Workspace-scoped tool called with a `project` key | `invalid_input: project` | US-003 |
| `koda_my_projects` with no reachable project | `no projects` | US-003 |
| WORKSPACE session on a runner without `kodaTools` | session notice `kodaToolsUnavailableOn: <runner name>` | US-001 |
| Web `/threads/:id/events` with an invalid thread id | 400 from `openWorkspaceThreadLiveUpstream`, API not called | US-004 |
| Web `/threads/:id/events` upstream non-200 (not the creator, threads disabled) | status passed through | US-004 |
| Web `/threads/:id` for a thread the API answers 404 | the page shows the error state | US-006 |
| Web `/threads` list while threads are disabled (`threadsEnabled: false`) | no new-thread link | US-005 |
| Web new-thread submit refused by the API (403 `threads.homeProjectAccess`, 409 `threads.noFleetRepo`) | the API message shown in the form, no navigation | US-005 |

## Out of Scope

- Write tools in WORKSPACE threads: the write tools (S5b-2b) and PendingAction (S5b-2a) are later features; they will take the `project` argument the same way.
- Project code mirrors or code read tools (`list_repos`, `read_file`, ...) for WORKSPACE threads: a WORKSPACE session never reads any repository (S5b-R15 applies to PROJECT threads only).
- Cross-project result merging inside one tool call: each project-scoped call acts in exactly one project; the agent calls a tool once per project.
- Changes to the runner, the fleet protocol or `FLEET_PROTOCOL_VERSION`.
- Changes to the REPO and PROJECT tool catalog (`KODA_TOOL_DESCRIPTORS`) or to any tool's own parsing, output or permission.
- Caching or rate-limiting `koda_my_projects` beyond the executor's existing per-call idempotency.
- Counting tickets, jobs or approvals in `koda_my_projects` by any rule other than 1d2-D7 (for example by assignee, label or a configurable window).
- Pagination of `koda_my_projects` beyond the first 50 projects.
- Web breadcrumbs for the `/threads` pages.
- Reserving the `threads` project slug; a project slugged `threads` is shadowed in the web (1d2-D10).
- Editing a WORKSPACE thread's home project, title or backend from the web after creation.
- A Playwright journey for the `/threads` pages; the deploy live check on koda-wk covers the journey, and the web stories are covered by component, page and lib specs.
- Showing WORKSPACE threads on any project page or in any project thread list (1d-D7 stands).
- ACP backends in the web new-thread page for WORKSPACE threads (refused by the API).
- US-002 only: a membership change that commits between the executor's `resolveMembership` and the tool's read is not detected for that one call (same as the REPO/PROJECT path today).
- US-003 only: `koda_my_projects` counts are read without a snapshot across the three counts; a concurrent change can make one line internally inconsistent for that call.

## Stories

1. **US-001: Per-kind koda tool catalog, WORKSPACE ASSIGN tools, notice and instructions** — `Workdir: apps/api` — No dependencies.
2. **US-002: Executor project argument (S5b-R7) and the WORKSPACE tool route** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: `koda_my_projects` and workspace-scoped tools** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: Web workspace thread client, types and live stream** — `Workdir: apps/web` — No dependencies.
5. **US-005: Web `/threads` list, new-thread page, nav and palette** — `Workdir: apps/web` — Depends on US-004.
6. **US-006: Web `/threads/:id` detail page** — `Workdir: apps/web` — Depends on US-004.

US-001 adds `KODA_MY_PROJECTS` and `kodaToolDescriptorsFor` to `koda-tool-descriptors.ts`; US-003 registers the tool
that serves the descriptor. No story changes an API route's request or response shape, so `openapi.json` and the CLI's
generated client stay as they are. The web stories call only routes that 1d-1 shipped (`/threads`, `/threads/:id`,
`/threads/:id/messages`, `/threads/:id/events`, `/projects`, `/projects/:slug/fleet/runners`). The web never reads
`thread.kind === 'WORKSPACE'` routes through `/projects/:slug/threads`.

### Context Files

**US-001**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_TOOL_DESCRIPTORS`, descriptor shape
- `apps/api/src/fleet/jobs/placement.service.ts` — `withKodaTools`, `attachProjectRepos`
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildWorkspaceThreadInstructions`, `KODA_TOOLS_LINE`
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — `sessionNotices`
- `packages/fleet-protocol/src/threads.ts` — `KodaToolDescriptor`, `KODA_TOOL_LIMITS`

**US-002**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `AssistantToolExecutor.run`, `execute`, `refusal`
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — `ToolCallContext`, `AssistantToolCallRecord`
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — `findCallContext`
- `apps/api/src/fleet/assistant/runner-tool.service.ts` — `RunnerToolService.call`
- `apps/api/src/projects/project-access.service.ts` — `findProjectIdBySlug`, `resolveMembership`

**US-003**

- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `AssistantTool`, `ToolContext`
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts` — tool group provider and `onModuleInit` registration pattern
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — `AssistantToolCallRepository`, the escape-hatch pattern
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_MY_PROJECTS` (created by US-001, served here)

**US-004**

- `apps/web/lib/thread-controller.ts` — `createThreadController`, `ThreadControllerDeps`
- `apps/web/composables/useThread.ts` — the project thread adapter to mirror
- `apps/web/server/utils/live-proxy.ts` — `openThreadLiveUpstream`, `openLiveUpstreamUrl`, `THREAD_ID_PATTERN`
- `apps/web/server/api/projects/[slug]/threads/[id]/events.get.ts` — the live proxy route to mirror
- `apps/web/lib/thread-create.ts` — `eligibleModels`, `buildThreadCreateSchema` (its `validation.required` message), `toCreateThreadBody`

**US-005**

- `apps/web/pages/[project]/threads/index.vue` — the project list page to mirror
- `apps/web/pages/[project]/threads/new.vue` — the project new-thread page to mirror
- `apps/web/layouts/default.vue` — sidebar Workspace section
- `apps/web/components/CommandPalette.vue` — command list
- `apps/web/composables/useWorkspaceThreads.ts` — created by US-004, used here

**US-006**

- `apps/web/pages/[project]/threads/[id].vue` — the project detail page to mirror
- `apps/web/components/fleet/threads/ThreadHeader.vue` — header kind label
- `apps/web/components/fleet/threads/ThreadTimeline.vue` — `slug` prop for job card links
- `apps/web/composables/useWorkspaceThread.ts` — created by US-004, used here
- `apps/web/lib/thread-view.ts` — `composerState`, `isTurnRunning`, `sessionLabel`

### Creates

**US-003**

- `apps/api/src/fleet/assistant/tools/workspace-tools.ts` — `myProjectsTool`, the `WorkspaceTools` provider
- `apps/api/test/integration/fleet/assistant-workspace-tools.integration.spec.ts` — DB-backed `koda_my_projects` and project-argument tests

**US-004**

- `apps/web/composables/useWorkspaceThreads.ts` — `useWorkspaceThreads`
- `apps/web/composables/useWorkspaceThread.ts` — `useWorkspaceThread`
- `apps/web/server/api/threads/[id]/events.get.ts` — workspace thread live proxy route (calls `openWorkspaceThreadLiveUpstream`)
- `apps/web/lib/workspace-thread-create.ts` — `buildWorkspaceThreadCreateSchema`, `toCreateWorkspaceThreadBody` (takes one object `{ homeProject, title, model, effort, maxCostUsd }`, strings except `maxCostUsd: number`)

**US-005**

- `apps/web/pages/threads/index.vue` — the `/threads` list page
- `apps/web/pages/threads/new.vue` — the `/threads/new` page

**US-006**

- `apps/web/pages/threads/[id].vue` — the `/threads/:id` detail page

### Modifies

**US-001**

- `apps/api/src/fleet/jobs/placement.service.project-code.spec.ts` — the test at `:175-184` ("omits tools and project repos via %s") asserts a WORKSPACE ASSIGN on a `kodaTools` runner has no `kodaTools`; under 1d2-D2 it carries `kodaToolDescriptorsFor('WORKSPACE')`. The `not.toHaveProperty('kodaTools')` assertion becomes an equality with `kodaToolDescriptorsFor('WORKSPACE')`; the `projectRepos` and `findProjectRepos` assertions stay.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.spec.ts` — the test at `:727-732` ("workspace AC-9 stores a live session without tools-unavailable notice") asserts no `kodaToolsUnavailableOn` for a WORKSPACE session on a runner without `kodaTools`; under 1d2-D9 the notice is recorded, so the assertion becomes `kodaToolsUnavailableOn: 'box'`.
- `apps/api/src/fleet/threads/workspace-turns.spec.ts` — the test at `:45-50` asserts `buildWorkspaceThreadInstructions({ skills: [] })` does not contain `koda_`; under 1d2-D9 the text names `koda_my_projects`, so that `not.toContain('koda_')` assertion becomes a `toContain('koda_my_projects')`; the role-line and `Skills available: none.` assertions stay.

**US-002**

- `apps/api/src/fleet/assistant/runner-tool.service.spec.ts` — the test at `:178-184` ("workspace AC-8 refuses tools before registry or executor") pins the 409 `fleet.notThreadJob` refusal 1d2-D8 removes; it becomes a test that a WORKSPACE job's call reaches the executor with `{ jobId, toolCallId, name, input }`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the test at `:4246-4253` ("workspace tool route refuses a held RUNNING job with 409 fleet.notThreadJob") becomes "workspace tool route answers a held RUNNING job": the same request with `input: { project: <seeded project slug> }` expects 200 and `isError: false`. Every other test in the file is unchanged.

**US-003**

- `apps/api/src/common/test-helpers/global-stubs.module.ts` — only if compiling `AssistantModule` with its new `ProjectsModule` import needs a stub the global module lacks; it may gain that stub provider without touching any assertion.
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — gains the `ProjectCountsReader` interface and the `PROJECT_COUNTS_READER` token; existing declarations unchanged.
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — gains `findProjectCounts` and implements `ProjectCountsReader` (1d2-D7); no existing method changes.
- `apps/api/src/fleet/assistant/assistant.module.ts` — imports `ProjectsModule`, provides `WorkspaceTools` and the `PROJECT_COUNTS_READER` token.

**US-004**

- `apps/web/tests/lib/thread-create.spec.ts` — the `runner` fixture at `:32` is typed `FleetRunnerSummary`, which gains the required `workspaceThreads` field; only if the web type-check rejects the fixture, it gains `workspaceThreads: false`. No assertion changes.
- `apps/web/tests/lib/thread-create-project.spec.ts` — the runner fixture at `:20-30` sets the `FleetRunnerSummary` fields; only if the web type-check rejects it, it gains `workspaceThreads: false`. No assertion changes.
- `apps/web/tests/pages/threads-new-page.spec.ts` — its runner fixtures set the `FleetRunnerSummary` fields; only if the web type-check rejects them, each gains `workspaceThreads: false`. No assertion changes.

**US-005**

None. The new nav link and palette command use new ids and paths (`/threads`, `my-threads`); the existing threads nav and palette specs (`tests/layouts/threads-nav.spec.ts`, `tests/components/command-palette-threads.spec.ts`) assert the project entries by their own ids and paths, which do not change.

**US-006**

None. `ThreadHeader` gains a WORKSPACE branch; the REPO and PROJECT label assertions of its existing specs do not change.

### Seams

- US-001 → US-002: `ToolCallContext.kind` is read from the thread row that US-001's ASSIGN serves; US-002 AC-9 and AC-15 enter at the runner tool route (`POST /fleet/runner/jobs/:jobId/tools/:name`) for a seeded WORKSPACE job.
- US-002 → US-003: the executor's scope steps (1d2-D4 steps 1-2, 1d2-D5) are what `koda_my_projects` relies on; US-003 AC-12 and AC-13 enter at the runner tool route.
- US-001 → US-003: `KODA_MY_PROJECTS` is the descriptor `myProjectsTool` serves; US-003 AC-14 resolves it through the registry after module init.
- US-004 → US-005 / US-006: `useWorkspaceThreads` and `useWorkspaceThread` are what the pages call; US-005 AC-1 and US-006 AC-1 assert the request paths the page triggers through the composables.

## Acceptance Criteria

### US-001: Per-kind koda tool catalog, WORKSPACE ASSIGN tools, notice and instructions (`Workdir: apps/api`)

1. [unit] `kodaToolDescriptorsFor('REPO')` returns descriptors equal, element by element and in order, to `KODA_TOOL_DESCRIPTORS`.
2. [unit] `kodaToolDescriptorsFor('PROJECT')` returns descriptors equal, element by element and in order, to `KODA_TOOL_DESCRIPTORS`.
3. [unit] The first descriptor `kodaToolDescriptorsFor('WORKSPACE')` returns has `name` `koda_my_projects`.
4. [unit] `kodaToolDescriptorsFor('WORKSPACE')` returns exactly one more descriptor than `KODA_TOOL_DESCRIPTORS` has, and its names after the first are the names of `KODA_TOOL_DESCRIPTORS` in the same order.
5. [unit] Every descriptor of `kodaToolDescriptorsFor('WORKSPACE')` other than `koda_my_projects` has `inputSchema.required` whose first entry is `project`.
6. [unit] The WORKSPACE `koda_get_ticket` descriptor has `inputSchema.required` equal to `['project', 'ref']`.
7. [unit] The `project` property of the WORKSPACE `koda_search_tickets` descriptor has `type` `string` and `pattern` `^[a-z0-9]+(-[a-z0-9]+)*$`.
8. [unit] The description of the WORKSPACE `koda_search_tickets` descriptor ends with `In a workspace thread, name the project with \`project\` (a slug koda_my_projects lists).`
9. [unit] The `koda_my_projects` descriptor's `inputSchema` has `properties` equal to an empty object and `additionalProperties` `false`.
10. [unit] After `kodaToolDescriptorsFor('WORKSPACE')` is called, `KODA_SEARCH_TICKETS.inputSchema` still has no `required` key and no `project` property.
11. [unit] `kodaToolDescriptorsFor('WORKSPACE')` returns at most `KODA_TOOL_LIMITS.maxTools` descriptors, each named to match `KODA_TOOL_LIMITS.nameRe`.
12. [unit] The ASSIGN payload `PlacementService.placeJob` builds for a WORKSPACE SESSION turn on a runner advertising `workspaceThreads: true` and `kodaTools: true` has `thread.kodaTools` equal to `kodaToolDescriptorsFor('WORKSPACE')`.
13. [unit] The ASSIGN payload `PlacementService.placeJob` builds for a WORKSPACE SESSION turn on a runner advertising `workspaceThreads: true` but not `kodaTools` has a `thread` block with no `kodaTools`.
14. [unit] `buildWorkspaceThreadInstructions({ skills: [] })` returns instructions whose koda tools line names the `koda_my_projects` tool and the `project` argument.
15. [unit] Thread ingest folding a `session_started` event for a WORKSPACE thread whose runner `box` does not advertise `kodaTools` stores a session with `kodaToolsUnavailableOn` equal to `box`.

### US-002: Executor project argument (S5b-R7) and the WORKSPACE tool route (`Workdir: apps/api`)

1. [unit] `AssistantToolExecutor.execute` for a REPO thread's job calling `koda_search_tickets` with input `{ project: 'web' }` returns `{ isError: true, content: 'invalid_input: project' }` and never calls the tool's `execute`.
2. [unit] `AssistantToolExecutor.execute` for a PROJECT thread's job calling `koda_search_tickets` with input `{ project: 'web', text: 'x' }` returns `{ isError: true, content: 'invalid_input: project' }`.
3. [unit] `AssistantToolExecutor.execute` for a WORKSPACE thread's job calling `koda_search_tickets` with input `{}` returns `{ isError: true, content: 'invalid_input: project' }`.
4. [unit] `AssistantToolExecutor.execute` for a WORKSPACE thread's job calling `koda_search_tickets` with input `{ project: 'Not A Slug' }` returns `invalid_input: project` and never calls `ProjectAccessService.findProjectIdBySlug`.
5. [unit] `AssistantToolExecutor.execute` for a WORKSPACE thread's job calling `koda_search_tickets` with input `{ project: 'b', text: 'x' }` calls the tool's `parse` with `{ text: 'x' }` (no `project` key) and its `execute` with a context whose `projectSlug` is `b` and whose `projectId` is the id `findProjectIdBySlug('b')` answered.
6. [integration] A WORKSPACE thread job whose creator is a DEVELOPER of project `b` calling `koda_get_ticket` with `{ project: 'b', ref: 'B-1' }` through `AssistantToolExecutor.execute` returns `isError: false` with content containing `/b/tickets/B-1`.
7. [integration] After a WORKSPACE thread job whose creator is a DEVELOPER of project `b` calls `koda_get_ticket` with `{ project: 'b', ref: 'B-1' }`, the stored `AssistantToolCall` row has `projectId` equal to project `b`'s id, not the home project's.
8. [integration] A WORKSPACE thread job whose home project has a fleet job `jh` and whose creator is a DEVELOPER of project `b` with fleet job `jb`, calling `koda_list_jobs` with `{ project: 'b' }`, returns content naming `jb` and not `jh`.
9. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_search_tickets` from the runner holding a RUNNING WORKSPACE THREAD job, with input `{ project: <an existing project the creator is not a member of> }`, answers 200 with `{ isError: true, content: 'not_found: project' }`.
10. [integration] A WORKSPACE thread job calling `koda_search_tickets` with `project` naming a slug that matches no project returns `{ isError: true, content: 'not_found: project' }`.
11. [integration] A WORKSPACE thread job calling `koda_search_tickets` with `project` naming a soft-deleted project the creator was a member of returns `{ isError: true, content: 'not_found: project' }`.
12. [integration] A WORKSPACE thread job whose creator is a global ADMIN with no `ProjectMember` row in project `c` calling `koda_search_tickets` with `{ project: 'c' }` returns `isError: false`.
13. [integration] A WORKSPACE thread job whose creator calls `koda_search_tickets` with `{ project: 'b' }` successfully, then is removed from project `b`, gets `{ isError: true, content: 'not_found: project' }` for a second call with a different `toolCallId` and the same input.
14. [unit] `AssistantToolExecutor.execute` (with the real `KodaCaslAbilityFactory`) for a WORKSPACE thread calling a stub project-scoped tool whose permission is the ability `create` `FleetJob`, with `{ project: 'b' }` and `resolveMembership` answering `VIEWER` for `b`, returns `{ isError: true }` with content starting `forbidden:` and ending `on b`, and never calls the stub's `execute`.
15. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_search_tickets` from the runner holding a RUNNING WORKSPACE THREAD job, with body `{ toolCallId: 't1', input: { project: <a project slug the creator is a DEVELOPER of> } }`, answers 200 with `isError` `false`.

### US-003: `koda_my_projects` and workspace-scoped tools (`Workdir: apps/api`)

1. [integration] `koda_my_projects` run through `AssistantToolExecutor.execute` for a WORKSPACE thread whose creator is a member of projects `a` and `b` but not `c` returns content naming `/a` and `/b` and not `/c`.
2. [integration] The project lines of a `koda_my_projects` result for a creator who is a member of projects `b-two` and `a-one` appear with `a-one` first.
3. [integration] For a project with one ticket in each of `CREATED`, `VERIFIED`, `IN_PROGRESS`, `VERIFY_FIX`, `CLOSED` and `REJECTED`, plus one soft-deleted `IN_PROGRESS` ticket, the project's `koda_my_projects` line contains `open_tickets: 4`.
4. [integration] For a project with a `FAILED` job finished 2 days ago, a `CRASHED` job finished 1 day ago, a `FAILED` job finished 8 days ago and a `COMPLETED` job finished today, the project's `koda_my_projects` line contains `failed_jobs_7d: 2`.
5. [integration] For a project with one `pending` and one `approved` `FleetApproval`, the project's `koda_my_projects` line contains `pending_approvals: 1`.
6. [integration] `koda_my_projects` for a WORKSPACE thread whose creator is a global ADMIN with no `ProjectMember` row in project `c` lists `/c`.
7. [integration] `koda_my_projects` does not list a soft-deleted project the creator is a member of.
8. [unit] `myProjectsTool(...).execute` passes each project's name through `ctx.data`, so a stub `ctx.data` that wraps text in `<<x>>` yields the name wrapped in `<<x>>` under the project line.
9. [unit] `myProjectsTool(...).execute` with 51 reachable projects returns 50 project lines followed by a last line `more: 1 projects not listed`.
10. [unit] `myProjectsTool(...).execute` with no reachable project returns `no projects`.
11. [unit] `AssistantToolExecutor.execute` for a WORKSPACE thread calling a tool whose `scope` is `workspace` with input `{}` runs the tool and never calls `ProjectAccessService.resolveMembership` or `findProjectIdBySlug`.
12. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_my_projects` from the runner holding a RUNNING REPO THREAD job answers 200 with `{ isError: true, content: 'invalid_input: koda_my_projects is only available in workspace threads' }`.
13. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_my_projects` from the runner holding a RUNNING WORKSPACE THREAD job, with input `{ project: 'a' }`, answers 200 with `{ isError: true, content: 'invalid_input: project' }`.
14. [unit] After the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_my_projects')` returns a tool whose `scope` is `workspace` and whose `descriptor` is `KODA_MY_PROJECTS`.
15. [integration] The `AssistantToolCall` row stored for a WORKSPACE `koda_my_projects` call has `projectId` equal to the thread's home project id.

### US-004: Web workspace thread client, types and live stream (`Workdir: apps/web`)

1. [unit] `eligibleModels(runners, 'WORKSPACE')` with an online enabled runner advertising `workspaceThreads: true` and model `m1`, and another advertising `workspaceThreads: false` and model `m2`, returns `['m1']`.
2. [unit] `eligibleModels(runners, 'PROJECT')` with two online enabled runners both advertising `projectThreads: true`, one with `workspaceThreads: true` and model `m1`, the other with `workspaceThreads: false` and model `m2`, returns `['m1', 'm2']`.
3. [unit] `createThreadController` given `threadPath: '/threads/t1'` calls `api.get` for the thread with path `/threads/t1` when `load()` runs.
4. [unit] `createThreadController` given `threadPath: '/threads/t1'` posts a send to `/threads/t1/messages`.
5. [unit] `createThreadController` given `slug: 'web'` and no `threadPath` calls `api.get` with `/projects/web/threads/t1`.
6. [unit] `useWorkspaceThreads().load('ARCHIVED')` calls `$api.get` with path `/threads` and query `{ status: 'ARCHIVED', size: '100' }`, and sets `threads` to the response `items`.
7. [unit] `useWorkspaceThreads().load()` sets `threadsEnabled` to `false` when the response's `threadsEnabled` is `false`.
8. [unit] `useWorkspaceThread('t1')` opens its event stream at `/api/threads/t1/events`.
9. [unit] `openWorkspaceThreadLiveUpstream({ threadId: '../x', ... })` returns `{ kind: 'error', status: 400 }` and never calls its `fetchImpl`.
10. [unit] `openWorkspaceThreadLiveUpstream({ threadId: 't1', cookie: 'koda_token=x', ... })` calls its `fetchImpl` with a URL ending in `/threads/t1/events` and a `cookie` header `koda_token=x`.
11. [unit] `openWorkspaceThreadLiveUpstream` whose `fetchImpl` answers 404 returns `{ kind: 'error', status: 404 }`.
12. [unit] `toCreateWorkspaceThreadBody` given home project `''`, title `t`, model `m1`, effort `''` and max cost `5` returns `{ title: 't', maxCostUsd: 5, backend: { kind: 'native', model: 'm1' } }` with no `homeProject` key.
13. [unit] `toCreateWorkspaceThreadBody` given home project `web` returns a body whose `homeProject` is `web`.
14. [unit] `buildWorkspaceThreadCreateSchema(t)` rejects an empty model with the message `t('fleet.threads.new.validation.required')` answers.

### US-005: Web `/threads` list, new-thread page, nav and palette (`Workdir: apps/web`)

1. [unit] Mounting `pages/threads/index.vue` calls `GET /threads` with `status` `ACTIVE`.
2. [unit] `pages/threads/index.vue` renders a row link to `/threads/<id>` for each listed thread.
3. [unit] `pages/threads/index.vue` renders a WORKSPACE row's home project name in the column where a REPO row shows `feat/<feature>`.
4. [unit] Switching `pages/threads/index.vue` to archived reloads `GET /threads` with `status` `ARCHIVED`.
5. [unit] `pages/threads/index.vue` renders no link to `/threads/new` when the list answers `threadsEnabled: false`.
6. [unit] `pages/threads/new.vue` offers a home project select whose first option is `fleet.threads.workspace.homeAutomatic` followed by one option per project `GET /projects` returns.
7. [unit] `pages/threads/new.vue` with `Automatic` selected loads runner summaries for the first listed project's slug (`/projects/<slug>/fleet/runners`).
8. [unit] `pages/threads/new.vue` offers only models of online enabled runners advertising `workspaceThreads`.
9. [unit] Submitting `pages/threads/new.vue` with `Automatic`, title `t` and model `m1` posts to `/threads` a body with no `homeProject` and navigates to `/threads/<created id>`.
10. [unit] Submitting `pages/threads/new.vue` with home project `web` posts a body whose `homeProject` is `web`.
11. [unit] When `POST /threads` answers 403 `threads.homeProjectAccess`, `pages/threads/new.vue` shows the API error text and does not navigate.
12. [unit] The rendered default layout, with no project in the route, contains a link to `/threads` labelled `nav.myThreads` that appears after the `/agents` link in the rendered nav.
13. [unit] The rendered default layout with project `web` in the route still contains the `/threads` link.
14. [unit] The command palette, with or without a project slug, offers an entry with id `my-threads` that navigates to `/threads` when activated.
15. [unit] `i18n/locales/en.json` and `i18n/locales/zh.json` both define `nav.myThreads`, `fleet.threads.workspace.title`, `fleet.threads.workspace.homeProject` and `fleet.threads.workspace.homeAutomatic`.

### US-006: Web `/threads/:id` detail page (`Workdir: apps/web`)

1. [unit] Mounting `pages/threads/[id].vue` for route id `t1` loads the thread through `useWorkspaceThread('t1')`, requesting `/threads/t1`.
2. [unit] `pages/threads/[id].vue` renders `ThreadHeader`, `ThreadControls`, `ThreadKodaToolsNotice`, `ThreadTimeline` and `ThreadComposer` for a loaded WORKSPACE thread.
3. [unit] `pages/threads/[id].vue` renders no `ThreadActionBar`, no `ThreadStaleBanner` and no `ThreadProjectCodeNotice`.
4. [unit] `pages/threads/[id].vue` passes `is-creator` true to `ThreadControls` for a loaded thread.
5. [unit] `pages/threads/[id].vue` passes the thread's `homeProject.slug` as the `slug` prop of `ThreadTimeline`.
6. [unit] `pages/threads/[id].vue` requests `/projects/<homeProject.slug>/fleet/runners` after the thread has loaded.
7. [unit] Sending from the composer of `pages/threads/[id].vue` posts to `/threads/t1/messages`.
8. [unit] Archiving from the controls of `pages/threads/[id].vue` posts to `/threads/t1/archive`.
9. [unit] A failed send on `pages/threads/[id].vue` shows a toast with `extractApiError` of the error.
10. [unit] `pages/threads/[id].vue` shows the error state when loading `/threads/t1` answers 404.
11. [unit] `ThreadHeader` for a WORKSPACE thread whose home project name is `Sandbox` shows `Sandbox` where a REPO thread shows `feat/<feature>`.
12. [unit] The tab title of `pages/threads/[id].vue` gains the `• ` prefix while a turn runs.
13. [unit] `pages/threads/[id].vue` makes no `/fleet/runners` request while the thread request is still pending.
