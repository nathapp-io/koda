# SPEC: Fleet S5a-B2 — Thread Ingest (Thread Stream, Durable Fold, Cost, Content SSE, Budgets, Dashboard)

## Summary

The runner now hosts brainstorm-thread sessions (B3b, PR #260) and ships every session event as one JSON line on a
`thread` log stream (`PUT /fleet/runner/jobs/:jobId/logs/thread`). The API refuses that stream today, so no reply ever
reaches a thread. This feature makes the API accept the `thread` stream and fold it, durably and exactly once, into the
thread's rows: user messages become `complete`, assistant messages stream in, tool calls are summarised, questions
are raised, session state is recorded, and usage cost and tokens accrue to the message, the thread, the THREAD job and
the fleet cost ledger (`FleetCostEvent`). It adds a content-carrying SSE per thread, puts THREAD jobs under budget hard
stops, makes thread spend visible in fleet spend analytics, catches up unfolded streams at startup, and stops the
dashboard from counting THREAD jobs as ordinary runner load.

This is feature B2 of fleet S5a phase B. Umbrella design:
`docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` (§2.4, §3.2, §3.3, §3.4). B1
`fleet-s5a-thread-core` (#256) built the thread data, routes, send path and placement; B3a/B3b (#259, #260) built the
runner session host. B4 `fleet-s5a-thread-web` (pages) follows.

## Motivation

Without ingest a thread is write-only: a message is sent, the runner runs the turn and streams the reply, and the API
drops the stream with 400 `fleet.logInput`. The user message stays `pending` forever, no assistant message exists,
`ChatThread.costUsd`, `tokens` and `pendingQuestion` are never written (B1 left them to B2), thread spend is invisible
to budgets' hard stops and to analytics, and the dashboard dry-run counts a long-lived THREAD job as an ordinary job,
so it reports runners as full while they are free for RUN and PLAN work. B4's chat page needs both the folded rows and
a live content feed.

## Design

### Rulings that bind every story

User, 2026-10-12:

- **B2-R1 (cost source):** usage plus reconcile. Every `usage` line adds its cost and tokens as it arrives. At
  `turn_end`, the part of `turn_end.costUsd` (and of each `turn_end.usage` token count) above the turn's summed
  `usage` lines is added as well, so the compaction call that `usage` events leave out is counted. A `turn_end` total
  at or below the summed usage adds nothing.
- **B2-R2 (analytics):** the fold writes one `FleetCostEvent` row per priced `usage` line, and one per positive
  `turn_end` reconcile, so every existing spend panel counts thread spend with no query change. Unpriced usage writes
  no row.
- **B2-R3 (session state):** `ChatThread` gains `session Json?`, written by the fold from the runner's
  `session_started`, `session_closed` and `session_failed` lines and served on `ThreadDto`.

Design decisions recorded with this spec (umbrella deviations marked):

- **B2-D1:** the fold runs after the upload's write lock is released and before the upload answers, so the runner's
  drain-before-UPLOADING (B3b) means every line of a turn is folded before the job's terminal transition. A failing
  fold never fails the upload (the bytes are already durable); the next append or the startup catch-up retries it.
- **B2-D2 (deviation from umbrella §3.3 "persist content at most once per second"):** there is no in-memory delta
  buffer. Each fold transaction writes the content of every message it touched; the runner's wake pacing (at most one
  wake per 250 ms, B3b) bounds the write rate, and nothing is lost on an API restart.
- **B2-D3:** `pendingQuestion` is cleared when the runner acks the `THREAD_ANSWER` for it with `ok` (B1's ack hook),
  at the next `turn_end`, and (already, B1) when the job ends. nax-agent emits no "question resolved" event.
- **B2-D4 (deviation from umbrella §3.3 "append a note to the message"):** an informational question
  (`answerable: false`) becomes a `toolSummary` entry named `ask_human`, because `turn_end` replaces a completed
  message's content with the authoritative output and would erase a note written into it.
- **B2-D5:** the raw `thread` stream is never served by the job-log routes: the list omits it, entries and raw answer
  404 `fleet.logs`, and no `fleet_log` live event is published for it (umbrella §3.2).
- **B2-D6:** money is never accumulated by repeated 4-place rounding. The exact per-line cost lives in
  `FleetCostEvent.costUsd` (8 places); after each fold the job's `costSpentUsd`, the thread's `costUsd` and each
  touched assistant message's `costUsd` are re-derived as the exact sum of their `FleetCostEvent` rows, rounded once to
  4 places (half-up). Many sub-cent rounds therefore add up correctly. All cost comparisons and sums use
  `Prisma.Decimal`, never floating point.
- **B2-D7 (deviation from umbrella §3.4 event fields):** SSE events carry `messageId` (not `id`, which every live event
  already uses for its own unique id), and `thread` carries no `state`: the client refetches the thread.
- **B2-D8:** a fold batch that fails is retried one line at a time; a line whose own fold fails is passed over as a bad
  line (logged), so one poisoned line can never wedge a thread's stream.

### Integration

Read-only symbols (verified on main `88686af2`):

- `LogStore` (`apps/api/src/fleet/logs/log-store.ts:15-23`): `read(key, from, to): Promise<Buffer>` (byte range,
  `to` clamped to size), `size(key)`, `withLock(key, fn)`. `KeyedMutex` (`keyed-mutex.ts`) is in-process and **not
  re-entrant**: code holding a key's lock must not call `withLock` for the same key.
- `IFleetConfig.logScanBytes` (`apps/api/src/config/fleet.config.ts:32`, default at `:128`, `FLEET_LOG_SCAN_BYTES`,
  2 MiB; minimum 65 536 at `env.validation.ts:86`).
- `THREAD_STREAM`, `THREAD_STREAM_LIMITS` (`lineMaxBytes` 65 536), `ThreadRunnerLine`, `ThreadCloseReason`,
  `ThreadFailReason` (`packages/fleet-protocol/src/threads.ts:44-58`). The API may import the package with `import
  type` only (the image does not ship `packages/`; `protocol.spec.ts` pins it), so runtime values are mirrored in
  `apps/api/src/fleet/common/thread-jobs.ts`, which today mirrors none of the stream constants (see the Mutated
  table).
- nax-agent 0.86.0 `SessionEvent` (`SessionEventBase` `{ sessionId, turnId, at, metadata }` plus one body): see
  "Thread stream lines" below. Note `usage` names its cache fields `cacheRead` / `cacheWrite`, while
  `turn_end.usage` (`TokenUsage`) names them `cacheReadTokens` / `cacheWriteTokens`.
- The `ChatThread` seq allocation SQL inside `PrismaChatThreadRepository.sendMessage`
  (`apps/api/src/fleet/threads/prisma-chat-thread.repository.ts:166`): `UPDATE "ChatThread" SET "nextSeq" =
  GREATEST(...) + 1 ... RETURNING "nextSeq" - 1`. Assistant messages allocate `seq` the same way.
- Lock order for every thread write (B1): **job row, then thread row.** `JobTransitionsService.apply` holds the job
  lock when `ThreadJobEffects.onJobEnded` runs.
- `BudgetEvaluator.signal(scopeKeys)` (`apps/api/src/fleet/budgets/budget-evaluator.ts:53`, exported by
  `BudgetsModule`), called only after a commit; `jobSpendKeys(job)` (`budget-rules.ts:45`) gives `global`,
  `project:<id>`, `repo:<id>`, `runner:<id>`.
- `createLiveStream(options)` (`apps/api/src/live/live-stream.ts:31`), `LiveStreamRegistry.tryAcquire / release`
  (`live-stream-registry.ts`), `JwtAuthProvider`, `decodeJwtPayload`, `tokenExpiryMs`, `ILiveConfig` via `LIVE_CFG`
  (`maxStreamsPerUser` 10, `heartbeatMs`), and `LiveController.events` (`live.controller.ts:32-71`) as the pattern.
- `FleetCostEvent` (`apps/api/prisma/schema.prisma:1248`): required `jobId, leaseEpoch, projectId, repoId, at,
  agentName, model, stage, featureName, callId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  costUsd (14,8)`; optional `runnerId, naxRunId, modelTier, profile, sessionRole, storyId, pricingSource, confidence,
  durationMs`; unique `(jobId, leaseEpoch, callId)`. Spend analytics (`prisma-analytics.repository.ts` `spendCells`,
  `spendTotals`, `jobCostSums`) read only this table.
- `toLoads(refs)` (`apps/api/src/fleet/jobs/placement-rules.ts:146-155`) puts a ref whose `command` is `THREAD` into
  `threads` only; a ref without `command` is counted in `active`.

Mutated symbols. **The baseline exists only to locate the code; implement the target.**

| Symbol | Baseline | Target |
|---|---|---|
| `isLogStream` / `LOG_STREAMS` (`apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts:1-6`) | the only stream check, `['run','stdout','stderr']` | unchanged (readable streams); the file gains `UPLOAD_STREAMS = [...LOG_STREAMS, 'thread']` and `isUploadStream(value)` |
| `logKey(jobId, leaseEpoch, stream)` (`apps/api/src/fleet/logs/log-store.ts:28-33`) | `stream: LogStreamName`; throws unless `isLogStream(stream)` | `stream: UploadStreamName`; throws unless `isUploadStream(stream)`; `logKey('j1', 1, 'thread')` = `logs/j1/1/thread.log` |
| `FleetJobLogRecord.stream`, `IFleetJobLogRepository.findStream` / `upsertStream` (`fleet-job-log.domain.ts:9-45`) and `PrismaFleetJobLogRepository` | `LogStreamName` | `UploadStreamName` (`LogStreamName \| 'thread'`); `FleetLogLivePublisher.touch`, `LogReadService` and `LiveFleetLogEvent.stream` keep the narrow `LogStreamName`: `LogReadService` narrows rows with `isLogStream` (which also drops `thread`), and `LogFallbackService` already iterates `LOG_STREAMS` only; the `FleetJobLog.stream` schema comment gains `thread` |
| `apps/api/src/fleet/common/thread-jobs.ts` | no stream constants | gains `THREAD_STREAM = 'thread'` and `THREAD_STREAM_LIMITS = { lineMaxBytes: 65536, streamMaxBytes: 209715200 }`, pinned equal to the package's by `thread-jobs.spec.ts` |
| `LogUploadService.parse` (`log-upload.service.ts:125-133`) | `isLogStream` | `isUploadStream`; then, in `upload`, a `thread` stream for a job whose `command` is not `THREAD` → 400 `fleet.logInput` (`reason: 'stream'`) |
| `LogUploadService.upload` (`:70-93`) | `live.touch` after `appended`/`complete`/`stream_cap` | skips `live.touch` for `thread`; after the lock is released, for those three outcomes, awaits `LogAppendHooks.run({ jobId, leaseEpoch, stream })`, catching and logging a hook failure |
| `LogUploadService` constructor | 7 parameters | an optional 8th, `@Optional() hooks?: LogAppendHooks` (positional spec construction keeps compiling) |
| `LogsModule` (`logs.module.ts`) | — | provides and exports `LogAppendHooks` |
| `LogReadService.target` / `list` (`log-read.service.ts:91-154`) | unknown stream → 400 | unchanged for unknown names; `thread` → 404 `fleet.logs`; `list` drops `thread` rows before building attempts, so an epoch whose only row is `thread` (and that has no log events) is not listed |
| `PrismaChatThreadRepository.mapMessage` (`prisma-chat-thread.repository.ts:260-263`) and `messages()` (`:71-73`, which maps rows inline today) | both spread every column except `threadId` | `messages()` maps through `mapMessage`, which also leaves out `streamRound` and `streamRoundStart`, so neither the list nor the send result carries them |
| `ChatThread` (schema) | no `session` | gains `session Json?` |
| `ChatMessage` (schema) | — | gains `streamRound Int?` and `streamRoundStart Int?` (fold-internal; not on `ChatMessageDto`) |
| `ChatThreadRecord`, `ThreadDto` (`domain/chat-thread.domain.ts:6-12`, `dto/thread.dto.ts:6-26`) | no `session` | gain `session: ThreadSession \| null` |
| `ThreadJobEffects.onInputAck` (`apps/api/src/fleet/threads/thread-job-effects.ts:17`) | `THREAD_ANSWER` ack only rewrites the payload | also, on `result === 'ok'`, reads the command's job (`threadId`; the ack already holds the job lock) and sets that thread's `pendingQuestion` to null when its `requestId` equals the command's `requestId`, before the payload rewrite |
| `BUDGET_STOP_COMMANDS` (`apps/api/src/fleet/budgets/prisma-budget.repository.ts:22`) | `[RUN, PLAN]` | `[RUN, PLAN, THREAD]` |
| `IDashboardRepository.findHeldRefs` (`apps/api/src/fleet/dashboard/domain/dashboard.domain.ts:15`, `prisma-dashboard.repository.ts:67-73`) | `{ runnerId, repoId }[]` | `{ runnerId, repoId, command }[]`, so `toLoads` in `FleetDashboardService.snapshot` classifies THREAD jobs |
| `LiveModule` (`apps/api/src/live/live.module.ts`) | exports `ProjectEventBus`, `UserEventBus` | also provides `ThreadEventBus` and exports it and `LiveStreamRegistry` |
| `FleetModule` (`apps/api/src/fleet/fleet.module.ts`) | — | imports `ThreadIngestModule` |
| `ThreadsModule` (`apps/api/src/fleet/threads/threads.module.ts`) | imports ProjectAccess, Skills, FleetRepos, ThreadStore, FleetJobs | also imports `LiveModule` (`ThreadEventBus`, `LiveStreamRegistry`) and `AuthModule` (`JwtAuthProvider`); declares `ThreadEventsController` |

### Data (US-001)

```prisma
/// Durable fold position of one THREAD job attempt's `thread` stream.
model ThreadIngestCursor {
  jobId        String
  leaseEpoch   Int
  offset       BigInt   @default(0)   // bytes folded; always at a line boundary
  skippedLines Int      @default(0)   // bad or unknown lines passed over
  updatedAt    DateTime @updatedAt
  job          FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  @@id([jobId, leaseEpoch])
}
```

`ChatThread.session Json?`; `ChatMessage.streamRound Int?`, `ChatMessage.streamRoundStart Int?`. Migration
`apps/api/prisma/migrations/20261014090000_thread_ingest/migration.sql`. No partial index.

`ThreadSession` (the `session` JSON; `ThreadDto.session`):
`{ jobId: string; state: 'live' | 'closed' | 'failed'; resumed: boolean; contextReset: boolean; reason: string | null;
at: string }`. `contextReset` is true when the job's `FleetThreadTurn.resume` is true and its `session_started` line
says `resumed: false` (the runner lost the transcript). `null` until a thread's first `session_started` is folded.

### Upload hook (US-001)

`LogAppendHooks` (`apps/api/src/fleet/logs/log-append-hooks.ts`): `register(stream: string, hook: (e: { jobId:
string; leaseEpoch: number; stream: string }) => Promise<void>): void` and `run(e): Promise<void>`, which awaits every
hook registered for `e.stream` in registration order. `LogUploadService.upload` calls `run` after
`store.withLock(...)` has returned (never inside it: the hook takes the same lock) and only for the outcomes
`appended`, `complete` and `stream_cap`. A hook that rejects is logged with the job id and swallowed; the upload
result is unchanged. `ThreadIngestModule` registers a closure that calls `this.ingestor.catchUp(jobId, leaseEpoch)` at
call time (never a bound method captured at registration), so a spy installed on the booted app's `ThreadIngestor`
sees the call.

### Thread stream lines

The stream holds one JSON object per line, written by the runner's `ThreadEventWriter` (B3a): nax-agent session
events with `{ sessionId, turnId, at, metadata }` plus their body, and the runner's own lines (`ThreadRunnerLine`).
Lines are untrusted. A line is **bad** (skipped and counted in `skippedLines`) when it is not valid JSON, not an
object, has no string `type`, is longer than `THREAD_STREAM_LIMITS.lineMaxBytes` (including its newline), or fails its type's
field rules below. Fields not named below are ignored. Every NUL (`\u0000`) in a string value is replaced with U+FFFD
before the fold (PostgreSQL text and jsonb cannot hold NUL). A line's `at`, when it does not parse as a date, reads as
the fold time. Types `thinking_delta`, `compaction` and `tool_progress` are **ignored** (skipped, not counted). Any other
`type` is bad.

| type | required fields (beyond `type`) | fold effect | story |
|---|---|---|---|
| `input_consumed` | `messageId` string 1..64 | the thread's `user` message with that id → `complete`; a message of another thread or another role → bad | US-002 |
| `turn_start` | `turnId` string 1..128 | insert an `assistant` message: `status streaming`, `content ''`, next `seq`, `jobId`, `turnId`; a second `turn_start` with the same `turnId` in the thread → bad | US-003 |
| `text_delta` | `turnId`, `round` integer ≥ 0, `text` string | append `text` to the turn's message content; if `round` differs from `streamRound`, first set `streamRound = round`, `streamRoundStart = content length` | US-003 |
| `stream_reset` | `turnId`, `round` | if `round === streamRound`, cut content to `streamRoundStart` characters | US-003 |
| `turn_end` | `turnId`, `status` one of `completed cancelled timed_out interrupted errored`, `output` string, `usage` object with `inputTokens` and `outputTokens` integers ≥ 0 (optional `cacheReadTokens`, `cacheWriteTokens` integers ≥ 0, absent read as 0), `costUsd` finite ≥ 0; optional `costSource`, `error { code?, message? }`, `outputTruncated` | `content = output` when `status` is `completed`, `output !== ''` and `outputTruncated !== true`, else unchanged (whatever the message's status); only when the message is `streaming`: `status` = `complete` for `completed`, else the end status, and `errored` sets `errorReason` = `error.message` (else `error.code`), at most 200 chars. Always: `pendingQuestion` → null, `lastActivityAt` = fold time, reconcile (US-005) | US-003, US-004, US-005 |
| `tool_call` | `turnId`, `callId` 1..128, `name` 1..128, `input` any | upsert a `toolSummary` entry (below) | US-004 |
| `tool_result` | `turnId`, `callId`, `isError` boolean, `preview` string | set the entry's `isError` and `preview` | US-004 |
| `approval_requested` | `requestId` 1..128; optional `callId` | remember `requestId` on the entry for `callId` | US-004 |
| `approval_resolved` | `requestId`, `decidedBy` string 1..32 | set `decidedBy` on the entry that holds `requestId` | US-004 |
| `question` | `turnId`, `requestId`, `text` string, `expiresAt` string that parses as a date; optional `answerable: false` | answerable → `pendingQuestion = { requestId, text (≤ 2048 chars), expiresAt }`; `answerable: false` → a `toolSummary` entry `{ callId: requestId, name: 'ask_human', preview: text }` | US-004 |
| `usage` | `turnId`, `round` integer, `inputTokens`, `outputTokens` integers ≥ 0, `costUsd` finite ≥ 0; optional `cacheRead`, `cacheWrite` integers ≥ 0, `costSource` one of `computed reported unpriced` | tokens and cost (US-005) | US-005 |
| `session_started` | `resumed` boolean | `session = { jobId, state: 'live', resumed, contextReset, reason: null, at }` | US-004 |
| `session_closed` | `reason` string 1..64 | `session.state = 'closed'`, `reason` | US-004 |
| `session_failed` | `reason` string 1..64 | `session.state = 'failed'`, `reason`; the thread's `pending` and `streaming` messages → `errored` with `errorReason = reason` (content kept) | US-004 |

A line that names a `turnId` with no assistant message in the thread (other than `turn_start`) is bad.
`input_consumed` for a user message that is no longer `pending` changes nothing (not counted as bad).
`session_closed` and `session_failed` while `session` is null set `session` with `resumed: false` and
`contextReset: false`.

`toolSummary` entry: `{ callId, name, input: string, isError: boolean | null, preview: string, decidedBy: string |
null }` (internal `requestId` for approval matching is kept on the entry). `input` is `JSON.stringify(input)` cut to at
most 512 UTF-8 bytes on a code point; `preview` is cut the same way. At most 50 entries per message: a `tool_call` for
a 51st `callId` is skipped (not counted as bad).

### Fold (US-002; line effects US-002 to US-005)

`ThreadIngestor.catchUp(jobId, leaseEpoch): Promise<void>` (`apps/api/src/fleet/threads/ingest/thread-ingestor.ts`),
under `store.withLock(logKey(jobId, leaseEpoch, 'thread'))`:

1. read the cursor (absent → offset 0) and the stored size;
2. while `offset < size`: read `[offset, min(size, offset + logScanBytes))`; take the bytes up to and including the
   last `\n`; if there is none, stop (a partial last line waits for the next append);
3. in **one transaction** (`ThreadIngestRepository.fold(batch)`, where a batch is the parsed lines, the end offset
   and the bad-line count; each parsed line also carries its own end offset, which the line-by-line retry uses; the
   repository also reads the job, its thread and the cursor): lock the job row, then the thread row (B1 lock order); fold each complete line in order;
   re-derive cost (B2-D6); upsert the cursor with `offset = end offset` and `skippedLines += bad lines`. If `fold`
   rejects, the batch is retried one line at a time, each line its own one-line batch; a line whose one-line batch
   rejects is folded as a bad line (cursor moves past it, `skippedLines + 1`) and the error is logged (B2-D8);
4. after the commit: publish the batch's live events (US-006) and, if any cost changed, `BudgetEvaluator.signal(
   jobSpendKeys(job))` (US-005); then loop.

A line is folded exactly once because the cursor moves in the same transaction as the line's effects. A job that is
not a THREAD job, or has no `threadId`, is skipped. `ThreadIngestModule` (`thread-ingest.module.ts`) registers
`catchUp` for stream `thread` with `LogAppendHooks` in `onModuleInit`; it imports `LogsModule`, `BudgetsModule`,
`LiveModule` and `PrismaModule` and keeps its repository (`THREAD_INGEST_REPOSITORY`,
`prisma-thread-ingest.repository.ts`) module-private.

### Cost (US-005)

For a `usage` line, with `cacheRead`/`cacheWrite` absent read as 0:

- tokens: the message's `usage` and the thread's `tokens` (both `{ input, output, cacheRead, cacheWrite }`, absent
  read as zeros) add the line's counts, priced or not, except for a **repeated** priced line: one whose
  `FleetCostEvent` insert was skipped as a duplicate adds no tokens either. A repeated unpriced line cannot be told
  apart and is counted;
- priced (`costSource` absent, `computed` or `reported`): insert (skipping a duplicate `(jobId, leaseEpoch, callId)`, so
  a repeated round never aborts the fold) a `FleetCostEvent` with `jobId`, `leaseEpoch`,
  `projectId`, `repoId`, `runnerId` from the job; `at` = the line's `at` when it parses as a date, else the fold time;
  `agentName` = `'native'` for a native backend, else the ACP `agent`; `model` = the thread backend's `model`, else
  `'default'`; `profile` `'read'`; `stage` `'thread'`; `featureName` = the thread's `feature`; `callId` =
  `<turnId>:<round>`; the four token counts; `costUsd` = the line's cost; `pricingSource` = `costSource ?? 'computed'`;
  the message's `costSource` is set to the same value;
- unpriced: no `FleetCostEvent`.

At `turn_end` (B2-R1): the message's summed tokens are compared with `turn_end.usage` (`inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`); each positive difference is added to the message and the thread. If
`turn_end.costSource` is not `unpriced` and `turn_end.costUsd` exceeds the sum of the turn's `FleetCostEvent` rows, a
`FleetCostEvent` with `callId` `<turnId>:turn_end` and the difference as `costUsd` (token counts 0) is inserted.

Then (B2-D6) `FleetJob.costSpentUsd` = round4(sum of the job's `FleetCostEvent.costUsd` at all epochs),
`ChatThread.costUsd` = round4(sum over the thread's THREAD jobs), and each touched message's `costUsd` =
round4(sum of the events whose `callId` starts with its `turnId` followed by `:`, matched as a literal prefix). The runner sends no `costSpentUsd` snapshot for a
THREAD job (B3b-R4) and no bundle exists, so nothing else writes these.

`THREAD` joins `BUDGET_STOP_COMMANDS`: a hard stop cancels QUEUED THREAD jobs and requests cancel of held ones
through the existing `cancelForBudget`. `windowSpend` already sums every job's `costSpentUsd`.

### Content SSE (US-006)

`ThreadEventBus` (`apps/api/src/live/thread-event-bus.ts`): `subscribe(threadId, listener): () => void`,
`publish(event: ThreadLiveEvent): void` (routes by `event.threadId`, never throws), same shape as `ProjectEventBus`.

`ThreadLiveEvent` = `{ id: <uuid>, threadId, at }` plus one of:

| `type` | extra fields | published after a batch that |
|---|---|---|
| `delta` | `messageId`, `text` | appended text to a message and did not reset it; `text` = all text the batch appended to that message |
| `message` | `messageId` | completed a user message (`input_consumed`), created a message, reset it, ended its turn, changed its `toolSummary`, or errored it |
| `question` | `requestId`, `text` | set `pendingQuestion` |
| `thread` | — | changed the thread's `session`, `costUsd`, `tokens` or `pendingQuestion` |

At most one event of each type per message (and one `thread`) per batch, in the order `message`, `delta`,
`question`, `thread`. Events go out only after the batch commits.

`GET /projects/:slug/threads/:id/events` (`ThreadEventsController`, `thread-events.controller.ts`, in
`ThreadsModule`, `@Sse()`, `@SkipThrottle()`, `@ApiExcludeEndpoint()`): order of checks: not a user principal → 403
`threads.principal`; not a project member → 403 (`assertProjectMembership`); thread not in the project → 404
`threads.notFound`; no JWT payload → 403; `LiveStreamRegistry.tryAcquire(userId, maxStreamsPerUser)` false → 429
(`ThrottleAppException`). Then `createLiveStream({ key: threadId, subscribe: ThreadEventBus.subscribe, stillAllowed:
membership re-check as in LiveController, onClose: release })`. Reconnect = refetch messages, then subscribe (B4).

### Startup catch-up (US-007)

`ThreadIngestBootstrap.onApplicationBootstrap()` (`thread-ingest.bootstrap.ts`, in `ThreadIngestModule`) selects THREAD
jobs that are non-terminal or have `finishedAt` within the last 24 hours, whose `FleetJobLog` `thread` row (per epoch)
has `sizeBytes` greater than that attempt's cursor offset (no cursor = 0), at most 200 attempts ordered by the job's
`createdAt` ascending, and awaits `catchUp` for each in that order. A failing `catchUp` is logged and the next job is still caught up. It runs in tests too (an empty
database makes it a no-op).

### Dashboard (US-007)

`findHeldRefs` returns `command`; `FleetDashboardService.snapshot` already passes the refs to `toLoads`, so held THREAD
jobs leave runners' `activeJobs` and the "queued but not placed" dry-run (`jobUnplaceableItems`) no longer treats them
as capacity or `busy_repo` load. `jobSilentItems` needs no change: a RUNNING THREAD job heartbeats every 30 s
(`threadHeartbeatMs`, B3b) against a 180 s `jobSilentSec`.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| `thread` upload for a non-THREAD job | 400 `fleet.logInput` (`reason: 'stream'`) | US-001 |
| Reading the `thread` stream through the job-log routes | list omits it; entries/raw 404 `fleet.logs` | US-001 |
| An append hook rejects | logged; upload result unchanged; the next append or the startup catch-up folds | US-001 |
| Partial last line | not folded; cursor stays at the last line boundary | US-002 |
| Bad line (malformed JSON, unknown type, foreign message, line over 64 KiB) | skipped, `skippedLines` + 1, following lines fold | US-002 |
| A fold batch fails (a line the database refuses) | retried line by line; the failing line is passed over as bad, the rest fold | US-002 |
| A line naming a turn with no assistant message, or a second `turn_start` for one turn | bad line; no message created or changed | US-003 |
| NUL in a string value | replaced with U+FFFD, then folded | US-003 |
| Ignored type (`thinking_delta`, `compaction`, `tool_progress`) | skipped, not counted | US-002 |
| `turn_end` for a message no longer `streaming` (job already ended) | status kept; content, tokens and cost still applied | US-003 |
| More than 50 tool calls in a turn | calls beyond 50 not summarised | US-004 |
| Oversized tool input or preview | cut to 512 UTF-8 bytes | US-004 |
| `session_failed` | session `failed` with reason; in-flight messages `errored` with the reason | US-004 |
| `THREAD_ANSWER` acked `rejected` | `pendingQuestion` kept | US-004 |
| Unpriced usage | tokens only; no cost, no `FleetCostEvent` | US-005 |
| A repeated priced `usage` round (same `turnId` and `round`) | no second `FleetCostEvent`; cost and tokens unchanged | US-005 |
| Budget hard stop with THREAD jobs | QUEUED cancelled, held ones get `CANCEL` | US-005 |
| SSE: agent key / non-member / foreign thread / stream limit | 403 `threads.principal` / 403 / 404 `threads.notFound` / 429 | US-006 |
| Unfolded stream at startup | caught up; one failing job does not stop the others | US-007 |

## Out of Scope

- Thread pages, composables, the SSE client and polling fallback, and rendering `session`, tool chips and question
  cards belong to feature `fleet-s5a-thread-web` (B4).
- `write_doc` and `published` / `publish_failed` lines, Publish, Plan and Run from a thread belong to phase C; until
  then those line types are counted as bad lines.
- ACP backends (phase D): the fold handles their lines identically; no ACP-specific behaviour is added.
- The API clamp for a negative remaining `maxCostUsd` at dispatch (a B1 follow-up) is not part of this feature.
- Unpriced usage adds no `FleetCostEvent`, so analytics token totals omit unpriced tokens; the thread's own `tokens`
  include them.
- `thinking_delta` and `compaction` lines stay only in the raw stream; nothing renders reasoning text.
- A thread stream left unfolded until log retention deletes it (30 days after the job ended) loses the unfolded lines;
  every append and every startup retries the fold first.
- A line with no newline within `FLEET_LOG_SCAN_BYTES` stalls that stream's fold; the runner caps lines at 64 KiB and
  the scan window is at least 64 KiB.
- The fold assumes a single API instance (`KeyedMutex` is in-process), as the rest of fleet logs does.
- The API does not check `pendingQuestion.expiresAt`; an expired question clears at the next `turn_end` or job end.
- Analytics job panels (`topJobs`, finish results, escalation reasons) keep excluding THREAD jobs (`NAX_JOBS`); only
  spend panels count them.
- The dashboard gains no thread-specific runner field or attention rule.
- Spend analytics `totals.jobs` and `medianJobCostUsd` count THREAD jobs once their cost events exist; that is
  intended, since they read the same cost-event table.
- A fold that fails on a stream's last append is retried only at the next append or the next API start; there is no
  timer-driven retry.
- Per-type field-rule failures other than those pinned (a non-integer `round`, a negative token count, a
  `question.expiresAt` that is not a date, a missing `turnId`) share the line validation without a dedicated
  acceptance criterion in the story that adds each line type.
- US-001 only: `GET .../logs/thread/raw` and the download route share the `thread` refusal of the entries route;
  only entries is pinned.
- US-002 only: two catch-ups of one stream are serialized by the stream's `withLock` key and the fold transaction locks
  the job row, then the thread row (B1 order); no acceptance criterion races two uploads or an upload against a job end.
- The fold stores text as the runner redacted it (`redactSecrets` on deltas, output and error messages; nax-agent's
  best-effort redaction of tool inputs and previews); the API adds no redaction of its own.
- US-003 only: `turn_end` with `outputTruncated: true` keeps the streamed text without a dedicated acceptance
  criterion; it follows the same "content unchanged" rule as a non-completed turn.
- US-002 only: per-type length bounds (`turnId`, `messageId`, `callId`, `name`, `requestId`, `reason`, `decidedBy`)
  share the line validation without a dedicated acceptance criterion.
- US-004 only: `approval_requested` without `callId`, and an `approval_resolved` whose `requestId` matches no entry,
  change nothing and have no dedicated acceptance criterion.
- US-004 only: the 2048-character cut of `pendingQuestion.text` has no dedicated acceptance criterion.
- US-005 only: `reported` pricing follows the `computed` path without a dedicated acceptance criterion; so do the
  reconcile of `cacheRead` / `cacheWrite` and `outputTokens` (only `inputTokens` is pinned), and a `turn_end` whose
  `costSource` is `unpriced`.
- US-005 only: the ACP `agentName` and the `'default'` model fallback share the native path without a dedicated
  acceptance criterion.
- US-006 only: the JWT expiry close and the heartbeat membership re-check reuse `createLiveStream` unchanged and have
  no dedicated acceptance criterion.
- US-007 only: the `createdAt` order and the 200-attempt bound of the startup catch-up have no dedicated acceptance
  criterion.

## Stories

1. **US-001: Thread stream acceptance, read refusal, append hook and schema** — `Workdir: apps/api` — no
   dependencies.
2. **US-002: Thread ingestor engine: cursor, batches, bad lines** — `Workdir: apps/api` — depends on US-001.
3. **US-003: Assistant message lifecycle** — `Workdir: apps/api` — depends on US-002 (same fold module).
4. **US-004: Tools, questions and session state** — `Workdir: apps/api` — depends on US-003.
5. **US-005: Cost, tokens, budget stops and spend analytics** — `Workdir: apps/api` — depends on US-004 (same fold
   module; `turn_end` reconcile builds on US-003's `turn_end`).
6. **US-006: Content SSE** — `Workdir: apps/api` — depends on US-005 (events cover every fold effect, including
   cost).
7. **US-007: Startup catch-up and dashboard loads** — `Workdir: apps/api` — depends on US-006.

US-002 and US-003 are one fold split in two for size: US-002 owns reading, batching, the cursor, bad lines and
failure isolation (proved with `input_consumed`, the simplest line); US-003 owns the assistant message's lines.

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `apps/api/src/fleet/logs/log-upload.service.ts` — `parse` uses `isUploadStream`; THREAD-only `thread`; no `live.touch` for `thread`; awaits `LogAppendHooks.run` after the lock
- `apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts` — gains `UPLOAD_STREAMS`, `UploadStreamName`, `isUploadStream`; repository stream types widen
- `apps/api/src/fleet/logs/log-store.ts` — `logKey` accepts `thread`
- `apps/api/src/fleet/logs/log-read.service.ts` — `thread` → 404 `fleet.logs`, dropped from `list`
- `apps/api/src/fleet/logs/logs.module.ts` — provides and exports `LogAppendHooks`

**US-002**

- `packages/fleet-protocol/src/threads.ts` — `THREAD_STREAM`, `THREAD_STREAM_LIMITS`, `ThreadRunnerLine`
- `apps/api/src/fleet/common/thread-jobs.ts` — gains the stream constants mirror
- `apps/api/src/fleet/logs/log-append-hooks.ts` — created by US-001, registered here
- `apps/api/src/fleet/fleet.module.ts` — imports `ThreadIngestModule`
- `apps/api/test/helpers/thread-fixtures.ts` — created by US-001

**US-003**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — the seq allocation SQL to reuse; `mapMessage` leaves out the round columns
- `apps/api/src/fleet/threads/ingest/thread-fold.ts` — created by US-002, gains the assistant message lines
- `apps/api/src/fleet/threads/ingest/thread-line.ts` — created by US-002, gains the lifecycle field rules
- `apps/api/src/fleet/threads/ingest/thread-ingestor.ts` — created by US-002 (`catchUp`)
- `apps/api/test/helpers/thread-fixtures.ts` — created by US-001

**US-004**

- `apps/api/src/fleet/threads/thread-job-effects.ts` — `onInputAck` clears the answered `pendingQuestion`
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDto` gains `session` (with `domain/chat-thread.domain.ts` and the repository's `mapThread`)
- `apps/api/src/fleet/sync/command-ack.processor.ts` — calls `onInputAck` (unchanged)
- `apps/api/src/fleet/threads/ingest/thread-fold.ts` — created by US-002, gains the tool, question and session lines
- `apps/api/src/fleet/threads/threads.service.ts` — the answer route that queues `THREAD_ANSWER` (unchanged)

**US-005**

- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS` gains `THREAD`
- `apps/api/src/fleet/budgets/budget-evaluator.ts` — `signal`, `evaluate`
- `apps/api/src/fleet/budgets/budget-rules.ts` — `jobSpendKeys`
- `apps/api/src/fleet/analytics/prisma-analytics.repository.ts` — spend panels read `FleetCostEvent`
- `apps/api/src/fleet/threads/ingest/thread-ingestor.ts` — created by US-002, gains cost re-derivation and the budget signal

**US-006**

- `apps/api/src/live/live.controller.ts` — SSE route pattern
- `apps/api/src/live/live.module.ts` — provides `ThreadEventBus`, exports it and `LiveStreamRegistry`
- `apps/api/src/fleet/threads/threads.module.ts` — imports `LiveModule` and `AuthModule`, declares `ThreadEventsController`
- `apps/api/test/integration/live/live-stream.integration.spec.ts` — `expectRefused` and the `app.listen(0)` / `openSse` pattern
- `apps/api/src/fleet/threads/ingest/thread-ingestor.ts` — created by US-002, publishes after commit

**US-007**

- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts` — `findHeldRefs` selects `command`
- `apps/api/src/fleet/dashboard/domain/dashboard.domain.ts` — `findHeldRefs` return type gains `command`
- `apps/api/src/fleet/dashboard/dashboard.service.ts` — `toLoads(held)` (unchanged)
- `apps/api/src/fleet/dashboard/attention-unplaceable.ts` — dry-run over the loads
- `apps/api/src/fleet/threads/ingest/thread-ingest.module.ts` — created by US-002, gains `ThreadIngestBootstrap`

### Creates

> New files each story authors.

**US-001**

- `apps/api/src/fleet/logs/log-append-hooks.ts` — `LogAppendHooks`
- `apps/api/src/fleet/logs/log-append-hooks.spec.ts`
- `apps/api/src/fleet/logs/log-upload-thread.spec.ts` — hook and stream rules on `LogUploadService` (unit)
- `apps/api/prisma/migrations/20261014090000_thread_ingest/migration.sql` — `ThreadIngestCursor`, `ChatThread.session`, `ChatMessage.streamRound` / `streamRoundStart`
- `apps/api/test/helpers/thread-fixtures.ts` — `seedThreadJob` (a thread, a RUNNING THREAD job held by an enrolled runner at epoch 1 with `firstStartedAt` set, its `FleetThreadTurn`, optional `pending` user messages) and `putThreadLines(server, runnerKey, job, lines, offset?)` (JSONL body, SHA-256 header; returns the new size)
- `apps/api/test/integration/fleet/fleet-thread-stream.integration.spec.ts`

**US-002**

- `apps/api/src/fleet/threads/ingest/thread-ingest.module.ts` — `ThreadIngestModule`
- `apps/api/src/fleet/threads/ingest/thread-ingest.module.spec.ts` — DI wiring (unit, no DB)
- `apps/api/src/fleet/threads/ingest/thread-ingestor.ts` — `ThreadIngestor.catchUp`
- `apps/api/src/fleet/threads/ingest/thread-ingestor.spec.ts` — batch failure isolation over a fake repository (unit)
- `apps/api/src/fleet/threads/ingest/thread-line.ts` — `parseThreadLine(raw): ThreadLine | { bad: true } | { ignored: true }`
- `apps/api/src/fleet/threads/ingest/thread-line.spec.ts`
- `apps/api/src/fleet/threads/ingest/thread-fold.ts` — per-line effects inside the fold transaction
- `apps/api/src/fleet/threads/ingest/domain/thread-ingest.domain.ts` — `THREAD_INGEST_REPOSITORY`, `ThreadIngestRepository` (`fold(batch)`, cursor reads)
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts`
- `apps/api/test/integration/fleet/fleet-thread-ingest.integration.spec.ts`

**US-003**

- `apps/api/test/integration/fleet/fleet-thread-messages.integration.spec.ts`

**US-004**

- `apps/api/src/fleet/threads/ingest/tool-summary.ts` — entry upsert, 512-byte cuts, 50-entry cap
- `apps/api/src/fleet/threads/ingest/tool-summary.spec.ts`
- `apps/api/test/integration/fleet/fleet-thread-ingest-session.integration.spec.ts`

**US-005**

- `apps/api/src/fleet/threads/ingest/thread-cost.ts` — cost event building, reconcile differences, `round4`
- `apps/api/src/fleet/threads/ingest/thread-cost.spec.ts`
- `apps/api/test/integration/fleet/fleet-thread-cost.integration.spec.ts`

**US-006**

- `apps/api/src/live/thread-event-bus.ts` — `ThreadEventBus`, `ThreadLiveEvent`
- `apps/api/src/live/thread-event-bus.spec.ts`
- `apps/api/src/fleet/threads/thread-events.controller.ts` — `ThreadEventsController`
- `apps/api/test/integration/fleet/fleet-thread-events.integration.spec.ts`

**US-007**

- `apps/api/src/fleet/threads/ingest/thread-ingest.bootstrap.ts` — `ThreadIngestBootstrap`
- `apps/api/test/integration/fleet/fleet-thread-ingest-bootstrap.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-dashboard-threads.integration.spec.ts`

### Modifies

**US-001**

- `apps/api/prisma/schema.prisma` — gains `ThreadIngestCursor` (with the `FleetJob` back-relation), `ChatThread.session`, `ChatMessage.streamRound` and `ChatMessage.streamRoundStart`; integration suites build their schema from this file.

**US-002**

- `apps/api/src/fleet/common/thread-jobs.spec.ts` — gains a parity case: the API's `THREAD_STREAM` and `THREAD_STREAM_LIMITS` deep-equal the package's (runtime import in the spec), because the mirror gained the stream constants. Existing parity assertions unchanged.

**US-003**

None. `mapMessage` dropping the two new fold-internal columns keeps every existing message payload unchanged; the story adds new test files only.

**US-004**

- `openapi.json` — regenerated by `bun run api:export-spec` for `ThreadDto.session`.

**US-005**

None. `BUDGET_STOP_COMMANDS` is module-private and no existing spec asserts that a THREAD job survives a hard stop; the new behaviour is pinned by new test files.

**US-006**

None. The SSE route is excluded from `openapi.json` (`@ApiExcludeEndpoint()`), like the project and `/me` streams, and `endpoint.e2e.spec.ts` covers no SSE route. `threads.module.spec.ts` compiles `ThreadsModule` with stubs; the new imports resolve there because `LiveModule` and `AuthModule` are importable modules, and its assertions are unchanged.

**US-007**

- `apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts` — the held-refs assertion `expect(await repo.findHeldRefs()).toEqual([{ runnerId, repoId: web.repoId }])` becomes `toEqual([{ runnerId, repoId: web.repoId, command: 'RUN' }])`, because `findHeldRefs` now returns each held job's `command` (the seeded held job is a RUN job). The rows it returns are otherwise unchanged.

### Seams

- SEAM-1 (US-001 -> US-002): `LogAppendHooks.register` is called by `ThreadIngestModule.onModuleInit`; a US-002 AC
  spies on the booted app's `ThreadIngestor.catchUp`, sends `PUT /api/fleet/runner/jobs/:jobId/logs/thread`, and
  asserts the call.
- SEAM-2 (US-005): `BudgetEvaluator.signal` is called after a fold that changed cost; US-005 ACs spy on the booted
  app's `BudgetEvaluator`, send the `thread` PUT, and assert the call (and its absence for a cost-free batch).
- SEAM-3 (US-006): `ThreadEventBus.publish` is called after a fold commits; US-006 ACs open
  `GET /api/projects/:slug/threads/:id/events` and send the `thread` PUT.
- SEAM-4 (US-007): `ThreadIngestBootstrap.onApplicationBootstrap` is the Nest lifecycle entry point; US-007 ACs call it
  on the booted app after writing an unfolded stream and assert the folded rows.

## Acceptance Criteria

Unless stated otherwise, an integration AC uses `seedThreadJob` (thread T of the `web` project, created by `dev`, with
backend `{ kind: 'native', model: 'm1' }` and feature `add-auth`; THREAD job J RUNNING on enrolled runner R at lease
epoch 1 with `firstStartedAt` set; `FleetThreadTurn.resume` false) and sends lines with `putThreadLines` to
`PUT /api/fleet/runner/jobs/J/logs/thread?leaseEpoch=1` as runner R. Lines carry no `at` unless stated (the fold time is
used). Turn id `t1` is used throughout. Cursor offsets are compared as `BigInt`. A `turn_start` named in an AC is
`{ type: 'turn_start', turnId: 't1' }`. A `turn_end` named in an AC carries `turnId: 't1'`, `status: 'completed'`,
`output: ''`, `usage: { inputTokens: 0, outputTokens: 0 }` and `costUsd: 0` unless the AC states other values.

### US-001: Thread stream acceptance, read refusal, append hook and schema (`Workdir: apps/api`)

1. [unit] `logKey('j1', 1, 'thread')` from `log-store.ts` returns `logs/j1/1/thread.log`.
2. [unit] `isLogStream('thread')` from `fleet-job-log.domain.ts` returns `false`.
3. [integration] `PUT /api/fleet/runner/jobs/J/logs/thread?leaseEpoch=1&offset=0` by runner R with a 40-byte JSONL body answers 200 with `{ outcome: 'appended', size: 40 }`, and the `FleetJobLog` row for `(J, 1, 'thread')` has `sizeBytes` 40.
4. [integration] The same PUT for a RUNNING RUN job held by R answers 400 with the `fleet.logInput` message.
5. [integration] After a `thread` upload for J, `GET /api/projects/web/fleet/jobs/J/logs` by `dev` answers 200 and lists no stream named `thread`.
6. [integration] `GET /api/projects/web/fleet/jobs/J/logs/thread/entries?leaseEpoch=1` by `dev` answers 404 with the `fleet.logs` message.
7. [integration] With a listener subscribed through `app.get(ProjectEventBus).subscribe(projectId, ...)`, an appended `thread` upload for J followed by an appended `run` upload for a RUN job of the same project delivers a `fleet_log` event for the RUN job and none for J.
8. [unit] `LogAppendHooks` with a hook registered for `thread`: `run({ jobId: 'j1', leaseEpoch: 1, stream: 'thread' })` calls the hook once with that object.
9. [unit] `LogUploadService` constructed with a `LogAppendHooks` holding a `thread` hook: an upload that appends to stream `thread` of a THREAD job calls the hook once with `{ jobId, leaseEpoch: 1, stream: 'thread' }`.
10. [unit] The same service: repeating an identical `thread` upload (outcome `duplicate`) does not call the hook again.
11. [unit] The same service with a `thread` hook that rejects: the upload resolves `{ outcome: 'appended', size }` with the appended size.
12. [unit] The same service with a `thread` hook that calls `store.withLock(logKey(jobId, 1, 'thread'), ...)`: the upload resolves (the hook runs after the write lock is released).
13. [integration] Inserting a second `ThreadIngestCursor` row with the same `jobId` and `leaseEpoch` fails with a unique-constraint violation.
14. [integration] Deleting a `FleetJob` row deletes its `ThreadIngestCursor` rows.
15. [integration] Applying the `20261014090000_thread_ingest` migration with `applyMigration` to a scratch schema from `scratchSchemaBefore` that holds one `ChatThread` row leaves that row with `session` null.

### US-002: Thread ingestor engine: cursor, batches, bad lines (`Workdir: apps/api`)

Here `seedThreadJob` creates `pending` user messages M1 and M2.

1. [integration] With `vi.spyOn(app.get(ThreadIngestor), 'catchUp')`, a `thread` PUT for J calls `catchUp` with `('J', 1)`.
2. [integration] Putting the line `{ type: 'input_consumed', messageId: M1 }` sets M1's `status` to `complete`, and the `ThreadIngestCursor` for `(J, 1)` has `offset` equal to the stream size.
3. [integration] Putting `input_consumed` with the id of a user message of another thread leaves that message unchanged and sets the cursor's `skippedLines` to 1.
4. [integration] A PUT whose body is the `input_consumed` line for M1 followed by the first half of the `input_consumed` line for M2 (no newline) sets M1 `complete`, leaves M2 `pending` and leaves the cursor at the end of the M1 line; a following PUT with the rest of the M2 line sets M2 `complete`.
5. [integration] A PUT of three lines, `input_consumed` M1, the text `not json`, and `input_consumed` M2, sets M1 and M2 `complete` and `skippedLines` to 1.
6. [integration] Putting a line `{ type: 'foo' }` sets `skippedLines` to 1.
7. [integration] Putting a line `{ type: 'thinking_delta', turnId: 't1', round: 1, text: 'x' }` leaves `skippedLines` 0.
8. [integration] A PUT of `input_consumed` M1, a 70 000-byte line (`input_consumed` M2 with a 70 000-character extra `pad` field), and nothing else sets M1 `complete`, leaves M2 `pending` and sets `skippedLines` to 1.
9. [integration] With `FLEET_LOG_SCAN_BYTES=65536`, a PUT of three `input_consumed` lines for M1, M2 and a third pending message M3, each padded with a 30 000-character extra `pad` field, sets all three messages `complete` and the cursor `offset` to the stream size.
10. [unit] `ThreadIngestor.catchUp` over a fake `ThreadIngestRepository` whose `fold` rejects any batch containing the second of three lines: the first and third lines are folded, the second is folded as a bad line (`skippedLines` 1), and the final cursor offset is the end of the third line.
11. [unit] `parseThreadLine` for the bytes of `{"type":"input_consumed","messageId":"m1"}` returns a line of type `input_consumed` with `messageId` `m1`.
12. [unit] `parseThreadLine` for `{"type":"input_consumed","messageId":7}` returns `{ bad: true }`.
13. [unit] The API's `THREAD_STREAM_LIMITS` from `thread-jobs.ts` deep-equals the package's `THREAD_STREAM_LIMITS` (runtime import in the spec), which is `{ lineMaxBytes: 65536, streamMaxBytes: 209715200 }`.

### US-003: Assistant message lifecycle (`Workdir: apps/api`)

1. [integration] On a thread whose highest message `seq` is 1, putting `{ type: 'turn_start', turnId: 't1' }` creates one `ChatMessage` with `role` `assistant`, `status` `streaming`, `content` `''`, `seq` 2, `jobId` J and `turnId` `t1`.
2. [integration] After `turn_start` `t1`, putting `text_delta` (`round` 1, `text` `Hel`) in one PUT and `text_delta` (`round` 1, `text` `lo`) in a second PUT leaves the message's `content` `Hello`.
3. [integration] After `turn_start` `t1`, putting `text_delta` round 1 `abc`, `stream_reset` round 1 and `text_delta` round 1 `xyz` leaves `content` `xyz`.
4. [integration] After `turn_start` `t1`, putting `text_delta` round 1 `one `, `text_delta` round 2 `two`, `stream_reset` round 2 and `text_delta` round 2 `TWO` leaves `content` `one TWO`.
5. [integration] After deltas `partial`, putting `turn_end` with `status` `completed` and `output` `Final` sets the message's `content` to `Final` and `status` to `complete`.
6. [integration] After deltas `partial`, putting `turn_end` with `status` `cancelled` and `output` `''` keeps `content` `partial` and sets `status` to `cancelled`.
7. [integration] Putting `turn_end` with `status` `errored`, `output` `''` and `error: { code: 'E', message: 'boom' }` sets `status` to `errored` and `errorReason` to `boom`.
8. [integration] After a PUT that folded `turn_start` `t1` and `text_delta` `Hello`, calling `app.get(ThreadIngestor).catchUp('J', 1)` again leaves `content` `Hello` and the thread's message count unchanged.
9. [integration] After `turn_start` `t1`, J is moved to CRASHED (its message becomes `errored`); then a `turn_end` line (`completed`, `output` `Late`) is appended to J's stored `thread` stream with `LogStore.append` and its `FleetJobLog` `sizeBytes` updated directly (a PUT would answer 409 for a terminal job), and `app.get(ThreadIngestor).catchUp('J', 1)` keeps the message `errored` and sets its `content` to `Late`.
10. [integration] Putting `text_delta` for turn `t9`, which has no `turn_start`, creates no message and sets `skippedLines` to 1.
11. [integration] Putting `turn_start` `t1` twice leaves exactly one assistant message with `turnId` `t1` and `skippedLines` 1.
12. [integration] After `turn_start` `t1`, putting `text_delta` round 1 with `text` `a\u0000b` (an escaped NUL in the JSON) sets `content` to `a\uFFFDb`.
13. [integration] After `turn_start` `t1` and a `text_delta`, `GET /api/projects/web/threads/T/messages` by `dev` answers 200 with items that have neither a `streamRound` nor a `streamRoundStart` key.
14. [integration] `POST /api/projects/web/threads/T/messages` by `dev` answers with a `message` that has neither a `streamRound` nor a `streamRoundStart` key.

### US-004: Tools, questions and session state (`Workdir: apps/api`)

1. [integration] After `turn_start` `t1`, putting `{ type: 'tool_call', turnId: 't1', callId: 'c1', name: 'search_repo', input: { pattern: 'foo' } }` gives the message a `toolSummary` deep-equal to `[{ callId: 'c1', name: 'search_repo', input: '{"pattern":"foo"}', isError: null, preview: '', decidedBy: null }]`.
2. [integration] Then putting `{ type: 'tool_result', turnId: 't1', callId: 'c1', isError: true, preview: 'refused' }` sets that entry's `isError` to `true` and `preview` to `refused`.
3. [unit] The tool-summary upsert in `tool-summary.ts` given a `tool_call` whose `input` serializes to 2000 bytes stores an `input` of at most 512 UTF-8 bytes that is a prefix of the serialization.
4. [unit] The same upsert given a `tool_result` with a 2000-byte `preview` stores a `preview` of at most 512 UTF-8 bytes.
5. [unit] Applying 51 `tool_call`s with distinct `callId`s to an empty summary leaves 50 entries and no entry for the 51st `callId`.
6. [integration] Putting `approval_requested` (`requestId` `a1`, `callId` `c1`) and then `approval_resolved` (`requestId` `a1`, `decision` `deny`, `decidedBy` `profile`) sets entry `c1`'s `decidedBy` to `profile`.
7. [integration] Putting `{ type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: E }` (E an ISO date) sets T's `pendingQuestion` deep-equal to `{ requestId: 'q1', text: 'Which repo?', expiresAt: E }`.
8. [integration] Putting the same question with `answerable: false` leaves T's `pendingQuestion` null and adds a `toolSummary` entry with `callId` `q1`, `name` `ask_human` and `preview` `Which repo?`.
9. [integration] After an answerable question `q1`, putting `turn_end` for `t1` sets T's `pendingQuestion` to null.
10. [integration] After an answerable question `q1` is folded, `POST /api/projects/web/threads/T/answer` by `dev` with `{ requestId: 'q1', text: 'acme/app' }` queues a `THREAD_ANSWER` command; then `POST /api/fleet/runner/sync` from R with a `commandAcks` entry `{ result: 'ok' }` for that command sets T's `pendingQuestion` to null.
11. [integration] The same flow with the ack `{ result: 'rejected', detail: 'not_pending' }` leaves T's `pendingQuestion.requestId` `q1`.
12. [integration] Putting `{ type: 'session_started', at: A, resumed: false, backend: { kind: 'native' }, skillShas: [] }` sets T's `session` deep-equal to `{ jobId: 'J', state: 'live', resumed: false, contextReset: false, reason: null, at: A }`.
13. [integration] For a THREAD job whose `FleetThreadTurn.resume` is true, putting `session_started` with `resumed: false` sets `session.contextReset` to `true`.
14. [integration] Putting `{ type: 'session_failed', reason: 'model_unknown' }` on a thread with a `pending` user message sets `session.state` to `failed` and `session.reason` to `model_unknown`, and sets that message's `status` to `errored` with `errorReason` `model_unknown`.
15. [integration] After `session_started` and `{ type: 'session_closed', reason: 'idle' }`, `GET /api/projects/web/threads/T` by a project VIEWER answers 200 with `session.state` `closed` and `session.reason` `idle`.

### US-005: Cost, tokens, budget stops and spend analytics (`Workdir: apps/api`)

1. [integration] After `turn_start` `t1`, putting `{ type: 'usage', turnId: 't1', round: 1, inputTokens: 100, outputTokens: 20, cacheRead: 5, costUsd: 0.0123 }` sets the message's `costUsd` to `'0.0123'`, `costSource` to `computed` and `usage` deep-equal to `{ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 }`.
2. [integration] The same line sets T's `costUsd` to `'0.0123'` and `tokens` deep-equal to `{ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 }`.
3. [integration] The same line sets J's `costSpentUsd` to `'0.0123'`.
4. [integration] The same line creates one `FleetCostEvent` for J with `leaseEpoch` 1, `callId` `t1:1`, `stage` `thread`, `agentName` `native`, `model` `m1`, `profile` `read`, `featureName` `add-auth`, `inputTokens` 100, `costUsd` 0.0123 and `pricingSource` `computed`.
5. [integration] Ten `usage` lines (rounds 1 to 10) of `costUsd` 0.00004 each set J's `costSpentUsd` to `'0.0004'` and T's `costUsd` to `'0.0004'`.
6. [integration] A `usage` line with `costSource` `unpriced`, `costUsd` 0 and `inputTokens` 50 adds 50 to T's `tokens.input`, leaves T's `costUsd` `'0'` and creates no `FleetCostEvent`.
7. [integration] After `usage` lines of `costUsd` 0.01 and 0.02 for `t1`, putting `turn_end` (`completed`) with `costUsd` 0.05 sets T's `costUsd` to `'0.05'` and creates a `FleetCostEvent` with `callId` `t1:turn_end` and `costUsd` 0.02.
8. [integration] After `usage` lines summing 0.03 for `t1`, a `turn_end` with `costUsd` 0.03 creates no `FleetCostEvent` with `callId` `t1:turn_end` and leaves T's `costUsd` `'0.03'`.
9. [integration] After `usage` lines with `inputTokens` summing 200 for `t1`, a `turn_end` whose `usage.inputTokens` is 300 sets the message's `usage.input` and T's `tokens.input` to 300.
10. [integration] Putting the same `usage` line (`t1`, round 1, `inputTokens` 100, `costUsd` 0.0123) twice in one PUT leaves one `FleetCostEvent` with `callId` `t1:1`, T's `costUsd` `'0.0123'`, T's `tokens.input` 100 and `skippedLines` 0.
11. [integration] With `vi.spyOn(app.get(BudgetEvaluator), 'signal')`, a PUT containing a priced `usage` line calls `signal` with keys including `global`, `project:<web project id>`, `repo:<repo id>` and `runner:R`.
12. [integration] With the same spy, a PUT containing only `turn_start` and `text_delta` lines does not call `signal`.
13. [integration] With a project budget policy `{ windowKind: 'lifetime', hardStop: true, runningJobs: 'cancel', amountUsd: '0.01' }` and a QUEUED THREAD job of a second thread in the project, a priced `usage` line of `costUsd` 0.02 for J followed by `app.get(BudgetEvaluator).evaluate(policyId, now)` moves the QUEUED job to CANCELLED with `stateReason` `budget:<policyId>`, and J (RUNNING) gets `cancelRequestedAt` set and one `CANCEL` command.
14. [integration] After a priced `usage` line of `costUsd` 0.0123 for J (no `at`, so inside the default 30-day window), `GET /api/projects/web/fleet/analytics/spend` by `dev` answers 200 with `totals.costUsd` `'0.0123'`.

### US-006: Content SSE (`Workdir: apps/api`)

The suite listens on port 0 (`app.listen(0)`) and opens streams with `openSse`. "Refused with S" means: the HTTP status
is S, or the status is 200 and the first frame is an `error` frame naming the matching exception (Forbidden, NotFound,
Throttle), as `expectRefused` in `live-stream.integration.spec.ts` accepts.

1. [unit] `ThreadEventBus`: a listener subscribed for thread `a` receives an event published with `threadId` `a` and does not receive one published with `threadId` `b`.
2. [integration] With `GET /api/projects/web/threads/T/events` open as a project VIEWER, putting `turn_start` `t1` and then (in a second PUT) `text_delta` round 1 `Hi` delivers an event of type `delta` whose data has `threadId` T, the message's id as `messageId` and `text` `Hi`.
3. [integration] With the stream open, one PUT holding `text_delta` `Hel` and `text_delta` `lo` for `t1` delivers one `delta` event with `text` `Hello` for that message.
4. [integration] With the stream open, putting `turn_end` for `t1` delivers a `message` event whose `messageId` is the assistant message's id.
5. [integration] With the stream open, putting `input_consumed` for pending user message M delivers a `message` event with `messageId` M.
6. [integration] With the stream open, one PUT holding `text_delta` round 1 `abc` and `stream_reset` round 1 delivers a `message` event for that message and no `delta` event for it.
7. [integration] With the stream open, putting an answerable `question` `q1` with text `Which repo?` delivers a `question` event with `requestId` `q1` and `text` `Which repo?`.
8. [integration] With the stream open, putting `session_started` delivers a `thread` event with `threadId` T.
9. [integration] With the stream open, putting a priced `usage` line delivers a `thread` event with `threadId` T.
10. [integration] With the stream open on thread T, a PUT for a THREAD job of another thread followed by a `session_started` PUT for J delivers T's `thread` event as the first event after `ready`.
11. [integration] `GET /api/projects/web/threads/T/events` with a rostered agent's API key is refused with 403.
12. [integration] `GET /api/projects/web/threads/T/events` by `outsider` (no membership) is refused with 403.
13. [integration] `GET /api/projects/web/threads/<thread of the ops project>/events` by root is refused with 404.
14. [integration] With 10 live streams of `dev` already open (project or thread streams), an 11th `GET /api/projects/web/threads/T/events` by `dev` is refused with 429.

### US-007: Startup catch-up and dashboard loads (`Workdir: apps/api`)

"Written directly" means: lines appended with `LogStore.append` at `logKey(job, 1, 'thread')` and a `FleetJobLog`
`thread` row with `sizeBytes` equal to the file size, with no cursor.

1. [integration] For a RUNNING THREAD job J whose stream (`turn_start` `t1`, `text_delta` `Hi`) was written directly, `app.get(ThreadIngestBootstrap).onApplicationBootstrap()` creates the assistant message with `content` `Hi` and a cursor whose `offset` equals the file size.
2. [integration] The same setup for a THREAD job with `state` COMPLETED and `finishedAt` 2 hours ago folds its stream.
3. [integration] The same setup for a THREAD job with `state` COMPLETED and `finishedAt` 3 days ago creates no cursor and no assistant message.
4. [integration] With `vi.spyOn(app.get(ThreadIngestor), 'catchUp')`, `onApplicationBootstrap()` does not call `catchUp` for a RUNNING THREAD job whose cursor `offset` equals its `FleetJobLog` `sizeBytes`.
5. [integration] With two RUNNING THREAD jobs whose streams were written directly and `catchUp` spied to reject once for the first, `onApplicationBootstrap()` resolves and the second job's stream is folded.
6. [integration] `findHeldRefs()` on the booted app's dashboard repository (`DASHBOARD_REPOSITORY`), while runner R holds a RUNNING THREAD job, returns an entry with `runnerId` R and `command` `THREAD`.
7. [integration] `GET /api/fleet/dashboard` as a global ADMIN while runner R (online, `capacity` 1) holds only a RUNNING THREAD job answers 200 with R's `activeJobs` 0.
8. [integration] The same request while R holds a RUNNING RUN job and a RUNNING THREAD job answers 200 with R's `activeJobs` 1.
9. [integration] `GET /api/fleet/dashboard` as a global ADMIN, while R (online, `capacity` 1, fitting) holds only a RUNNING THREAD job on repo `rA` and a RUN job on `rA` has been QUEUED (inserted directly, unplaced) for longer than `FLEET_JOB_QUEUED_WARN_SEC`, answers 200 with no `job_unplaceable` attention item for that RUN job.
