# Fleet S1 Slice 3a — Deviations and Plan Amendments

> **Status:** D75 and D76 implemented in #170; both amended by **D77** (below, #171/#172).
> **Origin:** `docs/20260930-review-fleet-s1-slice-3a.md` (Deep Code Review, 2026-09-30).
> **Scope:** Two `@plan-challenge` findings raised against slice 3a-1 and 3a-2 plans. Both are deviations where the code follows the plan but the plan itself has a contradiction or an implicit silent fallback that the reviewer believes weakens the contract.

This document records the deviations as **new decision numbers D75 and D76** and supersedes the conflicting parts of **D52** (PLAN commit idempotency) and the implicit fallback in the spec's READOPT heartbeat check.

---

## D75 — READOPT requires `status.lastHeartbeat`; no fallback to `updatedAt` (source rule amended by D77)

**Conflict:** the slice 3 design §1.3 says "READOPT re-attaches only when the pid is alive, `status.json` `run.id` equals the journaled `naxRunId` and the heartbeat is under 2 minutes old". The 3a-2 code at `apps/runner/src/supervisor/supervisor.ts:69-72` (`Supervisor.fresh`) implements the freshness test as:

```ts
const stamp = Date.parse(status.lastHeartbeat ?? status.updatedAt ?? row.updatedAt);
```

The fallback chain silently accepts the runner's own `updatedAt` column when `status.lastHeartbeat` is missing — but `JobRow.updatedAt` is bumped by every `updateJob` call (`supervisor.cancel`'s `cancelRequestedAt` patch, `Journal.appendEvent`'s patch, status-snapshot writes). A wedged nax whose `status.json` has not been flushed will therefore pass `fresh()` after any unrelated runner-side write, and the runner re-attaches to a stuck child.

**Resolution:** the freshness test must require `status.lastHeartbeat` to be present and parseable; **no** fallback to `updatedAt` (which is a runner-side write timestamp, not a child-side heartbeat). This restores the design's "heartbeat under 2 minutes" contract literally.

```ts
private fresh(status: StatusView): boolean {
  if (!status.lastHeartbeat) return false;
  const stamp = Date.parse(status.lastHeartbeat);
  return !Number.isNaN(stamp) && this.deps.now().getTime() - stamp < this.deps.readoptHeartbeatMs;
}
```

**Why this supersedes the 3a-1 register:** the 3a-1 plan's D42 sets `readoptHeartbeatMs = 120000` (2 min), but no row in D21–D59 names the *source* of the timestamp. The 3a-2 code introduced the fallback chain implicitly when wiring `StatusView` to `JobRow`. D75 makes the source explicit and removes the silent degradation.

**Plan-challenge closure:** the spec's §1.3 wording is correct; the code drifted. The fix removes three `??` operators and adds a regression test in `apps/runner/src/supervisor/supervisor.spec.ts` that asserts `fresh()` returns false when `status.lastHeartbeat` is null/empty/missing — even if `row.updatedAt` was bumped one millisecond ago.

**Implementation hooks:**
- `supervisor.ts:69-72` — `fresh()` body
- `supervisor.spec.ts` — new test "rejects READOPT when status.lastHeartbeat is absent"

---

## D76 — Resolving the D52/D53 contradiction on PLAN push failure (superseded by D77)

**Conflict:** the 3a-1 register's **D52** says "the PLAN commit is `chore(plan): <feature> PRD via koda job <jobId>`, idempotent … push failure: FAILED, `stateReason = 'plan push failed'`, **commit kept locally**". The same register's **D53** says "prepare first deletes the previous attempt's files under a reused `<jobDir>` (`nax-out`, `nax.stdout`, `nax.stderr`, `pre-plan`, `plan-out`, `plan-logs`, `bundle.tar.gz`, `bundle.list`, `bundle-manifest.json`)".

The 3a-2 implementation of D53 (`apps/runner/src/executor/host-executor.ts:60-61`) wipes `ATTEMPT_FILES` at the start of every `prepare`. After a transient push failure, the next server-side retry reaches `prepare`, which deletes `.nax/features/<f>/plan-out/` and the in-progress `pre-plan/` snapshot. The local commit *tree* survives in `.git/objects/`, but the plan outputs that drove it are gone, so the verdict cannot be re-derived and the next attempt re-stashes from scratch — losing the original branch tip.

The recovery story in D52 ("commit kept locally") is therefore broken: the operator sees `plan push failed` and an empty local branch on the next dispatch.

**Resolution:** split ATTEMPT_FILES into two sets:

| Set | Wiped on every prepare | Examples |
|:--|:--|:--|
| **Mutable per-attempt** | yes | `nax-out/`, `nax.stdout`, `nax.stderr`, `pre-plan/`, `plan-out.tmp/`, `plan-logs.tmp/`, `bundle.tar.gz`, `bundle.list`, `bundle-manifest.json` |
| **Persistent across attempts on push failure** | no | `plan-out/`, `plan-logs/` (the write-once stash), plus the journal `result_branch`/`result_sha`/`last_push_attempt_at` |

Concretely:

1. When `commitAndPushPlan` aborts with `stateReason = 'plan push failed'`, `markDone` records the `result_branch` and `result_sha` of the local commit in the journal (the schema already has `result_branch` and `result_sha` columns per D23).
2. The next `prepare` (after a server-side retry or a manual requeue) detects the journal row has `state = 'FAILED'`, `stateReason = 'plan push failed'`, and a non-null `result_branch` / `result_sha`. It:
   - skips the `rm plan-out/` (the kept commit's metadata);
   - runs `git push origin <result_branch>` (which is idempotent — a no-op if the commit already reached origin);
   - on success, transitions `FAILED -> RUNNING -> UPLOADING -> terminal` and reports `state = 'COMPLETED'`;
   - on failure, leaves the row in `FAILED` and bumps a `last_push_attempt_at` timestamp; the next prepare retries the push without re-committing.
3. The other ATTEMPT_FILES (`nax-out/`, `bundle.tar.gz`, etc.) still get wiped — those are outputs of a fresh run, not artefacts of the kept commit.

**Why this supersedes D52/D53:** D52's "commit kept locally" becomes operationally true (the local commit is reachable, its branch tip is in the journal, the next prepare resumes by pushing instead of re-stashing). D53's wipe becomes scoped to mutable per-attempt outputs only.

**Plan-challenge closure:** the contradiction is not "D52 wrong, D53 right" or vice versa; it is "D52 and D53 are both correct but overlap on `plan-out/`". D76 narrows D53 and turns D52 into a real recovery path.

**Implementation hooks:**
- `apps/runner/src/executor/host-executor.ts:60-61` — `ATTEMPT_FILES` split (rename `PERSISTENT_FILES`)
- `apps/runner/src/executor/host-executor.ts` `prepare` — early-return on a prior `plan push failed` row that resumes by pushing
- `apps/runner/src/executor/plan-commit.ts:86-103` — `commitAndPushPlan` populates `result_branch` / `result_sha` on `markDone`
- `apps/runner/src/journal/schema.ts` — `last_push_attempt_at TEXT` column on `jobs`
- `apps/runner/test/unit/host-executor.spec.ts` — new test "transient push failure: next prepare resumes by pushing, does not re-commit"
- `apps/runner/test/unit/plan-commit.spec.ts` — extend with the result-branch recording case

---

## D77 — Heartbeat source and PLAN push recovery, corrected (#172, #171)

**D75 correction (#172).** D75 was right to exclude the journal row's `updatedAt` (a runner-side write stamp) and wrong to exclude `status.updatedAt`. Both `status.json` stamps are written by nax. nax sets `lastHeartbeat` only on its 60s heartbeat write (`src/execution/crash-heartbeat.ts`); `StatusWriter.getSnapshot` does not carry it, so every other status write (story transitions, iterations) drops it, and it is absent for the first 60s of a run. Requiring it made READOPT reject, kill and re-run a healthy RUN job after most daemon restarts. Every nax status write, heartbeat included, stamps `updatedAt`, so it is at least as fresh a child-side liveness signal.

**Resolution:** `Supervisor.fresh` takes the newer of the parseable `status.lastHeartbeat` and `status.updatedAt`; neither present or parseable is stale. `row.updatedAt` never counts. PLAN readopt does not call `fresh()` and is unaffected.

**D76 correction (#171).** D76 keyed recovery on the current journal row. A server requeue bumps the lease epoch (plan D4), so the runner inserts a new row with `result_branch`/`result_sha` NULL; the recovery path could not run. Carrying the kept commit across epochs only works when placement returns the job to the same runner, and needs a prepare-to-finish path that skips `nax plan`.

**Resolution:**

1. A transient push failure is recovered inside the attempt: `commitAndPushPlan` retries only the `git push`, after back-offs of 2 s and 8 s (`PLAN_PUSH_BACKOFF_MS`, 3 pushes in all). An authentication failure is not retried (`no git credentials (runner 3b)`).
2. A requeue is a fresh attempt and re-plans. D53 is restored whole: `prepare` wipes `plan-out`/`plan-logs` with the other attempt files. On the same runner the unpushed commit survives on its local branch (D51 `keep-local`), so the new attempt's commit lands on top of it (or pushes it unchanged when the PRD is identical) and nothing is lost.
3. Removed: the persistent-files split in `prepare`, `PlanPushResume`/`resume`, the `needRetryPush` path in `JobRun.finish`, and the `last_push_attempt_at` column with its migration. No runner was deployed with it, and an existing journal keeps the unused nullable column harmlessly.

**Accepted cost:** a requeue after three failed pushes spends one more billed `nax plan`.

**Tests:** `supervisor.spec.ts` (non-heartbeat status write re-attached; newer stamp wins; both stale rejected); `plan-commit.spec.ts` (transient failure retried to one commit; persistent failure tried 3 times with the back-offs; auth failure not retried); `host-executor.spec.ts` (a requeue on a new epoch wipes the stash, re-plans, and the kept commit reaches origin).

---

## Decision addendum (D75–D77)

| # | Decision | Why |
|:--|:--|:--|
| D75 | `Supervisor.fresh` requires `status.lastHeartbeat`; no fallback to `status.updatedAt` or `row.updatedAt`. **Source rule amended by D77.** | The 2-minute freshness window is a *child-side* heartbeat contract; the runner's own `updatedAt` is a write timestamp, not a heartbeat. The silent fallback made a stuck nax appear fresh after any unrelated runner-side write. |
| D76 | `prepare` no longer wipes `plan-out/` on a row whose last attempt failed at PLAN push. The next attempt pushes the kept local commit (idempotent `git push`); on success the row transitions `FAILED -> RUNNING -> UPLOADING -> COMPLETED`. The journal records `result_branch` / `result_sha` from `markDone`; a `last_push_attempt_at` column bounds the retry budget. **Superseded by D77.** | D52 ("commit kept locally") and D53 ("wipe previous attempt's files") overlapped on `plan-out/`. The contradiction made a transient push failure a permanent failure with no operator-visible recovery. D76 narrows D53 to mutable per-attempt outputs and turns D52 into a real recovery path. |
| D77 | `fresh()` uses the newer of `status.lastHeartbeat` and `status.updatedAt` (both nax-written). A PLAN push is retried inside the attempt (2 s, 8 s back-off; an auth failure is not retried); a requeue re-plans from a wiped job dir. D76's resume machinery is removed. | nax drops `lastHeartbeat` on every non-heartbeat status write, so D75 rejected healthy runs. D76's resume could not run across a requeue's new epoch, and never can on another runner. |

---

## Out of scope

- D60 (server-side 409 re-check race) — the review marks it as a design-accepted server follow-up, not a runner fix; tracked separately.
- The other 13 review findings (SEC-1, SEC-2, BUG-2, ENH-1, BUG-4, BUG-5, BUG-6, TYPE-1, TYPE-2, ENH-2..5, STYLE-1..5, MEM-1) are addressed by the fix PR that lands with this deviation, but do not amend the plan register.