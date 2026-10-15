# SPEC: Fleet S5b-1a — Project Threads (Thread Kind, Anchor Repo, No-Checkout Runner Path, Web Scope Picker)

## Summary

koda threads today are bound to a repo and a nax feature: the runner checks out a worktree and the agent brainstorms a
spec for that feature. This feature adds a second thread kind, `PROJECT`: a thread that belongs to the project but to
no repo, feature or worktree. A project member creates it from the new-thread page with a scope picker, sends
messages, and the agent answers from a runner, as in a repo thread, but with no checkout and no repo tools. PROJECT
threads are the host the koda assistant tools (S5b-1b onward) plug into. This feature ships the thread kind end to end
with no koda tools yet.

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
  project's **anchor repo** — its oldest `FleetRepo` by `createdAt`, then smallest `id` — as `repoId`, the anchor's
  `defaultBranch` as `ref`, and `thread-<threadId>` as `feature` (as every THREAD job already does). The anchor is
  bookkeeping only (placement, budget keys, dashboards, activity); the runner never clones, fetches or touches it and
  requests no git token for the job. A project with no fleet repo cannot create or run a PROJECT thread (409
  `threads.noFleetRepo`).
- S5b-R9: no protocol version bump. The ASSIGN `thread` block gains an optional `kind`; a runner advertises
  `projectThreads: true`; PROJECT THREAD jobs are placed only on runners that advertise it.
- 1a-R1: the API always sends `thread.kind` (`REPO` or `PROJECT`) on a THREAD ASSIGN. A runner treats a missing `kind`
  as `REPO`. `ThreadAssign.feature` stays a required string: for a PROJECT thread the API sends `thread-<threadId>`
  (the job's own feature), and the runner never uses it for a PROJECT run. This keeps the runner's existing
  `feature: string` consumers (`thread-worktree.ts`, `thread-publish.ts`, `thread-action-run.ts`) unchanged.
- 1a-R2: PROJECT threads with an ACP backend are refused at creation (ACP sessions get no tools, nax#2444).
- 1a-R3: PROJECT threads have no Publish, Discard, Plan or Run. The routes answer 409 `threads.notRepoThread`; the web
  hides the action bar.
- 1a-R4: the kind rule (REPO has `repoId`, `baseRef`, `feature`, `specPath`; PROJECT has none) is enforced by the create
  path, the only writer of those columns. No database check constraint: integration schemas are built with
  `prisma db push` (`apps/api/test/helpers/partial-indexes.ts`), which cannot create one.
- 1a-R5: the new-thread form defaults to the Repo scope (today's behaviour).
- 1a-R6: the new protocol type is named `ChatThreadKind` (not `ThreadKind`), because `isThreadKind(command)` already
  means "the job command is THREAD".
- The kill switch is unchanged: `FLEET_THREADS_ENABLED` gates PROJECT threads exactly as it gates REPO threads.

### Integration

This feature changes the symbols below. Each baseline exists only to locate the code; it is never the interface to
implement.

**Protocol package** (`packages/fleet-protocol/src/threads.ts`, `index.ts`; US-001, additive only)

- `ChatThreadKind` — new: `export type ChatThreadKind = 'REPO' | 'PROJECT'` and
  `export const CHAT_THREAD_KINDS = ['REPO', 'PROJECT'] as const`, re-exported from `index.ts`.
- `ThreadAssign` — Target: gains `kind?: ChatThreadKind` (documented: absent means `REPO`). `feature` stays `string`.
- `RunnerCapabilities` (`index.ts:64-81`) — Target: gains `projectThreads?: true` ("Fleet S5b: the runner hosts PROJECT
  threads with no checkout. Absent on older runners.").

**API contract** (US-001)

- `apps/api/src/fleet/common/thread-jobs.ts` — re-exports `ChatThreadKind` and mirrors `CHAT_THREAD_KINDS` at runtime,
  as it does `THREAD_COMMAND_TYPES`.
- `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts:118-158`) — Target: accepts
  `projectThreads`, strict like `threadWrite` (only exactly `true`; any other present value fails with reason
  `projectThreads`); the parsed result has `projectThreads: true` only when the report had it.
- `RunnerSummaryDto` (`apps/api/src/fleet/runners/dto/runner-summary.dto.ts`) — Target: gains
  `projectThreads: boolean`, true iff `protocolVersion >= THREAD_MIN_PROTOCOL_VERSION` and the stored capabilities have
  `projectThreads === true`.

**API data and REPO-only guard** (US-002)

- `ChatThread` (`apps/api/prisma/schema.prisma:1058-1095`) — Target: gains `kind String @default("REPO") // REPO | PROJECT`;
  `repoId`, `baseRef`, `feature`, `specPath` become `String?`; the `repo` relation becomes optional. New migration
  `apps/api/prisma/migrations/20261017090000_chat_thread_kind/migration.sql` (sorts after the latest,
  `20261016090000_fleet_job_workflow`): adds the column with default `'REPO'` and drops NOT NULL on the four columns.
  The partial unique index `ChatThread_active_repo_feature_key` is unchanged (it admits any number of null `repoId`
  rows).
- `ChatThreadRecord` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts:46-58`) — Target: gains
  `kind: ChatThreadKind`; `repoId`, `baseRef`, `feature`, `specPath` become `string | null`. `ThreadDto`
  (`dto/thread.dto.ts`) mirrors it (`kind` with `enum: ['REPO', 'PROJECT']`; the four fields `nullable: true`).
  `mapThread` (`prisma-chat-thread.repository.ts:397-409`) maps `kind`; a stored value other than `PROJECT` maps to
  `REPO`.
- `repoThreadFields(thread: { kind: string; repoId: string | null; baseRef: string | null; feature: string | null; specPath: string | null }): { repoId: string; baseRef: string; feature: string; specPath: string }`
  — new, in `chat-thread.domain.ts`. Throws `ConflictAppException({}, 'threads.notRepoThread')` (409) only when
  `kind === 'PROJECT'` or any of the four fields is null; otherwise returns the four fields. A missing or unknown `kind`
  is treated as `REPO`, matching `mapThread` (existing unit fixtures build thread rows without `kind`). Every REPO-only consumer reads the fields through it:
  - `ThreadsService.plan` and `ThreadsService.run` (`threads.service.ts:87-115`): call it right after the not-found
    check, before the creator check.
  - `PrismaChatThreadRepository.publish` and `discard` (`prisma-chat-thread.repository.ts:171-255`): call it on the
    first read row right after its not-found check (`:181` and the matching line in `discard`), before the creator
    check.
  - `PrismaChatThreadRepository.createThreadJob` (`:354-381`) for a REPO thread (the PROJECT branch is US-004; until
    then a PROJECT send answers 409 `threads.notRepoThread`).
  - `findThreadAssign` (`prisma-fleet-job.repository.ts:201-215`) uses `thread.feature ?? \`thread-${turn.threadId}\``
    (1a-R1).
  - The thread-ingest cost event (`threads/ingest/prisma-thread-ingest.repository.ts:256-270`, `costEventData`): its
    `thread` argument gains `id` (the two call sites at `:201` and `:249` add `id` to the thread select), and
    `featureName` becomes `thread.feature ?? \`thread-${thread.id}\``.
  - `jobGateKeys` (`apps/api/src/fleet/budgets/budget-rules.ts:40-47`) — Baseline: `repoId: string`, always emits a
    `repo:<id>` key. Target: `repoId: string | null`; null emits no `repo:` key (project, runner and global keys
    unchanged). The `thread` parameter of `sendRefusalFor` (`prisma-chat-thread.repository.ts:316`) widens `repoId` to
    `string | null` the same way. In US-002 both still receive `thread.repoId` as stored (null for a PROJECT row); US-004
    swaps in the anchor.
- i18n (`apps/api/src/i18n/{en,zh}/threads.json`): new key `notRepoThread`.

**API create** (US-003)

- `validateCreateThread` (`apps/api/src/fleet/threads/thread-input.ts`) — Baseline:
  `validateCreateThread(value: CreateThreadInput, defaultBranch: string): Omit<CreateThreadInput, 'baseRef' | 'maxCostUsd'> & { baseRef: string; maxCostUsd: string }`.
  Target:

  ```ts
  export interface CreateThreadInput { kind?: ChatThreadKind; repoId?: string; feature?: string; baseRef?: string; title: string; maxCostUsd?: number; backend: ThreadBackend }
  export type NormalizedCreateThread =
    | { kind: 'REPO'; repoId: string; feature: string; baseRef: string; title: string; maxCostUsd: string; backend: ThreadBackend }
    | { kind: 'PROJECT'; title: string; maxCostUsd: string; backend: ThreadBackend & { kind: 'native' } };
  export function validateCreateThread(value: CreateThreadInput, defaultBranch: string): NormalizedCreateThread;
  ```

  Checks, in order, first failure wins: `kind` (absent means `REPO`; any other value than `REPO` / `PROJECT` fails with
  reason `kind`); for `REPO`, a missing or non-string `repoId` fails with reason `repoId` (new rule), then today's
  `feature`, `baseRef` checks; for `PROJECT`, any of `repoId`, `feature`, `baseRef` present fails with reason
  `projectFields`; then today's `title`, `maxCostUsd`, `backend` checks; for `PROJECT`, a backend of kind `acp` fails
  with reason `backend`. All failures are `ValidationAppException({ reason }, 'threads.input')` (400).
- `CreateThreadDto` (`dto/thread.dto.ts`) — Target: gains `kind?` (`enum: ['REPO', 'PROJECT']`); `repoId` and `feature`
  become `required: false`.
- `ChatThreadRepository.create` input (`chat-thread.domain.ts:62`) and `PrismaChatThreadRepository.create`
  (`prisma-chat-thread.repository.ts:48-56`) — Target: input is
  `{ kind: ChatThreadKind; projectId; repoId: string | null; baseRef: string | null; feature: string | null; title; createdById; backend; skills; maxCostUsd }`;
  `specPath` is `.nax/features/<feature>/spec.md` for REPO and `null` for PROJECT.
- `ThreadsService.create` (`threads.service.ts:27-40`) — Target: calls `validateCreateThread` once for PROJECT (no repo
  lookup). For PROJECT it resolves the anchor through `IFleetRepoRepository.findAnchor(projectId)`; null answers
  `ConflictAppException({}, 'threads.noFleetRepo')` (409); otherwise it creates the thread with `kind: 'PROJECT'` and
  null repo fields. REPO keeps today's two-pass flow.
- `IFleetRepoRepository.findAnchor(projectId: string): Promise<FleetRepoRecord | null>` — new
  (`apps/api/src/fleet/repos/domain/fleet-repo.domain.ts`, implemented in `prisma-fleet-repo.repository.ts`): the
  project's repo with the smallest `createdAt`, ties broken by the smallest `id`; null when the project has none.
- i18n: new key `noFleetRepo` in `threads.json` (en + zh).

**API session job** (US-004)

- `anchorRepoFor(projectId)` — a private helper of `PrismaChatThreadRepository` with the same rule as `findAnchor`.
- `createThreadJob` (`prisma-chat-thread.repository.ts:354-381`) — Target: for a PROJECT thread it resolves the anchor
  inside the send transaction; none answers 409 `threads.noFleetRepo`; the job gets `repoId` = anchor id and `ref` =
  anchor `defaultBranch`; the instructions come from `buildProjectThreadInstructions` with the project's slug.
- `sendRefusalFor` (`:316-334`) and `sendRefusalOf` (`:84-97`) — Target: `sendRefusalFor`'s `thread` parameter gains
  `kind` (passed by `sendRefusalOf` and by `sendMessage`); for a PROJECT thread the budget gate keys use the anchor's id, or `null` when the project has no fleet repo. The no-repo case is not a send refusal: GET detail
  answers 200 with the usual `sendRefusal`, and the send itself then answers 409 `threads.noFleetRepo` from
  `createThreadJob`.
- Job-dispatch activity payload (`:304`) — Target: for a PROJECT thread `payload.repoId` is the anchor's id and
  `payload.ref` its default branch.
- `buildProjectThreadInstructions(input: { project: string; skills: ThreadSkillSource[] }): string` — new, in
  `apps/api/src/fleet/threads/thread-instructions.ts`. Worked shape:

  ```ts
  export function buildProjectThreadInstructions(input: { project: string; skills: ThreadSkillSource[] }): string {
    const lines = [
      `You are a brainstorming partner for the koda project "${input.project}". This thread is not tied to a repository.`,
      'Ask one question at a time. You have no repository, no shell and no web access; do not claim facts about code you cannot see.',
    ];
    // then the same "Skills available" block as buildThreadInstructions
  }
  ```

  The text never mentions `write_doc`, `list_files`, `search_repo` or Publish.

**API ASSIGN and placement** (US-005)

- `findThreadAssign` (`prisma-fleet-job.repository.ts:201-215`) — Target: also selects the thread's `kind` and returns
  `kind` (`PROJECT` when the row says `PROJECT`, otherwise `REPO`); `feature` per 1a-R1.
- `toPlacementJob` (`apps/api/src/fleet/jobs/placement-rules.ts:163-170`) and `PlacementJob.thread` (`:24-33`) —
  Target: the thread argument gains `kind?: ChatThreadKind`. Both builders pass the assign's `kind`:
  `PlacementService.placeJob` (`placement.service.ts:85-86`, reached right after a send commits) and
  `PlacementService.fillRunnerThreads` (`:165`, reached from a runner sync).
- `firstMisfit` THREAD branch (`placement-rules.ts:108-125`) — Target: right after the `protocol` check, a job whose
  `thread.kind` is `PROJECT` on a runner whose `capabilities.projectThreads !== true` returns the new `MisfitReason`
  `'project_threads'`. Not in `PERMANENT_MISFITS`. The value is added to `MisfitReason`, the `PlacementMisfitDto.reason`
  enum (`jobs/dto/fleet-job.dto.ts:127`) and the dashboard list (`dashboard/dashboard.types.ts:109-111`).

**Runner** (US-006)

- `parseAssign` thread block (`apps/runner/src/supervisor/assign-parser.ts:148-188`) — Target: reads optional `kind`;
  a present value other than `REPO` or `PROJECT` returns `{ ok: false, detail: 'invalid thread kind' }`. A `PROJECT`
  block with an action other than `SESSION` returns `{ ok: false, detail: 'invalid thread action' }`. `feature` is
  checked as today for every kind. The parsed `ThreadAssign` carries `kind` as received (absent stays absent).
- Capability probe (`apps/runner/src/capabilities/nax-probe.ts:156-170`) — Target: the report gains
  `projectThreads: true`.
- `threadScratchDir(homeDir: string, threadId: string): string` — new in `apps/runner/src/thread/thread-paths.ts`:
  `join(threadDirFor(homeDir, threadId), 'scratch')`. It lives under the thread directory, so `pruneThreads` removes it
  with the thread.
- `buildProjectThreadTools(ctx: ThreadToolContext): EmbedderTool[]` — new in `apps/runner/src/thread/tools/index.ts`:
  `[loadSkillTool(ctx), readSkillFileTool(ctx)]`. The PROJECT run builds the full `ThreadToolContext` as the REPO path
  does, with `worktree` = the scratch dir and no `feature` / `onDocWritten`; the two factories keep their signatures.
- `ThreadJobRun.run` SESSION path (`apps/runner/src/thread/thread-job-run.ts:217-330`) — Target: when
  `thread.kind === 'PROJECT'` it skips step 1 (`credentials.acquire`) and steps 2-4 (`prepare`), creates
  `threadScratchDir(homeDir, threadId)` (recursive; no error when it exists), runs step 5 (skills) unchanged, opens the
  session with `worktree` = that scratch dir and `tools` = `buildProjectThreadTools({ worktree: scratch, skillsRoot, skills, git, searchTimeoutMs, nowMs })`, opens the stream with `stale`
  false, and creates no `ThreadLivePublish`. `command('THREAD_PUBLISH', …)` on such a run returns
  `{ result: 'rejected', detail: 'not_repo_thread' }`. REPO runs are unchanged.

**Web** (US-007)

- `ThreadDto` (`apps/web/lib/thread-types.ts:77-104`) — Target: gains `kind: 'REPO' | 'PROJECT'`; `repoId`, `baseRef`,
  `feature`, `specPath` become `string | null`. `FleetRunnerSummary` (`apps/web/lib/fleet-types.ts:102-112`) gains
  `projectThreads: boolean`.
- `apps/web/lib/thread-create.ts` — Target: `ThreadCreateValues` gains `kind: 'REPO' | 'PROJECT'`.
  `buildThreadCreateSchema` adds `kind: z.enum(['REPO', 'PROJECT']).default('REPO')` and moves the `repoId`, `baseRef`
  and `feature` rules into a `superRefine` that runs them only when `kind` is `REPO` (same message keys), adding each
  issue with `path: ['repoId']`, `['baseRef']` or `['feature']` so the form shows it on that field.
  `toCreateThreadBody` returns `{ kind: 'PROJECT', title, maxCostUsd, backend }` for PROJECT and today's body plus
  `kind: 'REPO'` for REPO. `eligibleModels(runners, kind)` gains a `kind` argument; for `PROJECT` it keeps only runners
  whose `projectThreads` is true.
- `apps/web/pages/[project]/threads/new.vue` — Target: a native `<select>` for the scope (`Repo` | `Project`, default
  `Repo`, 1a-R5) above the fields; Project hides the repo, base-ref and feature fields and passes `kind` to
  `eligibleModels`.
- `showActionBar` (`apps/web/lib/thread-handoff.ts:27-29`) — Target: false when `thread.kind === 'PROJECT'`.
- `ThreadListTable.vue:43` and `ThreadHeader.vue:25` — Target: a PROJECT thread renders `t('fleet.threads.kind.project')`
  where a REPO thread renders `feat/<feature>`.
- i18n (`apps/web/i18n/locales/{en,zh}.json`): `fleet.threads.new.scope`, `fleet.threads.new.scopeRepo`,
  `fleet.threads.new.scopeProject`, `fleet.threads.kind.project`.

Symbols this feature reads but does not change: `THREAD_MIN_PROTOCOL_VERSION` (`threads/thread-send-rules.ts:9`),
`pruneThreads` (`apps/runner/src/thread/thread-prune.ts:25`), `loadSkillTool` / `readSkillFileTool`
(`apps/runner/src/thread/tools/`), `useFleetDispatchOptions` (`apps/web/composables/useFleetDispatchOptions.ts`).

Patterns to follow: strict capability parsing — `threadWrite` (`capabilities-core.ts:138-139`); runtime mirror of a
package constant — `THREAD_COMMAND_TYPES` in `apps/api/src/fleet/common/thread-jobs.ts`; placement misfit —
`thread_write` (`placement-rules.ts:120-121`); migration tests — `scratchSchemaBefore` / `applyMigration`
(`apps/api/test/helpers/migration-schema.ts`); thread fixtures — `seedThreadJobFor`
(`apps/api/test/helpers/thread-fixtures.ts`).

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Plan / Run / Publish / Discard on a PROJECT thread | 409 `threads.notRepoThread` | US-002 |
| Create with an unknown `kind` | 400 `threads.input`, reason `kind` | US-003 |
| REPO create with no `repoId` | 400 `threads.input`, reason `repoId` | US-003 |
| PROJECT create with `repoId`, `feature` or `baseRef` | 400 `threads.input`, reason `projectFields` | US-003 |
| PROJECT create with an ACP backend | 400 `threads.input`, reason `backend` | US-003 |
| PROJECT create in a project with no fleet repo | 409 `threads.noFleetRepo` | US-003 |
| PROJECT send in a project with no fleet repo | 409 `threads.noFleetRepo`; no job created | US-004 |
| PROJECT THREAD job, no runner with `projectThreads` | job stays QUEUED; misfit `project_threads` | US-005 |
| Runner receives a `thread.kind` it does not know | ASSIGN refused, detail `invalid thread kind` | US-006 |
| PROJECT ASSIGN with a non-SESSION action | ASSIGN refused, detail `invalid thread action` | US-006 |
| `THREAD_PUBLISH` to a PROJECT run | ack `rejected`, detail `not_repo_thread` | US-006 |

## Out of Scope

- koda data tools in threads (the tool registry, executor, runner tool route and `kodaTools` capability) are S5b-1b and later; PROJECT threads in this feature have only the skill tools.
- WORKSPACE (app-wide, personal) threads are S5b-1d; this feature adds only the `PROJECT` kind.
- ACP backends for PROJECT threads: refused at creation; no ACP placement or runner path for PROJECT threads.
- `write_doc`, Publish, Discard, Plan and Run for PROJECT threads.
- Converting an existing thread between `REPO` and `PROJECT`.
- Any change to the `FleetJob` schema: `repoId`, `ref` and `feature` stay required (anchor repo, S5b-R13).
- A database check constraint for the thread kind rule (ruling 1a-R4).
- A `FLEET_PROTOCOL_VERSION` bump; the protocol additions are optional fields gated by the `projectThreads` capability.
- Making `ThreadAssign.feature` optional; PROJECT ASSIGNs carry `thread-<threadId>` (ruling 1a-R1).
- Choosing a different anchor than the project's oldest fleet repo, or showing the anchor repo in the web.
- Anchor repo deletion side effects: deleting the anchor is refused while a PROJECT session is active (existing `countUnfinishedJobs` rule), and deleting an idle anchor removes its old THREAD jobs and their turns, so the next PROJECT session starts with `resume: false`; both are accepted.
- A Playwright journey for PROJECT threads (a deliberate departure from the umbrella's one-journey-per-feature guidance); web stories are verified by unit and component tests.
- US-004 only: budget pauses scoped to the anchor repo also stop PROJECT threads; this coupling is accepted (S5b-R13).

## Stories

1. **US-001: Thread kind contract and runner capability** — `Workdir: apps/api` — No dependencies.
2. **US-002: Thread kind data and REPO-only guard** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Create PROJECT threads** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: PROJECT session job on the anchor repo** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: PROJECT ASSIGN and placement** — `Workdir: apps/api` — Depends on US-004.
6. **US-006: Runner no-checkout path for PROJECT threads** — `Workdir: apps/runner` — Depends on US-001.
7. **US-007: Web scope picker and PROJECT thread rendering** — `Workdir: apps/web` — Depends on US-003.

US-001 also edits `packages/fleet-protocol/src/threads.ts` and `packages/fleet-protocol/src/index.ts`. Its changes are
additive (new optional fields and a new type), so `bun run type-check` at the repo root passes for every package after
it. US-002's schema change makes four `ChatThread` columns nullable; US-002 owns every API compile site that reads them
(through `repoThreadFields` or the `?? thread-<id>` fallbacks listed in Design), so the `apps/api` type-check passes
after US-002.

### Context Files

**US-001**

- `packages/fleet-protocol/src/threads.ts` — `ThreadAssign`; gains `ChatThreadKind`, `CHAT_THREAD_KINDS`
- `packages/fleet-protocol/src/index.ts` — `RunnerCapabilities` gains `projectThreads`
- `apps/api/src/fleet/common/capabilities-core.ts` — strict `threadWrite` parsing to mirror
- `apps/api/src/fleet/common/thread-jobs.ts` — runtime mirror of package constants
- `apps/api/src/fleet/runners/dto/runner-summary.dto.ts` — `RunnerSummaryDto`

**US-002**

- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRecord`, gains `repoThreadFields`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `mapThread`, `publish`, `discard`, `createThreadJob`
- `apps/api/src/fleet/threads/threads.service.ts` — `plan`, `run`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`
- `apps/api/src/fleet/budgets/budget-rules.ts` — `jobGateKeys`

**US-003**

- `apps/api/src/fleet/threads/thread-input.ts` — `validateCreateThread`
- `apps/api/src/fleet/threads/threads.service.ts` — `create`
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — gains `findAnchor`
- `apps/api/src/fleet/threads/threads.controller.ts` — create route
- `apps/api/test/helpers/fleet-fixtures.ts` — `FleetHttpWorld`, `insertRunner`

**US-004**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `createThreadJob`, `sendRefusalFor`, `sendRefusalOf`, `sendMessage`
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildThreadInstructions` (pattern for the new builder)
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — cost event `featureName`
- `apps/api/test/helpers/thread-fixtures.ts` — `seedThreadJobFor`

**US-005**

- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`
- `apps/api/src/fleet/jobs/placement-rules.ts` — `firstMisfit`, `MisfitReason`, `PlacementJob`, `toPlacementJob`
- `apps/api/src/fleet/jobs/placement.service.ts` — `placeJob`, `fillRunnerThreads`
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `PlacementMisfitDto.reason` enum
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — dashboard misfit list

**US-006**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign` thread block
- `apps/runner/src/thread/thread-job-run.ts` — `run`, `command`
- `apps/runner/src/thread/thread-paths.ts` — `threadDirFor`
- `apps/runner/src/thread/tools/index.ts` — `buildThreadTools`
- `apps/runner/src/capabilities/nax-probe.ts` — capability report

**US-007**

- `apps/web/lib/thread-create.ts` — schema, body, `eligibleModels`
- `apps/web/pages/[project]/threads/new.vue` — the create form
- `apps/web/lib/thread-handoff.ts` — `showActionBar`
- `apps/web/components/fleet/threads/ThreadListTable.vue` — feature column
- `apps/web/components/fleet/threads/ThreadHeader.vue` — feature badge

### Creates

**US-002**

- `apps/api/prisma/migrations/20261017090000_chat_thread_kind/migration.sql` — `kind` column, nullable repo fields
- `apps/api/test/integration/fleet/fleet-thread-kind.integration.spec.ts` — schema, migration and REPO-only guard routes

**US-003**

- `apps/api/test/integration/fleet/fleet-project-threads.integration.spec.ts` — anchor lookup and create route

**US-004**

- `apps/api/test/integration/fleet/fleet-project-thread-send.integration.spec.ts` — anchor job, refusal, activity, cost

**US-005**

- `apps/api/test/integration/fleet/fleet-project-thread-placement.integration.spec.ts` — ASSIGN kind and placement

**US-006**

- `apps/runner/test/unit/thread-job-run-project.spec.ts` — no-checkout run path

**US-007**

- `apps/web/tests/lib/thread-create-project.spec.ts` — PROJECT schema, body and model filtering

### Modifies

**US-001**

- `apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts` — the test at line 14 asserts the whole `RunnerSummaryDto` with `toEqual`; the DTO gains `projectThreads`, so the expected literal gains `projectThreads: false` for that capability-free record. Other expectations unchanged.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the assertion at lines 40-41 pins the exact sorted key list of `RunnerSummaryDto`; it gains `projectThreads`. Other contract assertions unchanged.
- `apps/api/test/integration/fleet/runner-views.integration.spec.ts` — line 80 pins the exact sorted key list of a GET /api/projects/web/fleet/runners record; it gains `projectThreads` because that route returns `RunnerSummaryDto`. Other expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for `RunnerSummaryDto.projectThreads`; `bun run generate` also refreshes the untracked CLI client.

**US-002**

- `apps/api/prisma/schema.prisma` — `ChatThread` gains `kind` and the four repo fields become optional; integration suites build their schema from this file.
- `apps/api/src/fleet/threads/threads.service.spec.ts` — its `record` literal at line 9 is typed `ChatThreadRecord`, which gains the required `kind`; the literal gains `kind: 'REPO'` so `bun run type-check:spec` passes. Its expectations are unchanged.
- `apps/api/src/i18n/en/threads.json` — gains `notRepoThread`.
- `apps/api/src/i18n/zh/threads.json` — gains `notRepoThread`.
- `openapi.json` — regenerated by `bun run api:export-spec` for `ThreadDto.kind` and the nullable thread fields.

**US-003**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — the `create` call at line 162 passes the old input shape without `kind`; the repository input now requires `kind`, so that call gains `kind: 'REPO'` for `bun run type-check:spec`. Its expectations are unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite covers every endpoint behaviour change (rule api-testing); this story adds POST /api/projects/:slug/threads with `kind: 'PROJECT'` (201) and with `kind: 'PROJECT'` plus a `feature` (400). Existing expectations unchanged.
- `apps/api/src/i18n/en/threads.json` — gains `noFleetRepo`.
- `apps/api/src/i18n/zh/threads.json` — gains `noFleetRepo`.
- `openapi.json` — regenerated by `bun run api:export-spec` for `CreateThreadDto.kind` and the optional `repoId` / `feature`.

**US-004**

None. The story changes repository internals only; no existing test pins a PROJECT thread's job, instructions or refusal, and REPO-thread expectations are unchanged.

**US-005**

- `openapi.json` — regenerated by `bun run api:export-spec` for the new `PlacementMisfitDto.reason` value `project_threads` and the dashboard misfit enum.

**US-006**

- `apps/runner/src/capabilities/nax-probe.spec.ts` — the probe test near line 92 asserts the whole capability report with `toEqual`; the report gains `projectThreads: true`, so the expected literal gains that key. Other expectations unchanged.

**US-007**

- `apps/web/i18n/locales/en.json` — gains `fleet.threads.new.scope`, `fleet.threads.new.scopeRepo`, `fleet.threads.new.scopeProject`, `fleet.threads.kind.project`.
- `apps/web/i18n/locales/zh.json` — gains the same four keys.
- `apps/web/tests/lib/thread-create.spec.ts` — its `toCreateThreadBody` expectations for a REPO form pin the body with `toEqual`; the REPO body now also carries `kind: 'REPO'`, so each expected REPO body gains that key. Calls to `eligibleModels(runners)` gain the second argument `'REPO'`; expected model lists are unchanged.
- `apps/web/tests/pages/threads-new-page.spec.ts` — the submit test near line 189 asserts the exact POST body to /projects/web/threads with `toHaveBeenCalledWith`; the REPO body now carries `kind: 'REPO'`, so the expected body gains that key. Other expectations unchanged.

### Seams

- SEAM-1 (US-001 -> US-005): `parseCapabilitiesCore` stores `projectThreads`; US-005 ACs post a capability report
  through `POST /api/fleet/runner/sync` and assert placement of a PROJECT THREAD job.
- SEAM-2 (US-003 -> US-004): `IFleetRepoRepository.findAnchor`'s rule is what thread job creation applies; a US-004 AC
  triggers `POST /api/projects/:slug/threads/:id/messages` and asserts the job's `repoId` is the oldest repo's id.
- SEAM-3 (US-004): `buildProjectThreadInstructions` is called by thread job creation; US-004 ACs trigger
  `POST /api/projects/:slug/threads/:id/messages` and assert the stored `FleetThreadTurn.instructions`.
- SEAM-4 (US-005): both placement entry points carry `kind` — `POST /api/projects/:slug/threads/:id/messages` with a
  runner already online reaches `PlacementService.placeJob`; `POST /api/fleet/runner/sync` reaches
  `PlacementService.fillRunnerThreads`. US-005 has an AC for each.
- SEAM-5 (US-001 -> US-006): `ThreadAssign.kind` from the package is what the runner parser reads; US-006 ACs drive
  `parseAssign` with a PROJECT thread block, and start a `ThreadJobRun` from it.

## Acceptance Criteria

### US-001: Thread kind contract and runner capability (`Workdir: apps/api`)

1. [unit] In `apps/api/src/fleet/common/thread-jobs.spec.ts`, the API's `CHAT_THREAD_KINDS` deep-equals the `CHAT_THREAD_KINDS` exported by `@nathapp/fleet-protocol` (runtime import), which is `['REPO', 'PROJECT']`.
2. [unit] `parseCapabilitiesCore` on a valid report plus `projectThreads: true` returns an object whose `projectThreads` is `true`.
3. [unit] `parseCapabilitiesCore` on a valid report without `projectThreads` returns an object that has no `projectThreads` key.
4. [unit] `parseCapabilitiesCore` on a valid report plus `projectThreads: false` throws `CapabilityValidationError` with `reason` `projectThreads`.
5. [unit] `RunnerSummaryDto.from` for a runner at protocol 4 whose capabilities have `projectThreads: true` returns `projectThreads: true`.
6. [unit] `RunnerSummaryDto.from` for a runner at protocol 4 whose capabilities have no `projectThreads` returns `projectThreads: false`.
7. [unit] `RunnerSummaryDto.from` for a runner at protocol 3 whose capabilities have `projectThreads: true` returns `projectThreads: false`.

### US-002: Thread kind data and REPO-only guard (`Workdir: apps/api`)

1. [integration] Inserting a `ChatThread` row with no `kind` value stores `kind` `REPO`.
2. [integration] Inserting a `ChatThread` row with `kind` `PROJECT` and null `repoId`, `baseRef`, `feature` and `specPath` succeeds.
3. [unit] `repoThreadFields` for a thread object with no `kind` property and all four fields set returns those four values.
4. [integration] Applying the `20261017090000_chat_thread_kind` migration with `applyMigration` to a scratch schema from `scratchSchemaBefore` that holds one `ChatThread` row leaves that row with `kind` `REPO`.
5. [integration] After that migration the pre-existing `ChatThread` row keeps its `repoId`, `feature` and `specPath` values.
6. [integration] `GET /api/projects/:slug/threads/:id` for a PROJECT thread row answers 200 with `kind` `PROJECT`.
7. [integration] `GET /api/projects/:slug/threads/:id` for a PROJECT thread row answers 200 with `repoId`, `feature` and `specPath` null.
8. [unit] `repoThreadFields` for a REPO thread with all four fields set returns those four values.
9. [unit] `repoThreadFields` for a PROJECT thread throws `ConflictAppException` with the `threads.notRepoThread` key.
10. [unit] `repoThreadFields` for a REPO thread whose `feature` is null throws `ConflictAppException` with the `threads.notRepoThread` key.
11. [integration] `POST /api/projects/:slug/threads/:id/plan` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
12. [integration] `POST /api/projects/:slug/threads/:id/run` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
13. [integration] `POST /api/projects/:slug/threads/:id/publish` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
14. [integration] `POST /api/projects/:slug/threads/:id/discard` by the creator of a PROJECT thread answers 409 with the `threads.notRepoThread` message.
15. [unit] In `budget-rules.spec.ts`, `jobGateKeys({ projectId: 'p1', repoId: null, pinnedRunnerId: null })` returns keys none of which starts with `repo:`.

### US-003: Create PROJECT threads (`Workdir: apps/api`)

1. [unit] `validateCreateThread` with `kind: 'PROJECT'`, a title and a native backend returns a value whose `kind` is `PROJECT`.
2. [unit] `validateCreateThread` with `kind: 'PROJECT'` and a `feature` throws `ValidationAppException` with `reason` `projectFields`.
3. [unit] `validateCreateThread` with `kind: 'PROJECT'` and a `repoId` throws `ValidationAppException` with `reason` `projectFields`.
4. [unit] `validateCreateThread` with `kind: 'PROJECT'` and a `baseRef` throws `ValidationAppException` with `reason` `projectFields`.
5. [unit] `validateCreateThread` with `kind: 'PROJECT'` and backend `{ kind: 'acp', agent: 'claude' }` throws `ValidationAppException` with `reason` `backend`.
6. [unit] `validateCreateThread` with `kind: 'WORKSPACE'` throws `ValidationAppException` with `reason` `kind`.
7. [unit] `validateCreateThread` with no `kind`, no `repoId` and no `feature` throws `ValidationAppException` with `reason` `repoId`.
8. [unit] `validateCreateThread` with no `kind`, a `repoId`, a valid `feature` and a native backend returns a value whose `kind` is `REPO`.
9. [integration] `PrismaFleetRepoRepository.findAnchor(projectId)` for a project with two repos created at different times returns the repo with the earlier `createdAt`.
10. [integration] `PrismaFleetRepoRepository.findAnchor(projectId)` for a project with no fleet repo returns `null`.
11. [integration] `POST /api/projects/:slug/threads` as a project DEVELOPER with `{ kind: 'PROJECT', title, backend: { kind: 'native', model: 'm1' } }` answers 201 and the response's `kind` is `PROJECT`.
12. [integration] The thread row created by that request has null `repoId`, `baseRef`, `feature` and `specPath`.
13. [integration] `POST /api/projects/:slug/threads` with `kind: 'PROJECT'` in a project that has no fleet repo answers 409 with the `threads.noFleetRepo` message.
14. [integration] `GET /api/projects/:slug/threads` returns a PROJECT thread created in that project with `kind` `PROJECT`.

### US-004: PROJECT session job on the anchor repo (`Workdir: apps/api`)

1. [integration] `POST /api/projects/:slug/threads/:id/messages` by the creator of a PROJECT thread in a project with two fleet repos creates a THREAD `FleetJob` whose `repoId` is the repo with the earlier `createdAt`.
2. [integration] The THREAD `FleetJob` created by that send has `ref` equal to the anchor repo's `defaultBranch`.
3. [integration] The THREAD `FleetJob` created by that send has `feature` equal to `thread-<threadId>`.
4. [integration] The `FleetThreadTurn` created by that send has `instructions` that contain the project's slug.
5. [integration] The `FleetThreadTurn` created by that send has `instructions` that do not mention `write_doc`.
6. [unit] In `thread-instructions.spec.ts`, `buildProjectThreadInstructions({ project: 'sandbox', skills: [] })` returns text that contains `Skills available: none.`
7. [unit] `buildProjectThreadInstructions` with one skill source holding the skill `spec-writing` returns text with a line `- spec-writing — <description>` after `Skills available`.
8. [integration] `POST /api/projects/:slug/threads/:id/messages` on a PROJECT thread in a project whose only fleet repo was deleted answers 409 with the `threads.noFleetRepo` message.
9. [integration] That refused send creates no `FleetJob` row for the thread.
10. [integration] `GET /api/projects/:slug/threads/:id` for a PROJECT thread in a project with no fleet repo answers 200.
11. [integration] With a budget policy paused on the anchor repo's scope, `POST /api/projects/:slug/threads/:id/messages` on a PROJECT thread answers 409 with the `fleet.budgetPaused` message.
12. [integration] The `job.dispatched` activity row written by a PROJECT thread send has `payload.repoId` equal to the anchor repo's id.
13. [integration] Ingesting a `turn_end` cost line for a PROJECT thread's THREAD job writes a cost event whose `featureName` is `thread-<threadId>`.
14. [integration] `POST /api/projects/:slug/threads/:id/messages` on a REPO thread still creates a THREAD `FleetJob` whose `repoId` is the thread's `repoId`.

### US-005: PROJECT ASSIGN and placement (`Workdir: apps/api`)

1. [integration] A PROJECT thread send followed by `POST /api/fleet/runner/sync` from an online protocol-4 runner whose capabilities include `projectThreads: true` and the native model the thread names returns an ASSIGN command whose `payload.thread.kind` is `PROJECT`.
2. [integration] That ASSIGN payload's `thread.feature` is `thread-<threadId>`.
3. [integration] That ASSIGN payload's `repo.owner` and `repo.name` are the anchor repo's.
4. [integration] A REPO thread send followed by the same sync returns an ASSIGN whose `thread.kind` is `REPO`.
5. [integration] That REPO ASSIGN payload's `thread.feature` equals the thread's feature.
6. [integration] A PROJECT thread send while the only online runner has thread backends but no `projectThreads` (the `PlacementService.placeJob` path) leaves the THREAD job `QUEUED`.
7. [integration] A PROJECT thread send with no runner online, followed by `POST /api/fleet/runner/sync` from a protocol-4 runner without `projectThreads` (the `fillRunnerThreads` path), returns no ASSIGN command.
8. [unit] In `placement-rules.spec.ts`, `firstMisfit` for a THREAD job with `thread.kind` `PROJECT` and a runner without `projectThreads` returns `project_threads`.
9. [unit] `firstMisfit` for a THREAD job with `thread.kind` `PROJECT` and a runner with `projectThreads: true`, a matching native model and free thread capacity returns `null`.
10. [unit] `firstMisfit` for a THREAD job with `thread.kind` `REPO` and a runner without `projectThreads` but with a matching native model and free thread capacity returns `null`.
11. [unit] `firstMisfit` for a THREAD job with `thread.kind` `PROJECT` on a runner at protocol 3 returns `protocol`.
12. [unit] `PERMANENT_MISFITS.has('project_threads')` returns `false`.
13. [unit] In `prisma-fleet-job.repository.find-thread-assign.spec.ts`, `findThreadAssign` for a thread row whose `kind` is absent returns `kind` `REPO` and the row's `feature`.

### US-006: Runner no-checkout path for PROJECT threads (`Workdir: apps/runner`)

1. [unit] In `assign-parser-thread.spec.ts`, `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'PROJECT'`, action `SESSION` and a valid `feature` returns `ok: true` with `assign.thread.kind` `PROJECT`.
2. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'PROJECT'` and action `PUBLISH` returns `{ ok: false, detail: 'invalid thread action' }`.
3. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has `kind: 'OTHER'` returns `{ ok: false, detail: 'invalid thread kind' }`.
4. [unit] `parseAssign` on a THREAD ASSIGN whose thread block has no `kind` returns `ok: true` with no `kind` key on `assign.thread`.
5. [unit] The capability report from the nax probe includes `projectThreads: true`.
6. [unit] `threadScratchDir('/home/r', 't1')` returns `/home/r/threads/t1/scratch`.
7. [unit] `buildProjectThreadTools` returns tools whose names are exactly `['load_skill', 'read_skill_file']`.
8. [unit] In `thread-job-run-project.spec.ts`, starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN calls the session opener with `worktree` equal to `threadScratchDir(homeDir, threadId)`.
9. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN calls the session opener with tools whose names are exactly `['load_skill', 'read_skill_file']`.
10. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN never calls `credentials.acquire`.
11. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN never calls the `prepareWorktree` seam.
12. [unit] Starting a `ThreadJobRun` for a PROJECT SESSION ASSIGN creates the directory `threadScratchDir(homeDir, threadId)` before the session opener is called.
13. [unit] `command('THREAD_PUBLISH', {})` on a running PROJECT `ThreadJobRun` returns `{ result: 'rejected', detail: 'not_repo_thread' }`.
14. [unit] Starting a `ThreadJobRun` for a SESSION ASSIGN with no `kind` calls the `prepareWorktree` seam (REPO path unchanged).

### US-007: Web scope picker and PROJECT thread rendering (`Workdir: apps/web`)

1. [unit] `buildThreadCreateSchema(t)` accepts values with `kind: 'PROJECT'`, an empty `repoId`, an empty `feature`, a title, a cost cap and a model.
2. [unit] `buildThreadCreateSchema(t)` rejects values with `kind: 'REPO'` and an empty `repoId` with an issue at path `['repoId']` whose message key is `fleet.threads.new.validation.repoRequired`.
3. [unit] `toCreateThreadBody` for values with `kind: 'PROJECT'` returns a body whose `kind` is `PROJECT` and that has no `repoId`, `feature` or `baseRef` key.
4. [unit] `toCreateThreadBody` for values with `kind: 'REPO'` returns a body whose `kind` is `REPO`.
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
