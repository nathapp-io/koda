# SPEC: review-1120 runner fixes (K10, K11, K13, K18)

## Summary

This feature fixes the runner findings of the 2026-11-20 whole-repo review
(`docs/20261120-review-whole-repo-consolidated.md`): K10, K11, K13 and K18. The deploy, CI and release findings
shipped in #487; the API, CLI and web findings shipped in #488.

1. **READOPT replay (K10).** A READOPT that was applied and journaled `ok`, then lost to a second restart before its
   ack reached the API, is applied again when the same command id comes back, so a job whose run is not in memory gets
   a watcher again instead of an `ok` ack that leaves it unsupervised.
2. **Requeue ASSIGN does not block the sync loop (K11).** An ASSIGN that replaces an older epoch of the same job no
   longer awaits the older epoch's abandon inside the command handler. A finished older row is dropped at once; any
   other older row is abandoned in the background, and the new epoch's run waits for that abandon before it queues for
   the repo.
3. **Cancel during UPLOADING (K13).** By owner ruling (2026-11-20), the API refuses a cancel once the job is
   UPLOADING, with the same 409 it gives a finished job, and sends no CANCEL for a job it already knows is UPLOADING. A
   cancel in flight across the runner's RUNNING to UPLOADING move is unchanged (Out of Scope).
4. **Shutdown during a sync backoff (K18).** `SyncLoop.stop()` also ends the loop's retry and min-gap sleeps, so a
   SIGTERM during an API outage no longer waits up to 60 s before the daemon's cleanup runs.

## Motivation

- **K10.** `CommandHandler.handleOne` answers a command id it has already journaled from the journal. Only an ASSIGN
  replay calls `resumeStranded`; a READOPT replay just repeats the stored ack. When boot 2 applies a READOPT and
  restarts before the ack reaches the API, the API's `reconcileBoot` sees the READOPT still pending and queues no new
  one, so boot 3 receives the same command id, replays `ok`, and the API then sets `runnerBootId` to boot 3. No
  further READOPT is sent and nothing watches the job: nax keeps running but nobody reports its progress or verdict.
- **K11.** `CommandHandler.assign` awaits `supervisor.abandon` for every older-epoch row of the job. Both paths end in
  `JobRun.abandon`, which awaits `mutex.acquire(row.repoKey)`. The sync loop awaits `handleCommands` inline, so while
  another job holds that repo's lock (a long RUN) every sync on the runner waits: heartbeats, cancels and token
  refreshes for its other jobs. Finished rows stay until `jobRetentionDays` pruning, so any requeue onto a runner that
  still holds the older row triggers the stall.
- **K13.** `FleetJobsService.cancel` accepts a cancel in UPLOADING. The runner's `requestCancel` records the flag and
  acks `ok`, but the finish path computed its verdict before the upload and calls `transition(verdict.state)` after
  it without looking at the flag again, so the user sees an accepted cancel followed by COMPLETED.
- **K18.** `SyncLoop.stop()` aborts only an in-flight request. `run()` sleeps the retry backoff and the min gap through
  `deps.sleep` without a signal, and the daemon's `stop` awaits the loop before any cleanup. During an API outage a
  SIGTERM can wait up to the 60 s backoff ceiling, and a service manager with a shorter stop timeout can kill the daemon
  before cleanup runs.

## Design

### Calls made in this spec

- **K10.** In `CommandHandler.handleOne`, a replayed command whose record is `type === 'READOPT'` and
  `result === 'ok'` checks the row `journal.getJob(prior.jobId, prior.leaseEpoch)`. When the row exists and its
  `doneAt` is `null`, the handler calls `supervisor.readopt(prior.jobId, prior.leaseEpoch)` again, overwrites the
  journaled outcome with the new one through the new `Journal.updateCommandOutcome` (an absent `detail` stored as
  `null`, as `recordAs` already does), and acks the new outcome.
  `Supervisor.readopt` already returns `ok` without side effects when a run for that (job, epoch) is in memory, so a
  READOPT re-sent to the same boot is still a no-op. A row that is gone or has `doneAt` set keeps today's replay of the
  stored ack. A READOPT record that is `rejected` keeps today's replay. A throw from the repeated `readopt` acks
  `rejected` with detail `runner error` (as a throw from a first apply does) and leaves the journaled record unchanged.
  The journaled result is overwritten so a later replay of the same id (a third restart) acks what the API must see
  last: once `readopt` has rejected and marked the row done, the replay acks the rejection, not the stale `ok`.
- **K11.** `CommandHandler.assign` no longer awaits anything after inserting the new row. It calls
  `const retiring = supervisor.retireOlderEpochs(jobId, leaseEpoch)` and then
  `supervisor.begin(inserted.row, 'prepare', retiring)`. `retireOlderEpochs` walks `journal.jobsById(jobId)` for rows
  with a lower epoch: a row with `doneAt` set is dropped at once with `journal.abandon` (its run already called `executor.cleanup`, which in `HostExecutor.cleanup` closes the approval relay and releases
  the job's credentials, and the new epoch's prepare wipes the previous attempt's
  files, D53), before `retireOlderEpochs` returns; any other row goes through the existing `supervisor.abandon`, which
  still takes the repo mutex. It returns a promise that settles when every such abandon has settled; a rejected
  abandon is logged at `warn` with message `older epoch abandon failed` and never rejects the returned promise. The
  promise is added to the supervisor's pending set, so `idle()` waits for it, and removes itself from that set when it
  settles (as `track` does for a run). `Supervisor.begin` gains an optional
  third parameter `after: Promise<void>`. The run is put in the run map and its promise in the pending set at `begin`
  time, as today, so a CANCEL or ABANDON for the new epoch finds it and `idle()` waits for it. For a nax job `begin`
  calls `run.start(from, after)`: `JobRun.start` gains the same optional `after`, and `JobRun.run` sets its `queued`
  flag before it awaits `after` and then the repo mutex. A CANCEL for the new epoch that arrives while it waits
  therefore takes the existing D66 path at once (`endWhileQueued`: `CANCELLED`, `cancelled before start`, `doneAt` set),
  and the run, once it gets the lock, sees `doneAt` and lets go without calling `prepare`. A THREAD row starts at once and ignores `after`: an older THREAD
  row is retired with `journal.abandon` plus a credential release and never takes the repo mutex, so there is nothing
  to wait for. This keeps the D64 rule that the older epoch is gone
  before the new epoch's prepare, without holding the sync loop.
- **K13.** In `FleetJobsService.cancel`, right after the terminal-state check, a job in `UPLOADING` throws
  `ConflictAppException({ state: current.state }, 'fleet.jobState')`, the same 409 a finished job gets, before the
  `cancelRequestedAt` no-op check. A repeated cancel of an UPLOADING job whose cancel was requested while RUNNING is
  therefore also a 409. `cancelForBudget` and `cancelForRunnerDisabled` already skip UPLOADING and are unchanged.
- **K18.** `SyncLoop` owns one `AbortController` for its lifetime. `stop()` aborts it (and still aborts the in-flight
  request), and `run()` passes its signal as the second argument of both `deps.sleep` calls (the retry delay and the
  min gap). The `Sleep` type already takes an optional signal and `systemSleep` resolves early when it aborts, so
  `daemon.ts` does not change.

### Integration

Symbols this feature only reads:

- `Supervisor.readopt(jobId: string, leaseEpoch: number): Promise<ReadoptResult>` (`apps/runner/src/supervisor/supervisor.ts`)
- `Supervisor.abandon(jobId: string, leaseEpoch: number): Promise<void>`
- `Journal.getCommand(commandId: string): CommandRecord | null`, `Journal.jobsById(jobId: string): JobRow[]`,
  `Journal.abandon(jobId: string, leaseEpoch: number): void` (`apps/runner/src/journal/journal.ts`)
- `systemSleep: Sleep` with `type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>` (`apps/runner/src/time.ts`)
- `ConflictAppException` and the `fleet.jobState` 409 message (`apps/api/src/i18n/{en,zh}/fleet.json`, unchanged)

Symbols this feature changes (the baseline only locates the code; implement the target):

- `CommandHandler.handleOne` (`apps/runner/src/supervisor/command-handler.ts`). Baseline: a replay calls
  `resumeStranded` for an `ASSIGN`/`ok` record and acks the stored outcome. Target: also re-applies a `READOPT`/`ok`
  record whose row exists with `doneAt` null, as above.
- `CommandHandler.assign`. Baseline: `for (const older of ...) await supervisor.abandon(...)` then
  `supervisor.begin(inserted.row, 'prepare')`. Target: `supervisor.begin(inserted.row, 'prepare', supervisor.retireOlderEpochs(jobId, leaseEpoch))`, nothing awaited.
- `Supervisor.begin`. Baseline: `begin(row: JobRow, from: RunStart): void`. Target:
  `begin(row: JobRow, from: RunStart, after?: Promise<void>): void`.
- `JobRun.start` (`apps/runner/src/supervisor/job-run.ts`). Baseline: `start(from: RunStart): Promise<void>`. Target:
  `start(from: RunStart, after?: Promise<void>): Promise<void>`, with `queued` set before `after` is awaited.
- New: `Supervisor.retireOlderEpochs(jobId: string, leaseEpoch: number): Promise<void>`.
- New: `Journal.updateCommandOutcome(commandId: string, outcome: { result: 'ok' | 'rejected'; detail: string | null; appliedAt: string }): void`,
  an `UPDATE` of the existing `applied_commands` row; an unknown id changes nothing and inserts nothing.
- `SyncLoop.stop()` and `SyncLoop.run()` (`apps/runner/src/sync/sync-loop.ts`): target as in Calls above.
- `FleetJobsService.cancel` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts`): target as in Calls above.

### Failure Handling

| Case | Behaviour |
|---|---|
| READOPT replay, row exists, `doneAt` null, no run in memory | `readopt` runs again; its outcome is acked and journaled |
| READOPT replay, a run for the (job, epoch) is in memory | `readopt` answers `ok`; ack `ok`; nothing new starts |
| READOPT replay, row gone or `doneAt` set | stored ack replayed; `readopt` not called |
| READOPT replay of a `rejected` record | stored rejection replayed; `readopt` not called |
| READOPT replay, repeated `readopt` throws | ack `rejected` / `runner error`; journaled record unchanged |
| Requeue ASSIGN, older row finished | row dropped before the handler returns; no mutex taken |
| Requeue ASSIGN, older row not finished, repo mutex held elsewhere | handler acks `ok` at once; the new run starts after the older abandon |
| Older-epoch abandon rejects | `warn` `older epoch abandon failed`; the new epoch still starts |
| CANCEL of the new epoch while it waits for the older abandon | `ok`; the new epoch ends `CANCELLED` at once (D66 path) and never calls `prepare` |
| `stop()` while the loop sleeps a retry or min gap | the sleep ends at once; `run()` resolves without another sync |
| User cancel of an UPLOADING job | 409 `fleet.jobState`; no command, no `cancelRequestedAt`, no audit |

## Out of Scope

- A cancel the API accepted while the job was RUNNING that reaches the runner after it moved to UPLOADING locally: the runner still finishes with its verdict. The owner ruled that the API refuses a cancel in UPLOADING (2026-11-20); the runner's finish path does not change.
- The web Cancel button and the assistant `cancel_job` preview during UPLOADING: both still offer the action, and the 409 the API answers is shown through the existing error and refusal paths.
- Stamping journaled command results with a boot id: the READOPT replay re-applies instead (K10).
- A server-side heartbeat sweeper that would mark an unsupervised RUNNING job CRASHED: the runner-side replay closes the K10 window.
- Checking the shipped systemd unit and launchd plist stop timeouts against the sync backoff: K18 removes the wait instead.
- Releasing credentials or approvals again for a finished older row dropped by `retireOlderEpochs`: `HostExecutor.cleanup` already released them when that row finished.
- `daemon.ts` shutdown order: unchanged; it already stops the loop first.
- An ABANDON, or a further requeue, for a new epoch that is still waiting for its older abandon: it queues on the repo mutex ahead of that run's own lock request, and the run then finds its row gone and returns; no AC pins it.
- Deferring a requeued THREAD job's start: a THREAD row starts at once, because retiring an older THREAD row never takes the repo mutex.
- The `@ApiResponse` 409 description of the cancel route (`Job already finished`) and the committed `openapi.json`: unchanged; only the service's doc comments are updated.
- An ABANDON command and the `unknownJobIds` sweep (`abandonUnknown`) still await the older run's repo mutex inside the sync loop: K11 covers only the requeue ASSIGN.
- A daemon stop while a new epoch waits for its older abandon: the halted run still reaches `prepare` after the lock and discards it, as a run queued for the mutex already does.
- The API `reconcileBoot` READOPT rule: unchanged.

## Stories

Four stories, one package each: three runner stories and one API story. Only US-002 depends on another story (US-001). They are one bundle by
owner ruling (the 2026-11-20 split into three specs by area).

**US-001: READOPT replay re-applies to an unsupervised row.** Workdir: `apps/runner`. No dependencies.
`CommandHandler.handleOne` repeats `supervisor.readopt` for a replayed `READOPT`/`ok` record whose row is not done,
and `Journal.updateCommandOutcome` stores the new outcome (K10).

**US-002: Requeue ASSIGN retires older epochs without blocking.** Workdir: `apps/runner`. Depends on US-001 (both edit
`command-handler.ts` and `command-handler.spec.ts`; US-002 extends the `build()` that US-001's tests use).
`Supervisor.retireOlderEpochs` drops finished older rows at once and abandons the rest in the background;
`Supervisor.begin` starts the new epoch's run only after that abandon settles (K11).

**US-003: Sync loop stop ends its sleeps.** Workdir: `apps/runner`. No dependencies.
`SyncLoop.stop()` aborts the signal `run()` passes to its retry and min-gap sleeps (K18).

**US-004: API refuses a cancel during UPLOADING.** Workdir: `apps/api`. No dependencies.
`FleetJobsService.cancel` answers 409 `fleet.jobState` for an UPLOADING job and sends no CANCEL (K13).

### Context Files

**US-001**
- `apps/runner/src/supervisor/command-handler.ts`
- `apps/runner/src/supervisor/supervisor.ts`
- `apps/runner/src/journal/journal.ts`
- `apps/runner/src/supervisor/command-handler.spec.ts`
- `apps/runner/test/helpers/fake-executor.ts`

**US-002**
- `apps/runner/src/supervisor/command-handler.ts`
- `apps/runner/src/supervisor/supervisor.ts`
- `apps/runner/src/supervisor/job-run.ts`
- `apps/runner/src/supervisor/repo-mutex.ts`
- `apps/runner/src/supervisor/command-handler.spec.ts`

**US-003**
- `apps/runner/src/sync/sync-loop.ts`
- `apps/runner/src/time.ts`
- `apps/runner/src/sync/sync-loop.spec.ts`

**US-004**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.audit.spec.ts`
- `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`

### Creates

None.

### Modifies

**US-001**
- `apps/runner/src/supervisor/command-handler.ts` — `handleOne`'s replay branch re-applies a `READOPT`/`ok` record whose row exists with `doneAt` null through `supervisor.readopt`, acks the new outcome and stores it with `journal.updateCommandOutcome`; a throw acks `rejected` / `runner error`.
- `apps/runner/src/journal/journal.ts` — gains `updateCommandOutcome(commandId, { result, detail, appliedAt })`, an `UPDATE` of the existing `applied_commands` row that inserts nothing.
- `apps/runner/src/journal/journal.spec.ts` — gains the `updateCommandOutcome` cases.
- `apps/runner/src/supervisor/command-handler.spec.ts` — gains the READOPT replay cases; the existing "READOPT is delegated and its ack replays" test keeps passing (its row is COMPLETED, and a terminal row's first `readopt` marks it done).

**US-002**
- `apps/runner/src/supervisor/command-handler.ts` — `assign` stops awaiting older-epoch abandons and calls `supervisor.begin(inserted.row, 'prepare', supervisor.retireOlderEpochs(jobId, leaseEpoch))`.
- `apps/runner/src/supervisor/supervisor.ts` — gains `retireOlderEpochs(jobId, leaseEpoch)`; `begin` gains the optional `after` promise and passes it to `JobRun.start`; a `ThreadJobRun` starts at once, as today.
- `apps/runner/src/supervisor/job-run.ts` — `start` and `run` take the optional `after` promise; `run` sets `queued` before awaiting it and then the repo mutex.
- `apps/runner/src/supervisor/command-handler.spec.ts` — the D64 test "a higher epoch of the same job abandons the lower one first" asserts that `(j1, 1)` is gone and that pgid 4242 got SIGKILL right after `handle` resolves; the abandon of a row that is not done now completes in the background, so those two assertions move after `await b.supervisor.idle()` (the invariant kept: epoch 1 is killed and dropped before epoch 2's second `prepare`, and its cleanup is left to epoch 2). `build()` also returns its `RepoMutex` and its memory logger (`log`) so tests can hold a repo lock and read warnings.

**US-003**
- `apps/runner/src/sync/sync-loop.ts` — `SyncLoop` owns an `AbortController`; `stop()` aborts it and `run()` passes its signal to both `deps.sleep` calls.
- `apps/runner/src/sync/sync-loop.spec.ts` — gains the stop-during-sleep cases; the existing `sleep` stub ignores its second argument, so no existing assertion changes.

**US-004**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `cancel` throws `ConflictAppException({ state }, 'fleet.jobState')` for `UPLOADING`, right after the terminal-state check; its doc comment and the "Reachable only in ASSIGNED / RUNNING / UPLOADING" comment drop UPLOADING.
- `apps/api/src/fleet/jobs/fleet-jobs.audit.spec.ts` — the test "audits cancel from %s" runs over QUEUED, ASSIGNED, RUNNING and UPLOADING; UPLOADING is now refused with no audit entry, so it is dropped from that list (the invariant kept: every accepted cancel records one `fleet.job.cancel` audit entry), and the UPLOADING refusal cases are added.
- `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts` — gains the UPLOADING 409 route case.

### Seams

None: the new `Supervisor.retireOlderEpochs` and `Journal.updateCommandOutcome` are called only by `CommandHandler`
in the same story, and their ACs drive them through `CommandHandler.handle`, the entry point the sync loop calls.

## Acceptance Criteria

### US-001

Every AC uses a harness built like `command-handler.spec.ts`'s `build()`: `Journal.open(':memory:', time.now)` with
`fakeTime()`, a `FakeExecutor`, a real `Supervisor`, a `RepoMutex`, `createMemoryLogger()` and a `CommandHandler`, and
sets up the state a restarted daemon finds: the row `(j1, 1)` inserted with `journal.insertJob` and moved to
`RUNNING` with `pid` and `pgid` 4242 through `journal.updateJob`, no run started for it, and the record
`{ commandId: 'r1', type: 'READOPT', result: 'ok', detail: null }` for `(j1, 1)` written with `journal.recordCommand`.
"Replaying r1" is `handler.handle([{ commandId: 'r1', type: 'READOPT', jobId: 'j1', leaseEpoch: 1, payload: {} }])`.
A test that leaves a run going ends with `ex.dieAfterTicks(ex.ticks + 1)` or `supervisor.shutdown()`, then
`await supervisor.idle()`.

- AC-1 [unit] For a `REVIEW` row with `ex.alive = true` (a live process of ours), after replaying r1 the executor's `calls` come to include `resumeCredentials:j1` (awaited with the spec's `waitFor`; the run starts from `watch`).
- AC-2 [unit] (regression guard: passes before the change) In the AC-1 case, replaying r1 acks `{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }`.
- AC-3 [unit] For a `RUN` row whose `naxRunId` is null, replaying r1 acks `{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'run id mismatch' }`.
- AC-4 [unit] After the AC-3 replay, `journal.getCommand('r1')` has `result: 'rejected'` and `detail: 'run id mismatch'`.
- AC-5 [unit] After the AC-3 replay, replaying r1 a second time acks `{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'run id mismatch' }`.
- AC-6 [unit] For a `THREAD` row, replaying r1 acks `rejected` with detail `thread session ended by a runner restart`.
- AC-7 [unit] (regression guard: passes before the change) When the row's `doneAt` is set (`journal.markDone('j1', 1)`), replaying r1 acks `{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }` and the executor's `readStatus` is not called.
- AC-8 [unit] (regression guard: passes before the change) When the row is gone (`journal.abandon('j1', 1)`), replaying r1 acks `{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }`.
- AC-9 [unit] (regression guard: passes before the change) With the r1 record stored as `result: 'rejected'`, `detail: 'process gone'`, replaying r1 acks that rejection and the executor's `readStatus` is not called.
- AC-10 [unit] For a `REVIEW` row with `ex.alive = true` and no `dieAfterTicks` until after the second replay, replaying r1, waiting until `calls` include `resumeCredentials:j1`, then replaying r1 again leaves exactly one `resumeCredentials:j1` in `calls` and the second replay acks `{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }` (it finds the run in memory).
- AC-11 [unit] For a `RUN` row whose `naxRunId` is `'run-1'` and with `ex.statusError` set to an `Error`, replaying r1 acks `{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'runner error' }`.
- AC-12 [unit] (regression guard: passes before the change) After the AC-11 replay, `journal.getCommand('r1')` still has `result: 'ok'`.
- AC-13 [unit] `Journal.updateCommandOutcome('r1', { result: 'rejected', detail: 'x', appliedAt: '2026-11-20T00:00:00.000Z' })` on a stored record makes `getCommand('r1')` return `result: 'rejected'`, `detail: 'x'` and that `appliedAt`, with its `type`, `jobId` and `leaseEpoch` unchanged.
- AC-14 [unit] `Journal.updateCommandOutcome('nope', { result: 'ok', detail: null, appliedAt: '2026-11-20T00:00:00.000Z' })` for an id with no record leaves `getCommand('nope')` `null`.

### US-002

Every AC uses a harness built like `command-handler.spec.ts`'s `build()` (`Journal.open(':memory:', time.now)` with
`fakeTime()`, `FakeExecutor`, a real `Supervisor`, `CommandHandler`), which exposes its `RepoMutex` (`mutex`) and
`createMemoryLogger()` logger (`log`). "Holding the repo lock"
is `const release = await mutex.acquire('acme/app')` in the test before the ASSIGN (another job's run). "The older
row" is `(j1, 1)` inserted with `journal.insertJob` for repo `acme/app`; "the requeue" is
`handler.handle([assignCmd('c2', 'j1', 2)])`. Every test calls `ex.dieAfterTicks(ex.ticks + 2)` before the requeue so
the new epoch finishes, and ends with the lock released and `await supervisor.idle()`.

- AC-1 [unit] With the older row finished (`state` `COMPLETED`, `doneAt` set) and the repo lock held by the test, the requeue resolves with `[{ commandId: 'c2', leaseEpoch: 2, result: 'ok' }]` before the test releases the lock.
- AC-2 [unit] In the AC-1 case, `journal.getJob('j1', 1)` is `null` when the requeue resolves.
- AC-3 [unit] With the older row not finished (`state` `RUNNING`, `pid` and `pgid` 4242, `doneAt` null, no run started) and the repo lock held by the test, the requeue resolves with `[{ commandId: 'c2', leaseEpoch: 2, result: 'ok' }]` before the test releases the lock.
- AC-4 [unit] In the AC-3 case, the executor's `prepare` has not run for j1 when the requeue resolves.
- AC-5 [unit] In the AC-3 case, when the executor's `prepare` runs for `(j1, 2)` after the test releases the lock, `journal.getJob('j1', 1)` is already `null` (the test wraps the fake's `prepare` to record `journal.getJob('j1', 1)` into a variable at the call, and asserts on that variable after `idle()`, outside the wrapper).
- AC-6 [unit] In the AC-3 case, after the test releases the lock and `await supervisor.idle()`, `journal.getJob('j1', 2)` has `state` `COMPLETED`.
- AC-7 [unit] In the AC-3 case with `ex.alive = true`, after the test releases the lock and `await supervisor.idle()`, `ex.killed` includes `{ pgid: 4242, signal: 'SIGKILL' }`.
- AC-8 [unit] In the AC-3 case, `handler.handle([{ commandId: 'c3', type: 'CANCEL', jobId: 'j1', leaseEpoch: 2, payload: {} }])` before the test releases the lock acks `{ commandId: 'c3', leaseEpoch: 2, result: 'ok' }`.
- AC-9 [unit] After the AC-8 cancel and before the test releases the lock, `journal.getJob('j1', 2)` has `state` `CANCELLED` and a non-null `doneAt`.
- AC-10 [unit] After the AC-8 cancel, the test releasing the lock and `await supervisor.idle()`, the executor's `prepare` never ran for j1.
- AC-11 [unit] With epoch 1 started by `assignCmd('c1', 'j1', 1)` and running (`ex.ticks >= 1`), and no repo lock held by the test, the requeue resolves `ok`, and after `await supervisor.idle()` `journal.getJob('j1', 1)` is `null` and `ex.killed` equals `[{ pgid: 4242, signal: 'SIGKILL' }]`.
- AC-12 [unit] With `supervisor.abandon` replaced on the instance by a function that rejects with `Error('boom')` and the older row not finished, after the requeue and `await supervisor.idle()` the executor's `prepare` ran for j1.
- AC-13 [unit] In the AC-12 case, `log.lines` holds a `warn` entry with message `older epoch abandon failed`.
- AC-14 [unit] With `(j1, 1)` finished (`COMPLETED`, `doneAt` set) and `(j1, 2)` not finished (`RUNNING`, `doneAt` null, no run), the requeue `assignCmd('c3', 'j1', 3)` with the repo lock held by the test resolves with `(j1, 1)` already `null`, and after the test releases the lock and `await supervisor.idle()`, `(j1, 2)` is `null` and the executor's `prepare` ran for j1 exactly once.

### US-003

Every AC builds a `SyncLoop` the way `sync-loop.spec.ts`'s `makeLoop` does (an in-memory `Journal`, a scripted client,
`minGapMs` 250, a clock that does not advance). Except in AC-4 and AC-5, the `sleep` override records
each call's `ms`, its `signal` and `signal.aborted` as read at call time, and resolves only when that signal aborts, so the loop stays in its first sleep until the
test calls `loop.stop()`. "A failing client" is a `script` whose steps throw `new ServerError(500, 'x', null)`.

- AC-1 [unit] With a failing client, the `signal` passed to the first retry sleep is an `AbortSignal` whose `aborted`, as recorded at call time, is `false`.
- AC-2 [unit] With a failing client, calling `loop.stop()` during the first retry sleep makes that sleep's `signal.aborted` `true` and `loop.run()` resolves.
- AC-3 [unit] With a `script` whose first step answers an empty response, `minGapMs` 250 and the clock not advancing, the first sleep is the 250 ms min-gap sleep, and its `signal` has `aborted` `true` after `loop.stop()`.
- AC-4 [unit] With a failing client and `sleep` set to `(ms, signal) => systemSleep(60_000, signal)`, `loop.run()` resolves within 1,000 ms of `loop.stop()` being called during the first retry sleep.
- AC-5 [unit] In the AC-4 case, the client's `sync` is called exactly once.

### US-004

Unit ACs construct `FleetJobsService` with mocked collaborators the way `fleet-jobs.audit.spec.ts`'s `setup()` does, with a job `{ state: 'UPLOADING', runnerId: 'runner' }` and call
`service.cancel('u', 'p', 'j', true)`.

- AC-1 [unit] `cancel` of the UPLOADING job rejects with a `ConflictAppException` whose `prefix` is `fleet.jobState` and whose `args` are `{ state: 'UPLOADING' }`.
- AC-2 [unit] For the UPLOADING job, `repo.createCommand` is not called.
- AC-3 [unit] For the UPLOADING job, `repo.update` is not called.
- AC-4 [unit] For the UPLOADING job, the audit `record` is not called.
- AC-5 [unit] An UPLOADING job whose `cancelRequestedAt` is already set also rejects with a `ConflictAppException` whose `prefix` is `fleet.jobState`.
- AC-6 [unit] (regression guard: passes before the change) For a `RUNNING` job, `repo.createCommand` is called once with `type: 'CANCEL'`.
- AC-7 [integration] Through the real route in `fleet-job-cancel-requeue.integration.spec.ts`, `POST /api/projects/web/fleet/jobs/:id/cancel` by `dev` on an UPLOADING job held by a runner at `leaseEpoch` 1 answers 409.
- AC-8 [integration] After the AC-7 request, the job's `cancelRequestedAt` is `null` and it has no `CANCEL` `fleetCommand` row.
