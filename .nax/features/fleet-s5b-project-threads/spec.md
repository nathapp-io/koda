<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5b-1a — Project Threads (Thread Kind, Anchor Repo, No-Checkout Runner Path, Web Scope Picker)

## Summary

koda threads today are bound to a repo and a nax feature: the runner checks out a worktree and the agent brainstorms a
spec for that feature. This feature adds a second thread kind, `PROJECT`: a thread that belongs to the project but to
no repo, feature or worktree. A project member creates it from the new-thread page with a scope picker, sends
messages, and the agent answers from a runner, exactly as in a repo thread, but with no checkout and no repo tools.
PROJECT threads are the host the koda assistant tools (S5b-1b onward) plug into. This feature ships the thread kind end
to end with no koda tools yet.

This is feature 1 of fleet S5b. Umbrella design: `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md`
(§2 rulings S5b-R3, R9, R13; §5; §10 row 1). Later features: S5b-1b `fleet-s5b-koda-read-core`, S5b-1c
`fleet-s5b-koda-read-knowledge`, S5b-1d `fleet-s5b-workspace-threads`, S5b-2a, S5b-2b, S5b-3.

## Motivation

The koda assistant (S5b) must answer questions such as "which tickets are blocked?" that have nothing to do with a
repo checkout. Today a thread cannot exist without `repoId`, `baseRef`, `feature` and `specPath`
(`apps/api/prisma/schema.prisma:1058-1095`), the create route requires a repo and a feature
(`apps/api/src/fleet/threads/thread-input.ts`), and the runner always acquires git credentials and prepares a worktree
before it opens a session (`apps/runner/src/thread/thread-job-run.ts:217-330`). A user would have to pick a repo and an
unused feature name just to chat, and every session would clone and check out a repo it never reads.

## Design

### Rulings that bind every story (user, 2026-10-15)

- S5b-R3: a `PROJECT` thread has no repo, worktree or feature. `REPO` threads keep all S5a behaviour.
- S5b-R13 (anchor repo): `FleetJob.repoId`, `ref` and `feature` stay required. A PROJECT thread's THREAD job uses the
  project's **anchor repo** — its oldest `FleetRepo` by `createdAt`, then `id` — as `repoId`, the anchor's
  `defaultBranch` as `ref`, and `thread-<threadId>` as `feature` (as every THREAD job already does). The anchor is
  bookkeeping only (placement, budget keys, dashboards, activity); the runner never clones, fetches or touches it and
  requests no git token for the job. A project with no fleet repo cannot create or run a PROJECT thread (409
  `threads.noFleetRepo`).
- S5b-R9: no protocol version bump. The ASSIGN `thread` block gains an optional `kind` and its `feature` becomes optional;
  a runner advertises `projectThreads: true`; PROJECT THREAD jobs are placed only on runners that advertise it.
- 1a-R1: the API always sends `thread.kind` (`REPO` or `PROJECT`) on a THREAD ASSIGN. A runner treats a missing `kind`
  as `REPO`.
- 1a-R2: PROJECT threads with an ACP backend are refused at creation (ACP sessions get no tools, nax#2444).
- 1a-R3: PROJECT threads have no Publish, Discard, Plan or Run. The routes answer 409 `threads.notRepoThread`; the web
  hides the action bar.
- 1a-R4: the kind rule (REPO has `repoId`, `baseRef`, `feature`, `specPath`; PROJECT has none) is enforced by the create
  path, the only writer of those columns. No database check constraint: integration schemas are built with
  `prisma db push` (`apps/api/test/helpers/partial-indexes.ts`), which cannot create one. (Design §5 named a check
  constraint; this ruling replaces it.)
- 1a-R5: the new-thread form defaults to the Repo scope (today's behaviour).
- The kill switch is unchanged: `FLEET_THREADS_ENABLED` gates PROJECT threads exactly as it gates REPO threads.

### Integration

This feature changes the symbols below. Each baseline exists only to locate the code; it is never the interface to
implement.

**Protocol package** (`packages/fleet-protocol/src/threads.ts`, `index.ts`; edited in US-001)

- `ThreadKind` — new: `export type ThreadKind = 'REPO' | 'PROJECT'` and `export const THREAD_KINDS = ['REPO', 'PROJECT'] as const`.
- `ThreadAssign` — Baseline: `feature: string` required, no kind. Target: `kind?: ThreadKind` (documented: absent means
  `REPO`) and `feature?: string` (present iff the kind is `REPO`).
- `RunnerCapabilities` (`index.ts:64-81`) — Target: gains `projectThreads?: true` with the doc comment "Fleet S5b: the
  runner hosts PROJECT threads (no checkout). Absent on older runners."

**API data** (US-001)

- `ChatThread` (`apps/api/prisma/schema.prisma:1058-1095`) — Target: gains `kind String @default("REPO") // REPO | PROJECT`;
  `repoId`, `baseRef`, `feature`, `specPath` become optional (`String?`); the `repo` relation becomes optional. New
  migration `apps/api/prisma/migrations/20261016090000_chat_thread_kind/migration.sql`: adds the column with default
  `'REPO'` (existing rows become `REPO`) and drops NOT NULL on the four columns. The existing partial unique index
  `ChatThread_active_repo_feature_key` is unchanged (it admits any number of null `repoId` rows).
- `ChatThreadRecord` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts`) — Target: gains `kind: ThreadKind`;
  `repoId`, `baseRef`, `feature`, `specPath` become `string | null`. `ThreadDto` (`dto/thread.dto.ts`) mirrors it
  (`kind` with `enum: ['REPO', 'PROJECT']`; the four fields `nullable: true`).
- `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts:121-158`) — Target: accepts
  `projectThreads`, strict like `threadWrite` (only exactly `true`; any other present value fails with reason
  `projectThreads`); the parsed result carries `projectThreads: true` only when the report had it.
- `RunnerSummaryDto` (`apps/api/src/fleet/runners/dto/runner-summary.dto.ts`) — Target: gains
  `projectThreads: boolean`, true iff `protocolVersion >= THREAD_MIN_PROTOCOL_VERSION` and the stored capabilities have
  `projectThreads === true`.
- The API mirror `apps/api/src/fleet/common/thread-jobs.ts` re-exports `ThreadKind` and mirrors `THREAD_KINDS` at
  runtime, as it does `THREAD_COMMAND_TYPES`.

**API create and routes** (US-002)

- `CreateThreadInput` / `validateCreateThread` (`apps/api/src/fleet/threads/thread-input.ts`) — Baseline: `repoId` and
  `feature` required. Target: `CreateThreadInput` gains `kind?: ThreadKind` (default `REPO`); `repoId`, `feature` become
  optional in the type. For `REPO` the existing rules apply unchanged (a missing `repoId` fails with reason `repoId`).
  For `PROJECT`: any of `repoId`, `feature`, `baseRef` present fails with reason `projectFields`; a backend of kind
  `acp` fails with reason `backend`. A `kind` other than `REPO` or `PROJECT` fails with reason `kind`. All failures are
  `ValidationAppException({ reason }, 'threads.input')` (400).
- `CreateThreadDto` (`dto/thread.dto.ts`) — Target: gains `kind?` (`enum: ['REPO', 'PROJECT']`); `repoId` and `feature`
  become `required: false`.
- `ThreadsService.create` (`threads.service.ts:27-40`) — Target: for `PROJECT`, resolves the anchor through the new
  `IFleetRepoRepository.findAnchor(projectId)`; null answers `ConflictAppException({}, 'threads.noFleetRepo')` (409);
  otherwise writes a thread with `kind: 'PROJECT'` and null `repoId`, `baseRef`, `feature`, `specPath`.
- `IFleetRepoRepository.findAnchor(projectId: string): Promise<FleetRepoRecord | null>` — new
  (`apps/api/src/fleet/repos/domain/fleet-repo.domain.ts`, implemented in `prisma-fleet-repo.repository.ts`): the
  project's repo with the smallest `createdAt`, ties broken by the smallest `id`; null when the project has none.
- `ThreadsService.plan`, `ThreadsService.run`, `ThreadsService.publish`, `ThreadsService.discard` — Target: a thread whose
  `kind` is `PROJECT` answers `ConflictAppException({}, 'threads.notRepoThread')` (409) before any other state check
  except not-found.
- i18n (`apps/api/src/i18n/{en,zh}/threads.json`): new keys `noFleetRepo` and `notRepoThread`.

**API session job** (US-003)

- `PrismaChatThreadRepository.createThreadJob` (`prisma-chat-thread.repository.ts:355-381`) — Baseline: reads
  `thread.repoId` and `thread.baseRef`. Target: for a PROJECT thread it resolves the anchor (as `findAnchor`) inside the
  send transaction; none answers 409 `threads.noFleetRepo`; the job gets `repoId` = anchor id and `ref` = anchor
  `defaultBranch`; the instructions come from the new `buildProjectThreadInstructions`.
- `buildProjectThreadInstructions(input: { project: string; skills: ThreadSkillSource[] }): string` — new, in
  `apps/api/src/fleet/threads/thread-instructions.ts`. Worked shape (mirrors `buildThreadInstructions`):

  ```ts
  export function buildProjectThreadInstructions(input: { project: string; skills: ThreadSkillSource[] }): string {
    const lines = [
      `You are a brainstorming partner for the koda project "${input.project}". This thread is not tied to a repository.`,
      'Ask one question at a time. You have no repository, no shell and no web access; do not claim facts about code you cannot see.',
    ];
    // then the same "Skills available" block as buildThreadInstructions
  }
  ```

  `project` is the project's slug. The text never mentions `write_doc`, `list_files`, `search_repo` or Publish.
- `sendRefusalFor` (`prisma-chat-thread.repository.ts:316-334`) and the job-dispatch activity payload
  (`prisma-chat-thread.repository.ts:304`) — Target: for a PROJECT thread the budget gate keys and the activity
  `repoId` / `ref` use the anchor repo and its default branch.
- Thread ingest cost event (`threads/ingest/prisma-thread-ingest.repository.ts:269`) — Baseline:
  `featureName: thread.feature`. Target: `featureName: thread.feature ?? \`thread-${thread.id}\``.

**API ASSIGN and placement** (US-004)

- `findThreadAssign` (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:201-215`) — Target: selects the thread's
  `kind`; returns `kind`; includes `feature` only when the kind is `REPO`.
- `PlacementJob.thread` (`apps/api/src/fleet/jobs/placement-rules.ts:24-33`) — Target: gains `kind?: ThreadKind`;
  `PlacementService.fillRunnerThreads` passes the assign's `kind`.
- `firstMisfit` THREAD branch (`placement-rules.ts:108-125`) — Target: right after the `protocol` check, a job whose
  `thread.kind` is `PROJECT` on a runner whose `capabilities.projectThreads !== true` returns the new
  `MisfitReason` `'project_threads'`. Not in `PERMANENT_MISFITS`. The new value is added to `MisfitReason`, the
  `PlacementMisfitDto.reason` enum (`jobs/dto/fleet-job.dto.ts:127`) and the dashboard misfit list
  (`dashboard/dashboard.types.ts:111`).

**Runner** (US-005)

- `parseAssign` thread block (`apps/runner/src/supervisor/assign-parser.ts:148-188`) — Target: reads optional `kind`;
  a value other than `REPO` or `PROJECT` is `bad('thread kind')`. Missing or `REPO`: `feature` is required as today.
  `PROJECT`: `feature` must be absent (present is `bad('thread feature')`), and an action other than `SESSION` is
  `bad('thread action')`. The parsed `ThreadAssign` carries `kind` as received (absent stays absent).
- Capability probe (`apps/runner/src/capabilities/nax-probe.ts:156-170`) — Target: the report gains
  `projectThreads: true`.
- `threadScratchDir(homeDir: string, threadId: string): string` — new in `apps/runner/src/thread/thread-paths.ts`:
  `join(threadDirFor(homeDir, threadId), 'scratch')`. It lives under the thread directory, so `pruneThreads` removes it
  with the thread.
- `buildProjectThreadTools(ctx: Pick<ThreadToolContext, 'skillsRoot' | 'skills'>): EmbedderTool[]` — new in
  `apps/runner/src/thread/tools/index.ts`: `[loadSkillTool(ctx), readSkillFileTool(ctx)]`, the same factories
  `buildThreadTools` uses.
- `ThreadJobRun.run` SESSION path (`apps/runner/src/thread/thread-job-run.ts:217-330`) — Target: when
  `thread.kind === 'PROJECT'` it skips step 1 (`credentials.acquire`) and steps 2-4 (`prepare`), creates
  `threadScratchDir(homeDir, threadId)` (recursive, no error when it exists), runs step 5 (skills) unchanged, opens the
  session with `worktree` = that scratch dir and `tools` = `buildProjectThreadTools(...)`, opens the stream with
  `stale` false, and creates no `ThreadLivePublish`. A `THREAD_PUBLISH` command to such a run answers
  `{ result: 'rejected', detail: 'not_repo_thread' }`. REPO runs are unchanged.

**Web** (US-006)

- `ThreadDto` (`apps/web/lib/thread-types.ts:77-104`) — Target: gains `kind: 'REPO' | 'PROJECT'`; `repoId`, `baseRef`,
  `feature`, `specPath` become `string | null`. `FleetRunnerSummary` (`apps/web/lib/fleet-types.ts:102-112`) gains
  `projectThreads: boolean`.
- `apps/web/lib/thread-create.ts` — Target: `ThreadCreateValues` gains `kind: 'REPO' | 'PROJECT'`;
  `buildThreadCreateSchema` checks `repoId`, `baseRef` and `feature` only when `kind` is `REPO`;
  `toCreateThreadBody` returns `{ kind: 'PROJECT', title, maxCostUsd, backend }` (no `repoId`, `feature`, `baseRef`)
  for PROJECT and today's body plus `kind: 'REPO'` for REPO; `eligibleModels(runners, kind)` gains a `kind` argument and,
  for `PROJECT`, keeps only runners with `projectThreads` true.
- `apps/web/pages/[project]/threads/new.vue` — Target: a scope select (`Repo` | `Project`, default `Repo`, 1a-R5) above
  the fields; Project hides the repo, base-ref and feature fields.
- `showActionBar` (`apps/web/lib/thread-handoff.ts:27-29`) — Target: false when `thread.kind === 'PROJECT'`.
- `ThreadListTable.vue:43` and `ThreadHeader.vue:25` — Target: a PROJECT thread renders the label
  `t('fleet.threads.kind.project')` where a REPO thread renders `feat/<feature>`.
- i18n (`apps/web/i18n/locales/{en,zh}.json`): `fleet.threads.new.scope`, `fleet.threads.new.scopeRepo`,
  `fleet.threads.new.scopeProject`, `fleet.threads.kind.project`.

Symbols this feature reads but does not change: `THREAD_MIN_PROTOCOL_VERSION` (`threads/thread-send-rules.ts:9`),
`jobGateKeys` (`budgets/budget-rules.ts:40-47`), `pruneThreads` (`apps/runner/src/thread/thread-prune.ts:25`),
`loadSkillTool` / `readSkillFileTool` (`apps/runner/src/thread/tools/`), `useFleetDispatchOptions`
(`apps/web/composables/useFleetDispatchOptions.ts`).

Patterns to follow: strict capability parsing — `threadWrite` (`capabilities-core.ts:138-139`); runtime mirror of a
package constant — `THREAD_COMMAND_TYPES` in `apps/api/src/fleet/common/thread-jobs.ts`; placement misfit —
`thread_write` (`placement-rules.ts:120-121`); migration tests — `scratchSchemaBefore` / `applyMigration`
(`apps/api/test/helpers/migration-schema.ts`); thread fixtures — `seedThreadJobFor`
(`apps/api/test/helpers/thread-fixtures.ts`).

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| PROJECT create with `repoId`, `feature` or `baseRef` | 400 `threads.input`, reason `projectFields` | US-002 |
| PROJECT create with an ACP backend | 400 `threads.input`, reason `backend` | US-002 |
| Create with an unknown `kind` | 400 `threads.input`, reason `kind` | US-002 |
| PROJECT create or send in a project with no fleet repo | 409 `threads.noFleetRepo` | US-002, US-003 |
| Plan / Run / Publish / Discard on a PROJECT thread | 409 `threads.notRepoThread` | US-002 |
| PROJECT THREAD job, no runner with `projectThreads` | job stays QUEUED; misfit `project_threads` | US-004 |
| Runner receives `thread.kind` it does not know | ASSIGN refused (`bad('thread kind')`), as any malformed ASSIGN | US-005 |
| PROJECT ASSIGN that carries a `feature` or a non-SESSION action | ASSIGN refused | US-005 |
| `THREAD_PUBLISH` to a PROJECT run | ack `rejected`, detail `not_repo_thread` | US-005 |

## Out of Scope

- koda data tools in threads (the tool registry, executor, runner tool route and `kodaTools` capability) are S5b-1b and later; PROJECT threads in this feature have only the skill tools.
- WORKSPACE (app-wide, personal) threads are S5b-1d; this feature adds only the `PROJECT` kind.
- ACP backends for PROJECT threads: refused at creation; no ACP placement or runner path for PROJECT threads.
- `write_doc`, Publish, Discard, Plan and Run for PROJECT threads.
- Converting an existing thread between `REPO` and `PROJECT`.
- Any change to the `FleetJob` schema: `repoId`, `ref` and `feature` stay required (anchor repo, S5b-R13).
- A database check constraint for the thread kind rule (ruling 1a-R4).
- A `FLEET_PROTOCOL_VERSION` bump; the protocol additions are optional fields gated by the `projectThreads` capability.
- Choosing a different anchor than the project's oldest fleet repo, or showing the anchor repo in the web.
- A Playwright journey for PROJECT threads; web stories are verified by unit and component tests only.
- US-003 only: budget pauses scoped to the anchor repo also stop PROJECT threads; this coupling is accepted (S5b-R13).

## Stories

1. **US-001: Thread kind contract and data** — `Workdir: apps/api` — No dependencies.
2. **US-002: Create, list and route rules for PROJECT threads** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: PROJECT session job on the anchor repo** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: PROJECT ASSIGN and placement** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: Runner no-checkout path for PROJECT threads** — `Workdir: apps/runner` — Depends on US-001.
6. **US-006: Web scope picker and PROJECT thread rendering** — `Workdir: apps/web` — Depends on US-002.

US-001 also edits `packages/fleet-protocol/src/threads.ts` and `packages/fleet-protocol/src/index.ts` (type-only
consumers in the API; the runner compiles against them). Build gate for US-001: `bun run type-check` at the repo root.

### Context Files

**US-001**

- `packages/fleet-protocol/src/threads.ts` — `ThreadAssign`; gains `ThreadKind`, `THREAD_KINDS`
- `packages/fleet-protocol/src/index.ts` — `RunnerCapabilities` gains `projectThreads`
- `apps/api/src/fleet/common/capabilities-core.ts` — strict `threadWrite` parsing to mirror
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRecord`
- `apps/api/test/helpers/migration-schema.ts` — `scratchSchemaBefore`, `applyMigration`

**US-002**

- `apps/api/src/fleet/threads/thread-input.ts` — `validateCreateThread`
- `apps/api/src/fleet/threads/threads.service.ts` — `create`, `plan`, `run`, `publish`, `discard`
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — gains `findAnchor`
- `apps/api/src/fleet/threads/threads.controller.ts` — create and handoff routes
- `apps/api/test/helpers/fleet-fixtures.ts` — `FleetHttpWorld`, `insertRunner`

**US-003**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `createThreadJob`, `sendRefusalFor`, `sendMessage`
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildThreadInstructions` (pattern for the new builder)
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — cost event `featureName`
- `apps/api/src/fleet/budgets/budget-rules.ts` — `jobGateKeys`
- `apps/api/test/helpers/thread-fixtures.ts` — `seedThreadJobFor`

**US-004**

- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`
- `apps/api/src/fleet/jobs/placement-rules.ts` — `firstMisfit`, `MisfitReason`, `PlacementJob`
- `apps/api/src/fleet/jobs/placement.service.ts` — `fillRunnerThreads`, `assign`
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `PlacementMisfitDto.reason` enum
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — dashboard misfit list

**US-005**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign` thread block
- `apps/runner/src/thread/thread-job-run.ts` — `run`, `command`
- `apps/runner/src/thread/thread-paths.ts` — `threadDirFor`
- `apps/runner/src/thread/tools/index.ts` — `buildThreadTools`
- `apps/runner/src/capabilities/nax-probe.ts` — capability report

**US-006**

- `apps/web/lib/thread-create.ts` — schema, body, `eligibleModels`
- `apps/web/pages/[project]/threads/new.vue` — the create form
- `apps/web/lib/thread-handoff.ts` — `showActionBar`
- `apps/web/components/fleet/threads/ThreadListTable.vue` — feature column
- `apps/web/components/fleet/threads/ThreadHeader.vue` — feature badge

### Creates

**US-001**

- `apps/api/prisma/migrations/20261016090000_chat_thread_kind/migration.sql` — `kind` column, nullable repo fields
- `apps/api/test/integration/fleet/fleet-thread-kind-schema.integration.spec.ts` — migration and column checks

**US-002**

- `apps/api/test/integration/fleet/fleet-project-threads.integration.spec.ts` — create, list, get and route refusals

**US-003**

- `apps/api/test/integration/fleet/fleet-project-thread-send.integration.spec.ts` — anchor job, refusal, activity, cost

**US-004**

- `apps/api/test/integration/fleet/fleet-project-thread-placement.integration.spec.ts` — ASSIGN kind and placement

**US-005**

- `apps/runner/test/unit/thread-job-run-project.spec.ts` — no-checkout run path

**US-006**

- `apps/web/tests/lib/thread-create-project.spec.ts` — PROJECT schema, body and model filtering

### Modifies

**US-001**

- `apps/api/prisma/schema.prisma` — `ChatThread` gains `kind` and the four repo fields become optional; integration suites build their schema from this file.
- `apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts` — the test at line 14 asserts the whole `RunnerSummaryDto` with `toEqual`; the DTO gains `projectThreads`, so the expected literal gains `projectThreads: false` for that capability-free record. The other expectations are unchanged.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the assertion at lines 40-41 pins the exact sorted key list of `RunnerSummaryDto`; it gains `projectThreads` because the DTO now exposes it. The other contract assertions are unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for `ThreadDto.kind`, the nullable thread fields and `RunnerSummaryDto.projectThreads`; `bun run generate` also refreshes the untracked CLI client.

**US-002**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint behaviour change (rule api-testing); this story adds POST /api/projects/:slug/threads with `kind: 'PROJECT'` (201) and with `kind: 'PROJECT'` plus a `feature` (400). Existing expectations unchanged.
- `apps/api/src/i18n/en/threads.json` — gains `noFleetRepo` and `notRepoThread`.
- `apps/api/src/i18n/zh/threads.json` — gains `noFleetRepo` and `notRepoThread`.
- `openapi.json` — regenerated by `bun run api:export-spec` for `CreateThreadDto.kind` and the optional `repoId` / `feature`.

**US-003**

None. The story changes repository internals only; no existing test pins the THREAD job's instructions for a PROJECT thread, and REPO-thread expectations are unchanged.

**US-004**

- `openapi.json` — regenerated by `bun run api:export-spec` for the new `PlacementMisfitDto.reason` value `project_threads` and the dashboard misfit enum.

**US-005**

- `apps/runner/src/capabilities/nax-probe.spec.ts` — the probe test near line 92 asserts the whole capability report with `toEqual`; the report gains `projectThreads: true`, so the expected literal gains that key. The other expectations are unchanged.

**US-006**

- `apps/web/i18n/locales/en.json` — gains `fleet.threads.new.scope`, `fleet.threads.new.scopeRepo`, `fleet.threads.new.scopeProject`, `fleet.threads.kind.project`.
- `apps/web/i18n/locales/zh.json` — gains the same four keys.
- `apps/web/tests/lib/thread-create.spec.ts` — its `toCreateThreadBody` expectations for a REPO form pin the body with `toEqual`; the REPO body now also carries `kind: 'REPO'`, so each expected REPO body gains that key. Calls to `eligibleModels(runners)` gain the second argument `'REPO'`; the expected model lists are unchanged.

### Seams

- SEAM-1 (US-001 -> US-004): `parseCapabilitiesCore` stores `projectThreads`; US-004 ACs post a capability report
  through `POST /api/fleet/runner/sync` and assert placement of a PROJECT THREAD job.
- SEAM-2 (US-002 -> US-003): `IFleetRepoRepository.findAnchor` is created in US-002 and used by thread job creation;
  a US-003 AC triggers `POST /api/projects/:slug/threads/:id/messages` and asserts the job's `repoId` equals the
  oldest repo's id.
- SEAM-3 (US-003 -> US-003): `buildProjectThreadInstructions` is called by thread job creation; a US-003 AC triggers
  `POST /api/projects/:slug/threads/:id/messages` and asserts the stored `FleetThreadTurn.instructions`.
- SEAM-4 (US-001 -> US-005): `ThreadAssign.kind` from the package is what the runner parser reads; US-005 ACs drive
  `parseAssign` with a PROJECT thread block.
- SEAM-5 (US-005 -> US-005): `buildProjectThreadTools` and `threadScratchDir` are used by `ThreadJobRun.run`; US-005
  ACs start a run from a parsed PROJECT ASSIGN and assert the session opener's input.

## Acceptance Criteria

### US-001: Thread kind contract and data (`Workdir: apps/api`)

1. [unit] The API's `THREAD_KINDS` imported from `apps/api/src/fleet/common/thread-jobs.ts` deep-equals the `THREAD_KINDS` exported by `@nathapp/fleet-protocol` (runtime import in the spec), which is `['REPO', 'PROJECT']`.
2. [unit] `parseCapabilitiesCore` on a valid report plus `projectThreads: true` returns an object whose `projectThreads` is `true`.
3. [unit] `parseCapabilitiesCore` on a valid report without `projectThreads` returns an object that has no `projectThreads` key.
4. [unit] `parseCapabilitiesCore` on a valid report plus `projectThreads: false` throws `CapabilityValidationError` with `reason` `projectThreads`.
5. [unit] `RunnerSummaryDto.from` for a runner at protocol 4 whose capabilities have `projectThreads: true` returns `projectThreads: true`.
6. [unit] `RunnerSummaryDto.from` for a runner at protocol 4 whose capabilities have no `projectThreads` returns `projectThreads: false`.
7. [unit] `RunnerSummaryDto.from` for a runner at protocol 3 whose capabilities have `projectThreads: true` returns `projectThreads: false`.
8. [integration] Inserting a `ChatThread` row with no `kind` value stores `kind` `REPO`.
9. [integration] Inserting a `ChatThread` row with `kind` `PROJECT` and null `repoId`, `baseRef`, `feature` and `specPath` succeeds.
10. [integration] Inserting two ACTIVE `ChatThread` rows with `kind` `PROJECT` and null `repoId` and `feature` in one project succeeds (the active repo-feature unique index does not reject them).
11. [integration] Applying the `20261016090000_chat_thread_kind` migration with `applyMigration` to a scratch schema from `scratchSchemaBefore` that holds one `ChatThread` row leaves that row with `kind` `REPO`.
12. [integration] After that migration the pre-existing `ChatThread` row keeps its `repoId`, `feature` and `specPath` values.
13. [unit] `PrismaChatThreadRepository.get` maps a row with `kind` `PROJECT` to a `ChatThreadRecord` whose `kind` is `PROJECT`.
14. [unit] `PrismaChatThreadRepository.get` maps a row with null `repoId`, `baseRef`, `feature` and `specPath` to a `ChatThreadRecord` whose four fields are `null`.

### US-002: Create, list and route rules for PROJECT threads (`Workdir: apps/api`)

1. [unit] `validateCreateThread` with `kind: 'PROJECT'`, a title and a native backend returns a value whose `kind` is `PROJECT`.
2. [unit] `validateCreateThread` with `kind: 'PROJECT'` and a `feature` throws `ValidationAppException` with `reason` `projectFields`.
3. [unit] `validateCreateThread` with `kind: 'PROJECT'` and a `repoId` throws `ValidationAppException` with `reason` `projectFields`.
4. [unit] `validateCreateThread` with `kind: 'PROJECT'` and a `baseRef` throws `ValidationAppException` with `reason` `projectFields`.
5. [unit] `validateCreateThread` with `kind: 'PROJECT'` and backend `{ kind: 'acp', agent: 'claude' }` throws `ValidationAppException` with `reason` `backend`.
6. [unit] `validateCreateThread` with `kind: 'WORKSPACE'` throws `ValidationAppException` with `reason` `kind`.
7. [unit] `validateCreateThread` with no `kind` and no `repoId` throws `ValidationAppException` with `reason` `repoId`.
8. [integration] `PrismaFleetRepoRepository.findAnchor(projectId)` for a project with two repos created at different times returns the repo with the earlier `createdAt`.
9. [integration] `PrismaFleetRepoRepository.findAnchor(projectId)` for a project with no fleet repo returns `null`.
10. [integration] `POST /api/projects/:slug/threads` as a project DEVELOPER with `{ kind: 'PROJECT', title, backend: { kind: 'native', model: 'm1' } }` answers 201 and the response's `kind` is `PROJECT`.
11. [integration] `POST /api/projects/:slug/threads` with `kind: 'PROJECT'` in a project that has no fleet repo answers 409 with the `threads.noFleetRepo` message.
12. [integration] `POST /api/projects/:slug/threads/:id/run` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
13. [integration] `POST /api/projects/:slug/threads/:id/plan` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
14. [integration] `POST /api/projects/:slug/threads/:id/publish` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
15. [integration] `POST /api/projects/:slug/threads/:id/discard` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.


### US-003: PROJECT session job on the anchor repo (`Workdir: apps/api`)

1. [integration] `POST /api/projects/:slug/threads/:id/messages` by the creator of a PROJECT thread in a project with two fleet repos creates a THREAD `FleetJob` whose `repoId` is the repo with the earlier `createdAt`.
2. [integration] The THREAD `FleetJob` created by that send has `ref` equal to the anchor repo's `defaultBranch`.
3. [integration] The THREAD `FleetJob` created by that send has `feature` equal to `thread-<threadId>`.
4. [integration] The `FleetThreadTurn` created by that send has `instructions` that contain the project's slug.
5. [integration] The `FleetThreadTurn` created by that send has `instructions` that do not mention `write_doc`.
6. [unit] `buildProjectThreadInstructions({ project: 'sandbox', skills: [] })` returns text that contains `Skills available: none.`
7. [unit] `buildProjectThreadInstructions` with one skill source holding the skill `spec-writing` returns text with a line `- spec-writing — <description>` after `Skills available`.
8. [integration] `POST /api/projects/:slug/threads/:id/messages` on a PROJECT thread after the project's only fleet repo is deleted answers 409 with the `threads.noFleetRepo` message.
9. [integration] That refused send creates no `FleetJob` row for the thread.
10. [integration] With a budget policy paused on the anchor repo's scope, `POST /api/projects/:slug/threads/:id/messages` on a PROJECT thread answers the existing `fleet.budgetPaused` conflict.
11. [integration] The `job.dispatched` activity row written by a PROJECT thread send has `payload.repoId` equal to the anchor repo's id.
12. [integration] Ingesting a `turn_end` cost line for a PROJECT thread's THREAD job writes a cost event whose `featureName` is `thread-<threadId>`.
13. [integration] `POST /api/projects/:slug/threads/:id/messages` on a REPO thread still creates a THREAD `FleetJob` whose `repoId` is the thread's `repoId`.

### US-004: PROJECT ASSIGN and placement (`Workdir: apps/api`)

1. [integration] After a PROJECT thread send, a `POST /api/fleet/runner/sync` from an online protocol-4 runner whose capabilities include `projectThreads: true` and a native model the thread names returns an ASSIGN command whose `payload.thread.kind` is `PROJECT`.
2. [integration] That ASSIGN payload's `thread` has no `feature` key.
3. [integration] That ASSIGN payload's `repo.owner` and `repo.name` are the anchor repo's.
4. [integration] After a REPO thread send, the ASSIGN payload from the same sync has `thread.kind` `REPO` and `thread.feature` equal to the thread's feature.
5. [integration] After a PROJECT thread send, a `POST /api/fleet/runner/sync` from an online protocol-4 runner whose capabilities have thread backends but no `projectThreads` returns no ASSIGN command.
6. [integration] After that sync the PROJECT thread's THREAD job's `state` is still `QUEUED`.
7. [unit] `firstMisfit` for a THREAD job with `thread.kind` `PROJECT` and a runner without `projectThreads` returns `project_threads`.
8. [unit] `firstMisfit` for a THREAD job with `thread.kind` `PROJECT` and a runner with `projectThreads: true`, a matching native model and free thread capacity returns `null`.
9. [unit] `firstMisfit` for a THREAD job with `thread.kind` `REPO` and a runner without `projectThreads` but with a matching native model and free thread capacity returns `null`.
10. [unit] `firstMisfit` for a THREAD job with `thread.kind` `PROJECT` on a runner at protocol 3 returns `protocol` (the protocol check runs before the `project_threads` check).
11. [unit] `PERMANENT_MISFITS.has('project_threads')` returns `false`.

### US-005: Runner no-checkout path for PROJECT threads (`Workdir: apps/runner`)

1. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'PROJECT'`, action `SESSION` and no `feature` returns `ok: true` with `assign.thread.kind` `PROJECT`.
2. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'PROJECT'` and a `feature` returns `ok: false` with the reason `thread feature`.
3. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'PROJECT'` and action `PUBLISH` returns `ok: false` with the reason `thread action`.
4. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'OTHER'` returns `ok: false` with the reason `thread kind`.
5. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has no `kind` and a valid `feature` returns `ok: true` with no `kind` on `assign.thread`.
6. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has no `kind` and no `feature` returns `ok: false` with the reason `thread feature`.
7. [unit] The capability report from the nax probe includes `projectThreads: true`.
8. [unit] `threadScratchDir('/home/r', 't1')` returns `/home/r/threads/t1/scratch`.
9. [unit] `buildProjectThreadTools` returns tools whose names are exactly `['load_skill', 'read_skill_file']`.
10. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN calls the session opener with `worktree` equal to `threadScratchDir(homeDir, threadId)`.
11. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN calls the session opener with tools whose names are exactly `['load_skill', 'read_skill_file']`.
12. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN never calls `credentials.acquire`.
13. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN never calls the `prepareWorktree` seam.
14. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN creates the directory `threadScratchDir(homeDir, threadId)` before the session opener is called.
15. [unit] `command('THREAD_PUBLISH', {})` on a running PROJECT `ThreadJobRun` returns `{ result: 'rejected', detail: 'not_repo_thread' }`.

### US-006: Web scope picker and PROJECT thread rendering (`Workdir: apps/web`)

1. [unit] `buildThreadCreateSchema(t)` accepts values with `kind: 'PROJECT'`, an empty `repoId`, an empty `feature`, a title, a cost cap and a model.
2. [unit] `buildThreadCreateSchema(t)` rejects values with `kind: 'REPO'` and an empty `repoId` with the message key `fleet.threads.new.validation.repoRequired`.
3. [unit] `toCreateThreadBody` for values with `kind: 'PROJECT'` returns a body whose `kind` is `PROJECT` and that has no `repoId`, `feature` or `baseRef` key.
4. [unit] `toCreateThreadBody` for values with `kind: 'REPO'` returns a body whose `kind` is `REPO` and whose `repoId` and `feature` equal the form values.
5. [unit] `eligibleModels(runners, 'PROJECT')` returns only models of online, enabled runners whose `projectThreads` is `true`.
6. [unit] `eligibleModels(runners, 'REPO')` returns models of online, enabled runners regardless of `projectThreads`.
7. [unit] The new-thread page renders the scope select with `Repo` selected by default.
8. [unit] The new-thread page with the scope set to `Project` does not render the repo, base-ref and feature fields.
9. [unit] Submitting the new-thread page with the scope set to `Project` posts a body to `/projects/<slug>/threads` whose `kind` is `PROJECT`.
10. [unit] `showActionBar` returns `false` for a thread with `kind: 'PROJECT'` whose creator is the viewer.
11. [unit] `showActionBar` returns `true` for a REPO thread whose creator is the viewer, not archived, with `sendRefusal` not `disabled`.
12. [unit] `ThreadListTable` renders the `fleet.threads.kind.project` label in the feature column for a PROJECT thread row.
13. [unit] `ThreadListTable` renders no `feat/` text for a PROJECT thread row.
14. [unit] `ThreadHeader` renders the `fleet.threads.kind.project` label for a PROJECT thread.
15. [unit] `ThreadHeader` renders no `feat/` text for a PROJECT thread.
