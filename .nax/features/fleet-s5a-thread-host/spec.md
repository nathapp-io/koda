<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5a-B3b — Thread Host (THREAD Jobs on the Runner: ASSIGN, Thread Job Run, Commands, Supervisor, Daemon, Protocol v4)

## Summary

The koda fleet runner hosts brainstorm-thread sessions. It parses `THREAD` ASSIGN commands, reports the native models
it can serve (`threadBackends`), ships a job's `thread` log stream through the existing `LogShipper`, and runs each
`THREAD` job as a `ThreadJobRun`: credentials, the thread worktree and the skills are prepared while ASSIGNED, then a
nax-agent session runs while RUNNING, serving `THREAD_INPUT`, `THREAD_ANSWER`, `THREAD_STOP_TURN` and `THREAD_CLOSE`
until it closes (idle, closed, cost cap, stream cap, cancel) or fails. The Supervisor routes `THREAD` rows to it and
handles READOPT and ABANDON for them without a reap and without the repo mutex. The daemon wires it all in, keeps
`THREAD` jobs out of `freeSlots`, prunes archived threads and old skill caches, and reports protocol 4.

This is feature B3b of fleet S5a phase B (umbrella `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md`
§2.2, §3.1, §3.2, §4; koda design doc §9.57). It builds on B3a `fleet-s5a-thread-kit` (merged, PR #259), whose
blocks it calls, and on B1 `fleet-s5a-thread-core` (API, merged). B2 `fleet-s5a-thread-ingest` (API ingest of the
`thread` stream) and B4 `fleet-s5a-thread-web` follow.

## Motivation

B1 places `THREAD` jobs only on runners that report protocol 4, and B3a built the session host's parts without
wiring them. Until a runner can run a `THREAD` job end to end, no thread can start. The unsplit B3 draft's review
found that reusing the RUN path for thread rows would be unsafe: `Supervisor.reject` reaps the shared clone's
`.nax-pids` since the job's creation (killing a concurrent RUN's nax), and an ABANDON with no run in memory waits on
the repo mutex while `handleCommands` is awaited inline in the sync loop, stalling the whole loop behind a running
RUN. A thread job needs its own run with its own stop paths.

## Design

### Rulings that bind every story

- B3a rulings stay in force: D543 profile `read` only; B3-R2 native models from the `models.native` tiers; B3-R3
  nax-agent pinned at `0.86.0`; B3-R4 the `RepoMutex` only to create a missing clone (inside
  `prepareThreadWorktree`); B3-R9 ACP refused with `backend_unavailable`; B3-R10 `carryHistoryAcrossModels: true`;
  B3-R11 held delta text.
- B3-R5 (user, 2026-10-11): a `THREAD_INPUT` while a turn runs is acked `rejected` with detail `turn_running`; the
  runner keeps no input queue.
- B3b-R1: a `ThreadJobRun` never takes the `RepoMutex` itself, never calls `JobExecutor.reap`, `killIfOurs` or
  `JobExecutor.cleanup`, and never constructs a `JobRun`. The thread directory (`<RunnerHome.dir>/threads/<threadId>`)
  outlives the job so a later job of the thread can resume.
- B3b-R2: a thread command is applied without awaiting a turn, a close or a drain. `CommandHandler.handle` is awaited
  inline by the sync loop, so `ThreadJobRun.command` is synchronous and every close runs in the background.
- B3b-R3: the first close reason wins. Once a run is closing or failing, a later idle expiry, cost cap, stream cap,
  `THREAD_CLOSE`, `CANCEL` or session error changes nothing.
- B3b-R4: cost is counted from `usage.costUsd` only (`turn_end.costUsd` repeats the turn's usage), summed over the
  whole job, and compared as `spent >= Number(assign.maxCostUsd)`. The runner sends no `costSpentUsd` snapshot: the
  API's ingest (B2) adds usage to the job's spend (umbrella §2.4).
- B3b-R5: until B2, the API refuses `PUT .../logs/thread`; the shipper's existing refusal handling applies and the
  kill switch `FLEET_THREADS_ENABLED` stays off. Tests run the stream against `test/helpers/fake-log-server.ts`.

### Integration

Read-only symbols (verified on main `dc115462`):

- B3a: `prepareThreadWorktree(input): Promise<ThreadWorktreeResult>` and `pruneArchivedThreads({ git, homeDir,
  threadIds, activeThreadIds })` (`apps/runner/src/thread/thread-worktree.ts`); `ensureSkills({ skills, skillsRoot,
  git, timeoutMs, origin? })` and `pruneSkillCache(skillsRoot, now, maxAgeDays?)` (`thread/skill-fetch.ts`);
  `buildThreadTools(ctx: ThreadToolContext)` (`thread/tools/index.ts`); `ThreadSessionFactory` with `open({ jobId,
  thread, worktree, tools, approvalTimeoutSec })` → `{ ok: true; session; resumed } | { ok: false; reason }`
  (`thread/session-factory.ts`); `ThreadEventWriter` with `event`, `started`, `inputConsumed`, `closed`, `failed`,
  `flush` (`thread/thread-event-writer.ts`); `readNativeModels(naxHome, available)`, `nativeModelProviders(naxHome)`
  (`thread/native-models.ts`); `naxCredentialsConfig(naxHome)` (`thread/nax-credentials.ts`); `threadDirFor`
  (`thread/thread-paths.ts`).
- nax-agent 0.86.0: `AgentSession` (`send(message): AsyncIterable<SessionEvent>`, `answer(requestId, { text }):
  'accepted' | 'expired' | 'cancelled' | 'unknown'`, `cancel(reason?)`, `close(): Promise<void>`), `SessionEvent`
  (`usage { costUsd }`, `turn_end { status: 'completed' | 'cancelled' | 'timed_out' | 'interrupted' | 'errored' }`),
  `configureCredentials(config)`.
- `CredentialProvider.acquire(job, { wait, isCancelled? })` → `{ ok: true; credentials: { helper, binDir } } | { ok:
  false; reason; cancelled? }` and `release(job)` (`apps/runner/src/credentials/broker.ts`).
- `JobEvents.transition`, `snapshot`, `lifecycle` (`supervisor/job-events.ts`); runner transitions `ASSIGNED →
  RUNNING | FAILED | CANCELLED`, `RUNNING → UPLOADING | CANCELLED`, `UPLOADING → COMPLETED | FAILED | CANCELLED`
  (`supervisor/transitions.ts`); `startHeartbeat({ everyMs, sleep, now, emit })` (`supervisor/heartbeat.ts`).
- `repoDirFor`, `jobDirFor`, `assertSegment`, `assertFeature` (`paths/safe-segment.ts`); `THREAD_LIMITS`,
  `THREAD_STREAM`, `THREAD_MODEL_ID_RE`, `THREAD_COMMAND_TYPES`, `isThreadKind` (`@nathapp/fleet-protocol`).
- The API sends a THREAD ASSIGN with `command: 'THREAD'`, `feature: 'thread-<threadId>'`, `ref` = the thread's base
  ref, `profiles: []`, `bashMode: 'raw'`, `planFrom: null`, `maxCostUsd` = the thread's remaining budget and the
  `thread` block (`apps/api/src/fleet/threads/prisma-chat-thread.repository.ts:189`,
  `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:192`). It mints git tokens for THREAD jobs like any held job.

Mutated symbols. **The baseline exists only to locate the code; implement the target.**

| Symbol | Baseline | Target |
|---|---|---|
| `parseAssign` (`supervisor/assign-parser.ts`) | accepts `RUN`, `PLAN`, config kinds | also `THREAD`, with the `thread` block validated and copied (US-001) |
| `LogStreamName`, `LogJob` (`logs/types.ts`) | `stdout` / `stderr` / `run`; `LogJob` has `sources` | `LogStreamName` adds `'thread'`; `LogJob` = `NaxLogJob` (today's shape) \| `ThreadLogJob { jobId; leaseEpoch; threadPath; lifecycle }` (US-002) |
| `LogShipper.register` (`logs/log-shipper.ts`) | adds `stdout`, `stderr`, searches `run` | a `ThreadLogJob` adds one `thread` stream at `threadPath`, nothing else (US-002) |
| `NaxCapabilityProbe.probe` (`capabilities/nax-probe.ts`) | no `threadBackends` | reports `threadBackends`; `auth list` asks for tier providers too (US-002) |
| `TUNING` (`daemon/tuning.ts`) | 28 keys | gains `threadHeartbeatMs: 30_000` and `threadCloseTimeoutMs: 10_000` (US-003) |
| `SupervisorDeps`, `Supervisor` (`supervisor/supervisor.ts`) | one `JobRun` per row | `SupervisorDeps.threads?: ThreadRunSetup`; THREAD rows run as `ThreadJobRun`; `threadCommand(command)` (US-006) |
| `CommandHandler.apply` (`supervisor/command-handler.ts`) | thread command types → `unknown command type` | routed to `Supervisor.threadCommand` (US-006) |
| `Journal` (`journal/journal.ts`) | `activeCount()` counts every active row | gains `activeCountExcluding(command)` (US-007) |
| `SyncLoopDeps` (`sync/sync-loop.ts`) | ignores `archivedThreadIds` | gains `onArchivedThreads?: (ids) => void` (US-007) |
| `DaemonOptions`, `startDaemon` (`daemon/daemon.ts`) | no thread host | gains `threadSessions?`, `configureCredentials?`; wires the thread host (US-007) |
| `FLEET_PROTOCOL_VERSION` (`packages/fleet-protocol/src/index.ts`) | `3` | `4` (US-007) |

### THREAD ASSIGN (US-001)

`parseAssign` accepts `command: 'THREAD'`. For a THREAD job: `profiles` must be `[]` (else `invalid profiles`),
`bashMode` must be `'raw'` (else `invalid bashMode`), and `thread` must be an object (else `invalid thread`); a RUN,
PLAN or config job carrying a `thread` key is `invalid thread`. The `thread` block, each field checked in this order:

| Field | Rule | Detail |
|---|---|---|
| `threadId` | `assertSegment` | `invalid threadId` |
| `action` | `'SESSION'` (`PUBLISH` is phase C) | `invalid thread action` |
| `feature` | `assertFeature` | `invalid thread feature` |
| `resume` | boolean | `invalid thread resume` |
| `instructions` | string of at most 262144 characters | `invalid instructions` |
| `backend` | `{ kind: 'native', model?, effort? }` or `{ kind: 'acp', agent: 'claude' \| 'codex', model?, effort? }`; `model` matches `THREAD_MODEL_ID_RE`; `effort` matches `/^[a-z]{1,16}$/` | `invalid backend` |
| `skills` | array of objects whose `sourceId`, `owner`, `repo`, `sha` are strings and whose `skills` is an array of `{ name, dir, description }` strings | `invalid skills` |
| `initialMessage` | `null`, or `{ messageId, text }` with `messageId` passing `assertSegment` and `text` a string of at most `THREAD_LIMITS.messageMaxBytes` UTF-8 bytes | `invalid initialMessage` |

Only the listed fields are copied into `assign.thread` (an unknown key is dropped). The skill identifiers are
validated again by `ensureSkills` before they reach a path.

### Thread stream and capabilities (US-002)

`LogStreamName` becomes `LogEventPayload['stream'] | typeof THREAD_STREAM` (the legacy `log` event payload is not
widened). `LogJob` becomes `NaxLogJob | ThreadLogJob`; the shipper narrows on it wherever it reads
`spec.sources` (`register`, `lacksRun`, `discover`). `register` of a `ThreadLogJob` adds a single stream `thread` at
`threadPath` (no `stdout`, no `stderr`, no run-log search); `wake`, `drain`, `stopJob` and the upload rules are
unchanged. `ServerClient.putLog` already builds `/fleet/runner/jobs/<jobId>/logs/<stream>`.

`NaxCapabilityProbe.probe` asks `nax auth list --json` for the union of the profiles' providers and
`nativeModelProviders(naxHome)`, sorted and without duplicates, then adds `threadBackends: { native:
(await readNativeModels(naxHome, <providerIds whose credential is available>)).models, acp: [] }`.
`StaticCapabilityProbe` reports no `threadBackends` (a runner.json capability override cannot host threads).

### ThreadJobRun (US-003, US-004, US-005)

`apps/runner/src/thread/thread-job-run.ts`:

```ts
export interface ThreadHostDeps {
  readonly sessions: Pick<ThreadSessionFactory, 'open'>;
  readonly credentials: CredentialProvider;
  readonly git: Git;
  readonly homeDir: string;          // RunnerHome.dir; skills live in <homeDir>/skills
  readonly workspaceRoot: string;
  readonly prepareWorktree?: typeof prepareThreadWorktree;   // default: B3a prepareThreadWorktree
  readonly ensureSkills?: typeof ensureSkills;              // default: B3a ensureSkills
  readonly skillOrigin?: string;                            // tests: a file:// origin
}
export interface ThreadRunTuning {
  readonly threadIdleMs: number; readonly threadHeartbeatMs: number; readonly threadWakeGapMs: number;
  readonly threadSearchTimeoutMs: number; readonly threadSkillFetchTimeoutMs: number; readonly logDrainTimeoutMs: number;
  readonly threadCloseTimeoutMs: number;
  /** Passed to the writer; default THREAD_STREAM_LIMITS.streamMaxBytes. Tests lower it. */
  readonly streamMaxBytes?: number;
}
export interface ThreadRunSetup { readonly host: ThreadHostDeps; readonly tuning: ThreadRunTuning }
export type ThreadRunDeps = Pick<JobRunDeps, 'journal' | 'log' | 'now' | 'sleep' | 'mutex' | 'logs'> & ThreadRunSetup;
export type ThreadCommandOutcome = { result: 'ok' | 'rejected'; detail?: string };

export class ThreadJobRun {
  constructor(deps: ThreadRunDeps, jobId: string, leaseEpoch: number);
  /** Resolves when the run has ended: terminal and marked done, abandoned, or halted. */
  start(from: RunStart): Promise<void>;
  command(type: ThreadCommandType, payload: unknown): ThreadCommandOutcome;   // synchronous (B3b-R2)
  requestCancel(): boolean;
  halt(): void;
  abandon(): Promise<void>;
}
```

**Lifetime.** Like `JobRun`, the promise `start()` returns covers the whole run: it resolves only after the run has
ended (a terminal transition followed by `journal.markDone`, an abandon, or a halt). The Supervisor keeps the run in
its map until then, so a command reaches the run while it is preparing, running or closing, and a command after the
promise resolved finds no run (`does not hold job`, US-006). `TUNING` gains `threadHeartbeatMs: 30_000` and
`threadCloseTimeoutMs: 10_000`.

The stream file is `<jobDir>/thread-events.jsonl` (`jobDirFor(workspaceRoot, jobId)`, directory mode 0700). It is
keyed by job id only, so the start deletes it before creating the writer: a requeued epoch never re-ships the lines
of the epoch it replaces.

**Start** (`from` `'prepare'` or `'reprepare'`; `'watch'` or `'finish'` ends the job as a runner error with `a
thread job cannot be resumed`). Each step checks a cancel request (→ `CANCELLED` `cancelled before start`) and a halt
(→ return, no transition):

1. `credentials.acquire(row, { wait: true, isCancelled })`; refused with `cancelled` → `CANCELLED` `cancelled before
   start`; refused otherwise → `FAILED` with its reason.
2. `prepareWorktree({ git, mutex, repoKey: row.repoKey, repoDir: repoDirFor(workspaceRoot, repo.owner, repo.name),
   cloneUrl: repo.cloneUrl, identity: assign.gitIdentity, credentialHelper: <acquired helper>, homeDir, threadId,
   baseRef: assign.ref, feature: thread.feature })` — the thread's feature, never the job's `thread-<id>`.
3. `credentials.release(row)`, whatever step 2 returned; nothing later needs git credentials.
4. Step 2 not ok → `FAILED` with its reason.
5. `ensureSkills({ skills: thread.skills, skillsRoot: <homeDir>/skills, git, timeoutMs: threadSkillFetchTimeoutMs,
   origin: skillOrigin })`; not ok → `FAILED` `skill_fetch_failed`.
6. `sessions.open({ jobId, thread, worktree: <the worktree step 2 returned>, tools: buildThreadTools({ worktree,
   skillsRoot, skills: thread.skills, git, searchTimeoutMs: threadSearchTimeoutMs, nowMs }), approvalTimeoutSec:
   assign.approvalTimeoutSec })`; not ok → `FAILED` with its `reason`. A cancel or halt that arrives while `open` is
   pending ends as above **and closes the session `open` then resolves** (a throw is logged).
7. `RUNNING` with the patch `{ pid: null, pgid: null, branch: null }`; delete and recreate the stream file; create
   the writer over it (`wakeGapMs` `threadWakeGapMs`, `streamMaxBytes` from tuning, `onCap` → close `stream_cap`,
   `onWarn` → a `warn` lifecycle event); `logs.register({ jobId, leaseEpoch, threadPath, lifecycle })`;
   `writer.started({ resumed, backend: thread.backend, skillShas: thread.skills.map((s) => s.sha) })`; start the
   heartbeat (`snapshot { heartbeatAt }` every `threadHeartbeatMs` until the `UPLOADING` transition, a halt or an
   abandon).
8. `thread.initialMessage` present → a turn with it, started before `start` awaits anything else; otherwise the idle
   timer starts.

Every early exit (`FAILED` or `CANCELLED` before `RUNNING`) is followed by `journal.markDone`. A failure before
`RUNNING` writes no stream line (no stream is registered); the API ends the thread's pending message from the job's
terminal state. A throw from any start step (not a returned failure) ends the job `FAILED` with `runner error:
<message>` before `RUNNING`, or through the Fail steps with reason `session_error` after it.

**Turn.** Starting a turn sets the turn-running flag and stops the idle timer synchronously, then
`writer.inputConsumed(messageId)` and every event of `session.send(text)` goes to `writer.event`. After each `usage`
event, `spent >= Number(maxCostUsd)` closes with `cost_cap` (B3b-R4). After the iteration ends, `writer.flush()`,
the flag clears and the idle timer restarts. A `turn_end` whose status is `errored`, `timed_out`, `cancelled` or
`interrupted` leaves the session open. An iteration that throws (not during a close or after a halt) fails the run
with `session_error`.

**Idle.** The idle timer runs only while no turn runs; it expires after `threadIdleMs` and closes with `idle`.

**Close(reason)** — `reason` ∈ `idle`, `closed`, `cost_cap`, `stream_cap`, `cancelled`; the first one wins
(B3b-R3): stop the idle timer → if a turn runs, `session.cancel(reason)` and wait for its iteration to end →
`session.close()` (a throw is logged) → `writer.flush()`, `writer.closed(reason)` →
`logs.drain(jobId, leaseEpoch, logDrainTimeoutMs)` (a timeout is a `warn` lifecycle event) → stop the heartbeat →
`UPLOADING` → `CANCELLED` `cancelled` when the reason is `cancelled`, else `COMPLETED` with the reason →
`logs.stopJob`, `journal.markDone`.

**Fail(`session_error`)** — the same steps with `writer.failed('session_error')` in place of `writer.closed`, ending
`UPLOADING → FAILED` `session_error`.

**Commands** (`command(type, payload)`, all synchronous; a `THREAD_INPUT` that returns `ok` has already set the
turn-running flag, so a second `THREAD_INPUT` in the same `CommandHandler.handle` batch gets `turn_running`):

| Situation | Outcome |
|---|---|
| Run not yet `RUNNING` | `rejected` `session_not_ready` |
| Run closing or failing | `rejected` `session_closed` |
| `THREAD_INPUT` payload not `{ messageId: <segment>, text: <string of at most messageMaxBytes UTF-8 bytes> }` | `rejected` `invalid payload` |
| `THREAD_INPUT` while a turn runs | `rejected` `turn_running` (B3-R5) |
| `THREAD_INPUT` otherwise | `ok`; the turn starts in the background |
| `THREAD_ANSWER` payload not `{ requestId: <1..200 printable characters>, text: <string of at most messageMaxBytes UTF-8 bytes> }` | `rejected` `invalid payload` |
| `THREAD_ANSWER` | `session.answer(requestId, { text })`: `accepted` → `ok`; `expired`, `cancelled`, `unknown` → `rejected` with that word |
| `THREAD_STOP_TURN` | `ok`; `session.cancel('stopped')` when a turn runs, nothing otherwise; the session stays open |
| `THREAD_CLOSE` | `ok`; close `closed` in the background |
| `THREAD_PUBLISH` | `rejected` `unsupported` (phase C) |

**Cancel, halt, abandon.** `requestCancel()` before `RUNNING` records `cancelRequestedAt` (the next start step ends
`CANCELLED`); while `RUNNING` it closes with `cancelled`; while closing it does nothing; it returns false only for a
terminal row. `halt()` (daemon stop) sets the halted flag, calls `session.cancel('halted')` when a turn runs, stops
the idle timer and the heartbeat, calls `logs.stopJob`, closes the session without awaiting it, and lets `start`
resolve without waiting for the turn. After a halt, every background task of the run (the turn's iteration and tail,
the idle timer, a close in progress, the heartbeat) writes no journal event, no stream line and no transition.
`abandon()` halts, then `journal.abandon(jobId, leaseEpoch)` (which deletes the row and its events), then
`credentials.release(row)` (a throw is logged), then awaits `session.close()` for at most `threadCloseTimeoutMs` (a
timeout or throw is logged) — no mutex (B3b-R1), and never longer than the close bound.

**Test double** (`apps/runner/test/helpers/fake-agent-session.ts`, US-003): `fakeAgentSession(script)` returns an
`AgentSession` whose `send(message)` yields the next scripted turn's events. A scripted turn is a list of
`SessionEvent`s plus optional `hold: true` (the iteration pauses after the events listed so far until `release()`) and
`throwAfter` (the iteration throws after that many events). `answer` returns a scripted `AnswerStatus` (default
`'accepted'`); `close` resolves at once unless `hangClose: true`. Every call to `send`, `cancel`, `answer` and `close`
is appended, in order, to a shared `calls: string[]` recorder that the recording `CredentialProvider` and the
`prepareWorktree` / `ensureSkills` stubs write to as well. `fakeSessionFactory(session, result?)` returns an `open`
that resolves `{ ok: true, session, resumed: false }` (or the given result), with an optional `hold` until
`releaseOpen()`.

### Supervisor and CommandHandler (US-006)

`SupervisorDeps` gains `threads?: ThreadRunSetup`. For a row whose `command` is `THREAD`:

- `begin(row, from)` creates a `ThreadJobRun` in the same run map; with no `threads` it transitions the row `FAILED`
  `backend_unavailable` and marks it done.
- `cancel` calls the run's `requestCancel` (the existing journal path when no run is in memory).
- `abandon` with a run awaits `run.abandon()` (bounded by `threadCloseTimeoutMs`); with no run it calls
  `journal.abandon` and then `threads.host.credentials.release(row)` (a throw is logged) — never a `JobRun`, never the
  mutex.
- The run map entry and `pending` promise are the `start()` promise, as for `JobRun`, so `idle()` waits for thread runs
  too; a halted thread run resolves without waiting for its turn.
- `readopt`: terminal → `markDone`, `ok`, no executor call; `ASSIGNED` with `pid` null → `begin(row, 'reprepare')`,
  `ok`; any other state → `markDone`, `rejected` `thread session ended by a runner restart`, with no `killIfOurs`,
  `executor.reap` or `executor.cleanup`.
- `threadCommand(command: FleetCommandOut): ThreadCommandOutcome` — the run for `(jobId, leaseEpoch)` when it is a
  `ThreadJobRun`, else `rejected` `does not hold job`.

`CommandHandler.apply` routes `THREAD_INPUT`, `THREAD_ANSWER`, `THREAD_STOP_TURN`, `THREAD_CLOSE` and
`THREAD_PUBLISH` to `supervisor.threadCommand` and records the outcome (a re-sent command id is acked from the
record, never re-applied).

### Daemon (US-007)

- `DaemonOptions` gains `threadSessions?: Pick<ThreadSessionFactory, 'open'>` and `configureCredentials?: (config:
  CredentialsConfig) => void` (default nax-agent's). `startDaemon` calls `configureCredentials(naxCredentialsConfig(
  config.naxHome))` once, before the first sync.
- `threadNativeModels(naxHome, latest: () => RunnerCapabilities | null): () => Promise<NativeModelSet>`
  (`thread/thread-host.ts`) reads the native models for the providers whose credential `available` is true in
  `latest()` (none when `latest()` is null). `latest()` is the bounded report of the last probe (start, every
  `capabilityProbeMs`, SIGHUP), so a provider logged in since then is seen at the next probe. The default session factory is `new ThreadSessionFactory({ homeDir:
  home.dir, naxHome: config.naxHome, nativeModels: threadNativeModels(config.naxHome, () => reporter.latest()) })`.
- The Supervisor gets `threads: { host: { sessions, credentials: broker, git, homeDir: home.dir, workspaceRoot },
  tuning }`.
- `freeSlots` = `freeSlots(capacity, journal.activeCountExcluding('THREAD'))`; the server counts thread slots (B1-R1).
- The sync loop's `onArchivedThreads` keeps the latest `archivedThreadIds` (an absent field keeps the previous list).
  The job prune (start and every `pruneIntervalMs`) also runs `pruneArchivedThreads({ git, homeDir: home.dir,
  threadIds: <latest list>, activeThreadIds: <thread.threadId of every active THREAD row> })` and
  `pruneSkillCache(<home.dir>/skills, now())`; a throw is a `warn` log.
- `FLEET_PROTOCOL_VERSION` becomes 4 (sync and enroll both send it).

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| THREAD ASSIGN with a bad field | ASSIGN `rejected` with the field's detail | US-001 |
| THREAD ASSIGN on a runner without a thread host | `FAILED` `backend_unavailable` | US-006 |
| Credentials refused | `FAILED` with the broker's reason; `CANCELLED` when the refusal is a cancel | US-003 |
| A start step throws | `FAILED` `runner error: <message>` before `RUNNING`; Fail steps with `session_error` after | US-003 |
| Cancel or halt while `sessions.open` is pending | the session it resolves is closed | US-005 |
| Worktree preparation fails | `FAILED` with its reason (`worktree_conflict`, `checkout: ...`, `git auth failed`) | US-003 |
| Skill fetch fails | `FAILED` `skill_fetch_failed` | US-003 |
| Session cannot open | `FAILED` with the factory's reason | US-003 |
| Cancel before `RUNNING` | `CANCELLED` `cancelled before start` | US-005 |
| A turn ends `errored`, `timed_out`, `cancelled` or `interrupted` | session stays open | US-004 |
| The session's event iteration throws | `session_failed`, `UPLOADING`, `FAILED` `session_error` | US-004 |
| Cost reaches `maxCostUsd` | turn cancelled, `COMPLETED` `cost_cap` | US-004 |
| Stream reaches its cap | `COMPLETED` `stream_cap` | US-004 |
| Log drain times out | `warn` lifecycle event, then `UPLOADING` | US-004 |
| Second close reason | ignored (first wins) | US-005 |
| Thread command for a job the runner does not run | `rejected` `does not hold job` | US-006 |
| Thread command with a malformed payload | `rejected` `invalid payload` | US-005 |
| READOPT of a RUNNING thread job | `rejected`, no reap, no cleanup | US-006 |
| ABANDON of a thread job while a RUN holds the repo mutex | completes without waiting for the mutex | US-006 |
| ABANDON while `session.close()` hangs | completes after `threadCloseTimeoutMs` | US-006 |
| A requeued epoch of a THREAD job | starts a fresh stream file | US-004 |
| Archived-thread or skill-cache prune throws | `warn` log, the daemon keeps running | US-007 |

## Out of Scope

- The API accepting, folding and pricing the `thread` stream, cost accounting from `usage` lines and the content
  SSE belong to feature `fleet-s5a-thread-ingest` (B2); until then the API refuses `PUT .../logs/thread` and
  `FLEET_THREADS_ENABLED` stays off.
- The runner sends no `costSpentUsd` snapshot for a THREAD job (B3b-R4).
- `THREAD_PUBLISH`, `write_doc`, a `PUBLISH` action, a stale session start and Discard belong to phase C; the runner
  rejects `PUBLISH` at ASSIGN and `THREAD_PUBLISH` as `unsupported`.
- ACP session backends belong to phase D; `threadBackends.acp` is always `[]`.
- A runner configured with a runner.json `capabilities` block reports no `threadBackends` and hosts no threads.
- A daemon stop or crash ends a live session without a `session_closed` line; READOPT then rejects the job, the API
  marks it CRASHED, and the next message starts a new job with `resume: true`.
- Replaying a turn interrupted by a restart is not done; nax-agent reports it `interrupted` and the next input is a
  new turn.
- Unpriced usage (`costSource` `unpriced`, `costUsd` 0) never moves the cost cap; the API's budget rules govern it.
- A thread whose spend has overshot its cap gives a negative remaining `maxCostUsd`, which `COST_RE` rejects at
  ASSIGN (`invalid maxCostUsd`); the API's send rule `threads.costCap` refuses before that. A clamp in the API is a B1
  follow-up.
- The runner `context.md` (`.nax/mono/apps/runner/context.md`, "protocol v3") is updated by hand after merge.
- B3a's waived review items (`ensureClone`'s optional identity, base-ref resolution duplicating `resolveRef`, the
  event writer taking plain strings for reasons, the skill fetcher's unused `filePath` alias and single-`dir` branch)
  are not changed.
- US-001 only: `instructions` length, `resume` type, `skills` element shapes, a backend `effort` and an `acp` backend's `agent` value share
  the field table without a dedicated acceptance criterion.
- US-002 only: `wake`, `stopJob` and the shipper's refusal handling for a `thread` stream share the existing stream
  rules without a dedicated acceptance criterion; so does `StaticCapabilityProbe` reporting no `threadBackends`
  (unchanged code).
- US-003 only: a cancel or halt between the start steps, a credentials refusal, a throwing start step, a start with
  no initial message and `'watch'` / `'finish'` starts share the step rules without a dedicated acceptance criterion;
  so does `onWarn`.
- US-004 only: the drain timeout warning, the heartbeat stopping at `UPLOADING` and `session.close()` being called by
  the idle close share the close steps without a dedicated acceptance criterion.
- US-005 only: `session_not_ready`, `THREAD_ANSWER` payload validation, the `cancelled` and `unknown` answer statuses
  `THREAD_PUBLISH` (`unsupported`) and `requestCancel()` while `RUNNING` (pinned through `CANCEL` in US-006) share the
  command table without a dedicated acceptance criterion; so does `halt()` (pinned through ABANDON in US-006).
- US-006 only: a terminal or `ASSIGNED` thread row at READOPT, `cancel` with no run in memory, a thread command
  for a RUN job, and a throwing `session.close()` or `credentials.release` in `abandon()` share the existing Supervisor paths without a dedicated
  acceptance criterion.
- US-007 only: a prune that throws and an absent `archivedThreadIds` share the prune rules without a dedicated
  acceptance criterion.

## Stories

1. **US-001: THREAD ASSIGN parsing** — `Workdir: apps/runner` — no dependencies.
2. **US-002: Thread log stream and `threadBackends` report** — `Workdir: apps/runner` — no dependencies.
3. **US-003: ThreadJobRun start** — `Workdir: apps/runner` — depends on US-001, US-002.
4. **US-004: ThreadJobRun turns, idle, caps and failure** — `Workdir: apps/runner` — depends on US-003.
5. **US-005: ThreadJobRun commands and cancel** — `Workdir: apps/runner` — depends on US-004.
6. **US-006: Supervisor and CommandHandler for THREAD jobs** — `Workdir: apps/runner` — depends on US-001, US-005.
7. **US-007: Daemon wiring and protocol 4** — `Workdir: apps/runner` — depends on US-002, US-006.

US-007 also edits `packages/fleet-protocol/src/index.ts`. Build gate for every story: `bun run type-check` and
`bun run lint` in `apps/runner`; US-007 also `bun run type-check` at the repo root.

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`
- `apps/runner/src/paths/safe-segment.ts` — `assertSegment`, `assertFeature`
- `packages/fleet-protocol/src/threads.ts` — `ThreadAssign`, `THREAD_LIMITS`, `THREAD_MODEL_ID_RE`

**US-002**

- `apps/runner/src/logs/types.ts` — `LogJob`, `LogStreamName`
- `apps/runner/src/logs/log-shipper.ts` — `register`, stream entries
- `apps/runner/src/capabilities/nax-probe.ts` — `NaxCapabilityProbe.probe`, `credentials`
- `apps/runner/src/thread/native-models.ts` — `readNativeModels`, `nativeModelProviders`
- `apps/runner/test/helpers/fake-log-server.ts` — the upload rules in memory

**US-003**

- `apps/runner/src/supervisor/job-run.ts` — `JobRunDeps`, `RunStart`, the config-job heartbeat pattern
- `apps/runner/src/thread/session-factory.ts` — `ThreadSessionFactory.open`
- `apps/runner/src/thread/thread-event-writer.ts` — `ThreadEventWriter`
- `apps/runner/src/credentials/broker.ts` — `CredentialProvider`
- `apps/runner/src/daemon/tuning.ts` — gains `threadHeartbeatMs`

**US-004**

- `apps/runner/src/thread/thread-job-run.ts` — created by US-003, the turn, idle and close paths are added here
- `apps/runner/test/helpers/fake-agent-session.ts` — created by US-003, scripted sessions
- `apps/runner/test/helpers/fake-log-shipping.ts` — `holdDrain`, recorded calls
- `apps/runner/test/helpers/manual-clock.ts` — idle and heartbeat timing

**US-005**

- `apps/runner/src/thread/thread-job-run.ts` — created by US-003, `command`, `requestCancel`, `halt`, `abandon`
- `apps/runner/test/helpers/fake-agent-session.ts` — created by US-003, scripted sessions

**US-006**

- `apps/runner/src/supervisor/supervisor.ts` — `begin`, `cancel`, `abandon`, `readopt`
- `apps/runner/src/supervisor/command-handler.ts` — `apply`, `record`
- `apps/runner/src/thread/thread-job-run.ts` — created by US-003, `ThreadJobRun`, `ThreadRunSetup`
- `apps/runner/test/helpers/fake-executor.ts` — RUN jobs and recorded executor calls
- `apps/runner/test/helpers/fake-agent-session.ts` — created by US-003, scripted sessions

**US-007**

- `apps/runner/src/daemon/daemon.ts` — `startDaemon`, `pruneJobs`, `freeSlots` wiring
- `apps/runner/src/sync/sync-loop.ts` — `SyncLoopDeps`, `apply`
- `apps/runner/src/journal/journal.ts` — `activeCount`
- `packages/fleet-protocol/src/index.ts` — `FLEET_PROTOCOL_VERSION`
- `apps/runner/test/unit/daemon.spec.ts` — the fake server and the nax-mode setup (`probed`, line 365) to copy

### Creates

> New files each story authors.

**US-001**

- `apps/runner/src/supervisor/assign-parser-thread.spec.ts` — THREAD ASSIGN cases

**US-002**

- `apps/runner/src/logs/log-shipper-thread.spec.ts` — the `thread` stream against the fake log server
- `apps/runner/src/capabilities/nax-probe-thread.spec.ts` — `threadBackends` and the tier providers

**US-003**

- `apps/runner/src/thread/thread-job-run.ts` — `ThreadJobRun`, `ThreadHostDeps`, `ThreadRunTuning`, `ThreadRunSetup`
- `apps/runner/test/helpers/fake-agent-session.ts` — a scripted `AgentSession` and session factory
- `apps/runner/src/thread/thread-job-run-start.spec.ts` — start steps over fakes and a real journal

**US-004**

- `apps/runner/src/thread/thread-job-run-close.spec.ts` — turns, idle, caps, failure

**US-005**

- `apps/runner/src/thread/thread-job-run-commands.spec.ts` — commands and cancel

**US-006**

- `apps/runner/src/supervisor/supervisor-thread.spec.ts` — routing, READOPT, ABANDON through `CommandHandler.handle`

**US-007**

- `apps/runner/src/thread/thread-host.ts` — `threadNativeModels`
- `apps/runner/test/unit/daemon-thread.spec.ts` — daemon wiring with its own fake fleet server (modelled on `daemon.spec.ts`'s, plus a `thread` log route and an `archivedThreadIds` knob), fake sessions and real git

### Modifies

**US-001**

None. The THREAD branch is new; no existing assign-parser assertion covers the `THREAD` kind.

**US-002**

- `apps/runner/src/capabilities/nax-probe.spec.ts` — the exact `capabilities` object at line 76 gains `threadBackends: { native: [], acp: [] }`, because this story makes the nax probe always report thread backends; every other field stays as asserted.

**US-003**

- `apps/runner/src/daemon/tuning.spec.ts` — the exact `TUNING` object gains `threadHeartbeatMs: 30_000` and `threadCloseTimeoutMs: 10_000`, because this story adds the thread heartbeat interval and the session close bound; it stays frozen.

**US-004**

None. The close paths are added to the file US-003 creates.

**US-005**

None. The commands are added to the file US-003 creates.

**US-006**

None. Thread command types reach `CommandHandler` only through the new routing; the existing `unknown command type` test uses `REBOOT`.

**US-007**

- `apps/runner/src/sync/batch.spec.ts` — line 109 `expect(FLEET_PROTOCOL_VERSION).toBe(3)` becomes `toBe(4)`, because this story bumps the package protocol version to 4 now that the runner can run THREAD jobs.
- `apps/runner/test/unit/daemon.spec.ts` — line 138 `expect(server.syncs[0].protocolVersion).toBe(3)` becomes `toBe(4)`, because this story bumps the package protocol version to 4.

### Seams

- US-001 → US-006: `parseAssign` accepting `THREAD` is reached through `CommandHandler.handle` (US-006 AC-1).
- US-002 → US-003: a `ThreadLogJob` is what `ThreadJobRun` registers (US-003 AC-12); the real `LogShipper` ships it
  through `startDaemon` (US-007 AC-3).
- US-002 → US-007: `threadBackends` reaches the server in the first sync's `capabilities` (US-007 AC-2).
- US-003..US-005 → US-006: `ThreadJobRun` is begun, cancelled, abandoned and sent commands only through
  `CommandHandler.handle` (US-006 AC-1, AC-6, AC-7, AC-8).
- US-006 → US-007: `SupervisorDeps.threads` is set by `startDaemon` (US-007 AC-3).


## Acceptance Criteria

### US-001: THREAD ASSIGN parsing

Each criterion calls `parseAssign` with a THREAD ASSIGN command built from one valid fixture (`command: 'THREAD'`,
`feature: 'thread-t1'`, `profiles: []`, `bashMode: 'raw'`, `planFrom: null`, a `thread` block with `threadId: 't1'`,
`action: 'SESSION'`, `feature: 'brainstorm-x'`, `resume: false`, `instructions: 'be helpful'`, `backend: { kind:
'native', model: 'minimax/MiniMax-M3' }`, one skill source and `initialMessage: { messageId: 'm1', text: 'hi' }`),
changing only the field the criterion names.

- AC-1 [unit] `parseAssign` of the valid fixture returns an `assign.thread` deep-equal to the fixture's `thread`
  block.
- AC-2 [unit] `parseAssign` of the fixture without `thread` returns `{ ok: false, detail: 'invalid thread' }`.
- AC-3 [unit] `parseAssign` of a RUN ASSIGN that carries the fixture's `thread` block returns `{ ok: false, detail:
  'invalid thread' }`.
- AC-4 [unit] `parseAssign` of the fixture with `profiles: ['fast']` returns `{ ok: false, detail: 'invalid profiles'
  }`.
- AC-5 [unit] `parseAssign` of the fixture with `bashMode: 'gated'` returns `{ ok: false, detail: 'invalid bashMode'
  }`.
- AC-6 [unit] `parseAssign` of the fixture with `thread.threadId: '../t1'` returns `{ ok: false, detail: 'invalid
  threadId' }`.
- AC-7 [unit] `parseAssign` of the fixture with `thread.action: 'PUBLISH'` returns `{ ok: false, detail: 'invalid
  thread action' }`.
- AC-8 [unit] `parseAssign` of the fixture with `thread.feature: '../x'` returns `{ ok: false, detail: 'invalid thread
  feature' }`.
- AC-9 [unit] `parseAssign` of the fixture with `thread.backend: { kind: 'native', model: 'm/x[high]' }` returns `{
  ok: false, detail: 'invalid backend' }`.
- AC-10 [unit] `parseAssign` of the fixture with `thread.backend: { kind: 'acp', agent: 'claude' }` returns `ok`
  `true`.
- AC-11 [unit] `parseAssign` of the fixture with `thread.skills: 'none'` returns `{ ok: false, detail: 'invalid
  skills' }`.
- AC-12 [unit] `parseAssign` of the fixture with `thread.initialMessage.text` of 32769 ASCII characters returns `{ ok:
  false, detail: 'invalid initialMessage' }`.
- AC-13 [unit] `parseAssign` of the fixture with `thread.initialMessage: null` returns an `assign.thread` whose
  `initialMessage` is `null`.
- AC-14 [unit] `parseAssign` of the fixture with an extra `thread.extra: 1` returns an `assign.thread` that has no
  `extra` key.
- AC-15 [unit] `parseAssign` of the fixture with `thread.initialMessage.text` of 11000 characters `'中'` (33000 UTF-8
  bytes) returns `{ ok: false, detail: 'invalid initialMessage' }`.

### US-002: Thread log stream and `threadBackends` report

- AC-1 [unit] A `LogShipper` over the fake log server, given `register({ jobId: 'j1', leaseEpoch: 1, threadPath,
  lifecycle })` with `threadPath` holding `'{"a":1}\n'`, leaves the fake log server holding `'{"a":1}\n'` for
  `j1:1:thread`.
- AC-2 [unit] A `LogShipper` given a `ThreadLogJob` makes no PUT for stream `stdout`, `stderr` or `run`.
- AC-3 [unit] `drain('j1', 1, 5000)` on a registered `ThreadLogJob` whose file was appended after registration
  resolves `'drained'` with the fake log server holding the whole file for `j1:1:thread`.
- AC-4 [unit] `drain('j1', 1, 5000)` on a registered `ThreadLogJob` makes a last PUT for stream `thread` with `final`
  `true`.
- AC-5 [unit] `ServerClient.putLog` with `stream: 'thread'` requests a URL whose path is
  `/fleet/runner/jobs/j1/logs/thread`.
- AC-6 [unit] `NaxCapabilityProbe.probe` with a nax home whose `config.json` has `models.native` `{ balanced:
  'minimax/MiniMax-M3' }` and a fake `auth list` reporting `minimax` available returns `threadBackends` `{ native:
  ['minimax/MiniMax-M3'], acp: [] }`.
- AC-7 [unit] `NaxCapabilityProbe.probe` with the AC-6 home and a fake `auth list` reporting `minimax` unavailable
  returns `threadBackends` `{ native: [], acp: [] }`.
- AC-8 [unit] `NaxCapabilityProbe.probe` with the AC-6 home and no profiles calls nax with arguments `['auth', 'list',
  '--json', 'minimax']`.
- AC-9 [unit] `NaxCapabilityProbe.probe` with a nax home without `config.json` returns `threadBackends` `{ native: [],
  acp: [] }`.

### US-003: ThreadJobRun start

Each criterion runs a `ThreadJobRun` over a real `:memory:` journal holding one THREAD row (the US-001 fixture), the
fake session and factory from `test/helpers/fake-agent-session.ts` (Design "Test double"), `FakeLogShipping`, a
recording `CredentialProvider` and recording `prepareWorktree` / `ensureSkills` stubs that succeed unless the
criterion says otherwise, all writing to one shared `calls` recorder. "Once `RUNNING`" means after the row's state is
`RUNNING` and the first turn's iteration has ended; `start()` itself resolves only when the run ends.

- AC-1 [unit] Once `RUNNING`, with a first turn that ends `completed`, the row's state events are exactly `[RUNNING]`.
- AC-2 [unit] Once `RUNNING`, the shared recorder holds, in order, `credentials.acquire`, `prepareWorktree`,
  `credentials.release`, `ensureSkills`, `sessions.open`.
- AC-3 [unit] `prepareWorktree` is called with `feature` `'brainstorm-x'`, `baseRef` equal to the ASSIGN's `ref` and
  `credentialHelper` equal to the helper `credentials.acquire` returned.
- AC-4 [unit] `ensureSkills` is called with `skillsRoot` `<homeDir>/skills` and the fixture's skill sources.
- AC-5 [unit] `sessions.open` is called with `worktree` equal to the worktree `prepareWorktree` returned and
  `approvalTimeoutSec` equal to the ASSIGN's.
- AC-6 [unit] `start('prepare')` whose `prepareWorktree` returns `{ ok: false, reason: 'worktree_conflict' }` leaves
  the row's state events exactly `[FAILED]` with reason `worktree_conflict`.
- AC-7 [unit] `start('prepare')` whose `prepareWorktree` returns `{ ok: false, reason: 'worktree_conflict' }` calls
  `credentials.release`.
- AC-8 [unit] `start('prepare')` whose `prepareWorktree` returns `{ ok: false, reason: 'worktree_conflict' }` never
  calls `sessions.open`.
- AC-9 [unit] `start('prepare')` whose `prepareWorktree` returns `{ ok: false, reason: 'worktree_conflict' }` resolves
  with the row's `doneAt` set.
- AC-10 [unit] `start('prepare')` whose `ensureSkills` returns `{ ok: false, reason: 'skill_fetch_failed' }` leaves
  the row's state events exactly `[FAILED]` with reason `skill_fetch_failed`.
- AC-11 [unit] `start('prepare')` whose `sessions.open` returns `{ ok: false, reason: 'model_unknown' }` leaves the
  row's state events exactly `[FAILED]` with reason `model_unknown`.
- AC-12 [unit] Once `RUNNING`, `logs.register` was called with `threadPath` equal to
  `<workspaceRoot>/.jobs/<jobId>/thread-events.jsonl`.
- AC-13 [unit] Once `RUNNING`, the first line of `<jobDir>/thread-events.jsonl` has `type` `'session_started'` and
  `skillShas` equal to the shas of the fixture's skill sources.
- AC-14 [unit] Once `RUNNING`, the session's `send` was called with `'hi'`, the fixture's initial message text.
- AC-15 [unit] Once `RUNNING`, the stream file's `input_consumed` line with `messageId` `'m1'` comes before the first
  line written from a session event.

### US-004: ThreadJobRun turns, idle, caps and failure

Each criterion runs a `ThreadJobRun` over a real `:memory:` journal holding one THREAD row, a manual clock, the fake
session and factory from `test/helpers/fake-agent-session.ts` (Design "Test double") with turns scripted per
criterion, `FakeLogShipping`, a recording `CredentialProvider` and succeeding `prepareWorktree` / `ensureSkills`
stubs.

- AC-1 [unit] After a turn ends `completed`, advancing the clock by `threadIdleMs` leaves the row's state events
  exactly `[RUNNING, UPLOADING, COMPLETED]` with the `COMPLETED` reason `idle`.
- AC-2 [unit] After the idle close, the last line of the stream file is `session_closed` with `reason` `'idle'`.
- AC-3 [unit] With `FakeLogShipping.holdDrain()`, after the idle timer fires the row stays `RUNNING` until the drain
  is released.
- AC-4 [unit] Advancing the clock by `threadIdleMs` while a held turn is still delivering events records no
  `UPLOADING` event.
- AC-5 [unit] While the run is `RUNNING`, advancing the clock by `threadHeartbeatMs` journals a `snapshot` event whose
  payload has a `heartbeatAt` string.
- AC-6 [unit] A turn ending `timed_out` leaves the row in state `RUNNING`.
- AC-7 [unit] A turn ending `errored` leaves the session's `close` uncalled.
- AC-8 [unit] A turn ending `interrupted` leaves the row in state `RUNNING`.
- AC-9 [unit] With `maxCostUsd` `'1.00'`, a turn whose `usage` events carry `costUsd` 0.6 and then 0.5 calls the
  session's `cancel`.
- AC-10 [unit] With `maxCostUsd` `'1.00'`, a turn whose `usage` events carry `costUsd` 0.6 and then 0.5 ends the job
  `COMPLETED` with reason `cost_cap`.
- AC-11 [unit] With `maxCostUsd` `'1.00'`, a turn whose single `usage` event carries `costUsd` 0.6 and whose `turn_end`
  carries `costUsd` 0.6 leaves the row in state `RUNNING`.
- AC-12 [unit] A session whose turn throws after its first event leaves the row's state events exactly `[RUNNING,
  UPLOADING, FAILED]` with the `FAILED` reason `session_error`.
- AC-13 [unit] A session whose turn throws after its first event writes a last stream line `session_failed` with
  `reason` `'session_error'`.
- AC-14 [unit] A run with tuning `streamMaxBytes` 4096 ends `COMPLETED` with reason `stream_cap` after the first
  session event of its first turn.
- AC-15 [unit] A run started on a row whose `<jobDir>/thread-events.jsonl` already holds a line `{"type":"stale"}`
  writes a stream file whose lines include no `stale` line.

### US-005: ThreadJobRun commands and cancel

Each criterion runs a `ThreadJobRun` over a real `:memory:` journal holding one THREAD row, a manual clock, the fake
session and factory from `test/helpers/fake-agent-session.ts` (Design "Test double"), `FakeLogShipping`, a recording
`CredentialProvider` and succeeding `prepareWorktree` / `ensureSkills` stubs; the run is `RUNNING` with its first turn
finished unless the criterion says otherwise.

- AC-1 [unit] `command('THREAD_INPUT', { messageId: 'm2', text: 'next' })` calls the session's `send` with `'next'`.
- AC-2 [unit] Two `command('THREAD_INPUT', ...)` calls made back to back, with no await between them, return `{
  result: 'ok' }` and then `{ result: 'rejected', detail: 'turn_running' }`.
- AC-3 [unit] `command('THREAD_INPUT', { messageId: '../m', text: 'x' })` returns `{ result: 'rejected', detail:
  'invalid payload' }`.
- AC-4 [unit] `command('THREAD_INPUT', ...)` returns `{ result: 'ok' }` while the held turn it started is still
  delivering events.
- AC-5 [unit] `command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })` calls the session's `answer` with `'q1'`
  and `{ text: 'yes' }`.
- AC-6 [unit] `command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })` whose `answer` returns `'accepted'`
  returns `{ result: 'ok' }`.
- AC-7 [unit] `command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })` whose `answer` returns `'expired'` returns
  `{ result: 'rejected', detail: 'expired' }`.
- AC-8 [unit] `command('THREAD_STOP_TURN', {})` during a held turn calls the session's `cancel`.
- AC-9 [unit] `command('THREAD_STOP_TURN', {})` during a held turn leaves the row in state `RUNNING` after that turn
  ends.
- AC-10 [unit] `command('THREAD_CLOSE', {})` ends the job `COMPLETED` with reason `closed`.
- AC-11 [unit] `command('THREAD_CLOSE', {})` during a held turn records the session's `cancel` before its `close` in
  the shared recorder.
- AC-12 [unit] `command('THREAD_INPUT', { messageId: 'm2', text: 'next' })` while the idle close's drain is held
  returns `{ result: 'rejected', detail: 'session_closed' }`.
- AC-13 [unit] `requestCancel()` while the idle close's drain is held, then releasing the drain, ends the job
  `COMPLETED` with reason `idle`.
- AC-14 [unit] `requestCancel()` while `sessions.open` is held, then releasing it, leaves the row's state events
  exactly `[CANCELLED]` with reason `cancelled before start`.
- AC-15 [unit] `requestCancel()` while `sessions.open` is held, then releasing it, calls `close` on the session that
  `open` resolved.

### US-006: Supervisor and CommandHandler for THREAD jobs

Each criterion builds a `CommandHandler` over a real `:memory:` journal and a `Supervisor` whose `threads` uses the
fake session and factory from `test/helpers/fake-agent-session.ts` (Design "Test double"), a recording
`CredentialProvider` and succeeding worktree and skill stubs, with `FakeExecutor` for RUN jobs and the real
`RepoMutex`, and enters through `CommandHandler.handle`.

- AC-1 [integration] `handle([<THREAD ASSIGN>])` brings the THREAD row to state `RUNNING`.
- AC-2 [integration] `handle([<THREAD ASSIGN>])` on a Supervisor without `threads` ends the row `FAILED` with reason
  `backend_unavailable`.
- AC-3 [integration] `handle([<THREAD_INPUT for a RUNNING thread job>])` acks `{ result: 'ok' }`.
- AC-4 [integration] `handle([<THREAD_INPUT>])` sent twice with the same command id calls the session's `send` with
  its text once in total.
- AC-5 [integration] `handle([<THREAD_INPUT for a job id the runner never assigned>])` acks `{ result: 'rejected',
  detail: 'does not hold job' }`.
- AC-6 [integration] `handle([<THREAD_CLOSE>])`, waiting until `Supervisor.idle()` resolves, then
  `handle([<THREAD_INPUT>])` for that job acks the input `{ result: 'rejected', detail: 'does not hold job' }`.
- AC-7 [integration] `handle([<CANCEL for a RUNNING thread job>])` leaves the row's state events ending `[UPLOADING,
  CANCELLED]`.
- AC-8 [integration] With a RUN job of the same repo holding the repo mutex (its `FakeExecutor` watch held),
  `handle([<ABANDON for a RUNNING thread job>])` resolves while the RUN still holds the mutex.
- AC-9 [integration] After `handle([<ABANDON for a RUNNING thread job>])`, `journal.getJob(jobId, leaseEpoch)` is
  `null`.
- AC-10 [integration] `handle([<ABANDON for a RUNNING thread job>])` whose session's `close` never resolves resolves
  once a manual clock passes `threadCloseTimeoutMs`.
- AC-11 [integration] `handle([<ABANDON for a RUNNING thread job>])` calls `credentials.release` for that row.
- AC-12 [integration] `handle([<ABANDON for a RUNNING thread job>])` during a held turn, followed by releasing the
  turn, leaves `journal.pendingEvents(jobId, leaseEpoch, 100)` empty.
- AC-13 [integration] `handle([<ABANDON for a RUNNING thread row with no run in memory>])` resolves while a RUN of the
  same repo holds the repo mutex.
- AC-14 [integration] `handle([<READOPT for a RUNNING thread row with no run in memory>])` acks `{ result:
  'rejected', detail: 'thread session ended by a runner restart' }`.
- AC-15 [integration] `handle([<READOPT for a RUNNING thread row with no run in memory>])` makes no `reap`, `cleanup`
  or `kill` call on the `FakeExecutor`.

### US-007: Daemon wiring and protocol 4

Each `[integration]` criterion runs `startDaemon` in nax mode (a runner config with no `capabilities` block and a
`FakeNaxCli` that answers the version, trust, profile, sandbox and `auth list` calls, as `test/unit/daemon.spec.ts`
does from line 365) against the fake fleet server defined in `test/unit/daemon-thread.spec.ts` (Creates), with
injected `threadSessions` (the fake factory from `test/helpers/fake-agent-session.ts`) and `configureCredentials`, a
`file://` clone, and `selfCommand: [process.execPath, <src/main.ts>]`.

- AC-1 [integration] `startDaemon` calls the injected `configureCredentials` exactly once, with a config whose
  `configDir()` returns `config.naxHome`.
- AC-2 [integration] With a nax home whose `config.json` has `models.native` `{ balanced: 'minimax/MiniMax-M3' }` and
  `minimax` reported available, the first sync's `capabilities.threadBackends` equals `{ native:
  ['minimax/MiniMax-M3'], acp: [] }`.
- AC-3 [integration] A THREAD ASSIGN delivered by the fake fleet server leads to a `thread` log PUT for that job whose
  first line has `type` `'session_started'`.
- AC-4 [integration] With capacity 2 and one RUNNING THREAD job, the next sync reports `freeSlots` 2.
- AC-5 [unit] `Journal.activeCountExcluding('THREAD')` over one active RUN row and one active THREAD row returns 1.
- AC-6 [unit] `SyncLoop` given a response with `archivedThreadIds: ['t1']` calls `onArchivedThreads` with `['t1']`.
- AC-7 [integration] After a sync answering `archivedThreadIds: ['t9']` and the next prune pass, `<home>/threads/t9`
  no longer exists.
- AC-8 [integration] After a sync answering `archivedThreadIds: ['t1']` while thread `t1`'s job is RUNNING, the next
  prune pass keeps `<home>/threads/t1`.
- AC-9 [integration] A `<home>/skills/<sourceId>/<sha>` directory whose mtime is 31 days old is gone after the next
  prune pass.
- AC-10 [unit] `threadNativeModels(naxHome, () => caps)` with `caps.credentials` listing `minimax` available and
  `zai` unavailable, over tiers `{ fast: 'minimax/MiniMax-M2.7', balanced: 'zai/glm-5' }`, resolves `models`
  `['minimax/MiniMax-M2.7']`.
- AC-11 [unit] `threadNativeModels(naxHome, () => null)` resolves `{ models: [], defaultModel: null }`.
- AC-12 [integration] The daemon's first sync sends `protocolVersion` 4.
