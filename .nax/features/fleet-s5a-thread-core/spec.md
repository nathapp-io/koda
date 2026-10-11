# SPEC: Fleet S5a-B1 — Thread Core (Protocol v4 Contract, Thread Data, Routes, Send, Placement, Session Commands)

## Summary

koda gains brainstorm threads: a project member opens a thread against a fleet repo and chats with an agent that runs
on a fleet runner. This feature is the API core of that capability. It adds the protocol v4 contract (a `THREAD` job
kind, five thread command types, the runner's `threadBackends` report), the thread data model (`ChatThread`,
`ChatMessage`, `FleetThreadTurn`), the thread routes (create, list, get, messages, send, stop, end session, answer,
raise cap, archive), the send path that starts a session as a finite `THREAD` fleet job or feeds a live one with a
`THREAD_INPUT` command, `THREAD` placement as its own load class, and the effects of command acks and job ends on a
thread's messages. Everything ships behind the kill switch `FLEET_THREADS_ENABLED` (default off).

This is feature B1 of fleet S5a phase B. Umbrella design:
`docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` (§2, §3.1, §4.5, §8). Later features: B2
`fleet-s5a-thread-ingest` (thread event stream, durable ingest, cost, content SSE), B3 `fleet-s5a-thread-runner`
(runner session host on `@nathapp/nax-agent` 0.85.1), B4 `fleet-s5a-thread-web` (pages).

## Motivation

Fleet S5 needs repo-grounded brainstorming: a person talks to an agent that can read the repo and drafts a spec, then
hands it to the existing PLAN and RUN jobs. Agent sessions must run on the runner, where provider credentials live
(fleet design §3 (e)), so koda needs a way to start, feed, stop and close a long-lived chat session through the
existing runner sync channel. Today the fleet only knows finite nax jobs (`RUN`, `PLAN`, config jobs), one job per repo
per runner (`busy_repo`), and no server-to-runner message other than ASSIGN, CANCEL, READOPT, ABANDON and
APPROVAL_ANSWER. Without this feature there is no record to chat on, no job kind to host a session, and no command to
deliver a message to a running session.

## Design

### Rulings that bind every story (user, 2026-10-10)

- D539/D542: a thread is a long-lived record; its live session is a finite `THREAD` fleet job. D541: project members
  read every thread; only the creator acts (send, stop, end session, answer, raise cap); archive is creator or project
  ADMIN; agent API keys are refused on every thread route.
- D545 + the 2026-10-10 split: phase B is four features. B1 (this spec) is API only.
- B1-R1 (deviation from umbrella §2.3): **thread slots are counted by the server.** The v4 sync request carries no
  `freeThreadSlots`; on every sync of a runner whose `protocolVersion >= 4` the server assigns QUEUED `THREAD` jobs up
  to `Runner.threadCapacity` minus the runner's live `THREAD` jobs. `Runner.threadCapacity` is server-only (admin
  PATCH); the runner never reads it.
- B1-R2: the package constant `FLEET_PROTOCOL_VERSION` stays `3` in this feature. The API starts accepting version 4;
  B3 bumps the constant when the runner implements threads. Today's runner keeps reporting v3, so it never receives a
  `THREAD` job (placement misfit `protocol`).
- B1-R3: a paused budget refuses a send with the existing 409 `fleet.budgetPaused` (`BudgetPausedException`), not a
  new `threads.budgetPaused` key.
- B1-R4: `THREAD` jobs never enqueue the `fleet_job_outcome` notification; the thread shows its own state.
- B1-R5: `FLEET_THREADS_ENABLED` defaults to `false`. Services read `fleetConfig.threadsEnabled` on every request (never cached at construction), so an integration suite toggles it by setting the booted app's `app.get(FLEET_CFG).threadsEnabled`. When false: create and send answer 409 `threads.disabled`,
  placement refuses `THREAD` jobs (`threads_disabled`), reads stay available.

### Integration

Read-only symbols (verified on main `2969dcf4`):

- `FleetJobsService.cancel(actorId, projectId, jobId, canOperate)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:140`)
  — archive reuses it for the thread's non-terminal `THREAD` job with `canOperate = true`.
- `BudgetGate.assertNotPaused(keys, now)` (`apps/api/src/fleet/budgets/budget-gate.ts:16`) and
  `jobGateKeys({ projectId, repoId, pinnedRunnerId })` (`apps/api/src/fleet/budgets/budget-rules.ts`).
- `isRunnerOnline(lastSeenAt, now, offlineSec)` (`apps/api/src/fleet/common/runner-online.ts`) with
  `IFleetConfig.runnerOfflineSec`.
- `RunnerNotifier.notify(runnerId)` (`apps/api/src/fleet/jobs/runner-notifier.ts`) — wakes a long-polling runner.
- `FEATURE_RE`, `GIT_REF_RE` (`apps/api/src/fleet/jobs/dispatch-input.ts:9-11`).
- `ProjectMembershipGuard`, `@ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])` (DEVELOPER+),
  `@CurrentProject()`, `isUserPrincipal` — the pattern of `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`.
- `ConflictAppException(args, prefix)` (`apps/api/src/common/exceptions/conflict-app.exception.ts`),
  `ValidationAppException(args, prefix)`, `ForbiddenAppException`, `NotFoundAppException`.
- `FleetSweeper.sweep(now)` (`apps/api/src/fleet/sync/fleet-sweeper.ts:48`) — crashes held jobs of silent runners
  through `JobTransitionsService.apply`.
- The config-job pattern: a job plus a 1:1 input row in one transaction, then `placement.placeJob`
  (`apps/api/src/fleet/repo-config/config-jobs.service.ts:117-149`).
- The store-module pattern for a provider the jobs module calls without a cycle
  (`apps/api/src/fleet/schedules/schedule-store.module.ts`, `ScheduleProgressService.onJobEnded`).

Mutated symbols. **The baseline exists only to locate the code; implement the target.**

| Symbol | Baseline | Target |
|---|---|---|
| `FleetJobKindName` (`packages/fleet-protocol/src/index.ts:104`) | `'RUN' \| 'PLAN' \| ConfigJobKind` | adds `'THREAD'` |
| `FleetCommandTypeName` (`index.ts:105`) | 5 types | adds `ThreadCommandType` (`THREAD_INPUT`, `THREAD_ANSWER`, `THREAD_STOP_TURN`, `THREAD_CLOSE`, `THREAD_PUBLISH`) |
| `AssignPayload` (`index.ts:221`) | no thread field | gains `thread?: ThreadAssign` (present only for `THREAD` jobs) |
| `RunnerCapabilities` (`index.ts:59`) | no thread field | gains `threadBackends?: ThreadBackends` |
| `SyncResponse` (`index.ts:251`) | no thread field | gains `archivedThreadIds?: string[]` |
| `FleetCommandOut.payload` (`index.ts:244`) | 5 payload types | adds `ThreadInputPayload \| ThreadAnswerPayload` |
| `FleetJobDto.command` (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:31`) | `enum: ['RUN','PLAN','CONFIG_EDIT','CONFIG_DRIFT']` | type and enum gain `THREAD` (the fleet job routes return THREAD jobs) |
| `SUPPORTED_FLEET_PROTOCOL_VERSIONS` (`apps/api/src/fleet/common/protocol.ts:55`) | `[1, 2, 3]` | `[1, 2, 3, 4]` |
| `FleetJobKind`, `FleetCommandType` (`apps/api/src/common/enums.ts:142-147`) | no thread members | `FleetJobKind.THREAD`; the five thread command types |
| `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts`) | no `threadBackends` | parses and returns `threadBackends` strictly (below) |
| `IFleetConfig` (`apps/api/src/config/fleet.config.ts`) | — | gains `threadsEnabled: boolean` from `FLEET_THREADS_ENABLED` (`'true'` = on, anything else or unset = off) |
| `RunnerRecord`, `RunnerPatch` (`apps/api/src/fleet/runners/domain/runner.domain.ts`), `RunnerDto`, `UpdateRunnerDto` | `capacity` only | gain `threadCapacity` (DTO: integer 0..16) |
| `NewFleetJob`, `FleetJobRecord` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`) | no thread link | gain `threadId: string \| null` (`NewFleetJob.threadId` optional, default null) |
| `ActiveJobRef` (`fleet-job.domain.ts:184`) | `{ runnerId, repoId }` | `{ runnerId, repoId, command?: string }`; `PrismaFleetJobRepository.findActiveLoads` always sets `command` |
| `RunnerLoad` (`apps/api/src/fleet/jobs/placement-rules.ts:45`) | `{ active, repoIds }` | `{ active, repoIds, threads?: number }`; `toLoads` puts a ref whose `command` is `THREAD` into `threads` only, so `active` and `repoIds` count non-THREAD jobs; absent `threads` reads as 0 |
| `PlacementRunner` (`placement-rules.ts:32`) | no protocol fields | gains optional `protocolVersion?: number` and `threadCapacity?: number` (absent reads as 0); `findPlacementRunners` always sets both. Optional so the dashboard dry-run (`attention-unplaceable.ts`, B2) and existing spec literals compile unchanged |
| `PlacementJob` (`placement-rules.ts:22`) | no thread field | gains `thread?: { backend: ThreadBackend; enabled: boolean }` (set for THREAD jobs) |
| `MisfitReason` (`placement-rules.ts:8`) | 15 reasons | adds `thread_capacity`, `thread_backend`, `threads_disabled` (`protocol` is reused) |
| `firstMisfit` (`placement-rules.ts:92`) | one rule set | THREAD branch below |
| `IFleetJobRepository` (`fleet-job.domain.ts:191`) | — | gains `findThreadAssign(jobId): Promise<ThreadAssign \| null>` and `pinThreadRunner(threadId, runnerId): Promise<void>` (sets `ChatThread.runnerId` only when null) |
| `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts:26`) | 4 parameters | optional 5th `thread?: ThreadAssign`, copied to `payload.thread` |
| `PlacementRunnerRow` (`fleet-job.domain.ts:189`) | `PlacementRunner & { bootId }` | unchanged shape; carries the new optional `PlacementRunner` fields, which `findPlacementRunners` fills |
| `PlacementService.fillRunner` (`placement.service.ts:101`) | assigns any fitting QUEUED job | skips THREAD jobs |
| `PlacementService` | — | gains `fillRunnerThreads(runnerId, now?)` |
| `SyncService.sync` (`apps/api/src/fleet/sync/sync.service.ts:50`) | fills only on `freeSlots > 0` | also calls `fillRunnerThreads` when `protocolVersion >= 4`; response gains `archivedThreadIds` |
| `CommandAckProcessor.processOne` (`apps/api/src/fleet/sync/command-ack.processor.ts:48`) | no thread branch | THREAD_INPUT / THREAD_ANSWER branch (below) |
| `JobTransitionsService.apply` (`apps/api/src/fleet/jobs/job-transitions.service.ts:42`) | terminal hooks for config, outcome, schedule | adds the thread terminal hook |
| `FleetJobOutcomeRecorder.onTerminal` (`apps/api/src/fleet/jobs/job-outcome.recorder.ts:21`) | enqueues for every failure state | returns without enqueueing for a `THREAD` job |
| `SkillsService` (`apps/api/src/skills/skills.service.ts`) | — | gains `snapshotForProject(projectId): Promise<ThreadSkillSource[]>` |

The API image does not ship `packages/` (`protocol.spec.ts` pins production code to `import type` from the package),
so runtime values are mirrored in `apps/api/src/fleet/common/thread-jobs.ts`, as `config-jobs.ts` mirrors
`packages/fleet-protocol/src/config-jobs.ts`; specs import the package at runtime to pin the copies equal.

### Protocol additions (`packages/fleet-protocol/src/threads.ts`, re-exported from `index.ts`)

```ts
export const THREAD_JOB_KIND = 'THREAD' as const;
export function isThreadKind(command: string): command is typeof THREAD_JOB_KIND { return command === THREAD_JOB_KIND; }

export const THREAD_COMMAND_TYPES = ['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH'] as const;
export type ThreadCommandType = (typeof THREAD_COMMAND_TYPES)[number];

export type ThreadAgent = 'claude' | 'codex';
export type ThreadBackend =
  | { kind: 'native'; model?: string; effort?: string }
  | { kind: 'acp'; agent: ThreadAgent; model?: string; effort?: string };
/** Runner capability report: native model ids it can serve, ACP agents it can launch. */
export interface ThreadBackends { native: string[]; acp: ThreadAgent[] }

export interface ThreadSkill { name: string; dir: string; description: string }
export interface ThreadSkillSource { sourceId: string; owner: string; repo: string; sha: string; skills: ThreadSkill[] }

export type ThreadAction = 'SESSION' | 'PUBLISH';
export interface ThreadAssign {
  threadId: string;
  action: ThreadAction;
  /** The thread's feature (branch feat/<feature>), not the job's `thread-<id>` feature. */
  feature: string;
  resume: boolean;
  instructions: string;
  backend: ThreadBackend;
  skills: ThreadSkillSource[];
  initialMessage: { messageId: string; text: string } | null;
}
export interface ThreadInputPayload { messageId: string; text: string }
export interface ThreadAnswerPayload { requestId: string; text: string }

export const THREAD_LIMITS = { messageMaxBytes: 32_768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 } as const;
```

`THREAD_PUBLISH` and `action: 'PUBLISH'` are declared for protocol stability; nothing in this feature queues or
creates them (phase C).

`threadBackends` parsing (strict, like `approvals` and `configJobs`): an object with exactly the keys `native` and
`acp`; `native` an array of at most `THREAD_LIMITS.maxNativeModels` unique strings matching
`MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}$/`; `acp` an array of at most `THREAD_LIMITS.maxAcpAgents`
unique values from `['claude', 'codex']`. Any violation throws `CapabilityValidationError('threadBackends')`. Absent
`threadBackends` leaves the key absent in the result.

### New data (US-002)

```prisma
model ChatThread {
  id              String    @id @default(cuid())
  projectId       String
  repoId          String
  baseRef         String
  feature         String    // nax feature; branch feat/<feature>
  title           String
  createdById     String
  runnerId        String?   // pinned at the first THREAD assignment, never changed
  backend         Json      // ThreadBackend; immutable
  status          String    @default("ACTIVE") // ACTIVE | ARCHIVED
  archivedAt      DateTime?
  skills          Json      // ThreadSkillSource[] snapshot taken at creation
  maxCostUsd      Decimal   @default(5) @db.Decimal(12, 4)
  costUsd         Decimal   @default(0) @db.Decimal(12, 4)
  tokens          Json?     // { input, output, cacheRead, cacheWrite }; written by B2
  specPath        String    // .nax/features/<feature>/spec.md
  pendingQuestion Json?     // { requestId, text, expiresAt }; written by B2
  nextSeq         Int       @default(1)
  lastActivityAt  DateTime  @default(now())
  createdAt       DateTime  @default(now())
  // relations: project (cascade), repo FleetRepo (cascade), createdBy User, runner Runner? (SetNull), messages, turns, jobs
  @@index([projectId, lastActivityAt])
  @@index([runnerId, status])
}

model ChatMessage {
  id              String   @id @default(cuid())
  threadId        String
  seq             Int
  jobId           String?
  turnId          String?
  role            String   // user | assistant
  authorUserId    String?
  clientMessageId String?
  content         String   @db.Text
  toolSummary     Json?
  status          String   // pending | streaming | complete | cancelled | errored | timed_out | interrupted
  errorReason     String?  // set with status errored, at most 200 chars
  usage           Json?
  costUsd         Decimal? @db.Decimal(12, 4)
  costSource      String?
  createdAt       DateTime @default(now())
  @@unique([threadId, seq])
  @@unique([threadId, clientMessageId])
}

/// One THREAD job's input (1:1, like FleetConfigEdit for config jobs).
model FleetThreadTurn {
  jobId            String  @id   // FK FleetJob, cascade
  threadId         String        // FK ChatThread, cascade
  action           String        // SESSION | PUBLISH
  initialMessageId String?
  instructions     String  @db.Text
  backend          Json
  skills           Json
  resume           Boolean
}
```

- `FleetJob` gains `threadId String?` (FK `ChatThread`, `onDelete: SetNull`, indexed). `Runner` gains
  `threadCapacity Int @default(2)`.
- Raw SQL in the migration: partial unique index `ChatThread_active_repo_feature_key` on `("repoId", "feature")`
  `WHERE "status" = 'ACTIVE'`.
- Migration `apps/api/prisma/migrations/20261013090000_chat_threads/migration.sql`.

### Thread routes (US-003, US-004, US-007)

All under `projects/:slug/threads`, `ProjectMembershipGuard`, users only (an agent principal → 403
`threads.principal`, one `assertUser` check per handler).

| Route | Who | Story |
|---|---|---|
| `POST /` create | DEVELOPER+, checked in the handler after `assertUser` (no `@ProjectPermission` on this route, so an agent key reaches `threads.principal`) | US-003 |
| `GET /` list (`?status=ACTIVE\|ARCHIVED`, page/size; order `lastActivityAt` desc, `id` desc) | member | US-003 |
| `GET /:id` | member | US-003 |
| `GET /:id/messages?afterSeq=<integer >= 0, default 0>&limit=<1..200, default 100>` (ascending `seq`, `{ items }`; out-of-range query → 400 `threads.input`) | member | US-003 |
| `POST /:id/messages` `{ text, clientMessageId }` | creator | US-004, US-005 |
| `POST /:id/stop` | creator | US-007 |
| `POST /:id/end-session` | creator | US-007 |
| `POST /:id/answer` `{ requestId, text }` | creator | US-007 |
| `PATCH /:id` `{ maxCostUsd }` | creator | US-007 |
| `POST /:id/archive` | creator or project ADMIN (`ctx.role === 'ADMIN'`, which includes a global ADMIN) | US-007 |

A thread of another project, or an unknown id → 404 `threads.notFound`. `ThreadDto`: `id, repoId, baseRef, feature,
title, createdById, runnerId, backend, status, archivedAt, skills, maxCostUsd, costUsd, tokens, specPath,
pendingQuestion, lastActivityAt, createdAt, activeJob: { id, state } | null` (the thread's newest non-terminal THREAD
job). `ChatMessageDto`: every `ChatMessage` column except `threadId`.

**Create input** (`thread-input.ts`, errors → `ValidationAppException({ reason }, 'threads.input')`, HTTP 400):
`repoId` (a fleet repo of this project, else 404 `fleet.repos`); `feature` matching `FEATURE_RE` with
`feat/<feature>` matching `GIT_REF_RE`; `baseRef` optional, `GIT_REF_RE`, default the repo's default branch; `title`
1..200 characters without control characters; `maxCostUsd` optional, 0.0001..10000 with at most 4 decimals, default
5; `backend` exactly one of `{ kind: 'native', model?, effort? }` or `{ kind: 'acp', agent: 'claude' | 'codex',
model?, effort? }` with `model` matching `MODEL_ID_RE`, `effort` matching `/^[a-z]{1,16}$/`, no other keys. Create
order: `assertUser` (agent → 403 `threads.principal`); DEVELOPER+ through the CASL ability for
`withProjectRole(principal, ctx.role)` and `can(CREATE, 'FleetJob')` (else 403 `projects`, the guard's usual answer);
kill switch; input; repo; then insert. A duplicate ACTIVE `(repoId, feature)` → 409 `threads.featureTaken`
(`{ feature }`). Create stores `specPath = .nax/features/<feature>/spec.md` and
`skills = await skills.snapshotForProject(projectId)`, and creates no job. `ThreadsModule` imports `SkillsModule`
(which exports `SkillsService`).

**Skill snapshot** (`SkillsService.snapshotForProject`, backed by a new
`SkillCatalogRepository.listEnabledSnapshot(projectId)` in `skill-catalog.domain.ts` and
`prisma-skill-catalog.repository.ts`; `listProjectSkills` stays unchanged): the project's enabled skills grouped by
source, sources with a null `resolvedSha` left out, sources ordered by `owner`, then `repo`, then `sourceId`, skills by
`name`: `[{ sourceId, owner, repo, sha: resolvedSha, skills: [{ name, dir, description }] }]`.

### Send (US-004 behaviour, US-005 guards)

`POST /:id/messages`: `text` 1..`THREAD_LIMITS.messageMaxBytes` UTF-8 bytes; `clientMessageId` matching
`/^[A-Za-z0-9_-]{1,64}$/`.

**Lock order (every thread write: send, stop, end session, answer, cap, archive, and `ThreadJobEffects`): job, then
thread.** A thread write reads the thread's current job id without a lock, locks that job (`lockById`), then locks the
`ChatThread` row (`SELECT ... FOR UPDATE`), then re-reads the current job; if it changed, it releases and retries once,
and answers 409 `threads.turnRunning` if it changed again. `JobTransitionsService.apply` already holds the job lock
when it calls `ThreadJobEffects.onJobEnded`, which then locks the thread, so the two orders agree and a job end cannot
interleave with a send that saw the job RUNNING.

Definitions: the thread's **current job** is its newest `THREAD` job in a non-terminal state. A **live session** is a
current job in RUNNING with no `THREAD_CLOSE` command at its current `leaseEpoch` (acked or not).

Checks, in this order (the first that applies answers):

1. not the creator → 403 `threads.notCreator`;
2. a message of this thread with the same `clientMessageId` exists → 200 with `{ message, jobId: null }`, nothing
   queued (the handler sets the status with `@Res({ passthrough: true })`, since the route's default is 201);
3. `threadsEnabled` false → 409 `threads.disabled`;
4. `status = ARCHIVED` → 409 `threads.archived`;
5. `costUsd >= maxCostUsd` → 409 `threads.costCap`;
6. `BudgetGate.assertNotPaused(jobGateKeys({ projectId, repoId, pinnedRunnerId: runnerId }))` → 409
   `fleet.budgetPaused`;
7. `runnerId` set and that runner offline (`isRunnerOnline` false) → 409 `threads.runnerOffline`;
8. `runnerId` set and that runner's `protocolVersion < 4` → 409 `threads.runnerOutdated`;
9. current job in UPLOADING, or current job RUNNING with a `THREAD_CLOSE` at its epoch → 409 `threads.closing`;
10. a message of this thread in `pending` or `streaming`, or a current job in QUEUED or ASSIGNED → 409
    `threads.turnRunning`.

The order is implemented once as the pure function `sendRefusal(state): ThreadSendRefusal | null`
(`thread-send-rules.ts`) over a snapshot of the facts above; the service throws the matching exception.

Then the user message is inserted (`role user`, `status pending`, `authorUserId`, `clientMessageId`, `seq` from
`UPDATE "ChatThread" SET "nextSeq" = "nextSeq" + 1 ... RETURNING`), `lastActivityAt = now`, and:

- **live session:** a `FleetCommand` `THREAD_INPUT` `{ messageId, text }` to the current job's `runnerId` at its
  `leaseEpoch`; after commit `RunnerNotifier.notify(runnerId)`. Response `{ message, jobId: null }`, 201.
- **otherwise:** a `FleetJob` with `command THREAD`, `threadId`, `feature = 'thread-<threadId>'` (so the active
  `(repoId, feature)` index never meets the thread's own PLAN/RUN on `<feature>`), `ref = baseRef`, `profiles []`,
  `bashMode raw`, `approvalTimeoutSec` default, `selectorLabels []`, `pinnedRunnerId = runnerId` (null before the
  first assignment), `maxCostUsd = maxCostUsd - costUsd`, `requestedById = creator`; a `FleetThreadTurn` with
  `action SESSION`, `initialMessageId`, `instructions = buildThreadInstructions(...)`, `backend` and `skills` copied
  from the thread, `resume` = the thread already has any earlier `THREAD` job; the QUEUED state event and the
  `job.dispatched` activity as in `ConfigJobsService.create`. After commit `placement.placeJob(jobId)`. Response
  `{ message, jobId }`, 201. A `DuplicateActiveJobError` (a concurrent send won) → 409 `threads.turnRunning`.

### Instructions (`thread-instructions.ts`, US-004)

`buildThreadInstructions({ repo, baseRef, feature, specPath, skills })` (`repo` = `owner/name`) returns these lines
joined with `\n`, placeholders filled:

```text
You are a brainstorming partner for the repository {repo} (base ref {baseRef}), working on the feature "{feature}".
Goal: agree with the person on the feature's intent, then draft its spec, which belongs at {specPath}.
How to work:
1. Brainstorm with the person. Ask one question at a time. Read and search the code with your tools before you claim anything about it.
2. When the person agrees the intent is settled, call load_skill with "spec-writing" if it is listed below and follow it. You cannot write files in this session. Put the spec draft in your reply.
3. Then call load_skill with "spec-review" if it is listed below and review the draft against the code.
Tools: list_files and search_repo find files and text; read files with your read tool. You have no shell, no web access and no write access.
Skills available (call load_skill with the name):
- {name} — {description}
```

One `- {name} — {description}` line per snapshot skill, in snapshot order. With no skills the last line is
`Skills available: none.` instead of the heading and skill lines.

### Placement (US-006)

`toLoads` puts a held `THREAD` job into `threads` only. For a job with `isThreadKind(command)`, `firstMisfit` runs, in
order: `disabled`, `offline`, `budget_paused` (as today), `labels` (as today), `executor`, then
`threads_disabled` (`job.thread.enabled` false), `protocol` (`runner.protocolVersion < 4`), `thread_backend`, and
`thread_capacity` (`load.threads >= runner.threadCapacity`); it skips the profile, sandbox, interaction, approvals
relay and tools checks and is exempt from `busy_repo` and `capacity`. `thread_backend`: for `native`, the runner's
`capabilities.threadBackends.native` is empty or absent, or a set `model` is not in it; for `acp`, the `agent` is not
in `capabilities.threadBackends.acp`. Non-THREAD jobs ignore THREAD jobs for `busy_repo` and `capacity` (through
`toLoads`). A THREAD job without `job.thread` (a caller that did not build it) is treated as `threads_disabled`, never
a thrown error. The three new misfits are not in `PERMANENT_MISFITS`; `protocol` stays permanent, which does not
matter because THREAD jobs are never dispatched through `FleetJobsService.dispatch` and its `evaluatePinned` check.
`MISFIT_REASONS` (`apps/api/src/fleet/dashboard/dashboard.types.ts:109`) and the `PlacementMisfitDto.reason` enum
(`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:107`) gain `thread_capacity`, `thread_backend` and `threads_disabled`.
The dashboard dry-run (`jobUnplaceableItems`, `apps/api/src/fleet/dashboard/attention-unplaceable.ts`) skips
`isThreadKind` jobs; full dashboard treatment of THREAD jobs is B2.

`FleetJobsService.requeue` refuses a THREAD job with 409 `fleet.jobState` (`{ state }`): a new session goes through
the send route, which applies the cost cap, the archive and runner checks and the `maxCostUsd` computation.

`PlacementService` builds `PlacementJob.thread` from `findThreadAssign(jobId).backend` and
`fleetConfig.threadsEnabled`. `assign` passes the `ThreadAssign` to `buildAssignPayload` and, after a successful
`casAssign` of a THREAD job, calls `pinThreadRunner(threadId, runnerId)` in the same transaction. `fillRunner` skips
THREAD jobs. `fillRunnerThreads(runnerId, now)` locks the runner, computes `slots = threadCapacity - load.threads`,
and assigns QUEUED THREAD jobs from the same oldest-first scan window (`QUEUED_SCAN_LIMIT`) while `slots > 0`,
honouring pins and the budget pre-assign check like `fillRunner`. `SyncService.sync` calls it after `fillRunner`
whenever the sync's `protocolVersion >= 4`, regardless of `freeSlots`.

### Session commands, acks and job ends (US-007)

- `stop` → `THREAD_STOP_TURN` `{}`; `end-session` → `THREAD_CLOSE` `{}`; both need a live session (else 409
  `threads.noSession`), go to the current job's runner and epoch, and wake the runner.
- `answer` `{ requestId (1..128), text (1..messageMaxBytes) }` needs a live session and
  `pendingQuestion.requestId === requestId` (else 409 `threads.noQuestion`) → `THREAD_ANSWER` `{ requestId, text }`.
- `PATCH /:id` `{ maxCostUsd }` (same bounds as create) sets the thread's cap; it does not change a live session
  job's `maxCostUsd`.
- `archive`: under the job-then-thread lock, `status ARCHIVED`, `archivedAt = now`, committed first; after commit
  the current job, if any, goes through `FleetJobsService.cancel(actorId, projectId, jobId, true)` (QUEUED or
  never-acked ASSIGNED end CANCELLED on the server; otherwise `cancelRequestedAt` and one `CANCEL`). A send that
  takes the locks after the archive sees ARCHIVED (check 4). A 409 `fleet.jobState` from `cancel` (the job ended
  between the commit and the cancel) is ignored. Archiving an archived thread returns 200 unchanged.
  Archive is also the way to free a first session left QUEUED because no runner fits (stop needs a live session).
- Stop, end session and answer re-check the live session under the job-then-thread lock, so two concurrent
  end-session calls queue one `THREAD_CLOSE`.
- Sync response `archivedThreadIds`: ids of ARCHIVED threads whose `runnerId` is the syncing runner, newest
  `archivedAt` first, at most `THREAD_LIMITS.maxArchivedThreadIds`, read through
  `ThreadJobEffects.archivedThreadIds(runnerId)`. The runner prunes their directories (B3).
- `ThreadStoreModule` follows the fleet store-module precedent (`ApprovalStoreModule`, `BudgetStoreModule` and `ScheduleStoreModule` export their repository tokens so a sibling module can share storage without a cycle): it exports `CHAT_THREAD_REPOSITORY` to `ThreadsModule` and `ThreadJobEffects` to the jobs and sync modules. This is the recorded exception to the `api-data.md` "repositories are module-private" rule; no module outside `fleet/threads` and those two importers uses the token.
- `ThreadJobEffects` (`thread-job-effects.ts`, exported by `ThreadStoreModule`; `FleetJobsModule`
  (`fleet-jobs.module.ts`) and `SyncModule` (`sync.module.ts`) add `ThreadStoreModule` to `imports`). It writes
  through the module-private thread repository (`CHAT_THREAD_REPOSITORY`), which gains
  `replaceCommandPayload(commandId, payload)` for the `FleetCommand` rewrite. `JobTransitionsService` and
  `CommandAckProcessor` take it as their **last** constructor parameter, so existing specs that construct them
  positionally keep working once they pass a stub; their calls are guarded by `isThreadKind` / the command type.
  - `onInputAck(command, result, detail)`: for `THREAD_INPUT`, the command payload becomes `{ messageId }`; on
    `rejected` the message's `status` becomes `errored` with `errorReason = detail` (at most 200 chars). For
    `THREAD_ANSWER`, the payload becomes `{ requestId }`. `CommandAckProcessor.processOne` calls it for those two
    types after the fence check, inside the ack transaction, and returns no live job event.
  - `onJobEnded(job)`: called by `JobTransitionsService.apply` for every terminal transition (COMPLETED, FAILED,
    ESCALATED, CRASHED, CANCELLED) of a job with `isThreadKind(command)` and a `threadId`, in the same transaction:
    the thread's messages in `pending` or `streaming` become `errored` (`content` kept, `errorReason` = the job's
    state lowercased, e.g. `crashed`) and `pendingQuestion` becomes null. After a clean idle close no message is in
    flight, so nothing changes.
  - `errorReason` can carry runner-supplied text; the web (B4) renders it as plain text.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Kill switch off | create and send 409 `threads.disabled`; reads 200; placement `threads_disabled` | US-003, US-005, US-006 |
| Agent API key | 403 `threads.principal` | US-003 |
| VIEWER creates | 403 (project permission) | US-003 |
| Invalid feature, backend, title, ref or cost | 400 `threads.input` | US-003 |
| Feature already used by an ACTIVE thread of the repo | 409 `threads.featureTaken` | US-003 |
| Thread of another project | 404 `threads.notFound` | US-003 |
| Non-creator acts | 403 `threads.notCreator` | US-005, US-007 |
| Archived thread, send | 409 `threads.archived` | US-005 |
| Cost cap reached | 409 `threads.costCap` | US-005 |
| Budget paused | 409 `fleet.budgetPaused` | US-005 |
| Pinned runner offline / below v4 | 409 `threads.runnerOffline` / `threads.runnerOutdated`, nothing written | US-005 |
| Previous session closing | 409 `threads.closing` (the web retries) | US-005 |
| A turn or a queued session is in flight | 409 `threads.turnRunning` | US-005 |
| Message over 32 KiB | 400 `threads.input` | US-005 |
| Repeated `clientMessageId` | 200 with the existing message, nothing queued | US-004, US-005 |
| No runner fits the first session | job stays QUEUED, message `pending` | US-005 |
| Stop / end session / answer without a live session | 409 `threads.noSession` | US-007 |
| Answer for a question that is not pending | 409 `threads.noQuestion` | US-007 |
| `THREAD_INPUT` acked `rejected` | message `errored` with the ack detail | US-007 |
| THREAD job reaches any terminal state (sweeper, readopt, cancel, runner report) | in-flight messages `errored`, question cleared, no outcome notification | US-007 |
| Requeue of a THREAD job through the fleet jobs route | 409 `fleet.jobState` | US-005 |
| Queued THREAD job in the dashboard dry-run | skipped, no `job_unplaceable` item | US-006 |

After the API contract changes, `bun run generate` (which runs `api:export-spec`) regenerates `openapi.json`; the CLI
gains no commands. i18n: `apps/api/src/i18n/{en,zh}/threads.json` carries every `threads.*` key from the start
(US-003): `principal` (403), `notFound` (404), `input` (`-2`, with `{reason}`), `disabled`, `featureTaken`
(`{feature}`), `archived`, `costCap`, `runnerOffline`, `runnerOutdated`, `closing`, `turnRunning`, `noSession`,
`noQuestion` (409), `notCreator` (403).

## Out of Scope

- The `thread` log stream, durable ingest (`ThreadIngestCursor`), a user message becoming `complete`, assistant
  messages, cost and token accrual, setting `pendingQuestion`, and the content-carrying SSE belong to feature
  `fleet-s5a-thread-ingest` (B2).
- `THREAD` in budget hard stops (`BUDGET_STOP_COMMANDS`), thread spend in fleet analytics (`NAX_JOBS`), and dashboard
  attention rules for `THREAD` jobs belong to feature `fleet-s5a-thread-ingest` (B2).
- The runner session host, worktree, tools, skill fetch, the runner's `threadBackends` report and READOPT handling of
  `THREAD` jobs belong to feature `fleet-s5a-thread-runner` (B3), which also bumps the package
  `FLEET_PROTOCOL_VERSION` to 4; this feature leaves it at 3.
- Thread pages, composables and navigation belong to feature `fleet-s5a-thread-web` (B4).
- `write_doc`, Publish (`THREAD_PUBLISH` is declared but never queued; no `action: PUBLISH` job is created), Plan and
  Run from a thread, and `threads.busy` belong to phase C.
- ACP backends are accepted at create and matched by placement, but no runner reports them before phase D.
- A resume job pinned to a runner that stopped reporting the thread's backend waits QUEUED; no misfit is surfaced on
  the thread.
- Moving a thread to another runner, thread delete, search and export, editing a past message, turn notifications and
  CLI commands.
- Deleting a runner sets the threads' `runnerId` to null (`SetNull`); the next session is placed afresh with
  `resume: true`, and the runner side treats a missing transcript as a fresh session (B3).
- QUEUED THREAD jobs share the oldest-first `QUEUED_SCAN_LIMIT` window with other jobs; a large backlog of one kind can
  delay the other within a fill.
- US-003 only: input bounds other than `feature` and `backend` (`baseRef` format, `title` length and control
  characters, `maxCostUsd` range and decimals) share the create-input validation; only `feature` and `backend` are
  pinned by acceptance criteria.
- US-005 only: an empty `text` and a malformed `clientMessageId` share the send-input validation; only the 32 KiB cap
  is pinned.
- US-007 only: the `PATCH` cap bounds and the `answer` `requestId` and `text` bounds share the same validation as
  create and send; none has a dedicated acceptance criterion.
- US-007 only: until B2 clears `pendingQuestion` on the answering turn, a repeated `answer` for the same `requestId` queues a second `THREAD_ANSWER`; nax-agent reports the second as not pending on the runner. The API does not check `pendingQuestion.expiresAt`.
- US-003 only: the query bounds of the list and messages routes (`status` other than `ACTIVE` / `ARCHIVED`, `afterSeq` not a non-negative integer, `limit` outside 1..200 answer 400 `threads.input`) have no dedicated acceptance criterion; neither do the snapshot's ordering and its exclusion of sources without a resolved SHA.
- Dashboard runner loads (`DashboardService` calls `toLoads` on held refs without `command`) still count THREAD jobs as ordinary jobs, so dry-run verdicts for other jobs can be pessimistic while threads run; B2 owns the dashboard.
- US-004 only: no acceptance criterion forces a job end to interleave with a send; the lock order (job, then thread)
  is the guarantee.
- US-003 only: every thread route refuses agent keys through the same `assertUser` check; only create pins it with an
  acceptance criterion.
- US-004 only: two concurrent sends are serialized by the `ChatThread` row lock and the active `(repoId, feature)`
  index on `thread-<id>`; no acceptance criterion races two requests.
- US-005 only: check pairs other than archived-before-cost-cap and dedupe-before-archived follow the documented
  order without a dedicated acceptance criterion.
- US-007 only: end session and answer refuse a non-creator and a thread without a live session through the same
  checks as stop; only stop pins them.
- US-007 only: the `THREAD_ANSWER` ack payload replacement shares the `THREAD_INPUT` branch; only `THREAD_INPUT` is
  pinned.
- US-007 only: the terminal hook runs for every terminal transition of a THREAD job; only the sweeper crash path is
  pinned.
- US-007 only: the lock serialization of two concurrent end-session calls, and of an archive racing a send, has no
  acceptance criterion.

## Stories

1. **US-001: Thread protocol contract** — `Workdir: apps/api` — no dependencies.
2. **US-002: Thread data, kill switch and runner thread capacity** — `Workdir: apps/api` — depends on US-001.
3. **US-003: Thread create, list, get and messages routes** — `Workdir: apps/api` — depends on US-002.
4. **US-004: Send message: session start and live input** — `Workdir: apps/api` — depends on US-003.
5. **US-005: Send message guards** — `Workdir: apps/api` — depends on US-004 (same service and route).
6. **US-006: THREAD placement** — `Workdir: apps/api` — depends on US-005 (seams through the send route).
7. **US-007: Session commands, archive and job-end effects** — `Workdir: apps/api` — depends on US-006 (both edit
   `sync.service.ts`).

US-001 also edits `packages/fleet-protocol/src/index.ts` and creates `packages/fleet-protocol/src/threads.ts`
(type-only consumers in the API; the runner compiles against them). Build gate for US-001: `bun run type-check` at the
repo root (API and runner compile against the widened unions).

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `packages/fleet-protocol/src/index.ts` — gains the `threads.ts` re-export and the widened unions and optional fields
- `apps/api/src/fleet/common/protocol.ts` — `SUPPORTED_FLEET_PROTOCOL_VERSIONS` gains 4
- `apps/api/src/common/enums.ts` — `FleetJobKind.THREAD` and the five thread command types
- `apps/api/src/fleet/common/capabilities-core.ts` — gains strict `threadBackends` parsing
- `apps/api/src/fleet/common/config-jobs.ts` — runtime-mirror pattern for `thread-jobs.ts` (and `jobs/dto/fleet-job.dto.ts`, whose `command` enum gains `THREAD`)

**US-002**

- `apps/api/src/config/fleet.config.ts` — gains `threadsEnabled` from `FLEET_THREADS_ENABLED`
- `apps/api/src/fleet/runners/runners.service.ts` — `update` gains `threadCapacity` (with `runner.domain.ts` and `prisma-runner.repository.ts`)
- `apps/api/src/fleet/runners/dto/runner.dto.ts` — `RunnerDto` gains `threadCapacity`
- `apps/api/src/fleet/runners/dto/update-runner.dto.ts` — gains `threadCapacity` (0..16)
- `apps/api/test/helpers/migration-schema.ts` — `scratchSchemaBefore`, `applyMigration`

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` — guard, CASL ability (`casl.createForUser(withProjectRole(...))`), `isUserPrincipal` pattern
- `apps/api/src/skills/skill-catalog.domain.ts` — `SkillCatalogRepository` gains `listEnabledSnapshot`
- `apps/api/src/skills/skills.service.ts` — gains `snapshotForProject` (with `prisma-skill-catalog.repository.ts`)
- `apps/api/src/fleet/fleet.module.ts` — gains `ThreadsModule` in `imports`
- `apps/api/test/helpers/fleet-fixtures.ts` — `seedFleetBase`, `insertRunner`, `seedFleetHttpWorld`

**US-004**

- `apps/api/src/fleet/threads/threads.controller.ts` — created by US-003, gains `POST /:id/messages`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — created by US-003, gains seq allocation and the message, job-input and command writes
- `apps/api/src/fleet/repo-config/config-jobs.service.ts` — job plus 1:1 input row in one transaction, then `placeJob`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `NewFleetJob` and `FleetJobRecord` gain `threadId`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `createJob` writes `threadId`

**US-005**

- `apps/api/src/fleet/threads/thread-session.service.ts` — created by US-004, gains the ordered checks
- `apps/api/src/fleet/budgets/budget-gate.ts` — `assertNotPaused`
- `apps/api/src/fleet/common/runner-online.ts` — `isRunnerOnline`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `requeue` refuses THREAD jobs

**US-006**

- `apps/api/src/fleet/jobs/placement-rules.ts` — THREAD load class and misfits
- `apps/api/src/fleet/jobs/placement.service.ts` — `fillRunnerThreads`, thread pin at assign, `fillRunner` skips THREAD
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findActiveLoads` command, `findPlacementRunners` protocol fields, `findThreadAssign`, `pinThreadRunner`
- `apps/api/src/fleet/sync/sync.service.ts` — calls `fillRunnerThreads` for v4 syncs
- `apps/api/src/fleet/dashboard/attention-unplaceable.ts` — `jobUnplaceableItems` skips THREAD jobs (with `MISFIT_REASONS` in `dashboard.types.ts` and the `PlacementMisfitDto` enum)

**US-007**

- `apps/api/src/fleet/sync/command-ack.processor.ts` — thread ack branch
- `apps/api/src/fleet/jobs/job-transitions.service.ts` — thread terminal hook
- `apps/api/src/fleet/sync/sync.service.ts` — response gains `archivedThreadIds` (and `job-outcome.recorder.ts` skips THREAD jobs)
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` — imports `ThreadStoreModule`
- `apps/api/src/fleet/sync/sync.module.ts` — imports `ThreadStoreModule`

### Creates

> New files each story authors.

**US-001**

- `packages/fleet-protocol/src/threads.ts` — thread kind, command types, backends, assign and payload types, `THREAD_LIMITS`
- `apps/api/src/fleet/common/thread-jobs.ts` — runtime mirror: `THREAD_JOB_KIND`, `isThreadKind`, `THREAD_COMMAND_TYPES`, `THREAD_LIMITS`, `MODEL_ID_RE`, type re-exports
- `apps/api/src/fleet/common/thread-jobs.spec.ts` — mirror parity and `isThreadKind`

**US-002**

- `apps/api/prisma/migrations/20261013090000_chat_threads/migration.sql` — `ChatThread`, `ChatMessage`, `FleetThreadTurn`, `FleetJob.threadId`, `Runner.threadCapacity`, the partial unique index
- `apps/api/test/integration/fleet/fleet-threads-schema.integration.spec.ts` — constraints and the migration on PG

**US-003**

- `apps/api/src/fleet/threads/thread-store.module.ts` — `ThreadStoreModule` (repository, `CHAT_THREAD_REPOSITORY`; later `ThreadJobEffects`)
- `apps/api/src/fleet/threads/threads.module.ts` — `ThreadsModule`
- `apps/api/src/fleet/threads/threads.module.spec.ts` — DI wiring (unit, no DB)
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — domain types and the repository token
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — module-private repository
- `apps/api/src/fleet/threads/threads.service.ts` — create, list, get, messages
- `apps/api/src/fleet/threads/threads.controller.ts` — `ThreadsController`
- `apps/api/src/fleet/threads/thread-input.ts` — create-input validation
- `apps/api/src/fleet/threads/thread-input.spec.ts`
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDto`, `ThreadListDto`
- `apps/api/src/fleet/threads/dto/create-thread.dto.ts`
- `apps/api/src/fleet/threads/dto/chat-message.dto.ts` — `ChatMessageDto`, `ChatMessageListDto`
- `apps/api/src/i18n/en/threads.json`
- `apps/api/src/i18n/zh/threads.json`
- `apps/api/test/integration/fleet/fleet-threads-api.integration.spec.ts`

**US-004**

- `apps/api/src/fleet/threads/thread-session.service.ts` — send
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildThreadInstructions`
- `apps/api/src/fleet/threads/thread-instructions.spec.ts`
- `apps/api/src/fleet/threads/dto/send-message.dto.ts` — `SendMessageDto`, `SendMessageResultDto`
- `apps/api/test/integration/fleet/fleet-thread-send.integration.spec.ts`

**US-005**

- `apps/api/src/fleet/threads/thread-send-rules.ts` — `sendRefusal`, `ThreadSendRefusal`
- `apps/api/src/fleet/threads/thread-send-rules.spec.ts`
- `apps/api/test/integration/fleet/fleet-thread-send-guards.integration.spec.ts`

**US-006**

- `apps/api/test/integration/fleet/fleet-thread-placement.integration.spec.ts`

**US-007**

- `apps/api/src/fleet/threads/thread-job-effects.ts` — `ThreadJobEffects`
- `apps/api/src/fleet/threads/dto/answer-question.dto.ts`
- `apps/api/src/fleet/threads/dto/update-thread.dto.ts`
- `apps/api/test/integration/fleet/fleet-thread-commands.integration.spec.ts` — stop, end session, answer, cap, archive, `archivedThreadIds`
- `apps/api/test/integration/fleet/fleet-thread-job-end.integration.spec.ts` — acks, terminal hook, no outcome notification

### Modifies

**US-001**

- `apps/api/src/fleet/common/protocol.spec.ts` — the `isSupportedProtocolVersion` table row `[4, false]` becomes `[4, true]` and a row `[5, false]` is added, because the API now accepts protocol 4; the `kinds` record literal gains `THREAD: true` and the `commands` record literal gains the five thread command types, because the package unions grew (the `Record<Union, true>` literals no longer compile otherwise). The parity assertions themselves are unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the `FleetJobDto.command` enum gaining `THREAD`; `bun run generate` also refreshes the untracked CLI client.

**US-002**

- `apps/api/prisma/schema.prisma` — gains `ChatThread`, `ChatMessage`, `FleetThreadTurn`, `FleetJob.threadId`, `Runner.threadCapacity` and the back-relations; integration suites build their schema from this file.
- `apps/api/src/config/fleet.config.spec.ts` — gains cases for `FLEET_THREADS_ENABLED`; existing expectations unchanged.
- `apps/api/src/common/test-helpers/fleet-config.ts` — `testFleetConfig` returns a complete `IFleetConfig` literal; it gains `threadsEnabled: false`, because the interface grew a required field and the helper is type-checked by `bun run type-check` (only spec files are excluded).
- `apps/api/test/helpers/partial-indexes.ts` — `PARTIAL_UNIQUE_INDEXES` gains `CREATE UNIQUE INDEX IF NOT EXISTS "ChatThread_active_repo_feature_key" ON "ChatThread" ("repoId", "feature") WHERE "status" = 'ACTIVE'`, because integration schemas come from `prisma db push`, which cannot create partial indexes; the same statement appears verbatim in the migration (pinned by the partial-indexes unit spec under apps/api/test/unit/fleet).
- `openapi.json` — regenerated by `bun run api:export-spec` for `RunnerDto.threadCapacity` and `UpdateRunnerDto.threadCapacity`.

**US-003**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds POST /api/projects/:slug/threads (201, and 400 for an invalid feature), GET /api/projects/:slug/threads (200), GET /api/projects/:slug/threads/:id (200, 404) and GET /api/projects/:slug/threads/:id/messages (200), with FLEET_THREADS_ENABLED=true in that suite's environment. Existing expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the thread routes and DTOs.

**US-004**

- `apps/api/test/helpers/fleet-fixtures.ts` — `insertRunner` gains optional `protocolVersion` and `threadCapacity` overrides (defaults unchanged: protocol 1, threadCapacity from the column default) and the file gains an exported `THREAD_CAPS` (`FLEET_CAPS` plus `threadBackends: { native: ['m1'], acp: [] }`), because the send, guard and placement suites need v3 and v4 runners with thread capabilities; existing callers are unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds POST /api/projects/:slug/threads/:id/messages (201, and 403 for a non-creator). Existing expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the send route and DTOs.

**US-005**

None. The fixture overrides it needs land in US-004; the story adds checks to the send route and new test files only.

**US-006**

- `openapi.json` — regenerated by `bun run api:export-spec` for the three new `PlacementMisfitDto.reason` values and the dashboard misfit enums.

The new `RunnerLoad`, `PlacementRunner` and `ActiveJobRef` fields are optional, so the literals in
`placement-rules.spec.ts`, `attention-unplaceable.spec.ts` and `attention-rules.spec.ts` compile and keep their
verdicts; `fleet-job-repository.integration.spec.ts` matches runners with `expect.objectContaining`.

**US-007**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds POST /api/projects/:slug/threads/:id/stop (409 without a live session), POST .../end-session (409), POST .../answer (409), PATCH /api/projects/:slug/threads/:id (200) and POST .../archive (200). Existing expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the command, cap and archive routes.

### Seams

- SEAM-1 (US-001 -> US-006): `isThreadKind` and `threadBackends` drive placement; US-006 ACs feed a parsed capability
  report through `POST /api/fleet/runner/sync` and assert the assignment.
- SEAM-2 (US-003 -> US-003): `SkillsService.snapshotForProject` is called by thread create; a US-003 AC spies on the
  booted app's `SkillsService`, triggers `POST /api/projects/:slug/threads`, and asserts the call.
- SEAM-3 (US-004 -> US-006): the THREAD job and its `FleetThreadTurn` written by the send route are what
  `findThreadAssign` turns into `AssignPayload.thread`; a US-006 AC triggers `POST .../threads/:id/messages` with an
  eligible runner and asserts the ASSIGN payload.
- SEAM-4 (US-004): the send route calls `PlacementService.placeJob` and `RunnerNotifier.notify`; US-004 ACs spy on the
  booted app's providers and trigger `POST .../threads/:id/messages`.
- SEAM-5 (US-007): `ThreadJobEffects.onJobEnded` runs inside `JobTransitionsService.apply`; a US-007 AC triggers the
  scheduled `FleetSweeper.sweep(now)` against a silent runner and asserts the message rows.
  `ThreadJobEffects.onInputAck` runs inside `CommandAckProcessor`; US-007 ACs post the ack through
  `POST /api/fleet/runner/sync`.

## Acceptance Criteria

### US-001: Thread protocol contract (`Workdir: apps/api`)

1. [unit] `isThreadKind('THREAD')` imported from `apps/api/src/fleet/common/thread-jobs.ts` returns `true`.
2. [unit] `isThreadKind('RUN')` returns `false`.
3. [unit] `isSupportedProtocolVersion(4)` returns `true`.
4. [unit] `isSupportedProtocolVersion(5)` returns `false`.
5. [unit] The API's `THREAD_COMMAND_TYPES` deep-equals the `THREAD_COMMAND_TYPES` exported by `@nathapp/fleet-protocol` (runtime import in the spec), which is `['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH']`.
6. [unit] The API's `THREAD_LIMITS` deep-equals the package's `THREAD_LIMITS`, which is `{ messageMaxBytes: 32768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 }`.
7. [unit] `Object.values(FleetCommandType)` from `apps/api/src/common/enums.ts` includes each of the five values of `THREAD_COMMAND_TYPES`.
8. [unit] `parseCapabilitiesCore` on a valid report plus `threadBackends: { native: ['deepseek-v3'], acp: ['claude'] }` returns `threadBackends` deep-equal to `{ native: ['deepseek-v3'], acp: ['claude'] }`.
9. [unit] `parseCapabilitiesCore` on a valid report without `threadBackends` returns an object that has no `threadBackends` key.
10. [unit] `parseCapabilitiesCore` with `threadBackends.native` holding 33 distinct valid model ids throws `CapabilityValidationError` with `reason` `threadBackends`.
11. [unit] `parseCapabilitiesCore` with `threadBackends: { native: [], acp: ['gemini'] }` throws `CapabilityValidationError` with `reason` `threadBackends`.
12. [unit] `parseCapabilitiesCore` with `threadBackends: { native: ['bad model'], acp: [] }` throws `CapabilityValidationError` with `reason` `threadBackends`.
13. [unit] `parseCapabilitiesCore` with `threadBackends: { native: [], acp: [], other: [] }` throws `CapabilityValidationError` with `reason` `threadBackends`.

### US-002: Thread data, kill switch and runner thread capacity (`Workdir: apps/api`)

1. [unit] The `fleetConfig` factory with `FLEET_THREADS_ENABLED` unset returns `threadsEnabled: false`.
2. [unit] The `fleetConfig` factory with `FLEET_THREADS_ENABLED=true` returns `threadsEnabled: true`.
3. [unit] The `fleetConfig` factory with `FLEET_THREADS_ENABLED=yes` returns `threadsEnabled: false`.
4. [integration] `GET /api/fleet/runners/:id` as a global ADMIN for a runner inserted without a `threadCapacity` value returns `threadCapacity: 2`.
5. [integration] `PATCH /api/fleet/runners/:id` with `{ threadCapacity: 3 }` as a global ADMIN answers 200 and the response's `threadCapacity` is 3.
6. [integration] `PATCH /api/fleet/runners/:id` with `{ threadCapacity: 0 }` as a global ADMIN answers 200 and the response's `threadCapacity` is 0.
7. [integration] `PATCH /api/fleet/runners/:id` with `{ threadCapacity: 17 }` as a global ADMIN answers 400.
8. [integration] Inserting a second `ChatThread` row with `status` `ACTIVE` and the same `repoId` and `feature` as an existing ACTIVE row fails with a unique-constraint violation.
9. [integration] Inserting an `ACTIVE` `ChatThread` row with the same `repoId` and `feature` as an existing `ARCHIVED` row succeeds.
10. [integration] Inserting a second `ChatMessage` row with the same `threadId` and `seq` fails with a unique-constraint violation.
11. [integration] Inserting a second `ChatMessage` row with the same `threadId` and a non-null `clientMessageId` equal to an existing row's fails with a unique-constraint violation.
12. [integration] Inserting two `ChatMessage` rows in one thread with `clientMessageId` null (and different `seq`) succeeds.
13. [integration] Deleting a `FleetJob` row deletes its `FleetThreadTurn` row.
14. [integration] Applying the `20261013090000_chat_threads` migration with `applyMigration` to a scratch schema from `scratchSchemaBefore` that holds one `Runner` row leaves that row with `threadCapacity` 2.

### US-003: Thread create, list, get and messages routes (`Workdir: apps/api`)

1. [integration] With `FLEET_THREADS_ENABLED=true`, `POST /api/projects/:slug/threads` by a project DEVELOPER with `{ repoId, feature: 'add-auth', title: 'Auth', backend: { kind: 'native' } }` answers 201 with `status` `ACTIVE`, `createdById` equal to the caller, `baseRef` equal to the repo's default branch, `specPath` `.nax/features/add-auth/spec.md` and `maxCostUsd` `'5'`.
2. [integration] When the project has `spec-review` enabled from a source with `resolvedSha` `S` and `spec-writing` from the same source not enabled, the created thread's `skills` deep-equals `[{ sourceId, owner, repo, sha: 'S', skills: [{ name: 'spec-review', dir: 'skills/spec-review', description }] }]` with the source's id, owner and repo and the skill's description.
3. [integration] With `jest.spyOn(app.get(SkillsService), 'snapshotForProject')`, `POST /api/projects/:slug/threads` calls `snapshotForProject` once with the project's id.
4. [integration] After a successful `POST /api/projects/:slug/threads`, no `FleetJob` row has that thread's id as `threadId`.
5. [integration] `POST /api/projects/:slug/threads` by a project VIEWER answers 403.
6. [integration] `POST /api/projects/:slug/threads` with a rostered agent's API key answers 403 with the `threads.principal` message.
7. [integration] With `FLEET_THREADS_ENABLED` unset, `POST /api/projects/:slug/threads` by a project DEVELOPER answers 409 with the `threads.disabled` message.
8. [integration] `POST /api/projects/:slug/threads` with `feature: 'Add Auth'` answers 400 with the `threads.input` message.
9. [integration] `POST /api/projects/:slug/threads` with `backend: { kind: 'acp', agent: 'gemini' }` answers 400 with the `threads.input` message.
10. [integration] A second `POST /api/projects/:slug/threads` with the same `repoId` and `feature` as an ACTIVE thread answers 409 with the `threads.featureTaken` message.
11. [integration] `POST /api/projects/:slug/threads` with the `repoId` of another project's fleet repo answers 404.
12. [integration] `GET /api/projects/:slug/threads` by a project VIEWER answers 200 with the project's threads ordered by `lastActivityAt` descending.
13. [integration] With `FLEET_THREADS_ENABLED` unset, `GET /api/projects/:slug/threads/:id` by a project member answers 200.
14. [integration] `GET /api/projects/:slug/threads/:id` for a thread of another project answers 404 with the `threads.notFound` message.
15. [integration] `GET /api/projects/:slug/threads/:id/messages?afterSeq=1` on a thread with messages of `seq` 1, 2 and 3 answers 200 with `items` of `seq` 2 and 3 in that order.

### US-004: Send message: session start and live input (`Workdir: apps/api`)

1. [unit] `buildThreadInstructions({ repo: 'acme/app', baseRef: 'main', feature: 'add-auth', specPath: '.nax/features/add-auth/spec.md', skills: [<source with skill spec-review, description 'Review a spec'>] })` returns text whose lines include `- spec-review — Review a spec`.
2. [unit] The same call returns text that includes `.nax/features/add-auth/spec.md`.
3. [unit] The same call returns text that includes the sentence `Put the spec draft in your reply.`
4. [unit] `buildThreadInstructions` with `skills: []` returns text whose last line is `Skills available: none.`
5. [integration] The first `POST /api/projects/:slug/threads/:id/messages` by the creator with `{ text: 'hello', clientMessageId: 'c1' }` answers 201 with a message whose `role` is `user`, `status` `pending`, `seq` 1 and `authorUserId` the creator.
6. [integration] That call creates exactly one `FleetJob` with `command` `THREAD`, `threadId` the thread's id, `feature` `thread-<threadId>`, `ref` the thread's `baseRef`, `profiles` empty, `bashMode` `raw` and `pinnedRunnerId` null.
7. [integration] On a thread with `maxCostUsd` 5 and `costUsd` 1.25, the first send creates a THREAD job whose `maxCostUsd` is `'3.75'`.
8. [integration] The first send creates a `FleetThreadTurn` for the new job with `action` `SESSION`, `initialMessageId` the new message's id, `resume` false, and `backend` and `skills` deep-equal to the thread's.
9. [integration] The first send stores `FleetThreadTurn.instructions` equal to `buildThreadInstructions` called with the thread's repo `owner/name`, `baseRef`, `feature`, `specPath` and `skills`.
10. [integration] With `jest.spyOn(app.get(PlacementService), 'placeJob')`, the first send calls `placeJob` once with the new job's id.
11. [integration] On a thread with `runnerId` R (online, `protocolVersion` 4) and one COMPLETED THREAD job, a send creates a new THREAD job with `pinnedRunnerId` R whose `FleetThreadTurn.resume` is true.
12. [integration] On a thread whose THREAD job is RUNNING on an online runner R with `protocolVersion` 4 at lease epoch E with no `THREAD_CLOSE` command and no pending message, a send creates no `FleetJob` and creates one `FleetCommand` of type `THREAD_INPUT` for runner R and epoch E whose payload deep-equals `{ messageId: <new message id>, text: 'hello' }`.
13. [integration] With `jest.spyOn(app.get(RunnerNotifier), 'notify')`, a send to a live session on an online runner R with `protocolVersion` 4 calls `notify` with R.
14. [integration] Repeating a send with the same `clientMessageId` answers 200 with the same message id, and the counts of `FleetJob` and `FleetCommand` rows are unchanged.
15. [integration] A send on a thread whose last message has `seq` 1 (status `complete`) creates a message with `seq` 2.

### US-005: Send message guards (`Workdir: apps/api`)

1. [unit] `sendRefusal` for a state that is both archived and over the cost cap returns `archived`.
2. [integration] `POST /api/projects/:slug/fleet/jobs/:id/requeue` by a project DEVELOPER on a CRASHED THREAD job answers 409 with the `fleet.jobState` message and the job stays CRASHED.
3. [integration] A send by a project DEVELOPER who is not the thread's creator answers 403 with the `threads.notCreator` message.
4. [integration] With `FLEET_THREADS_ENABLED` unset, a send by the creator answers 409 with the `threads.disabled` message.
5. [integration] A send on an ARCHIVED thread answers 409 with the `threads.archived` message.
6. [integration] A send on a thread with `costUsd` 5 and `maxCostUsd` 5 answers 409 with the `threads.costCap` message.
7. [integration] A send on a thread whose project has a paused budget policy answers 409 with the `fleet.budgetPaused` message.
8. [integration] A send on a thread whose `runnerId` names a runner with `lastSeenAt` older than `FLEET_RUNNER_OFFLINE_SEC` answers 409 with the `threads.runnerOffline` message and creates no `ChatMessage` row.
9. [integration] A send on a thread whose `runnerId` names an online runner with `protocolVersion` 3 answers 409 with the `threads.runnerOutdated` message.
10. [integration] A send on a thread whose current THREAD job is UPLOADING answers 409 with the `threads.closing` message.
11. [integration] A send on a thread whose current THREAD job is RUNNING with a `THREAD_CLOSE` command at its epoch answers 409 with the `threads.closing` message.
12. [integration] A send on a thread that has a message in `pending` answers 409 with the `threads.turnRunning` message.
13. [integration] A send with a `text` of 32 769 UTF-8 bytes answers 400 with the `threads.input` message.
14. [integration] A first send on a thread with no `runnerId` while every runner is offline answers 201, the new THREAD job stays QUEUED and the message stays `pending`.
15. [integration] A repeated `clientMessageId` on a thread archived after the first send answers 200 with the existing message.

### US-006: THREAD placement (`Workdir: apps/api`)

1. [unit] `toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD' }])` gives runner `r1` a load with `active` 0, an empty `repoIds` and `threads` 1.
2. [unit] `firstMisfit` for a RUN job on repo `rA` against an online runner with `capacity` 1 whose only held job is a THREAD job on `rA` (load from `toLoads`) returns null.
3. [unit] `firstMisfit` for a THREAD job with `thread: { backend: { kind: 'native' }, enabled: true }` against an online runner with `capacity` 1, `protocolVersion` 4, `threadCapacity` 2, `threadBackends: { native: ['m1'], acp: [] }` and a load of `active` 1, `repoIds` containing the job's repo and `threads` 0 returns null.
4. [unit] The same THREAD job against the same runner with a load of `threads` 2 returns `thread_capacity`.
5. [unit] A THREAD job with `backend: { kind: 'native', model: 'm2' }` against a runner whose `threadBackends.native` is `['m1']` returns `thread_backend`.
6. [unit] A THREAD job with `backend: { kind: 'acp', agent: 'claude' }` against a runner whose `threadBackends.acp` is empty returns `thread_backend`.
7. [unit] A THREAD job against a runner with `protocolVersion` 3 returns `protocol`.
8. [unit] A THREAD job with `thread.enabled` false returns `threads_disabled`.
9. [unit] A THREAD job against a runner whose `interaction.ok` is false and whose `sandbox.available` is false (otherwise fitting) returns null.
10. [integration] With an online runner R reporting `protocolVersion` 4 and `threadBackends: { native: ['m1'], acp: [] }`, the first `POST /api/projects/:slug/threads/:id/messages` leaves the new THREAD job ASSIGNED to R and sets the thread's `runnerId` to R.
11. [integration] In the same setup, the ASSIGN `FleetCommand` for the THREAD job has a payload whose `thread` deep-equals `{ threadId, action: 'SESSION', feature: 'add-auth', resume: false, instructions, backend: { kind: 'native' }, skills, initialMessage: { messageId, text: 'hello' } }` with the thread's id, the stored instructions and skills, and the new message's id.
12. [integration] `POST /api/fleet/runner/sync` from runner R with `protocolVersion` 4, `freeSlots` 0 and `capabilities` carrying `threadBackends: { native: ['m1'], acp: [] }`, while a QUEUED THREAD job is pinned to R, answers with an ASSIGN command for that job.
13. [integration] `POST /api/fleet/runner/sync` from runner R with `protocolVersion` 3 and `freeSlots` 1, while a QUEUED THREAD job is pinned to R, answers with no ASSIGN command for that job and the job stays QUEUED.
14. [integration] Dispatching a RUN job on repo `rA` through `POST /api/projects/:slug/fleet/jobs` while runner R (`capacity` 1, the only runner) holds a RUNNING THREAD job on `rA` assigns the RUN job to R.
15. [integration] `GET /api/fleet/dashboard` as a global ADMIN, while a THREAD job has been QUEUED for longer than `FLEET_JOB_QUEUED_WARN_SEC`, answers 200 with no attention item whose `subjectId` is that job.

### US-007: Session commands, archive and job-end effects (`Workdir: apps/api`)

1. [integration] `POST /api/projects/:slug/threads/:id/stop` by the creator on a live session on runner R at epoch E answers 200 and creates one `FleetCommand` of type `THREAD_STOP_TURN` for R and E with payload `{}`.
2. [integration] `POST /api/projects/:slug/threads/:id/stop` on a thread with no live session answers 409 with the `threads.noSession` message.
3. [integration] `POST /api/projects/:slug/threads/:id/stop` by a project DEVELOPER who is not the creator answers 403 with the `threads.notCreator` message.
4. [integration] `POST /api/projects/:slug/threads/:id/end-session` by the creator on a live session answers 200 and creates one `FleetCommand` of type `THREAD_CLOSE` for the session's runner and epoch.
5. [integration] `POST /api/projects/:slug/threads/:id/answer` with `{ requestId: 'q1', text: 'yes' }` on a live session whose thread has `pendingQuestion.requestId` `q1` creates one `FleetCommand` of type `THREAD_ANSWER` with payload `{ requestId: 'q1', text: 'yes' }`.
6. [integration] `POST /api/projects/:slug/threads/:id/answer` with `requestId` `q2` while the pending question is `q1` answers 409 with the `threads.noQuestion` message.
7. [integration] `PATCH /api/projects/:slug/threads/:id` with `{ maxCostUsd: 10 }` by the creator answers 200 with `maxCostUsd` `'10'`.
8. [integration] `POST /api/projects/:slug/threads/:id/archive` by the creator on a thread whose THREAD job is RUNNING answers 200 with `status` `ARCHIVED`, and the job has `cancelRequestedAt` set and one `CANCEL` command.
9. [integration] `POST /api/projects/:slug/threads/:id/archive` by a project ADMIN who is not the creator answers 200.
10. [integration] `POST /api/projects/:slug/threads/:id/archive` by a project DEVELOPER who is not the creator answers 403 with the `threads.notCreator` message.
11. [integration] `POST /api/fleet/runner/sync` from runner R answers with `archivedThreadIds` deep-equal to `[T1]` when thread T1 is ARCHIVED with `runnerId` R, thread T2 is ACTIVE with `runnerId` R, and thread T3 is ARCHIVED with another runner.
12. [integration] `POST /api/fleet/runner/sync` from runner R with a `commandAcks` entry `{ result: 'rejected', detail: 'stale_input' }` for a pending `THREAD_INPUT` sets that command's message `status` to `errored` and `errorReason` to `stale_input`.
13. [integration] `POST /api/fleet/runner/sync` from runner R with a `commandAcks` entry `{ result: 'ok' }` for a `THREAD_INPUT` leaves that `FleetCommand`'s payload deep-equal to `{ messageId }`.
14. [integration] `FleetSweeper.sweep(now)` with runner R silent past `FLEET_JOB_CRASH_SEC` while R holds a RUNNING THREAD job of thread T, which has a `pending` message with content `hi` and a `pendingQuestion`, moves the job to CRASHED, sets that message's `status` to `errored` with `content` still `hi`, and sets T's `pendingQuestion` to null.
15. [integration] After `FleetSweeper.sweep(now)` crashes a THREAD job, the outbox holds no `fleet_job_outcome` row for that job.
