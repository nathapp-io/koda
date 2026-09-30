# Deep Code Review: PR #170 — Fleet S1 Slice 3a Post-Review Fixes

**Date:** 2026-09-30
**Reviewer:** Subrina (AI)
**PR:** [#170](https://github.com/nathapp-io/koda/pull/170) `fix/fleet-s1-slice3a-post-review-fixes`
**Base:** `main` @ `c81d3e3a` (PRs #168 + #169 already merged)
**Commits:** 7 (`c46e5b9f` … `8c653dd0`)
**Diff:** 36 files, +1058 / −57 (`docs/` 658 lines; runner ~400)
**Baseline (verified):** `bun test apps/runner/src apps/runner/test/unit` → **662 pass / 0 fail**; `bunx tsc --noEmit` clean (per PR).

---

## Overall Grade: **B+** (83/100)

This is a disciplined post-review fix branch: 15 findings addressed, each with a comment that names the ID and the decision hook, and 20 new tests. The low-level changes are mostly correct and well-scoped. However, two of the higher-value fixes are not sound as landed: **BUG-5 introduced a timezone-dependent regression in the very reap path it set out to harden**, and **D76's PLAN push-recovery trigger is unreachable on the server's normal retry path** (a requeue bumps the lease epoch and constructs a fresh journal row with null `result_branch`/`result_sha`), so the P0 fix is exercised only through the `FakeExecutor`. A third, quieter hazard is the new `last_push_attempt_at` column added to a `CREATE TABLE IF NOT EXISTS` schema with **no migration**, which breaks in-place upgrades of an existing `journal.db`.

### Per-dimension scores

| Dimension | Score | Notes |
|:--|:--|:--|
| **Security** | 15/20 | SEC-1 lands (journal `0o600`, home `0o700`) and is effectively enforced by the `0o700` home dir. But STYLE-1's tightened redaction **regressed** `api_key`, `x-api-key`, `api-key`, `apiKeys`, `keys`, `tokens`, `secrets`, `secret_key`, `refresh_token`, `accessTokenHash` from redacted to leaked. |
| **Reliability** | 15/20 | BUG-2/BUG-4/SEC-2/MEM-1 are correct. BUG-5 corrupts process-start comparison by the host UTC offset on non-UTC hosts → live nax pids are never reaped. D76 recovery is unverified end-to-end and unreachable via requeue. New schema column has no migration path. |
| **API Design** | 18/20 | Seams unchanged; `JobExecutor.kill` widened to `boolean` cleanly; `PlanPushOutcome.resume` is a tidy optional. Minor: `__checked` test seam is exported from a production module. |
| **Code Quality** | 18/20 | Comments explain the "why" and cite D-numbers. Small dead code (`parseEtime`), a no-op assignment, and one duplicated `recordCommand`. |
| **Best Practices** | 17/20 | Decisions D75/D76 documented in the deviations register; tests added for nearly every finding. Migration gap is the only structural miss. |

---

## Findings

### 🟠 HIGH

#### BUG-5a: `readProcessStart` mixes a UTC `ps` clock with a host-local `Date.parse`, breaking reap on non-UTC hosts
**Severity:** HIGH (regression) | **Category:** Bug
**Files:** `apps/runner/src/executor/pid-registry.ts:63-75` (`readProcessStart`), `:47` (`selectReapable` comparison), `:33` (`REGISTRATION_SLACK_MS`)

```ts
const proc = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], {
  stdout: 'pipe', stderr: 'ignore', stdin: 'ignore',
  env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },   // <-- prints UTC wall-clock
});
const text = (await new Response(proc.stdout).text()).trim();
...
const stamp = Date.parse(text);   // <-- interprets in the RUNNER's local TZ
```

`ps` is told `TZ=UTC`, so it prints the UTC wall-clock string (e.g. `Thu Oct  1 00:00:05 2026`). `Date.parse` runs in the **runner's own process**, which still uses the host timezone when `process.env.TZ` is unset — the comment explicitly admits "`process.env.TZ` may be unset in production". A timestamp with no zone/offset is parsed as host-local, so the returned `Date` is shifted by the host's UTC offset. Verified empirically:

```
TZ=UTC              => 2026-10-01T00:00:05.000Z   delta 0h
TZ=America/New_York => 2026-10-01T04:00:05.000Z   delta +4h
TZ=Asia/Singapore   => 2026-09-30T16:00:05.000Z   delta -8h
```

`selectReapable` then tests `started.getTime() <= registered + 5_000`. On any host west of UTC (all of the Americas), `started` is hours in the future, so **every real nax pid fails the check and is never reaped** — the exact orphan-process leak BUG-5 was written to prevent. (East-of-UTC hosts pass by accident; UTC hosts work.) The unit test only passes because `bun test` forces `TZ=UTC`, so CI cannot catch it.

**Risk:** Orphaned nax child processes accumulate on non-UTC hosts; `reap` silently reports nothing.

**Fix:** parse in the same frame `ps` emitted. Simplest correct option — drop the child override so both use host-local:
```ts
env: { ...process.env, LC_ALL: 'C' }
```
or keep `TZ: 'UTC'` and make the parse explicit:
```ts
const stamp = Date.parse(`${text} UTC`);
```
Either way, add a test that pins a non-UTC `TZ` for `readProcessStart` (e.g. run the child with `TZ=America/New_York` and assert the returned instant matches the process start within the slack).

#### D76: the PLAN push-recovery trigger is unreachable on the normal retry path
**Severity:** HIGH (fix does not achieve its stated goal) | **Category:** Bug / Plan
**Files:** `apps/runner/src/executor/host-executor.ts:66-78` (`keepPersistent`), `apps/runner/src/supervisor/job-run.ts:258-279` (`needRetryPush`), `apps/api/src/fleet/jobs/fleet-jobs.service.ts:123-143` (requeue), `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:90-97` (`casAssign`)

`keepPersistent` only fires when the row being prepared already has `resultBranch`/`resultSha`:
```ts
const keepPersistent = assign.command === 'PLAN' && job.resultBranch !== null && job.resultSha !== null;
```
and `needRetryPush` requires the same row's `lastPushAttemptAt !== null`. But the FAILED row that recorded those fields is **terminal and `markDone`-ed** (`job-run.ts:307`). The runner only re-enters `prepare` for a row that is `ASSIGNED` with `pid === null` (`supervisor.ts:100-103`, `command-handler.ts:88-91`). A failed push is neither.

The server's retry is `requeue` (FAILED → QUEUED), which carries `bumpEpoch: true` (`fleet-jobs.service.ts:137`, plan D4) and "run fields cleared". Placement then `casAssign`-es a new lease epoch, and the runner builds a **new** journal row via `insertJob` with `result_branch`/`result_sha` **NULL**. On that new row `keepPersistent` is false, so `prepare` still wipes `plan-out`/`plan-logs` and re-runs `nax plan`. The recovery the commit message describes ("the next prepare pushes the kept local commit instead of re-stashing") never runs; the branch tip only survives incidentally through `planBranch`'s `keep-local` case (`branch.ts:19-30`).

There is no test of the real path: `job-run.spec.ts` exercises D76 against `FakeExecutor` with hand-set journal columns, and `test/unit/host-executor.spec.ts` never sets `resultBranch`/`resultSha` before `prepare`/`finishPlan`. The deviations doc's promised `test/unit/host-executor.spec.ts` "transient push failure: next prepare resumes by pushing" test was not added.

**Risk:** The P0 recovery story is a no-op in production; operators still see a permanent `plan push failed`.

**Fix (choose one, then test it):**
1. Carry the kept-commit metadata across epochs — the server must include `resultBranch`/`resultSha` in the re-`ASSIGN` payload (and `parseAssign` must accept it), so the new row can resume; **or**
2. Make `reap`/`finish` recovery explicit on the *old* row: on a push failure, don't mark the row done; leave it in a recoverable state that the next sync's `resumeStranded` (or a dedicated retry) can pick up; **or**
3. Drop the claim and implement the recovery in `prepare` as documented (plain idempotent `git push origin <resultBranch>`) with a real `HostExecutor` integration test proving no second commit.

---

### 🟡 MEDIUM

#### MIG-1: new `last_push_attempt_at` column has no migration; in-place journal upgrades break
**Severity:** MEDIUM | **Category:** Bug / Reliability
**Files:** `apps/runner/src/journal/schema.ts:19`, `apps/runner/src/journal/journal.ts:11-15` / `:146-152`

`SCHEMA_SQL` uses `CREATE TABLE IF NOT EXISTS jobs (...)`. On an existing `journal.db` the `IF NOT EXISTS` short-circuits, so `last_push_attempt_at` is never added. `PATCH_COLUMNS` now maps it, and `updateJob` emits `UPDATE jobs SET ... last_push_attempt_at = ? ...` whenever the patch carries `lastPushAttemptAt` — which is every PLAN push success/failure (`job-run.ts:267-274`). On an upgraded host the first such update throws `no such column: last_push_attempt_at`, the error bubbles out of `finish()` into `start()`'s catch, and `failSafe` ends the job FAILED.

Secondary: `toJob` casts `r['last_push_attempt_at'] as string | null`, but `SELECT *` on the old schema yields `undefined`, not `null` (`journal.ts:23`). `needRetryPush`'s `!== null` then treats it as "set".

**Fix:** add an idempotent column migration guarded by `PRAGMA table_info(jobs)` (or a `meta`-stored schema version) before `SCHEMA_SQL` is applied, and normalise `toJob` with `?? null` for columns that may be absent.

#### SEC-3: redaction regex regressed common secret key shapes
**Severity:** MEDIUM | **Category:** Security
**File:** `apps/runner/src/logger.ts:12`

```ts
const SECRET_KEY = /(?:^|(?<=[a-z])(?=[A-Z]))(?:[Kk]ey|[Tt]oken|[Ss]ecret|[Pp]assword|[Aa]uthorization)\b/;
```
The regex now requires a word start or a lower→upper case change immediately before the word. That correctly keeps `monkey`/`monkeyCount`/`tokenize`/`xKeyx` out, but it also stops matching the dominant machine-generated key shapes. Evaluated against the previous `/key|token|secret|password|authorization/i`:

| Key | Before | After |
|:--|:--|:--|
| `api_key`, `api-key`, `x-api-key` | redacted | **leaked** |
| `keys`, `tokens`, `secrets`, `apiKeys` | redacted | **leaked** |
| `secret_key`, `refresh_token` | redacted | **leaked** |
| `accessTokenHash` | redacted | **leaked** |

This directly weakens the runner's stated invariant ("the `Logger` redacts secret-looking keys", `apps/runner/AGENTS.md`). It is defense-in-depth (today no call site logs such a field), but a future `log.warn(..., { api_key })` would leak.

**Fix:** keep the camelCase boundary but allow non-alphanumeric separators and plurals, e.g. match a `key|token|secret|password|authorization` substring that is either at a segment boundary or preceded by `_`/`-`, optionally followed by a plural `s`: `/(?:^|[_\-\s]|[a-z](?=[A-Z]))(?:key|token|secret|password|authorization)s?(?:$|[_\-\s]|[A-Z])/i` — then re-assert the same test cases (including `api_key`, `apiKeys`, `monkey`, `tokenize`).

---

### 🟢 LOW

#### MEM-1a: `pendingAcksAt` is not deleted when an ack is confirmed
`sync-loop.ts:141` deletes from `pendingAcks` on confirmation but leaves the `pendingAcksAt` timestamp behind until the 1h TTL sweep. Bounded, but it keeps every command id seen in the last hour, and `pruneStalePendingAcks` copies the whole map on every journal write. Delete the timestamp in the same loop.

#### DEAD-1: `parseEtime` is now production-dead
`pid-registry.ts:54` is referenced only by `pid-registry.spec.ts`; the doc comment ("for callers that still want elapsed time directly") no longer names a real caller. Either remove it and its spec, or mark it `/** @internal test-only */`.

#### NOOP-1: `status = 0` in the upload catch is dead
`upload-bundle.ts:54` reassigns `status = 0`, but `status` is already reset at the top of every loop iteration (line 47) and the throwing path never assigned it. Harmless, but it implies the value mattered. Remove for clarity.

#### DRY-1: unknown-command path duplicates `recordCommand`
`command-handler.ts:81` inlines the same record call as `CommandHandler.record` (line 37). Extract a `recordType(command, type, outcome)` helper so the two cannot drift.

#### API-1: `__checked` exports an internal test seam from a production module
`assign-parser.ts:26` (`export const __checked = checked`). Prefer a dedicated test that drives `parseAssign` with a value that makes a validator throw a non-`PathError`, instead of widening the module surface.

#### DOC-1: deviations table lists `plan-out/` as both mutable and persistent
`docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-deviations.md:53-54` puts `plan-out/` in the "wiped on every prepare" row, while the implementation (`host-executor.ts:32-33`) and the prose put it in the persistent set. Fix the table.

#### SEC-1a: best-effort chmod / unconditional home chmod
`journal.ts:55-59` chmods `-wal`/`-shm` once at open; if SQLite creates them later they inherit the umask. This is **mitigated** by the new `0o700` home dir (`daemon.ts:80-81`), which blocks traversal, so the residual risk is low. Note that `chmod(home.dir, 0o700).catch(() => undefined)` silently overrides any operator-chosen mode on an existing dir; consider logging when the chmod changes an existing mode.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P0 | BUG-5a | S | Parse `lstart` in the frame `ps` emitted; test under a non-UTC `TZ`. |
| P0 | D76 | M | Make the recovery reachable end-to-end (or remove the claim); add a real `HostExecutor` test. |
| P1 | MIG-1 | S | Add an idempotent `ALTER TABLE … ADD COLUMN` migration; `?? null` in `toJob`. |
| P1 | SEC-3 | S | Restore redaction of `_`/`-`/plural secret keys; extend the spec. |
| P2 | MEM-1a | S | Delete `pendingAcksAt` on ack confirmation. |
| P2 | DEAD-1, NOOP-1, DRY-1, API-1, DOC-1 | S | Small cleanups. |
| P3 | SEC-1a | S | Log when the home-dir chmod changes an existing mode. |

---

## What is correct and worth keeping

- **SEC-1** journal `0o600` + home `0o700`, with a root/Windows skip guard and a real mode assertion test.
- **SEC-2** `killIfOurs` → `Promise<void>`; the boolean was genuinely unused by all three callers.
- **BUG-2** `RUNNING` + `pid === null` → `failSafe` (no partial-bundle upload) and **BUG-4** skip reap when `pid === null` — both close honest-but-dangerous paths.
- **BUG-6** `NetworkError` vs 5xx split in `uploadWithRetry`; the `too-large` branch is now reachable only on network exhaustion of an oversized bundle.
- **MEM-1** TTL-bounded `pendingAcks` (correct even though `pendingAcksAt` cleanup is incomplete): a dropped ack is safely re-acked via `journal.getCommand`, so pruning cannot re-run a command.
- **STYLE-5** `checked` now re-throws non-`PathError`; `assertCloneUrl` throws `PathError` consistently.
- **TYPE-1/TYPE-2**, **ENH-1/3/4/5**, **STYLE-3**, **D75**: all accurate and tested.

---

## Resolution (fix branch)

| Finding | Status |
|:--|:--|
| BUG-5a (reap TZ regression) | Fixed: `readProcessStart` parses `lstart` as UTC; non-UTC regression test added. |
| D76 (recovery unreachable) | Filed as [#171](https://github.com/nathapp-io/koda/issues/171) — needs a cross-epoch design decision, not a runner-only fix. |
| D75 (README heartbeat contract) | Filed as [#172](https://github.com/nathapp-io/koda/issues/172) for the nax-compatibility check; implementation unchanged. |
| MIG-1 (`last_push_attempt_at` migration) | Fixed: idempotent `ALTER TABLE … ADD COLUMN` in `Journal.open`; `toJob` normalises to `null`; migration test added. |
| SEC-3 (redaction gaps) | Fixed: boundary-aware `SECRET_KEY` (`_`/`-`/camelCase/plural/SCREAMING); spec extended. |
| MEM-1a (`pendingAcksAt` on ack) | Fixed: confirmation deletes the timestamp; test added. |
| NOOP-1, DRY-1, DEAD-1, API-1, DOC-1 | Fixed (no-op removed, `recordAs`, `parseEtime` removed, `@design` note, deviations table corrected). |
| SEC-1a | Left as a documented low-risk note (home dir `0o700` already mitigates). |
| CI failure | Fixed: `journal.spec.ts` asserts the `-wal`/`-shm` mode while the connection is open, not after `close()`. |
