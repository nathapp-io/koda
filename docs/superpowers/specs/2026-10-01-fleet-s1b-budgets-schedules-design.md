# Fleet S1b — Budgets, Schedules and Run Progress — Design

Builds the two items the fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec") deferred to S1b:
C1 budget policies (§9.1) and C4 schedules (§9.2). It also adds two runner changes: a work-in-progress push after
every unfinished RUN (which schedules need) and the PRD story list in status snapshots. Where this document and
S1 spec §9.1/§9.2 disagree, this document wins.

## Goal

Make unattended fleet spend safe and useful. A schedule drives one feature to done across many RUNs; a budget
policy caps what any scope (global, project, repo, runner) can spend; the job page shows where the run is in its
plan, story by story, live.

## Success criteria

1. A scheduled RUN of a feature continues where the last tick stopped, on any runner, and the schedule disables
   itself when the feature completes, when its finish fails with every story passed, or after N ticks without
   progress.
2. A cron tick never creates a second QUEUED job for the same schedule.
3. Once a scope's window spend reaches its policy amount, no new job in that scope is dispatched or assigned, and
   RUNNING jobs follow the policy's `runningJobs` flag.
4. An admin can see why a scope is paused and resume it, raising the amount if needed.
5. The job detail page shows the PRD's stories with live status, the current story and phase, and cost.

## Rulings (user, 2026-10-01)

| # | Ruling |
|:--|:--|
| B1 | Un-pausing in S1b is an **admin resume** (optionally raising the amount). `BudgetIncident.approvalId` stays null until C8 (S1.5), whose `raise_budget_and_resume` decision calls the same service method. |
| B2 | Window spend is **snapshot-only**: the sum of what runners reported in `costSpentUsd`. It is a lower bound (a job that dies between snapshots loses its last interval). Ledger reconciliation at bundle ingest is deferred to S2a. `--max-cost` stays the hard per-job cap. |
| B3 | Policy permissions by scope: `global` and `runner` = global ADMIN; `project` and `repo` = project ADMIN of the owning project, or global ADMIN. Project members read their project's policies and the global ones. |
| B4 | Schedules dispatch **RUN only**, for one fixed feature: a "drive this feature to done" loop. PLAN schedules and PLAN→RUN chains are out of scope. |
| B5 | After **every** RUN that ends without finishing, the runner pushes the feature branch (story commits plus `prd.json`), never opening a PR. Any runner can continue the next RUN. |
| B6 | Status snapshots carry the PRD **story list**; the job page shows it as a live checklist. |
| B7 | Budget hard stops are detected by an **evaluator signalled after snapshot ingest**, debounced per scope, with a 60 s sweep as backstop (approach 1). |
| B8 | A `calendar_month_utc` pause **clears automatically** when the month rolls over. A `lifetime` pause clears only by admin resume. |

Earlier rulings that still hold: R2 (`runningJobs: finish | cancel`, default `finish`), single-instance API
(in-process sweeps and ticker), all runner git traffic brokered (R5).

### Why a RUN schedule works (verified at nax `f441a4ded`, 2026-10-01, `packages/nax`)

- A re-run resets `failed` stories to `pending` with `attempts = 0` (`src/prd/index.ts:363-395`, called at
  `src/execution/lifecycle/run-initialization.ts:231`). The 12-attempt cap is per run, so each tick retries.
- A run stopped by `--max-cost`, a provider quota, SIGINT or a crash resumes from `prd.json`;
  `checkpoint.jsonl` skips green agent phases when HEAD and the tree digest match
  (`src/execution/checkpoint/resume-plan.ts:23-37`).
- All stories passed: the run exits `completed` at $0 with no agent (`src/execution/unified-executor.ts:126-129`)
  and the finish ledger stands down on an already-finished branch (`src/finish/context.ts:285-340`).
- `blocked` and (headless) `paused` stories are never picked again (`src/prd/index.ts:209`): such a feature stalls
  at about $0 per run. The no-progress rule (§3.3) stops it.
- nax's finish phase pushes only when no story failed or paused (`src/finish/phase.ts:98-115`), and the koda
  runner pushes only PLAN output (runner design R-3.4). Without B5 an unfinished RUN's commits stay on one machine
  and a tick on another runner redoes and re-bills them.
- `progress.passed` is nax's `status.json` count (`src/execution/status-file.ts:141`), cumulative over the PRD.
- `nax run --schedule` (`bin/nax.ts:236`) only delays one run's start; recurring scheduling belongs to koda.

## Out of scope

- C8 typed approvals and an approvals inbox (S1.5). The `approvalId` column is the seam.
- Ledger cost reconciliation (S2a, with C6).
- PLAN schedules, PLAN→RUN chains, per-tick fresh feature names.
- A general `idempotencyKey` on dispatch; only schedules coalesce.
- Per-story cost.
- A multi-instance ticker or evaluator.
- Counter tables for spend; spend is a `SUM` on demand.

## 1. Runner and protocol

### 1.1 Work-in-progress push (slice 1a)

**Where:** `JobRun.finish()` (`apps/runner/src/supervisor/job-run.ts:267-316`), for `command = RUN`, after the
verdict is computed and before the `UPLOADING` transition (`:293`). It calls a new `JobExecutor.pushProgress(...)`
implemented in `HostExecutor` on the model of `HostExecutor.finishPlan`: same credential-helper acquisition, same
`job.assign.gitIdentity`, same cancel probe while waiting for a git token.

- **When:** the verdict is not `COMPLETED` (so `FAILED`, `ESCALATED`, or `CANCELLED` after nax exited) and the
  job run is not halted (`this.halted` false: no `ABANDON`, lease held). `COMPLETED` already implies nax's finish
  phase pushed (finish results in `COMPLETING_RESULTS`, `apps/runner/src/verdict/run-verdict.ts:10`).
- **Never:** on `CRASHED` (the daemon died; READOPT owns the job), when halted, or for PLAN jobs. The git broker
  refuses a stale epoch anyway (S1 spec §6.3).
- **What:**
  1. If `.nax/features/<feature>/prd.json` is dirty, commit **only that file** with message
     `chore(nax): progress of <feature> via koda job <jobId>`. Uncommitted story code is never committed.
  2. `git push origin <branchName>`: plain fast-forward, never forced, through the job's credential helper.
  3. Transient failures retry with `PLAN_PUSH_BACKOFF_MS` (2 s, 8 s; `apps/runner/src/executor/plan-commit.ts`).
     A non-fast-forward rejection is not retried. A cancel during a retry wait stops retrying.
- **Result:** new snapshot field `wipPush`: `pushed`, `none` (nothing new), or `failed:<reason>` (`failed:diverged`
  for a non-fast-forward). It never changes the job's verdict.
- **Result branch and sha:** when `wipPush = pushed`, `resultBranch`/`resultSha` are the pushed branch and commit
  and override the finish-ledger values (`job-run.ts:289-291`); otherwise the existing values stand.
- **Divergence:** a `failed:diverged` push leaves local and origin diverged; the next RUN on that runner then
  fails checkout with `checkout: branch diverged` (runner design §2 step 4). That is a visible failure, counted
  as no progress by schedules (§3.3); the schedule page shows the job's `wipPush` and `stateReason`.
- No PR is opened; that stays with nax's finish phase.

The next RUN of the feature continues `origin/<branchName>` on any runner (runner design R-3.3, §2 step 4).

### 1.2 Story list in snapshots (slice 1b)

- The `Watcher` gains a `repoDir` option. On each status poll it reads `<repoDir>/.nax/features/<feature>/prd.json`
  (skipped if the file exceeds 1 MiB) and maps each user story to `{ id, title, status, attempts, dependsOn }`:
  - `title` clipped to 80 characters (surrogate-safe, as `status-snapshot.ts` clips); `dependsOn` at most 10 ids.
  - `status` is nax's string (`pending`, `in-progress`, `passed`, `failed`, `skipped`, `blocked`, `paused`,
    `regression-failed`, `decomposed`), passed through.
  - `attempts` an integer ≥ 0.
- **Byte cap:** the serialized `stories` array is at most **8 KiB**, so the whole snapshot stays under the
  16 KiB per-event payload limit (`SYNC_LIMITS.payloadBytes`, `apps/api/src/fleet/sync/sync-request.parser.ts:4`,
  mirrored in `apps/runner/src/sync/batch.ts:4`). The watcher keeps stories in PRD order and stops before the one
  that would exceed the cap, setting `storiesTruncated: true`. At most 100 stories in any case.
- Sent only when the stable-JSON hash of the list differs from the last one sent for this job and epoch.
- A missing, oversize or unparsable PRD omits the field. It never fails the job.

### 1.3 Protocol and server

- `SnapshotEventPayload` (`packages/fleet-protocol/src/index.ts`) gains optional `stories`, `storiesTruncated`
  (slice 1b) and `wipPush` (slice 1a). `FLEET_PROTOCOL_VERSION` stays `1`: the fields are additive and optional.
- The server's snapshot mirror (`apps/api/src/fleet/sync/event-payloads.ts`) validates each field and **drops** an
  invalid or over-cap one, like every other mirrored field; it never rejects the event.
- `FleetJob` gains `wipPush String?` (1a) and `stories Json?`, `storiesTruncated Boolean @default(false)` (1b),
  exposed in `FleetJobDto`. `requeue` clears them with the other live fields (`fleet-jobs.service.ts:145-149`).
- The existing `fleet_job` live event (`id/projectId/jobId/state/at`) is unchanged; the job page refetches on it,
  so the new fields appear live without a payload change.

### 1.4 Web (slice 1b, and the `wipPush` line in 1a)

- The job detail page (`apps/web/pages/[project]/fleet/jobs/[id].vue`) gets a story checklist under
  `FleetJobProgress`: one row per story with a status chip and attempts, the current story highlighted with its
  `currentPhase`, and a "list truncated" note when `storiesTruncated`. Without `stories` the page shows counts
  only, as today.
- 1a: `wipPush` shows next to the result branch: pushed, nothing to push, or the failure reason.

### 1.5 Testing

- 1a unit: the push decision for every verdict and halted state; the prd-only commit; each push failure to its
  `wipPush` value; result branch/sha precedence; cancel during the retry wait.
- 1a runner integration (real API in process, fake nax, `file://` bare remote): a FAILED RUN and a cost-limit RUN
  both push; a second RUN on a **different** runner starts from the pushed branch and sees the updated
  `prd.json`; a halted job pushes nothing.
- 1b unit: story mapping, clipping, byte-cap truncation, the hash gate, the 1 MiB read cap; server mirror drops an
  invalid or over-cap list and keeps the rest of the snapshot.
- 1b web unit: the checklist renders, highlights the current story, shows the truncation note, and falls back
  without `stories`.

## 2. C1 budgets

### 2.1 Model (slice 2a)

```
BudgetPolicy {
  id, scopeType: global | project | repo | runner, scopeId?,
  scopeKey        String   // 'global' or '<scopeType>:<scopeId>'; one unique index covers the global row
  projectId       String?  // owning project for project and repo scopes; null for global and runner
  windowKind: calendar_month_utc | lifetime,
  amountUsd       Decimal(12,4),
  warnPercent     Int?     // 1-99 or null = no warn
  hardStop        Boolean  @default(true),
  runningJobs: finish | cancel = finish,
  pausedAt?, pausedWindowStart?,
  createdById, updatedById, createdAt, updatedAt
  @@unique([scopeKey, windowKind])
}

BudgetIncident {
  id, policyId, kind: warn | hard_stop | resumed | window_reset,
  windowStart, spentUsd Decimal(12,4), amountUsd Decimal(12,4),
  actorId?, approvalId? (null until C8), createdAt
}
-- partial unique: (policyId, kind, windowStart, amountUsd) WHERE kind IN ('warn', 'hard_stop')

FleetJob += costCarriedUsd Decimal(12,4) @default(0), firstStartedAt DateTime?, cancelReason String?
```

- **`warnPercent` in the DTO:** omitted on create → 80; explicit `null` → no warn; on update, omitted → unchanged.
- **Incident uniqueness** includes `amountUsd`, so after a resume that raises the amount, the next warn and hard
  stop in the same window are new incidents (B1).
- **Scope ids:** `scopeId` references a project, repo or runner with no foreign key (it is polymorphic).
  `projectId` is resolved at create (repo → its project). A policy whose scope row no longer exists is ignored by
  dispatch, placement and the evaluator, and the 60 s sweep deletes it with its incidents.
- **Requeue keeps spend:** `requeue` adds the attempt's `costSpentUsd` to `costCarriedUsd` before zeroing it
  (`fleet-jobs.service.ts:147`), and `firstStartedAt` is set on the first start and never cleared.
- **Window start:** `calendar_month_utc` = first instant of the current UTC month; `lifetime` = no lower bound.
- **Window spend:** `SUM(costSpentUsd + costCarriedUsd)` over jobs in scope with `firstStartedAt >= windowStart`.
  A job counts in the window it first started in. Scope filters: global = all jobs; project = `projectId`;
  repo = `repoId`; runner = `runnerId`.
- New indexes: `FleetJob (projectId, firstStartedAt)`, `(repoId, firstStartedAt)`, `(runnerId, firstStartedAt)`.
- Known limit: deleting a repo cascades its jobs, so their spend leaves `lifetime` totals.

### 2.2 Evaluator (slice 2a)

`BudgetEvaluator` lives in `apps/api/src/fleet/budgets/`.

- **Signal:** `JobReportProcessor.process` (`apps/api/src/fleet/sync/job-report.processor.ts`) records each job
  whose `costSpentUsd` differs before and after applying its events, and signals that job's scope keys (global,
  project, repo, runner) **after** `txManager.run` returns. Signals are debounced per scope key at about 1 s. The
  sync transaction runs no budget queries.
- **Evaluate one policy**, in one transaction that first locks the policy row (`SELECT … FOR UPDATE`), because a
  debounced signal and the sweep can run at once:
  1. Compute window spend.
  2. **Warn:** `warnPercent` set and spend ≥ `amountUsd × warnPercent / 100` → insert the `warn` incident
     (`ON CONFLICT DO NOTHING`) and, when inserted, dispatch the `fleet.budget.warn` webhook (§4).
  3. **Hard stop:** `hardStop` on, not paused for the current window, spend ≥ `amountUsd` →
     - set `pausedAt = now`, `pausedWindowStart = windowStart`;
     - insert the `hard_stop` incident; dispatch the `fleet.budget.hard_stop` webhook;
     - cancel the scope's `QUEUED` jobs (state `CANCELLED`, `stateReason = 'budget:<policyId>'`). For a
       `runner` policy these are the QUEUED jobs pinned to it (`pinnedRunnerId`).
     - if `runningJobs = cancel`, request cancel of the scope's `ASSIGNED` and `RUNNING` jobs through a new
       system method `FleetJobsService.cancelForBudget(jobIds, policyId)`: it sets `cancelRequestedAt` and
       `cancelReason = 'budget:<policyId>'` and queues `CANCEL`, with a system actor in activity. When the runner
       later reports `CANCELLED` with no reason, the transition uses `cancelReason` as `stateReason`.
  4. Live events and runner notifications collected in the transaction are published after it commits, as
     `PlacementService` does.
- **Sweep:** a `BudgetSweeper` on the `FleetSweeper` pattern (`apps/api/src/fleet/sync/fleet-sweeper.ts:31-39`:
  `setInterval` in `onModuleInit`, gated by `fleetConfig.sweepEnabled`, `unref()`), every 60 s, exposing
  `tick(now)` for tests. It evaluates every policy, deletes policies whose scope row is gone, and clears a
  `calendar_month_utc` pause whose `pausedWindowStart` is before the current window (clear `pausedAt` and
  `pausedWindowStart`, insert a `window_reset` incident; B8).
- Overspend under `runningJobs: finish` is by design: jobs already running finish under their own `--max-cost`.

### 2.3 Enforcement points (slice 2a)

A policy is **effectively paused** when `pausedAt` is set and, for `calendar_month_utc`, `pausedWindowStart`
equals the current window start. A stale monthly pause is therefore not enforced even before the sweep clears it.

- **Dispatch and requeue** (`FleetJobsService.dispatch`, `.requeue`): if an effectively paused policy covers the
  job's global, project or repo scope, or the pinned runner's runner scope, refuse with 409 code
  `fleet.budgetPaused` and `{ policyId, scopeType, scopeId }`.
- **Assignment** (both entry points: `PlacementService.placeJob` and `PlacementService.fillRunner`,
  `apps/api/src/fleet/jobs/placement.service.ts:68,107`): a shared pre-assign check, run before the private
  `assign()`, inside the placement transaction:
  - a QUEUED job whose global, project or repo scope is effectively paused is **cancelled**
    (`stateReason = 'budget:<policyId>'`), never assigned. This closes the race with a dispatch that lands just
    after a pause.
  - a runner whose runner-scope policy is effectively paused is not a candidate. `firstMisfit`
    (`placement-rules.ts:75`) gains a `budgetPaused: boolean` input on the runner and returns the new misfit
    `budget_paused`, added to `MisfitReason` (`placement-rules.ts:5`) and `PlacementMisfitDto` but **not** to
    `PERMANENT_MISFITS` (it clears on resume). A QUEUED job pinned to that runner is cancelled with the reason
    above.
- `--max-cost` per job is unchanged and stays the innermost cap.

### 2.4 Resume and management (API and CLI in 2a; web in 2b)

- Routes, following the `fleet/repos` + `projects/:slug/fleet/repos` pair:
  - `/fleet/budgets` (global ADMIN): CRUD for global and runner policies, and list of all policies.
  - `/projects/:slug/fleet/budgets`: list for any project member (the project's project and repo policies plus
    the global ones, read-only); create, update and delete of project and repo policies for project ADMIN or
    global ADMIN. A repo-scope policy must name a repo of that project.
  - `POST <either prefix>/:id/resume { amountUsd? }` with the same permission as editing that policy.
- **Resume:** optionally set a new amount, then clear the pause, insert a `resumed` incident with `actorId`, and
  write a `FleetActivity` row. 400 `fleet.budgetAmountNotAboveSpend` if the resulting amount is ≤ the current
  window spend. C8 will call the same service method.
- Each list row carries current window spend, warn state and pause state. Deleting a paused policy clears the
  pause. Every mutation writes a `FleetActivity` row.
- CLI (2a): `koda fleet budget list | set | rm | resume`, with `--project` selecting the project routes.
- Web (2b):
  - `/admin/fleet/budgets`: global and runner policies.
  - `/:project/fleet/budgets`: project and repo policies (read for members, edit for project ADMIN), global
    policies read-only.
  - Each row shows spend against the amount, warn and pause state, refreshed on `fleet_job` notices.
  - A banner on the project's fleet pages when any policy covering the project is effectively paused or past its
    warn threshold, linking to the policy.

### 2.5 Testing

- 2a unit: window start for both kinds, threshold math with decimals, scope resolution per job, the cancel set per
  scope and `runningJobs`, effective-pause rule, debounce coalescing, `warnPercent` DTO defaults.
- 2a integration (real Postgres, `KODA_DB_TESTS=1`): warn fires once per window and again after a raised amount;
  hard stop cancels QUEUED and leaves RUNNING under `finish`, requests cancel under `cancel` and the final
  `stateReason` is `budget:<policyId>`; dispatch and requeue while paused → 409; **both** `placeJob` and
  `fillRunner` cancel a job that slipped in after the pause; paused runner excluded with `budget_paused`; a second
  hard stop after resume-and-raise in the same month; month rollover clears a monthly pause and not a lifetime
  one; resume rejects an amount ≤ spend; requeue carries spend into the window; each scope's permissions on both
  route prefixes.
- 2b web unit: list, edit forms, resume dialog, banner.

## 3. C4 schedules

### 3.1 Model (slice 3a)

```
JobSchedule {
  id, projectId, repoId, name,
  cron            String   // five-field
  timezone        String   // IANA
  feature, ref, profiles String[], maxCostUsd Decimal(12,4), selectorLabels String[], pinnedRunnerId?,
  enabled         Boolean,
  nextFireAt      DateTime,
  lastFiredAt?, lastJobId?,
  lastPassedCount Int @default(0),
  noProgressTicks Int @default(0),
  noProgressLimit Int @default(3),
  disabledReason?: completed | finish_failed | no_progress | owner_lost_access | template_invalid | manual,
  createdById, updatedById, createdAt, updatedAt
}
FleetJob += scheduleId?, coalescedCount Int @default(0), scheduleCountedAt DateTime?
-- partial unique: FleetJob (scheduleId) WHERE state = 'QUEUED'
```

- The template is explicit columns, validated by the dispatch rules (`apps/api/src/fleet/jobs/dispatch-input.ts`).
  The command is always `RUN`.
- The `(scheduleId) WHERE QUEUED` index is a backstop: the existing active `(repoId, feature)` unique index
  (`prisma/migrations/20260930090000_fleet_jobs/migration.sql:152`) already forbids a second active job of the
  feature. It is kept because S1 spec §9.2 names it and it documents the coalescing invariant.
- **Cron library:** add `cron-parser` to `apps/api` for parsing and next-fire computation with an IANA timezone
  (DST handled by the library). Validation: five fields; timezone accepted by `Intl.DateTimeFormat`; then iterate
  the next 100 fires from now and reject (400 `fleet.scheduleCronTooFrequent`) if any two consecutive fires are
  less than **15 minutes** apart.

### 3.2 Ticker (slice 3a)

`ScheduleTicker` in `apps/api/src/fleet/schedules/`, on the `FleetSweeper` pattern (`setInterval` in
`onModuleInit`, gated by `fleetConfig.sweepEnabled`, `unref()`), every 60 s, exposing `tick(now)` for tests:

1. Load enabled schedules with `nextFireAt <= now`.
2. Claim each by compare-and-set: `UPDATE ... SET nextFireAt = <next fire after now>, lastFiredAt = now WHERE id
   = ? AND nextFireAt = <loaded value>`. Zero rows → another tick has it; skip. Missed fires while the API was
   down collapse into one fire.
3. For a claimed schedule:

| State | Action |
|:--|:--|
| the schedule has a `QUEUED` job | `coalescedCount + 1` on it, atomically. No new job. |
| the schedule has an `ASSIGNED`, `RUNNING` or `UPLOADING` job | Skip; `schedule.tick_skipped` activity. |
| the owner (`createdById`) is disabled, or has no DEVELOPER-or-higher role on the project and is not a global ADMIN (`projectRepo.findMembershipRole`) | Disable with `owner_lost_access`. |
| otherwise | Dispatch (step 4). |

4. Dispatch through `FleetJobsService.dispatch`, which gains an optional `scheduleId` input passed through to
   `createJob`, with `actorId = createdById`. Outcomes:

| Outcome | Action |
|:--|:--|
| 201 | Record `lastJobId`. |
| 409 `fleet.budgetPaused` | Skip; stays enabled. |
| 409 active `(repoId, feature)` (a manual job of the feature is active) | Skip; never coalesces into a manual job. |
| 404 repo (`fleet.repos`) | Disable with `template_invalid`. |
| 404 pinned runner (`fleet.runners`) | Disable with `template_invalid`. |
| 422 `FleetDispatchException` (pinned runner permanently misfits) | Disable with `template_invalid`. |
| 400 validation | Disable with `template_invalid`. |
| any other error | Log, skip; stays enabled. |

### 3.3 Auto-disable (slice 3a)

Hooked into `JobTransitionsService.apply` (`apps/api/src/fleet/jobs/job-transitions.service.ts:34-56`), the single
path for runner-reported and server terminal transitions, through a `ScheduleProgressService` it calls in the same
transaction. (`ScheduleProgressService` depends only on repositories, not on `FleetJobsService`, to avoid a DI
cycle.)

Applies when a job with `scheduleId` reaches a terminal state **and** `scheduleCountedAt` is null; it then sets
`scheduleCountedAt`, so a user requeue of a scheduled job that ends again is not counted twice. Rules, in order:

1. `COMPLETED` (finish results in `COMPLETING_RESULTS`) → disable with `completed`.
2. `CANCELLED` (by a user or a budget) → no change to either counter.
3. `progress` null or without a numeric `passed` → no progress.
4. `progress.passed` equals `progress.total` (> 0) and the state is not `COMPLETED` → disable with
   `finish_failed` (every story passed but nax's finish did not open a PR; a human must look).
5. `progress.passed > lastPassedCount` → progress: `noProgressTicks = 0`, `lastPassedCount = progress.passed`.
   This holds for any terminal state, including `FAILED` and `CRASHED`.
6. Otherwise → no progress.

No progress → `noProgressTicks + 1`; at `noProgressLimit` disable with `no_progress`. A feature stalled on
`blocked` or `paused` stories, a crash loop, or a checkout that keeps failing (`checkout: branch diverged`) all
end here.

Every auto-disable writes a `FleetActivity` row and dispatches the `fleet.schedule.disabled` webhook (§4).
Re-enabling resets `noProgressTicks`, `disabledReason` and recomputes `nextFireAt` from now; it keeps
`lastPassedCount`.

### 3.4 API, CLI and web

- Permissions: create needs project DEVELOPER or higher (as dispatch); edit, enable, disable and delete need the
  owner or a project ADMIN; any project member reads.
- API (3a): `/projects/:slug/fleet/schedules` CRUD plus `POST .../:id/enable` and `.../:id/disable`.
- CLI (3a): `koda fleet schedule list | show | add | edit | rm | enable | disable`.
- Web (3b):
  - `/:project/fleet/schedules`: name, repo and feature, cron in its timezone, next fire, enabled or disabled
    reason.
  - Schedule detail: the template, and the tick history (each job with state, stories passed delta, cost,
    `coalescedCount`, `wipPush` and `stateReason`, linking to the job page), plus cumulative cost. Refreshed on
    `fleet_job` notices.

### 3.5 Testing

- 3a unit: cron validation and the 15-minute gap, timezone and DST next-fire, missed-fire collapse, the fire and
  dispatch-outcome tables, every auto-disable rule in order including null progress and the counted-once guard.
- 3a integration (real Postgres, `tick(now)` with a fake clock): the compare-and-set claim fires once under two
  concurrent ticks; coalescing into a QUEUED job; skip while RUNNING; a budget 409 skips without disabling; skip on
  a manual active job; disable on `COMPLETED`, `finish_failed`, after `noProgressLimit` ticks, on owner removal and
  on a deleted repo; a requeued scheduled job is counted once; re-enable resets the counters.
- 3b web unit and E2E (Playwright, `apps/web/tests/e2e/`): create a schedule; trigger a tick through a test-only
  hook or a short cron with the fake clock; the scripted runner (as in
  `apps/web/tests/e2e/fleet-dispatch.e2e.spec.ts`) completes the job; the schedule shows disabled with
  `completed`.

## 4. Cross-cutting

- **Error codes** in 409/400 bodies, next to the existing fleet codes: `fleet.budgetPaused`,
  `fleet.budgetAmountNotAboveSpend`, `fleet.scheduleCronTooFrequent`.
- **i18n:** API messages in `apps/api/src/i18n/{en,zh}`, web strings in `apps/web/i18n/locales/{en,zh}.json`,
  including the `budget_paused` misfit and every `disabledReason`.
- **Webhooks:** `fleet.budget.warn`, `fleet.budget.hard_stop` and `fleet.schedule.disabled` are sent with
  `WebhookDispatcherService.dispatch(projectId, event, payload)`
  (`apps/api/src/webhook/webhook-dispatcher.service.ts:21`) inside the triggering transaction, as tickets do. The
  fleet budget and schedule modules import `WebhookModule`. `projectId` is the policy's `projectId` (project and
  repo scopes) or the schedule's project. Global and runner policy events send no webhook; they show in activity
  and on the admin page.
- **Activity (C5):** `FleetActivity.entityType` gains `budget` and `schedule` (`prisma/schema.prisma` comment).
  Every policy and schedule mutation, resume, rollover, auto-disable, budget cancel and skipped tick writes a row,
  with `projectId` set for project and repo policies and for schedules, so members see them through
  `fleet/activity`. Automatic actions record the responsible user (the schedule owner, or the policy's last
  editor).
- **Migrations:** one per slice that changes the schema. Partial unique indexes are raw SQL in the migration and
  are added to `PARTIAL_UNIQUE_INDEXES` in `apps/api/test/helpers/partial-indexes.ts`, which test setup replays.
- **OpenAPI and CLI client:** regenerated in each slice that adds endpoints.

## 5. Delivery

One plan per slice, one PR each, in order:

| Slice | Content | Depends on |
|:--|:--|:--|
| 1a | WIP push: runner `pushProgress`, `wipPush` field and column, web line (§1.1, §1.3, §1.4) | — |
| 1b | Story list: watcher, protocol, mirror, columns, web checklist (§1.2-§1.4) | — |
| 2a | Budgets backend: model, carried spend, evaluator, sweeper, enforcement, cancel reason, API, CLI (§2.1-§2.4) | — |
| 2b | Budgets web: admin and project pages, banner (§2.4) | 2a |
| 3a | Schedules backend: model, cron, ticker, dispatch outcomes, auto-disable, API, CLI (§3.1-§3.4) | 1a, 2a |
| 3b | Schedules web and E2E (§3.4, §3.5) | 3a |

1a, 1b and 2a are independent and can be planned in any order; the plans are written in table order.

The S1 two-machine live check (`docs/deployment/runner.md`, "Live check") is still pending a koda deployment and
the GitHub App. When it runs after 1a, it also covers a WIP push on one machine continued on the other.
