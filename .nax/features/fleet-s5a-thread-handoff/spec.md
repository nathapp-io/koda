<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5a-C2 — Thread Handoff on the API (Publish, Discard, Plan, Run)

## Summary

The koda API lets the creator of a brainstorm thread turn the thread's written documents into a feature: **Publish**
commits the allowlisted docs the agent wrote onto `feat/<feature>` in the runner's clone, **Discard** throws away
unpublished changes when a session started stale, **Plan** dispatches a `PLAN` job on that branch pinned to the thread's
runner, and **Run** dispatches the `RUN` job after the plan completed. The API folds the runner's new thread stream lines
(`write_doc`, `published`, `publish_failed`, `discarded`, `discard_failed`, `session_started.stale`) into three new
`ChatThread` columns and one result snapshot, keeps at most one active job per thread, sends the thread title in the
ASSIGN, accepts the runner's `threadWrite` capability, and tells the agent about `write_doc`. One runner story adds the
PLAN `expectBranch` check (`branch_mismatch`) and makes a thread PLAN start from the runner's local branch.

This is feature C2 of fleet S5a phase C (umbrella `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md`
§2.1, §5, §8). C1 `fleet-s5a-thread-write` (runner write path, koda #268 `7e6a8c38`) is merged; C3 (web action bar,
Discard banner, commit markers, PLAN / RUN cards) follows.

## Motivation

C1 gave the runner `write_doc`, Publish, stale start and Discard, but nothing reaches them: the deployed API never queues
`THREAD_PUBLISH` or a `PUBLISH` / `DISCARD` job, its stream parser counts the five new line types as bad lines, its
capability parser drops `threadWrite`, and `buildThreadInstructions` still tells the agent "You cannot write files in
this session". A thread therefore ends with a spec draft in a chat reply that the user must copy by hand into a branch
before dispatching PLAN and RUN from the dispatch form. C2 closes the loop on the API so that C3 only adds buttons.

## Design

### Rulings that bind every story

- **C2-R1 (user, 2026-10-13):** C2 is one feature (API plus one runner story); the PLAN branch check is a runner
  change carried by an optional ASSIGN field `expectBranch` that older runners ignore.
- **C2-D1:** write-path results live in a new `ChatThread.lastWrite` JSON column, not in the session snapshot: the next
  `session_started` overwrites the snapshot and `PUBLISH` / `DISCARD` jobs open no session. `stale` is session state and
  lives on the session snapshot as an optional `stale: true` key.
- **C2-D2:** the one-active-job rule (umbrella §5.1) counts every non-terminal `FleetJob` with the thread's `threadId`
  (`THREAD` of any action, `PLAN`, `RUN`). For `PLAN` / `RUN` the check runs inside `FleetJobsService.dispatch`'s
  transaction, right before `createJob`, under a `ChatThread` row lock, so two concurrent requests cannot both pass.
- **C2-D3:** a `PUBLISH` or `DISCARD` job spends nothing and needs no model, so placement skips the backend check for it
  and instead requires `threadWrite`. `thread_write` is not a permanent misfit (a runner restart or re-probe clears it).
- **C2-D4:** the terminal hook (`ThreadJobEffects.onJobEnded`) is unchanged: `closeSnapshot` only touches a session whose
  `jobId` is the ending job, and a `PUBLISH` / `DISCARD` job never starts a session. US-003 pins this with one AC.
- **C2-D5:** Publish on a live session sends `THREAD_PUBLISH` and is allowed with an empty `writtenPaths` (the runner
  computes the real dirty set and answers `published` with `paths: []` when nothing changed). Publish without a live
  session creates a `PUBLISH` job only when `writtenPaths` is non-empty.
- **C2-D6:** a thread's `PLAN` and `RUN` use `ref = feat/<feature>`, `feature = <thread feature>`,
  `pinnedRunnerId = thread.runnerId` and `threadId`; `PLAN` adds `planFrom = specPath`. The ASSIGN of a `PLAN` with a
  `threadId` carries `expectBranch` equal to the job's `ref`.

### Integration

Read-only symbols (verified on `feat/fleet-s5a-thread-handoff` = main `7e6a8c38`):

- `ThreadAction` (`'SESSION' | 'PUBLISH' | 'DISCARD'`), `ThreadAssign.title?`, `ThreadRunnerLine`,
  `ThreadPublishFailReason`, `ThreadDiscardFailReason`, `RunnerCapabilities.threadWrite?` —
  `packages/fleet-protocol/src/threads.ts` and `src/index.ts` (added by C1). The API re-exports them from
  `apps/api/src/fleet/common/thread-jobs.ts` and `common/protocol.ts`.
- `FleetCommandType.THREAD_PUBLISH` exists (`thread-jobs.ts` `THREAD_COMMAND_TYPES`).
- `ACTIVE_STATES` / `TERMINAL_STATES` — `apps/api/src/fleet/jobs/job-state.ts:8,11`.
- `allocateThreadSeq`, `ChatThreadRepository` — `threads/domain/chat-thread.domain.ts`.
- `ConflictAppException(params, key)` — `apps/api/src/common/exceptions/conflict-app.exception.ts`; 409 keys live in
  `apps/api/src/i18n/en/threads.json` as `{ "<key>": { "409": "<text>" } }`.
- `isRunnerOnline` — `fleet/common/runner-online.ts`; `THREAD_MIN_PROTOCOL_VERSION = 4` — `threads/thread-send-rules.ts`.
- `PlacementService.placeJob(jobId)` and its `assignOne` path (`jobs/placement.service.ts:85,160,188-196`), which
  builds the `PlacementJob` from `findThreadAssign` and the ASSIGN with `buildAssignPayload`.
- `CommandAckProcessor` routes `THREAD_INPUT` / `THREAD_ANSWER` acks to `ThreadJobEffects.onInputAck`
  (`fleet/sync/command-ack.processor.ts:68-69`).
- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`jobs/fleet-jobs.service.ts:63`): validates, pins,
  budget-gates, then in `txManager.run` calls `repo.createJob`, maps `DuplicateActiveJobError` to 409 `fleet.jobs`.
- Runner: `prepareCheckout` (`apps/runner/src/executor/checkout.ts:17`), `resolveRef` (`executor/refs.ts:11`),
  `HostExecutor.readPlan` / `finishPlan` (`executor/host-executor.ts:201,217`; `finishPlan` already refuses to push when
  `readPlan` is not ok), `planVerdict` (`verdict/plan-verdict.ts:19`), called from `supervisor/job-run.ts:412-414`.

Symbols this feature changes. The baseline only locates the code; implement the target.

| Symbol | Baseline | Target |
|---|---|---|
| `ChatThread` (`apps/api/prisma/schema.prisma:1057`) | no write-path columns | adds `writtenPaths String[] @default([])`, `publishedSha String?`, `specPublished Boolean @default(false)`, `lastWrite Json?` (US-001) |
| `ChatThreadRecord` / `ThreadDto` | no write-path fields | add `writtenPaths: string[]`, `publishedSha: string \| null`, `specPublished: boolean`, `lastWrite: ThreadWriteResult \| null` (US-001); `ChatThreadDetail` / `ThreadDetailDto` add `handoff` (US-006) |
| `ThreadSession` (`chat-thread.domain.ts:16`) | six keys | adds optional `stale?: true` (US-002) |
| `parseCapabilitiesCore` (`common/capabilities-core.ts:118`) | drops `threadWrite` | keeps `threadWrite: true`, rejects any other value (US-001) |
| `PlacementJob.thread` (`jobs/placement-rules.ts:32`) | `{ backend; enabled }` | `{ backend; enabled; action: ThreadAction }` (US-001) |
| `MisfitReason` / `firstMisfit` (`placement-rules.ts:10,101`) | thread branch checks backend for every THREAD job | adds `'thread_write'`; `PUBLISH` / `DISCARD` skip the backend check and require `threadWrite` (US-001) |
| `findThreadAssign` (`jobs/prisma-fleet-job.repository.ts:192`) | no `title` | returns `title` from `ChatThread.title` (US-001) |
| `parseThreadLine` (`threads/ingest/thread-line.ts:78`) | five C1 line types are `{ bad: true }`; `session_started.stale` dropped | parses all five and `stale` (US-002) |
| `PrismaThreadIngestRepository.fold` (`ingest/prisma-thread-ingest.repository.ts:69`) | session, tool, assistant, usage lines | also folds the five write-path lines through new `ingest/thread-write-fold.ts` (US-002) |
| `ThreadJobEffects.onInputAck` (`threads/thread-job-effects.ts:25`) | `THREAD_INPUT`, `THREAD_ANSWER` | also `THREAD_PUBLISH` (US-004); `CommandAckProcessor` routes it there |
| `PrismaChatThreadRepository.sendMessage` (`threads/prisma-chat-thread.repository.ts:153`) | creates the THREAD job inline | job creation moves to a private `createThreadJob`; refuses `threads.busy` when a `PLAN`, `RUN`, `PUBLISH` or `DISCARD` job of the thread is active (US-003) |
| `buildThreadInstructions` (`threads/thread-instructions.ts:3`) | "You cannot write files in this session." | describes `write_doc` and Publish (US-004) |
| `FleetJobsService.dispatch` opts | `{ scheduleId?, ticketActor? }` | adds `threadId?: string` (US-006) |
| `buildAssignPayload` (`jobs/assign-payload.ts`) | no `expectBranch` | `PLAN` with `threadId` adds `expectBranch: job.ref` (US-006) |
| `AssignPayload` (`packages/fleet-protocol/src/index.ts:230`) | no `expectBranch` | adds `expectBranch?: string` (US-005) |
| `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts`) | no `expectBranch` | accepts it on `PLAN` only (US-005) |
| `checkPlanPrd` (`apps/runner/src/verdict/plan-verdict.ts:11`) | `(text)` | `(text, expectBranch?)`; a mismatch is `{ ok: false, reason: 'branch_mismatch' }` (US-005) |
| `prepareCheckout` (`apps/runner/src/executor/checkout.ts:17`) | `PLAN` detaches at `resolveRef(ref)` (origin first) | `PLAN` with `expectBranch` detaches at the local `refs/heads/<expectBranch>` when it exists (US-005) |

### Data (US-001)

Migration `apps/api/prisma/migrations/20261015090000_thread_handoff/migration.sql`:

```sql
ALTER TABLE "ChatThread" ADD COLUMN "writtenPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ChatThread" ADD COLUMN "publishedSha" TEXT;
ALTER TABLE "ChatThread" ADD COLUMN "specPublished" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatThread" ADD COLUMN "lastWrite" JSONB;
```

`ThreadWriteResult` (in `chat-thread.domain.ts`, also the `lastWrite` JSON shape):

```ts
export type ThreadWriteResult =
  | { kind: 'published'; jobId: string; at: string; sha: string; paths: string[]; ignored: string[] }
  | { kind: 'publish_failed'; jobId: string; at: string; reason: string }
  | { kind: 'discarded'; jobId: string; at: string; sha: string }
  | { kind: 'discard_failed'; jobId: string; at: string; reason: string };
```

### Capability and placement (US-001)

- `parseCapabilitiesCore`: `threadWrite` absent -> absent from the result; `true` -> `threadWrite: true`; any other value
  -> `CapabilityValidationError` with reason `threadWrite` (strict, like `configJobs`).
- `PlacementService` passes `action: threadAssign.action` into `PlacementJob.thread` at both call sites.
- `firstMisfit` thread branch, in order: `threads_disabled`, `protocol`, then for `action` `PUBLISH` / `DISCARD`:
  `!runner.capabilities.threadWrite` -> `thread_write` (no backend check); for `SESSION`: the existing backend check;
  then `thread_capacity` for every action.

### Ingest (US-002)

New parsed line types in `thread-line.ts` (each with optional `at`, kept like the session lines):

| Line | Valid when | Parsed |
|---|---|---|
| `write_doc` | `path` non-empty string of at most 512 characters, `bytes` integer >= 0 | `{ type, at?, path, bytes }` |
| `published` | `sha` 40 or 64 lowercase hex, `paths` and `ignored` arrays of at most 200 strings of 1..512 characters, `specPresent` boolean | `{ type, at?, sha, paths, ignored, specPresent }` |
| `publish_failed` | `reason` non-empty string of at most 64 characters | `{ type, at?, reason }` |
| `discarded` | `tipSha` 40 or 64 lowercase hex | `{ type, at?, tipSha }` |
| `discard_failed` | `reason` non-empty string of at most 64 characters | `{ type, at?, reason }` |
| `session_started` | as today; `stale` absent or `true` (any other value -> bad) | adds `stale: true` only when the line has it |

Fold (new `ingest/thread-write-fold.ts`, called from `fold` under the existing job and thread locks; `at` = the line's
`at` or the fold's clock, `jobId` = the batch's job). Every write-path line marks the thread changed, so the fold emits
the existing `thread` live event:

| Line | `ChatThread` update |
|---|---|
| `write_doc` | append `path` to `writtenPaths` unless already present; when `writtenPaths` already holds 200 entries the path is not added |
| `published` | `publishedSha = sha`, `specPublished = specPresent`, `writtenPaths = []`, `lastWrite = { kind: 'published', jobId, at, sha, paths, ignored }` |
| `publish_failed` | `lastWrite = { kind: 'publish_failed', jobId, at, reason }`; `writtenPaths` unchanged |
| `discarded` | `writtenPaths = []`, `lastWrite = { kind: 'discarded', jobId, at, sha: tipSha }`, and the stored session loses its `stale` key when it has one |
| `discard_failed` | `lastWrite = { kind: 'discard_failed', jobId, at, reason }` |

`foldSessionLine` writes `stale: true` into the stored session only when the `session_started` line has it.

A `THREAD_PUBLISH` ack (US-004) with result `rejected` sets `lastWrite = { kind: 'publish_failed', jobId: command.jobId, at: <now>,
reason: <ack detail, at most 64 characters> }`; an `ok` ack writes nothing (the `published` line follows on the stream).

### One active job per thread and Publish (US-003)

`activeThreadJob(threadId)` (repository, private to the module): the latest (`queuedAt desc, id desc`) `FleetJob` with
that `threadId` and a state in `ACTIVE_STATES`, any command, with its `FleetThreadTurn.action` (null for `PLAN` / `RUN`).

`sendMessage` additionally refuses 409 `threads.busy` after `sendRefusal` passes, when `activeThreadJob` is a `PLAN` or
`RUN`, or a `THREAD` job whose action is `PUBLISH` or `DISCARD`.

`POST /projects/:slug/threads/:id/publish` (creator, users only, 200, body `{}`, returns `{ jobId: string | null }`).
Inside `txManager.run`, after the same job-then-thread locks as `sendMessage`, the checks run in this order:

1. thread missing -> 404 `threads.notFound`; caller not the creator -> 403 `threads.notCreator`;
2. `threadsEnabled` false -> 409 `threads.disabled`; `status = ARCHIVED` -> 409 `threads.archived`;
3. `thread.runnerId` null -> 409 `threads.nothingToPublish`;
4. runner offline -> 409 `threads.runnerOffline`; runner `protocolVersion < 4` or no `capabilities.threadWrite` -> 409
   `threads.runnerOutdated`;
5. active job is a `THREAD` `SESSION` job: `UPLOADING` or a `THREAD_CLOSE` queued at its epoch -> 409 `threads.closing`;
   `QUEUED` / `ASSIGNED`, or a message of the thread `pending` / `streaming` -> 409 `threads.turnRunning`; otherwise
   (`RUNNING`, idle) queue `THREAD_PUBLISH` with payload `{}` at the job's `leaseEpoch`, notify the runner after commit,
   return `{ jobId: null }`;
6. any other active job -> 409 `threads.busy`;
7. no active job: `writtenPaths` empty -> 409 `threads.nothingToPublish`; otherwise `createThreadJob(thread, 'PUBLISH')`,
   place it after commit, return `{ jobId }`.

`createThreadJob(thread, action, message?)` (private, extracted from `sendMessage`) creates the `THREAD` job with the
values `sendMessage` uses today (`feature: thread-<id>`, `ref: baseRef`, `pinnedRunnerId: thread.runnerId`, remaining cap
as `maxCostUsd`, `bashMode: raw`), its `FleetThreadTurn` (`action`, `initialMessageId: message?.id ?? null`,
`resume: action === 'SESSION' && <previous THREAD job exists>`, `instructions` from `buildThreadInstructions`,
`backend`, `skills`), the `QUEUED` state event and the `job.dispatched` activity, and maps `DuplicateActiveJobError` to
409 `threads.busy` for `PUBLISH` / `DISCARD` and `threads.turnRunning` for `SESSION` (today's mapping).

### i18n

Every new 409 key is added to both `apps/api/src/i18n/en/threads.json` and `apps/api/src/i18n/zh/threads.json` in the
story that first throws it: `busy` and `nothingToPublish` (US-003), `nothingToDiscard` (US-004), `notPublished`
(US-006), `notPlanned` (US-007). English texts: `busy` "Another job of this thread is still active",
`nothingToPublish` "Thread has nothing to publish", `nothingToDiscard` "Thread has nothing to discard",
`notPublished` "Publish the thread's spec before planning", `notPlanned` "The thread's latest plan has not completed".

### Discard and instructions (US-004)

`POST /projects/:slug/threads/:id/discard` (creator, users only, 200, body `{}`, returns `{ jobId: string }`). Same
locks; checks in order: 404 / 403 as Publish; `threads.disabled`; `threads.archived`; `thread.runnerId` null -> 409
`threads.nothingToDiscard`; `threads.runnerOffline`; `threads.runnerOutdated` (as Publish step 4); any active job of the
thread, including a live session -> 409 `threads.busy`; otherwise `createThreadJob(thread, 'DISCARD')`, place it after
commit, return `{ jobId }`.

`buildThreadInstructions` replaces step 2's "You cannot write files in this session. Put the spec draft in your reply."
and the tools line's "no write access" with:

- step 2: `When the person agrees the intent is settled, call load_skill with "spec-writing" if it is listed below and
  follow it. Write the spec to <specPath> with write_doc.`
- a new line after the tools line: `write_doc writes Markdown (.md) files under docs/ and .nax/features/<feature>/ only.
  Nothing is committed until the person presses Publish; tell them when a draft is ready to publish.`
- the tools line becomes: `Tools: list_files and search_repo find files and text; read files with your read tool;
  write_doc writes docs. You have no shell and no web access.`

### Runner PLAN branch (US-005)

- `AssignPayload.expectBranch?: string` — "PLAN only: the branch the PRD must name (a thread PLAN)".
- `parseAssign`: `expectBranch` present on a non-`PLAN` job -> `invalid expectBranch`; on a `PLAN` it must pass the same
  `plain(..., 255)` rule as `ref` (else `invalid expectBranch`) and is copied; absent -> the parsed assign has no
  `expectBranch` key.
- `checkPlanPrd(text, expectBranch?)`: after the existing checks, when `expectBranch` is given and `prd.branchName !==
  expectBranch`, the result is `{ ok: false, reason: 'branch_mismatch', branchName: prd.branchName }`.
- `HostExecutor.readPlan(job)` passes `job.assign.expectBranch`, so `planVerdict` ends the job `FAILED` with reason
  `branch_mismatch` and `finishPlan` pushes nothing (its existing `!check.ok` refusal).
- `prepareCheckout` for a `PLAN` with `expectBranch`: when `refs/heads/<expectBranch>` exists in the clone, the checkout
  detaches at that local commit (a thread's re-published docs are ahead of `origin/<branch>` after the first PLAN pushed);
  otherwise the existing `resolveRef(assign.ref)` path. The `.nax` check applies to whichever commit is chosen.

### Plan and Run (US-006, US-007)

`POST /projects/:slug/threads/:id/plan` (creator, users only, 201, body `PlanThreadDto { profiles?: string[];
maxCostUsd?: string }`, returns `DispatchResultDto`). `ThreadsService.plan` checks in order: 404 / 403; `threads.disabled`;
`threads.archived`; `specPublished` false -> 409 `threads.notPublished`; then calls `FleetJobsService.dispatch(userId,
projectId, { repoId, command: 'PLAN', ref: 'feat/<feature>', feature, planFrom: specPath, profiles, maxCostUsd,
pinnedRunnerId: thread.runnerId }, { threadId })`. The DTO validation mirrors `DispatchFleetJobDto` for `profiles`
(at most 8 strings of at most 64 characters) and `maxCostUsd`.

`POST /projects/:slug/threads/:id/run` (creator, users only, 201, body `RunThreadDto { profiles?; maxCostUsd?;
bashMode?: 'raw' | 'gated' | 'escalate' }`). `ThreadsService.run` checks in order: 404 / 403; `threads.disabled`;
`threads.archived`; the thread's latest `PLAN` job is missing or not `COMPLETED` -> 409 `threads.notPlanned`; then
`dispatch(..., { repoId, command: 'RUN', ref: 'feat/<feature>', feature, profiles, maxCostUsd, bashMode,
pinnedRunnerId: thread.runnerId }, { threadId })`.

`FleetJobsService.dispatch` with `opts.threadId`: the created job carries `threadId`; inside the existing transaction,
before `createJob`, the repository method `lockIdleThread(threadId)` runs `SELECT ... FROM "ChatThread" WHERE id = $1
FOR UPDATE` and counts `FleetJob` rows with that `threadId` in `ACTIVE_STATES`; a count above 0 -> 409 `threads.busy`.
A `DuplicateActiveJobError` with `opts.threadId` set -> 409 `threads.busy` (instead of `fleet.jobs`).

`buildAssignPayload`: a `PLAN` job with a non-null `threadId` gets `expectBranch: job.ref`; every other job has no
`expectBranch` key.

`ChatThreadDetail.handoff: { plan: ThreadHandoffJob | null; run: ThreadHandoffJob | null }`, where
`ThreadHandoffJob = { jobId: string; state: string; stateReason: string | null }` is the thread's latest (`queuedAt desc,
id desc`) job of that command. `GET /projects/:slug/threads/:id` returns it.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| `threadWrite` reported as a non-`true` value | capability report rejected (`CapabilityValidationError` `threadWrite`) | US-001 |
| `PUBLISH` / `DISCARD` job, runner without `threadWrite` | misfit `thread_write`, job stays `QUEUED` | US-001 |
| malformed write-path line | bad line, counted in `skippedLines`, nothing folded | US-002 |
| `write_doc` beyond 200 distinct paths | path not added to `writtenPaths` | US-002 |
| `THREAD_PUBLISH` acked `rejected` | `lastWrite` `publish_failed` with the ack detail | US-004 |
| Send while a `PLAN` / `RUN` / `PUBLISH` / `DISCARD` job is active | 409 `threads.busy` | US-003 |
| Publish with no runner, or no live session and empty `writtenPaths` | 409 `threads.nothingToPublish` | US-003 |
| Publish during a turn, or before the session is running | 409 `threads.turnRunning` | US-003 |
| Publish while the session closes | 409 `threads.closing` | US-003 |
| Publish / Discard on a runner that is offline | 409 `threads.runnerOffline` | US-003, US-004 |
| Publish / Discard on a runner without `threadWrite` | 409 `threads.runnerOutdated` | US-003, US-004 |
| Publish while a `PLAN` / `RUN` / action job is active | 409 `threads.busy` | US-003 |
| Discard with no runner | 409 `threads.nothingToDiscard` | US-004 |
| Discard with any active job, including a live session | 409 `threads.busy` | US-004 |
| `expectBranch` on a non-`PLAN` ASSIGN | `invalid expectBranch` | US-005 |
| PRD `branchName` differs from `expectBranch` | job `FAILED` `branch_mismatch`, nothing pushed | US-005 |
| Plan before a publish that contained the spec | 409 `threads.notPublished` | US-006 |
| Plan / Run while a job of the thread is active (also two concurrent requests) | 409 `threads.busy` | US-006, US-007 |
| Run without a `COMPLETED` latest PLAN | 409 `threads.notPlanned` | US-007 |
| Any write route by a non-creator | 403 `threads.notCreator` | US-003, US-004, US-006 |

## Out of Scope

- The web side of phase C (action bar, Discard banner, commit markers, PLAN / RUN cards) belongs to feature C3.
- ACP thread backends belong to phase D; nothing in C2 depends on the backend kind.
- The API never pushes or reads git; the runner commits on Publish and the thread's PLAN pushes `feat/<feature>`.
- `FLEET_PROTOCOL_VERSION` stays 4; `expectBranch` is optional and an older runner ignores it (no `branch_mismatch`).
- Base-ref drift is not rebased and a thread cannot move to another runner.
- A rejected `THREAD_PUBLISH` ack writes `lastWrite` but emits no live event; the page sees it on its next thread
  refetch.
- `RunnerSummaryDto` does not expose `threadWrite`; the write routes answer `threads.runnerOutdated` instead.
- Publish and Discard spend nothing, so they pass no `BudgetGate` check; Plan and Run keep `dispatch`'s budget gate.
- A `PUBLISH` or `DISCARD` job re-adopted after a daemon restart ends `FAILED` (C1 behaviour); the API folds nothing for it.
- The runner `context.md` and the API `context.md` are updated by hand after merge.
- US-002 only: an `at` that is not an ISO date on a write-path line, a `published.paths` entry over 512 characters, a
  64-hex `sha`, a malformed `publish_failed` / `discarded` line, the `discard_failed` line (parsed and folded like
  `publish_failed`), `writtenPaths` left unchanged by `publish_failed`, and a `session_started` without `stale` storing
  no `stale` key (already pinned by the existing fold tests) share the Design tables without a dedicated acceptance
  criterion.
- US-003 only: the `{ jobId: null }` body of a live Publish and the `{ jobId }` body of a `PUBLISH` job, the job's
  `threadId` and `pinnedRunnerId` (set by the extracted `createThreadJob` exactly as `sendMessage` sets them today), a
  refused request creating no command or job, and 403 `threads.principal` for an agent API key (the controller's
  existing `assertUser`) share the Design rules without a dedicated acceptance criterion.
- US-003 only: the job-then-thread lock order, the retry when the current job changes between the pre-lock read and the
  lock (as `sendMessage` retries today), and the `job.dispatched` activity row of a `PUBLISH` job share `sendMessage`'s
  existing behaviour without a dedicated acceptance criterion.
- US-004 only: `threads.disabled`, `threads.archived` and `threads.runnerOffline` on Discard follow Publish's checks
  (pinned in US-003), and an ack `detail` longer than 64 characters is cut to 64, without a dedicated acceptance
  criterion.
- US-005 only: `expectBranch` failing the `plain` rule on a `PLAN`, the `.nax` check on the local commit, and
  `planVerdict` turning the `branch_mismatch` check into `FAILED` (its existing `!ok` path) share the rules in Design
  without a dedicated acceptance criterion.
- US-006 only: the losing request of two concurrent Plans answering 409 `threads.busy`, a `DuplicateActiveJobError`
  under `opts.threadId` mapping to `threads.busy`, `threads.disabled` and `threads.archived` on Plan, the `profiles` / `maxCostUsd` DTO bounds and
  `dispatch`'s budget gate share existing behaviour without a dedicated acceptance criterion.
- US-007 only: Run's `bashMode` validation and `threads.disabled` / `threads.archived` share Plan's rules without a
  dedicated acceptance criterion.

## Stories

1. **US-001: Write-path columns, `threadWrite` capability and placement, ASSIGN title** — `Workdir: apps/api` — no
   dependencies.
2. **US-002: Ingest the write-path lines** — `Workdir: apps/api` — depends on US-001.
3. **US-003: One active job per thread and Publish** — `Workdir: apps/api` — depends on US-001.
4. **US-004: Discard, the publish ack and the `write_doc` instructions** — `Workdir: apps/api` — depends on US-003.
5. **US-005: Runner PLAN `expectBranch`** — `Workdir: apps/runner` — no dependencies.
6. **US-006: Plan from a thread** — `Workdir: apps/api` — depends on US-003, US-005.
7. **US-007: Run from a thread** — `Workdir: apps/api` — depends on US-006.

US-005 also edits `packages/fleet-protocol/src/index.ts`. Build gate for every story: `bun run type-check` and
`bun run lint` in its Workdir; US-001 also `bunx prisma validate` and `bun run db:generate` in `apps/api`; US-005
also `bun run type-check` at the repo root. US-003, US-004, US-006 and US-007 add routes, so they regenerate `openapi.json` with
`bun run api:export-spec` at the repo root. API DB-backed specs need `bun run test:db:up` and `KODA_DB_TESTS=1`.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma` — `ChatThread` model at line 1057.
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseCapabilitiesCore`, the `configJobs` strict pattern.
- `apps/api/src/fleet/jobs/placement-rules.ts` — `PlacementJob`, `MisfitReason`, `firstMisfit` thread branch.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `mapThread`.

**US-002**
- `apps/api/src/fleet/threads/ingest/thread-line.ts` — `parseThreadLine`, `sessionLine`.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — `fold`, `foldSessionLine`.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.spec.ts` — the fold test harness to extend.

**US-003**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `sendMessage`, `command`, `currentThreadJob`.
- `apps/api/src/fleet/threads/threads.controller.ts` — route, guard and `assertUser` pattern.
- `apps/api/src/fleet/threads/threads.service.ts` — `endSession` / `sendMessage` delegation.
- `apps/api/src/fleet/threads/thread-send-rules.ts` — `sendRefusal`, `THREAD_MIN_PROTOCOL_VERSION`.
- `apps/api/test/e2e/fleet/thread-send-guards.e2e.spec.ts` — e2e harness for thread routes with a scripted runner.

**US-004**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `createThreadJob` and `publish` (created by US-003, extended here).
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildThreadInstructions`.
- `apps/api/src/fleet/threads/thread-job-effects.ts` — `onInputAck`.
- `apps/api/src/fleet/sync/command-ack.processor.ts` — the THREAD ack routing at line 68.

**US-005**
- `packages/fleet-protocol/src/index.ts` — `AssignPayload`.
- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign` base fields.
- `apps/runner/src/verdict/plan-verdict.ts` — `checkPlanPrd`, `planVerdict`.
- `apps/runner/src/executor/checkout.ts` — `prepareCheckout`.
- `apps/runner/src/executor/host-executor.ts` — `readPlan`, `finishPlan`.

**US-006**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `createJob`, transaction helpers.
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`.
- `apps/api/src/fleet/threads/threads.service.ts` — `get`, where the detail is assembled.
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — validation decorators to mirror.

**US-007**
- `apps/api/src/fleet/threads/threads.service.ts` — `plan` (created by US-006), the pattern to mirror.
- `apps/api/src/fleet/threads/threads.controller.ts` — the plan route added by US-006.

### Creates

**US-001**
- `apps/api/prisma/migrations/20261015090000_thread_handoff/migration.sql`

**US-002**
- `apps/api/src/fleet/threads/ingest/thread-write-fold.ts`
- `apps/api/src/fleet/threads/ingest/thread-write-fold.spec.ts`

**US-003**
- `apps/api/test/integration/fleet/thread-publish.integration.spec.ts`

**US-004**
- `apps/api/test/integration/fleet/thread-discard.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/threads/dto/thread-handoff.dto.ts`
- `apps/api/test/integration/fleet/thread-plan-run.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/threads/threads.service.spec.ts` — its `record` fixture is a full `ChatThreadRecord` compared with `toEqual`; the fixture gains `writtenPaths: []`, `publishedSha: null`, `specPublished: false`, `lastWrite: null`, and the assertions stay.

**US-002**
None. The existing parser and fold tests never feed a write-path line or a `stale` key, and the parsed `session_started` line gains `stale` only when the input has it, so their `toEqual` assertions stay valid.

**US-003**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the project rule requires every endpoint change here: add the publish route's happy path (a `PUBLISH` job queued) and one refusal (`threads.nothingToPublish`) to the threads block; existing tests are unchanged.

**US-004**
- `apps/api/src/fleet/threads/thread-instructions.spec.ts` — AC3 asserts the text `Put the spec draft in your reply.`, which this story removes; replace it with an assertion that the instructions name `write_doc` and the spec path, and keep AC1, AC2 and AC4.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the discard route's happy path and one refusal (`threads.busy`) to the threads block; existing tests are unchanged.

**US-005**
None. `checkPlanPrd`'s new parameter is optional and the parsed assign gains `expectBranch` only when the ASSIGN has it, so the existing `verdict.spec.ts`, `job-run.spec.ts` and assign-parser tests stay valid.

**US-006**
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the `ThreadDetailDto` assertion uses `toContain`, so it stays; add `handoff` to it. The runner summary key list at line 41 is unchanged because `threadWrite` is not exposed.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the plan route's happy path (201, job `PLAN` with `threadId`) and `threads.notPublished` to the threads block; existing tests are unchanged.

**US-007**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the run route's `threads.notPlanned` refusal and its happy path after a `COMPLETED` PLAN to the threads block; existing tests are unchanged.

### Seams

- US-001 -> US-003, US-004: `capabilities.threadWrite` as stored by `parseCapabilitiesCore` decides `threads.runnerOutdated`
  on Publish and Discard (US-003 AC-6, US-004 AC-4) and the `thread_write` misfit of their jobs (US-001 AC-7).
- US-001 -> US-002: the `writtenPaths` / `publishedSha` / `specPublished` / `lastWrite` columns the fold writes.
- US-002 -> US-006: `specPublished`, set by the `published` fold, gates Plan (US-006 AC-2, AC-3).
- US-003 -> US-004: `createThreadJob` creates the `DISCARD` job (US-004 AC-1), reached through `POST .../discard`.
- US-003 -> US-006, US-007: `threads.busy` on Send during a thread `PLAN` / `RUN` (US-003 AC-2).
- US-005 -> US-006: `AssignPayload.expectBranch`, set by `buildAssignPayload` for a thread PLAN (US-006 AC-9, AC-10).
- US-006 -> US-007: `handoff.plan` and `dispatch`'s `{ threadId }` option, reused by Run (US-007 AC-2, AC-5).

## Acceptance Criteria

### US-001: Write-path columns, `threadWrite` capability and placement, ASSIGN title

- AC-1 [integration]: a `ChatThread` created through `PrismaChatThreadRepository.create` reads back with
  `{ writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null }` as its write-path fields.
- AC-2 [integration]: `ChatThread.lastWrite` written as `{ kind: 'published', jobId: 'j1', at:
  '2026-10-15T00:00:00.000Z', sha: <40 hex>, paths: ['docs/a.md'], ignored: [] }` reads back equal to that object.
- AC-3 [unit]: `parseCapabilitiesCore` given a valid report with `threadWrite: true` returns an object whose
  `threadWrite` is `true`.
- AC-4 [unit]: `parseCapabilitiesCore` given a valid report without `threadWrite` returns an object with no
  `threadWrite` key.
- AC-5 [unit]: `parseCapabilitiesCore` given a valid report with `threadWrite: false` throws `CapabilityValidationError`
  whose reason is `threadWrite`.
- AC-6 [unit]: `parseCapabilitiesCore` given a valid report with `threadWrite: 'yes'` throws `CapabilityValidationError`
  whose reason is `threadWrite`.
- AC-7 [unit]: `firstMisfit` for a `THREAD` job with `thread.action` `PUBLISH`, on an online protocol-4 runner whose
  capabilities have no `threadWrite`, returns `'thread_write'`.
- AC-8 [unit]: `firstMisfit` for a `THREAD` job with `thread.action` `DISCARD`, on an online protocol-4 runner with
  `threadWrite: true`, an empty `threadBackends.native` list and free thread capacity, returns null.
- AC-9 [unit]: `firstMisfit` for a `THREAD` job with `thread.action` `SESSION`, on a runner with `threadWrite: true` and
  an empty `threadBackends.native` list, returns `'thread_backend'`.
- AC-10 [unit]: `firstMisfit` for a `THREAD` job with `thread.action` `PUBLISH`, on a runner with `threadWrite: true`
  whose thread load equals its `threadCapacity`, returns `'thread_capacity'`.
- AC-11 [unit]: `PERMANENT_MISFITS.has('thread_write')` returns false.
- AC-12 [integration]: `PlacementService.placeJob` for a queued `THREAD` job whose `FleetThreadTurn.action` is
  `PUBLISH`, pinned to a runner without `threadWrite`, returns misfits that map that runner to `thread_write`.
- AC-13 [integration]: `findThreadAssign` for a job whose thread has title `Add auth` returns a `ThreadAssign` whose
  `title` is `Add auth`.
- AC-14 [integration]: `GET /projects/:slug/threads/:id` for a thread row with `writtenPaths ['docs/a.md']`,
  `publishedSha` S, `specPublished` true and a `lastWrite` object returns those four values unchanged.

### US-002: Ingest the write-path lines

- AC-1 [unit]: `parseThreadLine('{"type":"write_doc","path":"docs/a.md","bytes":12}')` returns
  `{ type: 'write_doc', path: 'docs/a.md', bytes: 12 }`.
- AC-2 [unit]: `parseThreadLine` of a `write_doc` line with `bytes: -1` returns `{ bad: true }`.
- AC-3 [unit]: `parseThreadLine` of a `published` line with a 40-hex `sha` S, `paths: ['docs/a.md']`, `ignored: []` and
  `specPresent: true` returns `{ type: 'published', sha: S, paths: ['docs/a.md'], ignored: [], specPresent: true }`.
- AC-4 [unit]: `parseThreadLine` of a `published` line whose `sha` is `xyz` returns `{ bad: true }`.
- AC-5 [unit]: `parseThreadLine('{"type":"publish_failed","reason":"branch_moved"}')` returns
  `{ type: 'publish_failed', reason: 'branch_moved' }`.
- AC-6 [unit]: `parseThreadLine` of a `discarded` line with a 40-hex `tipSha` T returns `{ type: 'discarded', tipSha: T }`.
- AC-7 [unit]: `parseThreadLine` of a `session_started` line with `resumed: false` and `stale: true` returns a line whose
  `stale` is `true`.
- AC-8 [unit]: `parseThreadLine` of a `session_started` line with `resumed: false` and `stale: false` returns
  `{ bad: true }`.
- AC-9 [integration]: folding two `write_doc` lines for `docs/a.md` and one for `docs/b.md` leaves the thread's
  `writtenPaths` equal to `['docs/a.md', 'docs/b.md']`.
- AC-10 [unit]: `foldWriteLine` for a `write_doc` line on a thread whose `writtenPaths` already holds 200 entries
  leaves `writtenPaths` equal to those 200 entries.
- AC-11 [integration]: folding a `published` line with `sha` S, `specPresent: true`, `paths: ['docs/a.md']` and
  `ignored: []` on a thread with `writtenPaths ['docs/a.md']` leaves the thread with `{ publishedSha: S, specPublished:
  true, writtenPaths: [], lastWrite: { kind: 'published', jobId: <batch job>, at: <line at>, sha: S, paths:
  ['docs/a.md'], ignored: [] } }`.
- AC-12 [integration]: folding a `publish_failed` line with reason `branch_moved` and `at` A sets the thread's
  `lastWrite` to `{ kind: 'publish_failed', jobId: <batch job>, at: A, reason: 'branch_moved' }`.
- AC-13 [integration]: folding a `discarded` line with `tipSha` T on a thread whose `writtenPaths` is `['docs/a.md']`
  and whose stored session has `stale: true` leaves the thread with `writtenPaths: []`, `lastWrite.kind` `discarded`,
  `lastWrite.sha` T and a stored session without a `stale` key.
- AC-14 [integration]: folding a `session_started` line with `stale: true` stores a session with `state: 'live'` and
  `stale: true`.
- AC-15 [integration]: `fold` of a batch containing only a `published` line returns live events that include exactly
  one event of type `thread` for the thread.

### US-003: One active job per thread and Publish

- AC-1 [integration]: `POST /projects/:slug/threads/:id/messages` while the thread has a `RUNNING` `THREAD` job whose
  turn action is `PUBLISH` answers 409 with key `threads.busy`.
- AC-2 [integration]: `POST .../messages` while a `PLAN` job with the thread's `threadId` is `QUEUED` answers 409
  `threads.busy`.
- AC-3 [integration]: `POST .../publish` on a thread whose `THREAD` `SESSION` job is `RUNNING` with no message pending
  or streaming creates exactly one `FleetCommand` of type `THREAD_PUBLISH`, payload `{}`, at that job's `leaseEpoch`.
- AC-4 [integration]: `POST .../publish` while a message of the thread is `streaming` answers 409 `threads.turnRunning`.
- AC-5 [integration]: `POST .../publish` while a `THREAD_CLOSE` command is queued at the live job's epoch answers 409
  `threads.closing`.
- AC-6 [integration]: `POST .../publish` on a thread whose pinned runner's capabilities have no `threadWrite` answers
  409 `threads.runnerOutdated`.
- AC-7 [integration]: `POST .../publish` on a thread whose pinned runner's `lastSeenAt` is older than the offline window
  answers 409 `threads.runnerOffline`.
- AC-8 [integration]: `POST .../publish` with no active job and `writtenPaths ['docs/a.md']` creates a `THREAD` job
  whose `FleetThreadTurn` has `{ action: 'PUBLISH', initialMessageId: null, resume: false }`.
- AC-9 [integration]: the ASSIGN that placement builds for the `PUBLISH` job of AC-8 has a `thread` whose `action`,
  `initialMessage` and `title` are `PUBLISH`, null and the thread's title.
- AC-10 [integration]: `POST .../publish` with no active job and `writtenPaths` `[]` answers 409
  `threads.nothingToPublish`.
- AC-11 [integration]: `POST .../publish` on a thread whose `runnerId` is null answers 409 `threads.nothingToPublish`.
- AC-12 [integration]: `POST .../publish` while a `RUN` job with the thread's `threadId` is `RUNNING` answers 409
  `threads.busy`.
- AC-13 [integration]: `POST .../publish` by a project member who is not the creator answers 403 `threads.notCreator`.
- AC-14 [integration]: `POST .../messages` on a thread with no active job creates a `THREAD` job whose
  `FleetThreadTurn` has `action: 'SESSION'` and `initialMessageId` equal to the new message's id.
- AC-15 [integration]: `ThreadJobEffects.onJobEnded` for a `PUBLISH` job that ended `COMPLETED` with `stateReason`
  `published`, on a thread whose stored session belongs to an earlier job and is `closed`, leaves that stored session
  unchanged.

### US-004: Discard, the publish ack and the `write_doc` instructions

- AC-1 [integration]: `POST /projects/:slug/threads/:id/discard` on a thread with a runner and no active job creates a
  `THREAD` job whose `FleetThreadTurn` has `{ action: 'DISCARD', initialMessageId: null, resume: false }`.
- AC-2 [integration]: the ASSIGN that placement builds for the `DISCARD` job of AC-1 has a `thread` whose `action` and
  `initialMessage` are `DISCARD` and null.
- AC-3 [integration]: `POST .../discard` while the thread's `THREAD` `SESSION` job is `RUNNING` answers 409
  `threads.busy`.
- AC-4 [integration]: `POST .../discard` on a thread whose pinned runner has no `threadWrite` answers 409
  `threads.runnerOutdated`.
- AC-5 [integration]: `POST .../discard` on a thread whose `runnerId` is null answers 409 `threads.nothingToDiscard`.
- AC-6 [integration]: `POST .../discard` while a `PLAN` job with the thread's `threadId` is `QUEUED` answers 409
  `threads.busy`.
- AC-7 [integration]: `POST .../discard` by a project member who is not the creator answers 403 `threads.notCreator`.
- AC-8 [integration]: `CommandAckProcessor` handling a `THREAD_PUBLISH` ack with result `rejected` and detail
  `turn_running` sets the thread's `lastWrite` to `{ kind: 'publish_failed', jobId: <command job>, at: <ack time>,
  reason: 'turn_running' }`.
- AC-9 [integration]: `CommandAckProcessor` handling a `THREAD_PUBLISH` ack with result `ok` leaves the thread's
  `lastWrite` unchanged.
- AC-10 [unit]: `buildThreadInstructions` for spec path `.nax/features/add-auth/spec.md` returns text containing
  `Write the spec to .nax/features/add-auth/spec.md with write_doc.`
- AC-11 [unit]: `buildThreadInstructions` for feature `add-auth` returns a line equal to `write_doc writes Markdown (.md)
  files under docs/ and .nax/features/add-auth/ only. Nothing is committed until the person presses Publish; tell them
  when a draft is ready to publish.`
- AC-12 [unit]: `buildThreadInstructions` returns a line equal to `Tools: list_files and search_repo find files and
  text; read files with your read tool; write_doc writes docs. You have no shell and no web access.`
- AC-13 [integration]: a `THREAD` `SESSION` job created by `POST .../messages` stores `FleetThreadTurn.instructions`
  equal to `buildThreadInstructions` of that thread, which names `write_doc`.

### US-005: Runner PLAN `expectBranch`

- AC-1 [unit]: `parseAssign` of a `PLAN` ASSIGN with `expectBranch: 'feat/add-auth'` returns an assign whose
  `expectBranch` is `feat/add-auth`.
- AC-2 [unit]: `parseAssign` of a `PLAN` ASSIGN without `expectBranch` returns an assign with no `expectBranch` key.
- AC-3 [unit]: `parseAssign` of a `RUN` ASSIGN with `expectBranch: 'feat/add-auth'` is rejected with
  `invalid expectBranch`.
- AC-4 [unit]: `checkPlanPrd` of a PRD with one story and `branchName` `feat/other`, given `expectBranch`
  `feat/add-auth`, returns `{ ok: false, reason: 'branch_mismatch', branchName: 'feat/other' }`.
- AC-5 [unit]: `checkPlanPrd` of a PRD with one story and `branchName` `feat/add-auth`, given `expectBranch`
  `feat/add-auth`, returns a result whose `ok` is true.
- AC-6 [unit]: `checkPlanPrd` of a PRD with one story and `branchName` `feat/other`, given no `expectBranch`, returns a
  result whose `ok` is true.
- AC-7 [unit]: `HostExecutor.readPlan` for a `PLAN` job whose assign has `expectBranch` `feat/add-auth` and whose
  stashed `prd.json` names `feat/other` returns a check whose `reason` is `branch_mismatch`.
- AC-8 [unit]: `HostExecutor.finishPlan` for the job of AC-7 makes no `git push` call.
- AC-9 [unit]: `prepareCheckout` on a real temporary repository where local `feat/add-auth` is one commit ahead of
  `origin/feat/add-auth`, for a `PLAN` assign with `ref` and `expectBranch` `feat/add-auth`, leaves `HEAD` detached at
  the local branch's commit.
- AC-10 [unit]: `prepareCheckout` on the repository of AC-9 for a `PLAN` assign with `ref` `feat/add-auth` and no
  `expectBranch` leaves `HEAD` detached at `origin/feat/add-auth`'s commit.
- AC-11 [unit]: `prepareCheckout` on a real temporary repository with an `origin/feat/add-auth` and no local
  `feat/add-auth`, for a `PLAN` assign with `ref` and `expectBranch` `feat/add-auth`, leaves `HEAD` detached at
  `origin/feat/add-auth`'s commit.

### US-006: Plan from a thread

- AC-1 [integration]: `POST /projects/:slug/threads/:id/plan` with `{}` on a thread with `specPublished: true`, a runner
  and no active job creates a `PLAN` job whose `{ ref, feature, planFrom, pinnedRunnerId, threadId }` equal
  `{ 'feat/<feature>', <thread feature>, <thread specPath>, <thread runnerId>, <thread id> }`.
- AC-2 [integration]: `POST .../plan` on a thread with `specPublished: false` answers 409 `threads.notPublished`.
- AC-3 [integration]: `POST .../plan` on a thread whose `specPublished` became true by folding a `published` line with
  `specPresent: true` answers 201.
- AC-4 [integration]: `POST .../plan` while the thread's `THREAD` `SESSION` job is `RUNNING` answers 409 `threads.busy`.
- AC-5 [integration]: `POST .../plan` while a `PLAN` job with the thread's `threadId` is `RUNNING` answers 409
  `threads.busy`.
- AC-6 [integration]: two `POST .../plan` requests for the same idle thread sent concurrently leave exactly one `PLAN`
  job with that `threadId`.
- AC-7 [integration]: `POST .../plan` with `{ profiles: ['cc-plan'], maxCostUsd: '2' }` creates a job whose
  `{ profiles, maxCostUsd }` equal `{ ['cc-plan'], '2' }`.
- AC-8 [integration]: `POST .../plan` by a project member who is not the creator answers 403 `threads.notCreator`.
- AC-9 [unit]: `buildAssignPayload` for a `PLAN` job with `threadId` `t1` and `ref` `feat/add-auth` returns a payload
  whose `expectBranch` is `feat/add-auth`.
- AC-10 [unit]: `buildAssignPayload` for a `PLAN` job with `threadId` null returns a payload with no `expectBranch` key.
- AC-11 [unit]: `buildAssignPayload` for a `RUN` job with `threadId` `t1` returns a payload with no `expectBranch` key.
- AC-12 [integration]: `FleetJobsService.dispatch` called with `opts.threadId` while a `THREAD` job of that thread is
  `RUNNING` throws a 409 with key `threads.busy`.
- AC-13 [integration]: `GET /projects/:slug/threads/:id` for a thread with one `PLAN` job in state `FAILED` with
  `stateReason` `branch_mismatch` returns `handoff` equal to `{ plan: { jobId, state: 'FAILED', stateReason:
  'branch_mismatch' }, run: null }`.
- AC-14 [integration]: `GET /projects/:slug/threads/:id` for a thread with two `PLAN` jobs returns `handoff.plan.jobId`
  equal to the job queued last.

### US-007: Run from a thread

- AC-1 [integration]: `POST /projects/:slug/threads/:id/run` with `{}` on a thread whose latest `PLAN` job is
  `COMPLETED` and with no active job creates a `RUN` job whose `{ ref, feature, pinnedRunnerId, threadId, planFrom }`
  equal `{ 'feat/<feature>', <thread feature>, <thread runnerId>, <thread id>, null }`.
- AC-2 [integration]: `POST .../run` on a thread with no `PLAN` job answers 409 `threads.notPlanned`.
- AC-3 [integration]: `POST .../run` on a thread whose latest `PLAN` job is `FAILED` and whose earlier `PLAN` job is
  `COMPLETED` answers 409 `threads.notPlanned`.
- AC-4 [integration]: `POST .../run` with `{ bashMode: 'escalate', profiles: ['native'] }` creates a `RUN` job whose
  `{ bashMode, profiles }` equal `{ 'escalate', ['native'] }`.
- AC-5 [integration]: `POST .../run` while a `RUN` job with the thread's `threadId` is `RUNNING` answers 409
  `threads.busy`.
- AC-6 [integration]: the ASSIGN that placement builds for the `RUN` job of AC-1 has no `expectBranch` key.
- AC-7 [integration]: `POST .../run` by a project member who is not the creator answers 403 `threads.notCreator`.
- AC-8 [integration]: `GET /projects/:slug/threads/:id` after the `RUN` job of AC-1 is created returns `handoff.run.jobId`
  equal to that job's id.
