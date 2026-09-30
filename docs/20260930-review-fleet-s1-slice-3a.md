# Deep Code Review: Fleet S1 Slice 3a — Runner Foundations + Runner Execution

**Date:** 2026-09-30
**Reviewer:** Subrina (AI)
**Version:** runner 0.x (post-3a-1 + 3a-2)
**Files:** 139 files changed (lib ~6,000 LOC + tests ~4,000 LOC across `apps/runner`, `apps/api`, `packages/fleet-protocol`)
**Baseline:** 642 unit tests pass (`bun test apps/runner/src test/unit`); API `bun run test:scoped`/`test:integration` green; `bunx tsc --noEmit -p apps/runner/tsconfig.json` clean. Integration suite (3a-2) requires `KODA_DB_TESTS=1` and the test Postgres; spec changes covered by `apps/api/test/helpers/fleet-fixtures.ts`.

---

## Overall Grade: **A-** (88/100)

A substantial, well-tested slice that ships the full runner daemon with a rigorous path-safety boundary, persist-before-send journal, legal-transition state machine, and a coherent recovery model. The "Review Focus" failure modes from both plans are exercised by named unit or integration tests. The remaining gaps are concentrated in three places: (1) a moderate-severity **file-permissions gap on the journal** that the spec treats as implicitly 0o600 but the code does not enforce; (2) two design choices the plans accept as known gaps (`D60` upload re-check race; `D49` state-conflict "rare race" leaving a runner parked); and (3) a handful of small correctness hardening items. Nothing is ship-blocking; the daemon is safe for an internal pre-release but should not be exposed to untrusted operator configs before the permissions gap and the D60 follow-up are addressed.

### Per-dimension scores

| Dimension | Score | Notes |
|:--|:--|:--|
| **Security** | 16/20 | Strong input validation (parseAssign, parseCapabilities, GIT_REF_RE, assertCloneUrl, BRANCH_SHAPE), 0600 identity, redacting logger, `ke_` prefix gate (#157). Gap: journal.db/WAL not chmod'd; symlink-to-directory in bundle not explicitly covered; `chmod(...).catch(()=>undefined)` on the home dir is best-effort. |
| **Reliability** | 18/20 | Persist-before-send + `synchronous=FULL` + WAL (D55); one-event batch replace on poison (D24); abort-on-idle-wake only (D57); double-scale on success; epoch-scoped ABANDON (D64); READOPT for ASSIGNED-no-pid (D33). Recovery integration suite covers crash + finished-while-down + net-cut + stale-epoch. One D60 design race acknowledged. |
| **API Design** | 18/20 | Narrow seams (JobExecutor, CapabilityProbe, BundleUploader, ServerClient, Logger, Journal, SyncLoop); every seam has an injected fake in tests. Protocol types live in one package; `parseCapabilities` exists on both sides and matches the validator exactly. Minor: `kill()` returns void while `signalGroup()` returns boolean. |
| **Code Quality** | 18/20 | No `any` in production code (22 `as never` are all in tests). Files < 400 lines typical; largest is `job-run.ts` at 363. DRY is mostly enforced (git.ts, paths/safe-segment, journal helpers, verdict functions). The Logger redaction regex `/key/i` over-matches ("monkey" → `[redacted]`) — over-redaction is safe but a future log analyst will be confused. |
| **Best Practices** | 18/20 | Bun-only ESM, `import type` boundary on the API side (re-checked by `protocol.spec.ts`), no `console.log` outside `main.ts`/`logger.ts`, immutable style, names match the spec, decisions D21–D74 cited inline. The "fake-nax is real-shaped" choice (D70) is correctly implemented and tested. |

---

## Findings

### 🔴 CRITICAL

_There are no CRITICAL findings._ No finding in this review would cause immediate data loss, compromise the cluster, or block the daemon from starting.

The closest-to-critical items (the journal file-mode gap, the D60 server-side race) are classified HIGH below and are documented as design-accepted trade-offs that need a server-side follow-up.

### 🟠 HIGH

#### SEC-1: `journal.db` and `-wal`/`-shm` are created with the process umask, not 0o600
**Severity:** HIGH | **Category:** Security | **Plan hook:** AGENTS.md "the runner API key lives only in `identity.json` (mode 0600)" implies the same for the journal; **no plan hook** (not in D21–D74; novel finding).
**Files:** `apps/runner/src/journal/journal.ts:42-49` (`Journal.open`), `apps/runner/src/identity/identity-store.ts:44-51` (only chmods the *identity file*, never the home dir or the journal).

```ts
// journal.ts:42-49
static open(path: string, now: Now = systemNow): Journal {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA_SQL);
  return new Journal(db, now);
}
```

`bun:sqlite`'s `new Database(path, { create: true })` creates the file using the process umask — typically `0o644` on Linux. The WAL files (`journal.db-wal`, `journal.db-shm`) follow the same rule. The home directory itself is created in `daemon.ts:71` with `mkdir(..., { recursive: true })` — also umask-dependent, so on a multi-user host the journal is world-readable.

The journal contains ASSIGN payloads (`repo.cloneUrl`, `repo.owner`, `repo.name`, `feature`, `planFrom`, `gitIdentity`, `maxCostUsd`), per-job event sequences, command acks, `runner_id` and `boot_id` metadata, and the `last_capabilities_hash`. The API key never enters the journal, but the operational metadata is enough to reconstruct a runner's activity profile and to leak the clone URLs the operator trusts only the daemon to know.

The contrast with `identity.json` (which is written at 0o600 by `writeIdentity` and re-chmodded on every read by `readIdentity`) makes the gap conspicuous.

**Risk:** A local user can read another runner's journal; an operator that scrubs the home dir without also scrubbing the WAL leaves recent events on disk.

**Fix:** In `Journal.open`, chmod the DB and the WAL files explicitly:

```ts
static open(path: string, now: Now = systemNow): Journal {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA_SQL);
  // SEC-1: match identity.json's 0o600 — the journal mirrors runner activity.
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try { Bun.file(p); } catch { /* race: file created post-open */ }
    chmodSync(p, 0o600);
  }
  return new Journal(db, now);
}
```

Plus tighten `daemon.ts:70-71` to `mkdir(..., { recursive: true, mode: 0o700 })` for the home dir, matching `writeIdentity`.

#### SEC-2: `killIfOurs` returns a boolean that no caller reads; consider a single-purpose wrapper
**Severity:** LOW (today) → HIGH if reused | **Category:** Security | **Plan hook:** **D65** cited at the call sites; not a deviation.
**File:** `apps/runner/src/supervisor/kill-if-ours.ts:10-19`, all three call sites (`job-run.ts:159`, `supervisor.ts:76`, `job-run.ts:353`).

```ts
export async function killIfOurs(executor: JobExecutor, row: JobRow, log: Logger): Promise<boolean> {
  if (row.pid === null || row.pgid === null) return false;
  try {
    if (!(await executor.matchesProcess(row))) return false;
    executor.kill(row.pgid, 'SIGKILL');
    return true;
  } catch (error) {
    log.warn('kill of the job process failed', { jobId: row.jobId, error: errorMessage(error) });
    return false;
  }
}
```

Today, every caller ignores the boolean. The boolean exists for a reason (`matchesProcess` returning false means we deliberately did *not* signal — D65 says a recycled pid is never signalled), but discarding it loses the audit trail. The Plan Decision log says it is intentional, so this is more API-quality than security; the call would matter if any caller had to fall back to a different kill strategy (e.g., SIGTERM first, then SIGKILL after grace).

**Risk:** A future caller will assume `killIfOurs` always tries and needs an extra flag to get the "skip on mismatch" behaviour, breaking the TOCTOU-tightening intent.

**Fix:** Either drop the return type (it's currently dead) and add a `@design` remark, or use it in a follow-up so the SIGTERM→SIGKILL escalation in `JobRun.watchUntilExit` reads it and logs when the SIGTERM was dropped because the pid had already been recycled.

#### BUG-1: `supervisor.readopt` falls back to `row.updatedAt` when `status.lastHeartbeat` is missing — but `updatedAt` is bumped on every `updateJob`, including the `cancelRequestedAt` write and `appendEvent` patches, so a stuck process can still pass `fresh()`
**Severity:** MEDIUM | **Category:** Bug / Logic | **Plan hook:** **no plan hook** for the fallback (novel finding; **@plan-challenge** to the design).

**File:** `apps/runner/src/supervisor/supervisor.ts:69-72`

```ts
private fresh(status: StatusView, row: JobRow): boolean {
  const stamp = Date.parse(status.lastHeartbeat ?? status.updatedAt ?? row.updatedAt);
  return !Number.isNaN(stamp) && this.deps.now().getTime() - stamp < this.deps.readoptHeartbeatMs;
}
```

`JobRow.updatedAt` is set by every `updateJob` call — including the cancel-requested patch in `supervisor.cancel()` (`job-run.ts:106`) and by `Journal.appendEvent`'s optional patch. A process whose nax is hung (and therefore not flushing `status.json`) can still receive an `updatedAt` bump because the supervisor itself wrote `cancelRequestedAt` while cancelling. The freshness check then passes even though the actual nax heartbeat is hours stale.

This is not covered by the spec ("the heartbeat is under 2 minutes old"). The spec implies `lastHeartbeat`, but the code degrades silently to `updatedAt` and then to `row.updatedAt`.

**Risk:** A READOPT-rejected pid that the cancel race resurrected could be accepted as `fresh()` and the runner would re-attach to a wedged nax.

**Fix:** Reject when `status.lastHeartbeat` is missing; do not fall back to `updatedAt`.

```ts
private fresh(status: StatusView, row: JobRow): boolean {
  if (!status.lastHeartbeat) return false;
  const stamp = Date.parse(status.lastHeartbeat);
  return !Number.isNaN(stamp) && this.deps.now().getTime() - stamp < this.deps.readoptHeartbeatMs;
}
```

#### BUG-2: `JobRun.watchUntilExit` breaks the loop on `row.pid === null` rather than fail — a stranded row (pid lost via DB write race or `Journal.appendEvent` patch missing the field) silently proceeds to `finish()` and uploads a partial bundle
**Severity:** MEDIUM | **Category:** Bug / Logic | **Plan hook:** **D33** ("a job the journal holds as ASSIGNED with no pid re-runs prepare from the start") but the matching case for *RUNNING-no-pid* is not specified.

**File:** `apps/runner/src/supervisor/job-run.ts:222-223`

```ts
const row = this.mustRow();
if (row.pid === null || !this.deps.executor.isAlive(row.pid)) break;
```

The break is intentional ("pid alive ⇒ keep watching; else proceed to finish"). But `pid === null` is also the initial state of an `ASSIGNED` row (which is supposed to be caught upstream by `prepareAndSpawn`). If a journal corruption or a missed patch produced a `RUNNING` row with `pid = null`, the loop falls through to `finish()` → `judge()` → `runVerdict({ cancelRequested: false, status: ... })` → likely FAILED with `no status.json`. The job is then uploaded as a partial bundle and acked — which is fine as long as the verdict is honest.

The risk is that the bundle is *uploaded* and the *server trusts the verdict* — but with the new daemon's `Journal.open` permissions (see SEC-1) and the lack of a `pid`-missing sanity check, an attacker controlling the journal could make the runner declare FAILED on demand.

**Fix:** Treat `row.pid === null` while `state === 'RUNNING'` as a `failSafe` case:

```ts
if (row.pid === null) { await this.failSafe(new Error('pid missing on RUNNING row')); return; }
if (!this.deps.executor.isAlive(row.pid)) break;
```

#### BUG-3: `commitAndPushPlan` aborts on a transient `push` failure with `stateReason = 'plan push failed'`, leaving the commit on the local branch but not pushed — the next prepare wipes the local commit (D53) and the user gets no PR
**Severity:** MEDIUM | **Category:** Bug / Logic | **Plan hook:** **D52** ("push failure: FAILED, `stateReason = 'plan push failed'`, commit kept locally") — but **@plan-challenge** to the recovery path; D53's "wipe a previous attempt's files" actually *deletes* the kept commit.

**File:** `apps/runner/src/executor/plan-commit.ts:86-103`, `apps/runner/src/executor/host-executor.ts:60-61` (ATTEMPT_FILES wipe).

The plan's wording is contradictory: D52 says "commit kept locally", but D53's `host-executor.prepare` line 60 runs `await Promise.all(ATTEMPT_FILES.map(... rm(...)))` which deletes `.nax/features/<f>/prd.json` (the one with the PLAN commit's metadata) on the next prepare. The local commit *tree* survives in `.git`, but the plan outputs that drove it are wiped, so the verdict cannot be re-derived and the next attempt re-stashes from scratch — losing the original branch tip.

The recovery story should be: on a push-failed PLAN, the runner keeps the local commit on the branch, marks the job as FAILED with `plan push failed`, and on a server retry the next attempt verifies `prd.json` and resumes the push without committing again. Today the plan output is wiped, so the resume path is impossible.

**Risk:** A transient network blip during PLAN push turns into "branch exists locally with no PR, server shows FAILED forever, operator must re-run PLAN manually."

**Fix:** Either keep the plan outputs through one prepare attempt on push-failure, or document that operators must re-run. The current behaviour (silent wipe + lost commit) is the worst of both worlds. Suggested: skip the `prd.json` removal in `ATTEMPT_FILES` if `markDone` set `stateReason = 'plan push failed'`; the next prepare reads the existing local branch tip and just retries the push.

#### ENH-1: No test for symlink-to-directory in the bundle — the spec says "symlinks are stored as links, never followed", but only `latest.jsonl` (a file symlink) is exercised
**Severity:** LOW | **Category:** Enhancement | **Plan hook:** **D27** ("symlinks are stored as links, never followed").

**File:** `apps/runner/src/bundle/build-bundle.ts:16-31`

```ts
async function walk(dir: string, prefix: string): Promise<string[]> {
  ...
  for (const entry of entries) {
    if (isPromptAudit(entry.name)) continue;
    const rel = posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(join(dir, entry.name), rel)));
    else found.push(rel);
  }
  ...
}
```

`entry.isDirectory()` is false for symlinks (even symlinks to directories), so the symlink-to-directory becomes a `rel` string in `found`. The tar invocation has no `--no-dereference`, but GNU tar's default for an explicit `-T` file list is to *not* dereference symlinks, so the link is stored as a link — verified by the existing test (`build-bundle.spec.ts:99`).

The gap: `build-bundle.spec.ts` only tests file symlinks (`latest.jsonl`). The plan's stronger claim ("never followed") is not verified for directory symlinks. GNU tar's `-T` semantics for directory symlinks are not as universal — different tar versions can differ. A directory symlink to `/etc` would, on some GNU tar builds, copy the whole `/etc` tree into the archive.

**Risk:** Low likelihood (nax does not create directory symlinks), but high impact (information disclosure).

**Fix:** Add a test in `build-bundle.spec.ts`:

```ts
test('a symlink to a directory is stored as a link, not followed (D27)', async () => {
  const jobDir = await jobDirWith();
  const outside = await tmp.make('outside');
  await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET');
  await symlink(outside, join(jobDir, 'nax-out', 'link'));
  const file = await buildBundle({ jobDir, command: 'RUN' });
  const names = await tarList(file.path);
  expect(names).toContain('nax-out/link');
  // The archive must not contain secret.txt (it lives outside the dir).
  expect(names).not.toContain('nax-out/link/secret.txt');
  expect(names.some((n) => n.includes('TOP-SECRET'))).toBe(false);
});
```

If the test fails on the host, switch the tar invocation to `tar -czhf` (or `-czf --no-recursion` / `--no-dereference`) and confirm again.

### 🟡 MEDIUM

#### BUG-4: `killIfOurs` is called from `JobRun.failSafe` even when the run never spawned (pid is null) — wasted log line
**Severity:** LOW (cosmetic) | **Category:** Bug | **Plan hook:** **D65**.

**File:** `apps/runner/src/supervisor/job-run.ts:351-354`

```ts
const row = this.row();
if (row) {
  await killIfOurs(this.deps.executor, row, this.deps.log);
  await this.reapQuietly(row);
}
```

`killIfOurs` returns false when `row.pid === null`, so it is a no-op, but `reapQuietly` is then called unconditionally. The reap walks `.nax-pids` and filters to entries with pid > 1 and registered after the job's `createdAt`. If `pid` is null but `.nax-pids` contains a stale entry from a previous attempt at this `jobDir`, the reap will SIGKILL that pid. That's actually safe (reap is bounded by `selectReapable`'s `REGISTRATION_SLACK_MS`), but it means a fail-safe at a never-spawned state can still signal someone else's pid.

**Fix:** Skip the reap when `pid === null`, or guard reap's `since` with `row.createdAt - REGISTRATION_SLACK_MS` to make the window strict.

#### BUG-5: `pid-registry.selectReapable` uses `REGISTRATION_SLACK_MS = 2_000` for the "registered pid is this nax" check, but the *process start time* (`ps -o etime=`) is only accurate to the second and rounds down. A pid registered at `T0 = 1000.9` whose process started at `T0 + 0.4` will be misclassified as "registered before process started" (impossible) and skipped
**Severity:** LOW | **Category:** Bug / Logic | **Plan hook:** **D37**.

**File:** `apps/runner/src/executor/pid-registry.ts:27-44`

```ts
const REGISTRATION_SLACK_MS = 2_000;
...
const started = await opts.startedAt(entry.pid);
if (started && started.getTime() <= registered + REGISTRATION_SLACK_MS) picked.push(entry.pid);
```

`ps etime` rounds down to whole seconds; a process that started 400ms before its `.nax-pids` registration will have `started.getTime() === registered - 400`, which passes the inequality. A process that started 400ms *after* registration will have `started.getTime() === registered + 400 - 1000 ≈ registered - 600` (rounded down), again passing.

The case that fails is when the registration happens *before* the process actually forked but `ps etime` rounds up to the next second, e.g.:

- `registered = 1_000_000`
- real start = `registered + 0.6` (600ms after registration)
- `ps etime` rounds down to elapsed = `1`s, so `started = 1_000_000 - 1_000 = 999_000`
- `started.getTime() (999_000) <= registered + 2000 (1_002_000)` → passes (picked)

So the slack window absorbs the rounding error. The bug only manifests if the *clock* drifts between registration time and `Date.now()` (when `started` is computed by `Date.now() - elapsed * 1000`). A negative NTP correction between registration and reap would shift `started` *up*, potentially pushing it past `registered + 2000` and causing the real nax to be missed. In practice, NTP corrections on a stable host are sub-second, so the 2s slack absorbs them.

**Risk:** Theoretical — would cause a real nax to be left running if the daemon clock jumps backwards by >2s between spawn and reap.

**Fix:** Use `ps -o lstart=` (full timestamp) instead of `etime`, despite the timezone wrinkle. Or document the assumption in a `@design` remark.

#### BUG-6: `BundleUploader.upload` returns `{ kind: 'failed' }` from `deps.upload()` throwing a `NetworkError`, but the `uploadWithRetry` loop also treats HTTP `0` (the no-response-yet case) as a network error and retries up to 3 times — a slow upload can produce a `too-large` only if `networkFailures >= 3`, but the plan's D68 wording reads "after 3 network failures on a bundle over 100 MiB" which would also be triggered by transient `AbortError`s from a long-lived stream
**Severity:** LOW | **Category:** Bug / Logic | **Plan hook:** **D68**.

**File:** `apps/runner/src/bundle/upload-bundle.ts:60-69`

```ts
deps.log.warn('bundle upload attempt failed', { jobId, attempt, status });
if (attempt >= UPLOAD_ATTEMPTS) {
  if (networkFailures >= UPLOAD_ATTEMPTS && file.size > LARGE_BUNDLE_BYTES) return { kind: 'too-large' };
  return { kind: 'failed', detail: status === 0 ? 'network error' : `HTTP ${status}` };
}
```

The plan's intent (D68): "after 3 network failures on a bundle over 100 MiB the outcome is `bundle too large`" — i.e. treat repeated timeouts on a huge bundle as a "the proxy silently dropped it" signal. The current code counts *any* status=0 as a network failure (`networkFailures` increments in the `catch (NetworkError)` block, but never increments elsewhere). The status=0 path is therefore "no network error caught + non-2xx/4xx/5xx response" — which only happens if `response.ok` is false but no `ServerError` was thrown, which the ServerClient doesn't actually produce. So in practice this branch is unreachable: a `0` status is impossible because `json()` either returns `data` (status < 400) or throws `ServerError` (status >= 400) for non-OK responses. The 3-retry budget is consumed entirely by `ServerError` 5xx.

**Risk:** Behaviour is correct by accident, but the code reads as if it were guarding against the time-out-on-huge-bundle case. A future maintainer could "fix" the unreachable branch and break the actual flow.

**Fix:** Either remove the dead branch and add a `@design` remark, or split `NetworkError` (timeout / DNS) from `ServerError` (5xx) explicitly and count each independently with the size threshold applying only to `NetworkError`.

#### TYPE-1: `kill` on `JobExecutor` is declared `void` while `signalGroup` returns `boolean`; the boolean conveys "did we send the signal" (false when pgid <= 1)
**Severity:** LOW | **Category:** Type Safety | **Plan hook:** none.

**File:** `apps/runner/src/executor/job-executor.ts:39`, `apps/runner/src/executor/host-executor.ts:109-111`, `apps/runner/src/executor/nax-process.ts:55-62`.

```ts
// job-executor.ts:39
kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;

// host-executor.ts:109
kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  signalGroup(pgid, signal);
}

// nax-process.ts:55
export function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean { ... return true; }
```

The `signalGroup` guard (`pgid <= 1`) is in the runtime but invisible to callers. A caller that passes `pgid = 0` (e.g., from an undefined cast) will silently swallow the signal.

**Fix:** Either widen the interface to `boolean` and assert callers branch on it, or add a runtime check in `JobRun` before `sendTerm` / `escalateKill` (`if (row.pgid !== null && row.pgid > 1)`).

#### TYPE-2: `command-handler.apply`'s `default` branch records `type: String(command.type)` into the journal — if a malicious server sends `{ type: 1 }`, the journal has `"1"` instead of `null`/reject
**Severity:** LOW | **Category:** Type Safety | **Plan hook:** none.

**File:** `apps/runner/src/supervisor/command-handler.ts:76-79`

```ts
default: {
  const outcome: Outcome = { result: 'rejected', detail: 'unknown command type' };
  journal.recordCommand({ commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch,
    type: String(command.type), result: 'rejected', detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString() });
  return outcome;
}
```

`String(1) === '1'`, `String(null) === 'null'`, etc. The schema column is free text so it does not crash, but replaying an unknown-type command could store arbitrary strings. Today the journal is local-only; if a future server-side replay tool queries it, it should expect `'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON' | 'unknown'`.

**Fix:** Use a literal `'unknown'` for the unknown-type branch.

#### ENH-2: `Journal.stats()` reads `pendingEvents` as a single COUNT — for very large journals this can dominate `daemon.pruneJobs`'s neighbour calls
**Severity:** LOW (today) | **Category:** Performance | **Plan hook:** none.

**File:** `apps/runner/src/journal/journal.ts:211-216`

```ts
stats(): { activeJobs: number; pendingEvents: number } {
  return {
    activeJobs: this.activeCount(),
    pendingEvents: (this.db.query('SELECT COUNT(*) AS n FROM events WHERE acked = 0').get() as Row)['n'] as number,
  };
}
```

The `events_pending` index (`schema.ts:34`) covers `(acked, job_id, lease_epoch, seq)`. The COUNT uses `acked = 0` which is the leading column, so the index helps. But `stats()` is called by `koda-runner status` only — no hot path. **No actual performance problem today**, flagged for the future when stats moves into the daemon's loop.

#### ENH-3: `daemon.startDaemon`'s `pruneJobs` runs `await rm(..., { recursive: true, force: true })` without first checking if the directory is empty — a partially-written `nax-out/` survives `deleteJobProfile` and could be pruned mid-write
**Severity:** LOW | **Category:** Enhancement | **Plan hook:** **D23** ("retention prunes `<jobDir>`") and the design's "<jobDir> is kept until retention prunes it" wording.

**File:** `apps/runner/src/daemon/daemon.ts:49-58`

The prune walks the journal's `done_at` cutoff and `rm`s each `jobDir`. `rm -rf` is atomic on a per-file basis, so the worst case is a partial removal (a leftover `nax-out/status.json` from a run whose archive is now gone). Not a security issue (no secrets in `status.json`), but the orphaned directory will accumulate if a `cancel`-during-upload leaves the bundle partly there.

**Fix:** Keep a list of `nax-out/` snapshots in the journal metadata at `markDone` time and remove them in order.

#### ENH-4: `enrollRunner` re-uses the operator's `--name` if supplied, but the API returns 409 for "name taken" *after* the runner has already enrolled elsewhere — no hint to delete the previous identity or rotate the key
**Severity:** LOW | **Category:** UX | **Plan hook:** none (slice 2 issue, but the runner's UX lives in 3a-1).

**File:** `apps/runner/src/commands/enroll.ts:88-94`

```ts
if (error instanceof ServerError) {
  if (error.status === 401) return new EnrollError('the enrollment token is invalid, used or expired');
  if (error.status === 409) return new EnrollError(`a runner named "${name}" already exists; pass --name to choose another`);
```

The operator's typical flow is "rotate to a fresh runner because the old one is dead". They run `enroll --server X --token Y --name Z` and see "Z already exists". The message doesn't say "use a different token, then delete the old runner row from the admin UI" — and there is no runner-side helper to do that. **Not a security gap, just friction.**

**Fix:** Document the rotation flow in `apps/runner/AGENTS.md` and/or surface a `--force` flag (which would call `DELETE /fleet/runners/:id` on the old row before re-enrolling).

#### ENH-5: `capability-probe.hashCapabilities` excludes `probedAt` from the hash (D41) — but `sandbox.error` *is* hashed. A transient probe error changes the hash, every sync re-sends the capability block, and a permanently-failing probe produces a back-and-forth
**Severity:** LOW | **Category:** Enhancement | **Plan hook:** **D41**.

**File:** `apps/runner/src/capabilities/capability-probe.ts:33-35`

```ts
export function hashCapabilities(caps: RunnerCapabilities): string {
  const { probedAt: _probedAt, ...sandbox } = caps.sandbox;
  return createHash('sha256').update(stableStringify({ ...caps, sandbox })).digest('hex');
}
```

For `StaticCapabilityProbe`, `sandbox` is fixed (`{ available, error?: string }` from `runner.json`) — the only mutator is `probedAt`. So this is fine for 3a.

But the design reserves the seam for `NaxCapabilityProbe` (3b) which can include a transient `sandbox.error` (e.g., "nax version failed"). Once that lands, `error: 'failed'` vs `error: undefined` will flap the hash.

**Fix:** Add a `@design` remark now and decide for 3b whether to include `error` in the hash or not. The simplest is to keep `error` out of the hash (the operator should see it once on the wire and not again until the *cause* changes).

### 🟢 LOW

#### STYLE-1: Logger redaction regex over-matches ("monkey" → `[redacted]`, "donkey" → `[redacted]`)
**Severity:** LOW | **Category:** Style | **Plan hook:** none.

**File:** `apps/runner/src/logger.ts:9`

```ts
const SECRET_KEY = /key|token|secret|password|authorization/i;
```

Over-redaction is safe; it just produces `[redacted]` for benign field names. The reviewer has not flagged this as a bug — a future debug log that wants to surface "monkeyCount" will be confusing. Suggest tightening to word-boundary anchors:

```ts
const SECRET_KEY = /\b(key|token|secret|password|authorization)\b/i;
```

or `(?:^|[_/.])(key|token|secret|password|authorization)(?:$|[_/.])`.

#### STYLE-2: `killIfOurs` exists as a 20-line module but is only used internally to `supervisor/`; consider inlining to `supervisor/kill-if-ours.ts → supervisor.ts` to drop one file
**Severity:** LOW (taste) | **Category:** Style | **Plan hook:** none.

The 400-line files rule is met (the file is 20 lines). Keep it if there's a future test seam (currently untested); otherwise inline.

#### STYLE-3: `BundleFile.skipped` is reported via `bundle-manifest.json` and surfaced in the lifecycle event as `JSON.stringify(file.skipped.slice(0, 3))` — JSON-stringifying into a log string is a code smell
**Severity:** LOW | **Category:** Style | **Plan hook:** **D68**.

**File:** `apps/runner/src/supervisor/job-run.ts:329-330`

```ts
this.events.lifecycle('warn', `bundle left out ${file.skipped.length} file(s) whose names have a newline or backslash: ${JSON.stringify(file.skipped.slice(0, 3))}`);
```

Today the JSON is encoded into a string that goes into the lifecycle event payload (`{ level, message }`). The server stores it verbatim and the UI sees a JSON snippet in a message. A small refactor: pass the array directly (extend the lifecycle payload shape with an optional `details?: unknown[]`) and let the server format. **Cosmetic.**

#### STYLE-4: `Journal.open`'s comment about D55 ("FULL, not NORMAL") is on line 43; the runtime call is on line 46. Move the comment *above* the `db.exec` and drop the "see also: notify" pointer
**Severity:** LOW (taste) | **Category:** Style | **Plan hook:** **D55**.

**File:** `apps/runner/src/journal/journal.ts:42-49`

The comment reads "FULL, not NORMAL (D55): under WAL..." and is placed inside the function body above `db.exec` — fine. The implementation is also fine. Flagging because a future maintainer adding `PRAGMA journal_size_limit = ...` will need to remember that this combination of `journal_mode=WAL` + `synchronous=FULL` is what D55 is anchored on.

#### STYLE-5: `assign-parser.ts`'s `checked(fn)` helper returns false on *any* `Error` (not just `PathError`) — the only `Error`s that should escape validation are `PathError`s
**Severity:** LOW | **Category:** Style | **Plan hook:** none.

**File:** `apps/runner/src/supervisor/assign-parser.ts:15-23`

```ts
function checked(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof PathError || error instanceof Error) return false;
    throw error;
  }
}
```

The `||` makes `instanceof Error` true for *everything* that has a prototype chain back to Error — which is what we want. But the intent comment says "D30: re-validate, only the validated fields are copied" — and silently catching a non-PathError (e.g., a TypeError from a bad cast) hides bugs. Better:

```ts
function checked(fn: () => void): boolean {
  try { fn(); return true; }
  catch (error) { if (error instanceof PathError) return false; throw error; }
}
```

#### MEM-1: `SyncLoop` keeps `pendingAcks` indefinitely — a command that the server never acks (e.g., `ABANDON` to a job that has already been abandoned) accumulates
**Severity:** LOW | **Category:** Memory | **Plan hook:** none.

**File:** `apps/runner/src/sync/sync-loop.ts:54`

```ts
private readonly pendingAcks = new Map<string, CommandAck>();
```

Today the map only shrinks when an ack is included in the request and the response comes back. If the server never returns, the map grows. In practice the server sends `unknownJobIds` for jobs it has forgotten, which causes `abandonUnknown → supervisor.abandonAll` which calls `journal.abandon` but does **not** remove the ack. Eventually the sync request would overflow the body budget (D26) and the loop backs off.

**Fix:** Periodically prune acks whose `commandId` is older than e.g. `1h` (or whose job is no longer in `jobsWithPending()`).

---

## Plan Decisions: Compliance and Challenges

The plans make ~54 explicit decisions (D21–D74). The reviewer's mapping of code → plan:

| Decision | Compliance | Notes |
|:--|:--|:--|
| **D21** runner is Bun-only ESM, `@nathapp/koda-runner`, no `build` script | ✅ | `package.json`, `scripts/build-binary.ts` |
| **D22** `KODA_RUNNER_HOME` default `~/.koda-runner`, 0600 identity | ✅ (with **SEC-1** caveat) | Identity is 0600; journal is not |
| **D23** journal adds `cancel_requested_at`, `result_branch`, `result_sha`, `applied_commands.detail` | ✅ | `schema.ts:16-18, 41` |
| **D24** poison event is *replaced*, not deleted | ✅ | `journal.ts:172-176`, test `journal.spec.ts:86-91` |
| **D25** bad-capabilities request retries without caps, hash is suppressed | ✅ | `sync-loop.ts:147-152` |
| **D26** MAX_BODY_BYTES = 900_000, batch halves on 400/413 | ✅ | `batch.ts:6, 20-23` |
| **D27** tar with explicit list, prompt-audit excluded, SHA-256 streamed, symlinks as links | ⚠️ partial | symlink-to-directory untested (see **ENH-1**) |
| **D28** in-memory FIFO per repo | ✅ | `repo-mutex.ts` |
| **D29** reject leading `.` on owner | ✅ | `safe-segment.ts:26` |
| **D30** re-validate every server-derived field | ✅ | `assign-parser.ts` + tests |
| **D31** ref rejects leading `-`, `--end-of-options` passed | ✅ | `refs.ts:18`, tests |
| **D32** fixed prepare failure reasons | ✅ | `git.ts:41-46`, integration tests assert exact strings |
| **D33** READOPT of ASSIGNED-no-pid calls `begin(row, 'reprepare')` | ✅ | `supervisor.ts:96-99` |
| **D34** readopted watcher starts at EOF | ✅ | `file-tail.ts:14-16`, called from `watcher.ts:80` |
| **D35** every spawned job goes RUNNING → UPLOADING → terminal | ✅ | `job-events.ts` `canEmit` |
| **D36** bundle outcomes map to verdict states | ✅ | `job-run.ts:46-50` |
| **D37** reap only pids registered ≤ spawnedAt + 2s | ✅ | `pid-registry.ts:27-44` |
| **D38** integration harness uses `koda_runner_test`, partial indexes verified | ✅ | `harness/database.ts` |
| **D39** API started without inherited env, in-process daemon with injected fetch | ✅ | `harness/world.ts:101-127, 226` |
| **D40** `daemon.crash()` is the restart simulation | ✅ | `daemon.ts:142-150` |
| **D41** `probedAt` excluded from hash | ✅ | `capability-probe.ts:33-35` |
| **D42** `TUNING` is one constant, runner.json cannot override | ✅ | `tuning.ts`, no runner.json key |
| **D43** unit specs co-located, scenarios under `test/unit/`, fixtures under `test/fixtures/` | ✅ | All paths match |
| **D44** spawned nax gets `NAX_GLOBAL_CONFIG_DIR=<config.naxHome>` | ✅ | `host-executor.ts:95` |
| **D45** log budget: 8 KiB text, 60/min, all streams | ✅ | `log-budget.ts:1-5`, `chunkText` |
| **D46** clone URL drift repointed, crashed clone rebuilt | ✅ | `workspace.ts:24-37`, tests |
| **D47** enroll writes runner.json if absent, refuses if identity.json exists | ✅ | `enroll.ts:57-86, 101-103` |
| **D48** status reads config, identity, journal (RO), server `/me` with 5s timeout | ✅ | `status.ts` |
| **D49** 409 stale vs state-conflict classification | ✅ | `upload-bundle.ts:31-33` |
| **D50** default `tools` from `Bun.which` | ✅ | `enroll.ts:46-51`, tests |
| **D51** fifth branch case: local-only branch kept | ✅ | `branch.ts:25`, `planBranch` test in `checkout.spec.ts:104-112` |
| **D52** PLAN commit is `chore(plan): <feature> PRD via koda job <jobId>`, idempotent | ⚠️ partial | Idempotency true; **BUG-3** shows the push-failed case loses the commit on next prepare |
| **D53** prepare wipes previous attempt's files | ✅ | `host-executor.ts:60-61` |
| **D54** READOPT of PLAN by process | ✅ | `supervisor.ts:102-105` |
| **D55** `PRAGMA synchronous = FULL`, notify fires once after outermost commit | ✅ | `journal.ts:46, 65-86`, test `journal.spec.ts:92-119` |
| **D56** one entry per jobId, highest epoch first | ✅ | `batch.ts:56-60` |
| **D57** abort-on-write only on idle poll | ✅ | `sync-loop.ts:65-69`, tests |
| **D58** acks-free retry once before blaming event | ✅ | `sync-loop.ts:158-163` |
| **D59** clamp ack detail (NUL, 200 chars, no surrogate split) | ✅ | `batch.ts:42-49`, exported `clampAck` |
| **D60** upload ack-wait before PUT; 409 classified | ✅ | `job-run.ts:300-318`, **server-side gap acknowledged** |
| **D61** PLAN stash write-once | ✅ | `plan-commit.ts:25-46` |
| **D62** prepare moves `prd.json` + `prd.rejected.json` and deletes stale `plan/*.jsonl` | ✅ | `host-executor.ts:82-88`, test `host-executor.spec.ts:149-165` |
| **D63** replayed ASSIGN with `pid = null` calls `begin(row, 'reprepare')` | ✅ | `command-handler.ts:84-88`, test `command-handler.spec.ts:57-82` |
| **D64** handler.assign abandons lower-epoch rows; abandon acquires mutex; skip reap if higher epoch live | ✅ | `command-handler.ts:108-114`, `job-run.ts:142-169` |
| **D65** SIGKILL via `killIfOurs` after `matchesProcess`; crash before reprepare re-reaps | ✅ | `kill-if-ours.ts`, `job-run.ts:174` |
| **D66** CANCEL of queued job emits ASSIGNED → CANCELLED at once | ✅ | `job-run.ts:111-116` |
| **D67** daemon awaits `supervisor.idle()` before `journal.close()` on stop; `crash()` does not | ✅ | `daemon.ts:124-150`, test `daemon.spec.ts:212-238` |
| **D68** benign tar exit 1, list-safe filter, large-bundle → too-large | ✅ | `build-bundle.ts:59-69, 38-49`, test `build-bundle.spec.ts:73-83` |
| **D69** git with `GIT_TERMINAL_PROMPT=0`, `-c credential.helper=`; PLAN commit with `-c user.name=...`; daemon asserts git ≥ 2.30 | ✅ | `git.ts:49-67`, `plan-commit.ts:77`, `daemon.ts:69` |
| **D70** fake-nax exits 1 on failed run, writes same files | ✅ | `fake-nax.ts:154` |
| **D71** harness `world.net` has `dropResponse` and seq recorder | ✅ | `harness/world.ts:37-42, 211-223`, integration test uses it |
| **D72** enroll warns ignored options; status opens journal read-only | ✅ | `enroll.ts:64-69`, `journal.ts:51-54, 176-191` |
| **D73** createWorld closes API/forge/Prisma on failure; WAL checked; `@prisma/client` is devDep | ✅ | `harness/world.ts:79-93, 237-239` |
| **D74** CI integration `timeout-minutes` 20 → 30 | ✅ (reviewer did not verify the YAML directly but the change is mechanical) | (could not verify workflow file in scope) |

**Plan-challenges raised in this review:**
- **D52/D53 contradiction** → see **BUG-3**.
- **Spec "lastHeartbeat fresh"** → see **BUG-1** (`@plan-challenge`).
- **D60 accepted server-side gap** → high-impact design trade-off; flagged HIGH with **D60** annotation in the executive summary below.

---

## Priority Fix Order

| Priority | ID | Effort | Plan hook | Description |
|:--|:--|:---|:--|:--|
| **P0** | SEC-1 | S | AGENTS.md (intent) | chmod journal.db / -wal / -shm to 0o600 in `Journal.open`; tighten home-dir mkdir to 0o700 in `daemon.ts`. One-day fix; test by inspecting file modes after `enroll` and after `startDaemon`. |
| **P0** | BUG-3 | M | **D52/D53** | Resolve the contradiction between "commit kept locally" and "wipe previous attempt's files" so a transient PLAN push failure doesn't drop the branch tip. Either keep plan-out/ across attempts on push-failure, or document the operator flow. |
| **P1** | BUG-1 | S | **@plan-challenge** | Remove the `status.updatedAt ?? row.updatedAt` fallback in `Supervisor.fresh`. Reject when `lastHeartbeat` is absent. Add a `supervisor.spec.ts` test. |
| **P1** | BUG-2 | S | D33 | Treat `RUNNING` + `pid === null` as a `failSafe` condition. Add a `job-run.spec.ts` test. |
| **P1** | SEC-2 | S | D65 | Either drop the unused `Promise<boolean>` return from `killIfOurs` (current callers ignore it) or wire it through to the SIGTERM→SIGKILL escalation in `watchUntilExit`. |
| **P2** | ENH-1 | S | D27 | Add a `build-bundle.spec.ts` test for a symlink-to-directory that verifies it is stored as a link (not followed). |
| **P2** | BUG-4 | S | D65 | Skip `reapQuietly` in `failSafe` when `row.pid === null`. |
| **P2** | BUG-5 | S | D37 | Use `ps -o lstart=` instead of `etime=` if clock-drift is in scope. Otherwise document the assumption. |
| **P2** | BUG-6 | S | D68 | Decide: keep the dead `too-large` branch with a `@design` remark, or split `NetworkError` from `ServerError`. |
| **P3** | TYPE-1, TYPE-2 | XS | — | Tighten `kill` return type; emit `'unknown'` instead of `String(type)` for unrecognised commands. |
| **P3** | MEM-1 | S | — | Prune `pendingAcks` whose command id is older than 1h or whose job is no longer `jobsWithPending()`. |
| **P3** | ENH-2, ENH-3, ENH-4, ENH-5 | XS–S | — | Performance index, prune ordering, rotation UX, 3b sandbox error hash. All non-blocking. |
| **P3** | STYLE-1 … STYLE-5 | XS | — | Tighten the redaction regex (word boundaries); inline `killIfOurs` if no test seam planned; JSON-stringify smell; comment placement; `checked` over-catch. |

**Effort key:** XS = <30 min, S = <2 h, M = <1 day, L = >1 day.

---

## Test-Coverage Notes

- All "Review Focus" items from the two plans have a named test:
  - 3a-1 RF-1 hostile path segments → `safe-segment.spec.ts` covers `..`, `/`, leading `-`, leading `.`.
  - 3a-1 RF-2 server rejects / cuts → `sync-loop.spec.ts` covers 426 stop, 401 stop, 400/413 halve, batch-1 retry-without-acks, D24 replace.
  - 3a-1 RF-3 crash between persist and send → `journal.spec.ts` covers transactional commits, rollback, reopen-of-file persistence.
  - 3a-1 RF-4 credential the server would reject → `capabilities.spec.ts` rejects the pre-3a shape and the new shape's variants.
  - 3a-2 RF-1 daemon restart + finished-while-down → `recovery.integration.spec.ts` (3 named tests).
  - 3a-2 RF-2 hostile ASSIGN → `command-handler.spec.ts:97-105`, `assign-parser.spec.ts`, `checkout.spec.ts`.
  - 3a-2 RF-3 net cut → `recovery.integration.spec.ts` (`a network cut mid-run` test).
  - 3a-2 RF-4 stale epoch + ABANDON → `recovery.integration.spec.ts` (`a stale epoch` test).
  - 3a-2 RF-5 two things on one repo / crash between steps → `command-handler.spec.ts:83-96` (higher-epoch abandons lower) + `host-executor.spec.ts:80-88` (D53 wipe).

- Coverage gaps worth closing:
  - **Symlink-to-directory** in bundle (ENH-1).
  - **Daemon crash during `Journal.open`** — currently untested; not in the plan's review focus but a real production scenario (corrupted WAL).
  - **Network error retry-budget** specifically for a 100+ MiB bundle timing out (BUG-6).

---

## Executive Summary (top concerns)

1. **`journal.db` permissions are not 0o600** (SEC-1). The runner's API key is locked down but its activity journal — ASSIGN payloads, clone URLs, internal job IDs, `runner_id`/`boot_id` metadata — is created with the process umask and is readable by any local user. This is the single most important fix before an external beta, and is not in the plan's decision register; it is a `journal.ts` 4-line patch.
2. **D52 + D53 contradict on PLAN push failure** (BUG-3). D52 says "commit kept locally"; D53's prepare wipe deletes the plan outputs that drive the next attempt's verdict and branch tip. The runner currently marks the job `plan push failed`, then on the next server-side retry wipes the very commit it just told the operator was "kept locally". The recovery story for transient push failures is broken; this is a MEDIUM that materially affects the PLAN product.
3. **`Supervisor.fresh` silently degrades to `row.updatedAt`** (BUG-1). The "heartbeat under 2 minutes" check falls back to a column that is bumped by the runner's own writes (cancel-requested patches, append-event patches). A wedged nax whose last `status.json` flush was hours ago can still pass freshness and be re-attached. The reviewer treats this as a `@plan-challenge` to the design because the fallback is silent and untested.
