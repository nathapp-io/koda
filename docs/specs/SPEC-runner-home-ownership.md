# SPEC: Exclusive ownership of a runner home

## Summary

Allow one live Koda runner daemon per physical runner home on a host. A contending start must fail before opening the writable job journal. A replacement can start after the owner stops or dies.

## Motivation

Finding 1 of the November 25 whole-repo review reproduced two real daemon processes sharing one SQLite journal. The first held an assignment in preparation, before its PID was recorded. Redelivery of that job and lease epoch caused both daemons to launch an inert child. Server-side replay is legitimate recovery behavior. Each daemon has its own in-memory supervisor and repo mutex. [Review evidence](../review-evidence/20261125/runner-duplicate-daemon.ts)

## Design

### Approach

Use a separate SQLite database at `daemon-lock.db` inside the existing private runner home. The lock is a live transaction on a dedicated connection. The file can persist across restarts. A PID string, the existence of the file and an age threshold cannot establish ownership. Keeping this separate from `journal.db` allows the daemon to commit job events normally and lets status readers inspect the journal.

Illustrative lifecycle using the runner’s existing Bun SQLite dependency:

```text
open the stable lock database in the prepared runner home
try to begin a write transaction without waiting for another writer
on success, keep that connection alive for the ownership interval
on contention, close the contender connection and report the occupied home
on release, close the owner connection and leave the lock database in place
```

### Failure Handling

`koda-runner --home <dir> run` reports contention through the existing structured stderr logger. Report the absolute spelling of the supplied home relative to the process working directory. Example `msg` value: `Runner home is already in use: /tmp/example-runner`. The contender exits 1 while the owner remains live. An inaccessible or unusable lock database also fails startup with status 1 and a diagnostic identifying the lock path. There is no retry inside the contending invocation. A later invocation retries normally. Startup failure after acquisition relinquishes ownership once daemon resources opened by that attempt have been retired. Shutdown retains ownership through the last journal writer.

### Integration

The baselines below locate current code. The targets define the change.

- `startDaemon(options: DaemonOptions): Promise<DaemonHandle>` in `apps/runner/src/daemon/daemon.ts`. **Baseline:** validates Git, prepares directories and sockets, opens the job journal, writes `boot_id` and starts sync. **Target:** same signature. Preserve the initial Git check and creation of the private home, then establish ownership before daemon-owned startup side effects, including writable journal open, rotation, housekeeping and sync. Acquisition and partial startup cleanup belong to this entry point, including when called directly by the recovery harness.
- `DaemonHandle.stop(): Promise<void>` and `crash(): void`. **Baseline:** clean stop waits for writers and closes the journal. The in-process crash stand-in closes it without draining. **Target:** keep both signatures and couple ownership release to retirement of the corresponding journal lifecycle. Repeated stop on an old handle cannot release a successor’s ownership. The OS releases the lock on real process death, even if a job child remains alive. The diagnostic uses the absolute spelling of an alias supplied by the caller. The lock itself follows the physical directory.
- Existing readers and callers: `runCommand(homeOverride, deps)` converts startup errors to exit 1. `collectStatus(homeOverride, deps)` opens the journal read-only. The CLI `run` action passes `startDaemon` into `runCommand`. These paths supply the process-level observations.

## Out of Scope

- Server-side ASSIGN delivery, lease fencing and READOPT policy remain separate protocol concerns.
- This feature covers cooperating daemon versions on one host using a local filesystem. Mixed-version overlap, cloned identities, cross-host locks and network filesystem semantics require separate rollout or coordination.
- Distinct runner homes sharing a workspace, a nax home or child-process resources have separate coordination requirements.
- Manual replacement of a live lock file and hostile filesystem mutation by another local process are outside cooperative startup.
- Forced takeover of a live but unresponsive owner and age-based expiry are deferred. An operator stops the owner before restarting.

## Stories

**US-001: Enforce ownership across daemon startup, recovery and shutdown.** Workdir: `apps/runner`. No dependencies.

Implement ownership inside the daemon module using private lifecycle state. Exercise the real startup and retirement paths in separate local processes. Use an inert executor and a recording sync transport. Existing read-only status and recovery tests remain compatibility checks. Verification includes the runner package’s `bun run test`, `bun run type-check` and `bun run lint`.

### Context Files

**US-001**
- `apps/runner/src/daemon/daemon.ts`
- `apps/runner/src/commands/run.ts`
- `apps/runner/src/commands/status.ts`
- `apps/runner/src/journal/journal.ts`
- `apps/runner/test/unit/daemon.spec.ts`

### Creates

**US-001**
- `apps/runner/test/unit/daemon-home-ownership.spec.ts` — multiprocess ownership and restart regression coverage.
- `apps/runner/test/fixtures/daemon-home-worker.ts` — child process running the actual daemon startup with controlled local collaborators.

### Modifies

**US-001**
- `apps/runner/src/daemon/daemon.ts` — guard the current unconditionally writable startup and tie release to retirement of the protected daemon. Keep existing handle and journal reader contracts.

### Seams

Ownership is private to the daemon module. One story owns startup and retirement. The command-to-daemon path is exercised at the runner entry point.

## Acceptance Criteria

### US-001

Use a temporary enrolled home, real SQLite and independent OS processes for ownership contention. Synchronize at explicit preparation and shutdown barriers. In daemon-versus-daemon cases, keep the first daemon alive while awaiting a contender’s result. In the timed SQLite case, keep the independent writer connection open. For contention and restart, point all processes at the same temporary home. The independence case gets two different physical homes. The diagnostic case uses a relative symlink to the occupied home. The startup-side-effect case also exercises a directory alias. Start subprocesses ahead of time for timed checks. Signal readiness after their Git preflight, immediately before the ownership attempt. Observe startup side effects in a distinct contender process so instrumentation cannot count owner activity.

- [integration] With two runner processes released together against one idle home, exactly one boot ID reaches the recording sync transport at `POST /fleet/runner/sync`.
- [cli] While an independent SQLite connection holds an active write transaction on the home’s `daemon-lock.db`, a `koda-runner --home <dir> run` invocation returns status 1 within one second of that local readiness barrier. The bound discriminates a nonwaiting attempt from a busy-retry timeout and excludes process launch and Git checks.
- [cli] With working directory P and relative `--home runner-alias` naming a symlink to the occupied home, the contender’s stderr logger emits `msg` equal to `Runner home is already in use: P/runner-alias`, with P expanded to the fixture’s absolute path.
- [integration] When a contender calls `startDaemon` through a directory symlink to the occupied home, its protected startup event log is empty. Record attempts at workspace `.jobs` creation, runner-log rotation, socket-directory preparation, writable `Journal.open` and sync. Home-directory preparation is allowed before the guard.
- [integration] With an `ASSIGN` still eligible for redelivery and owner A paused before recording its worker PID, the executor records exactly one launch for that `jobId` and `leaseEpoch`. The fixture controller starts B, awaits its occupied-home exit, then releases A’s preparation and its held acknowledgement directly. B needs no sync or preparation barrier.
- [integration] Two independent homes with separate runner resources each reach `POST /fleet/runner/sync` while the other process is alive.
- [cli] With the owner holding a known active job, `koda-runner --home <dir> status --json` reports that job’s ID from the journal.
- [integration] While `DaemonHandle.stop()` waits for a held journal writer, a second `run` receives the occupied-home failure.
- [integration] After `DaemonHandle.stop()` resolves, the replacement owner retrieves the previously persisted `jobId` from the same journal.
- [integration] After the owning OS process is killed with an inert child still alive, a replacement reaches `POST /fleet/runner/sync` on the same home without manual file cleanup.
- [integration] After `startDaemon` fails its initial capability probe, a fresh caller reaches `POST /fleet/runner/sync` on the same home while the original caller process is still alive.
- [cli] With a directory occupying `daemon-lock.db`, the run command exits 1.
- [cli] With that unusable lock path, the stderr startup diagnostic includes the full path to `daemon-lock.db`.
- [integration] After the in-process `DaemonHandle.crash()` stand-in, a replacement can start on the same home.
- [integration] A repeated `stop()` on a retired handle leaves a newer owner’s home occupied for a third `startDaemon` contender.
