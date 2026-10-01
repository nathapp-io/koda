# Fleet S1b — Budgets, Schedules and Run Progress — Design

Builds the two items the fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec") deferred to S1b:
C1 budget policies (§9.1) and C4 schedules (§9.2). It also adds two runner changes that schedules need: a
work-in-progress push after every unfinished RUN, and the PRD story list in status snapshots. Where this document
and S1 spec §9.1/§9.2 disagree, this document wins.

## Goal

Make unattended fleet spend safe and useful. A schedule drives one feature to done across many nightly RUNs; a
budget policy caps what any scope (global, project, repo, runner) can spend; the job page shows where the run is
in its plan, story by story, live.

## Success criteria

1. A scheduled RUN of a feature continues where the last tick stopped, on any runner, and the schedule disables
   itself when the feature completes, or after N ticks without progress.
2. A cron tick never creates a second QUEUED job for the same schedule.
3. Once a scope's window spend reaches its policy amount, no new job in that scope is dispatched or assigned, and
   RUNNING jobs follow the policy's `runningJobs` flag.
4. An admin can see why a scope is paused and resume it, raising the amount if needed.
5. The job detail page shows the PRD's stories with live status, the current story and phase, and cost.

## Rulings (user, 2026-10-01)

| # | Ruling |
|:--|:--|
| B1 | Un-pausing in S1b is an **admin resume** (optionally raising the amount). `BudgetIncident.approvalId` stays null until C8 (S1.5), whose `raise_budget_and_resume` decision calls the same service method. |
| B2 | Window spend is **snapshot-only**: the sum of `FleetJob.costSpentUsd`. It is a lower bound (a job that dies between snapshots loses its last interval). Ledger reconciliation at bundle ingest is deferred to S2a. `--max-cost` stays the hard per-job cap. |
| B3 | Policy permissions by scope: `global` and `runner` = global ADMIN; `project` and `repo` = project ADMIN of the owning project, or global ADMIN. Project members read their project's policies and the global ones. |
| B4 | Schedules dispatch **RUN only**, for one fixed feature: a "drive this feature to done" loop. PLAN schedules and PLAN→RUN chains are out of scope. |
| B5 | After **every** RUN that ends without finishing, the runner pushes the feature branch (story commits plus `prd.json`), never opening a PR. Any runner can continue the next RUN. |
| B6 | Status snapshots carry the PRD **story list**; the job page shows it as a live checklist. |
| B7 | Budget hard stops are detected by an **evaluator signalled after snapshot ingest**, debounced per scope, with a 60 s sweep as backstop (approach 1). |
| B8 | A `calendar_month_utc` pause **clears automatically** when the month rolls over. A `lifetime` pause clears only by admin resume. |

Earlier rulings that still hold: R2 (`runningJobs: finish | cancel`, default `finish`), single-instance API
(in-process sweeps and ticker), all runner git traffic brokered (R5).

### Why a RUN schedule works (verified at nax `f441a4ded`, `packages/nax`)

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
- `nax run --schedule` (`bin/nax.ts:236`) only delays one run's start; recurring scheduling belongs to koda.

## Out of scope

- C8 typed approvals and an approvals inbox (S1.5). The `approvalId` column is the seam.
- Ledger cost reconciliation (S2a, with C6).
- PLAN schedules, PLAN→RUN chains, per-tick fresh feature names.
- A general `idempotencyKey` on dispatch; only schedules coalesce.
- Per-story cost.
- A multi-instance ticker or evaluator.
- Counter tables for spend; spend is a `SUM` on demand.

## 1. Runner and protocol (slice 1)

### 1.1 Work-in-progress push

After a RUN job's nax process exits and the runner has its verdict (`apps/runner/src/verdict/run-verdict.ts`):

- **When:** the verdict is not `COMPLETED` (so `FAILED`, `ESCALATED`, or `CANCELLED` after nax exited), and the
  runner still holds the lease. `COMPLETED` already implies nax's finish phase ran and pushed.
- **Never:** on `CRASHED` (the daemon died; READOPT owns that job), after `ABANDON`, or with a lost lease. The git
  broker refuses a stale epoch anyway (S1 spec §6.3).
- **What:**
  1. If `.nax/features/<feature>/prd.json` is dirty, commit **only that file** with message
     `chore(nax): progress of <feature> via koda job <jobId>` and the job's git identity. Uncommitted story code is
     never committed.
  2. `git push origin <branchName>`: plain fast-forward, never forced, through the job's credential helper.
  3. Transient failures retry with `PLAN_PUSH_BACKOFF_MS` (2 s, 8 s; `apps/runner/src/executor/plan-commit.ts`).
     A non-fast-forward rejection is not retried.
- **Result:** a new snapshot field `wipPush`: `pushed`, `none` (nothing new to push) or `failed:<reason>`
  (`failed:diverged` for a non-fast-forward). It never changes the job's verdict.
- **Ordering:** the push happens before `UPLOADING`, so `resultBranch` and `resultSha` point at the pushed commit,
  as for PLAN.
- No PR is opened; that stays with nax's finish phase.

The next RUN of the feature then continues `origin/<branchName>` on any runner (runner design R-3.3, §2 step 4).

### 1.2 Story list in snapshots

- The watcher, on each status poll, reads the checkout's `.nax/features/<feature>/prd.json` and maps each user
  story to `{ id, title, status, attempts, dependsOn }`:
  - `title` clipped to 160 characters (surrogate-safe, as `status-snapshot.ts` clips).
  - `status` passed through as nax's string (`pending`, `in-progress`, `passed`, `failed`, `skipped`, `blocked`,
    `paused`, `regression-failed`, `decomposed`).
  - `attempts` an integer ≥ 0; `dependsOn` at most 20 ids.
- At most 200 stories; beyond that the list is cut and `storiesTruncated: true` is set.
- Sent only when the stable-JSON hash of the list differs from the last one sent for this job and epoch.
- A missing or unparsable PRD omits the field. It never fails the job.

### 1.3 Protocol and server

- `SnapshotEventPayload` (`packages/fleet-protocol/src/index.ts`) gains optional `stories`, `storiesTruncated`
  and `wipPush`. `FLEET_PROTOCOL_VERSION` stays `1`: the fields are additive and optional, and older runners
  simply omit them.
- The server's snapshot validator (`apps/api/src/fleet/sync/event-payloads.ts`) checks the shapes and caps above
  and rejects an oversize list the same way it rejects other malformed payloads.
- `FleetJob` gains `stories Json?`, `storiesTruncated Boolean @default(false)` and `wipPush String?`. They go out
  on `fleet_job` SSE notices and in `FleetJobDto` like the other live fields.

### 1.4 Web

- The job detail page (`apps/web/pages/[project]/fleet/jobs/[id].vue`) gets a story checklist under
  `FleetJobProgress`: one row per story with a status chip, attempts, and the current story highlighted with its
  `currentPhase`. Live for non-terminal jobs via the existing `onFleetJob` path. Without `stories` the page shows
  counts only, as today.
- `wipPush` shows next to the result branch: pushed, nothing to push, or the failure reason.

### 1.5 Testing

- Unit: the push decision for every verdict and lease state; the prd-only commit; each push failure to its
  `wipPush` value; story mapping, clipping, truncation and the hash gate; the server validator for each field.
- Runner integration (real API in process, fake nax, `file://` bare remote): a FAILED RUN and a cost-limit RUN
  both push; a second RUN on a **different** runner starts from the pushed branch and sees the updated
  `prd.json`; a lost lease pushes nothing.
- Web unit: the checklist renders, highlights the current story and falls back without `stories`.

## 2. C1 budgets (slice 2)

### 2.1 Model

```
BudgetPolicy {
  id, scopeType: global | project | repo | runner, scopeId?,
  scopeKey        String   // 'global' or '<scopeType>:<scopeId>'; lets one unique index cover the global row
  windowKind: calendar_month_utc | lifetime,
  amountUsd       Decimal(12,4),
  warnPercent     Int?     // 1-99, null = no warn, default 80
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
-- partial unique: (policyId, kind, windowStart) WHERE kind IN ('warn', 'hard_stop')
```

- `scopeId` references a project, repo or runner by id, with no foreign key (it is polymorphic). A policy whose
  scope row no longer exists is ignored by dispatch, placement and the evaluator, and the 60 s sweep deletes it
  with its incidents.
- `progress.passed` used by §3.3 is nax's `status.json` count (nax `src/execution/status-file.ts:141`).
- **Window start:** `calendar_month_utc` = first instant of the current UTC month; `lifetime` = no lower bound.
- **Window spend:** `SUM(FleetJob.costSpentUsd)` over jobs in scope with `startedAt >= windowStart`. A job counts
  in the window it started in. Scope filters: global = all jobs; project = `projectId`; repo = `repoId`; runner =
  `runnerId`.
- New indexes: `FleetJob (projectId, startedAt)`, `(repoId, startedAt)`, `(runnerId, startedAt)`.
- Known limit: deleting a repo cascades its jobs, so their spend leaves `lifetime` totals.

### 2.2 Evaluator

`BudgetEvaluator` lives in `apps/api/src/fleet/budgets/`.

- **Signal:** after a snapshot that changed `costSpentUsd` commits (`apps/api/src/fleet/sync/job-report.processor.ts`),
  the job's scope keys (global, project, repo, runner) are signalled. Signals are debounced per scope key at
  about 1 s. The sync path itself runs no budget queries.
- **Evaluate one policy**, in one transaction:
  1. Compute window spend.
  2. **Warn:** `warnPercent` set and spend ≥ `amountUsd × warnPercent / 100` → insert the `warn` incident (the
     partial unique makes it once per window) and record outbox event `fleet.budget.warn`.
  3. **Hard stop:** `hardStop` on, not already paused for this window, spend ≥ `amountUsd` →
     - set `pausedAt = now`, `pausedWindowStart = windowStart`;
     - insert the `hard_stop` incident; record outbox event `fleet.budget.hard_stop`;
     - cancel the scope's `QUEUED` jobs with `stateReason = 'budget: <policyId>'`;
     - if `runningJobs = cancel`, cancel its `ASSIGNED` and `RUNNING` jobs through the existing cancel path
       (`FleetJobsService.cancel` semantics: `CANCEL` command to the runner), same reason.
       For a `runner` policy "in scope" means `runnerId` = that runner.
- **Sweep:** every 60 s (`@Interval`, as `fleet-sweeper.ts`), evaluate every policy. It also clears a
  `calendar_month_utc` pause whose `pausedWindowStart` is before the current window: clear `pausedAt` and
  `pausedWindowStart`, insert a `window_reset` incident (B8).
- Overspend under `runningJobs: finish` is by design: jobs already running finish under their own `--max-cost`.

### 2.3 Enforcement points

- **Dispatch and requeue** (`FleetJobsService.dispatch`, `.requeue`): if a paused policy covers the job's global,
  project or repo scope, or the pinned runner's runner scope, refuse with 409 code `fleet.budgetPaused` and
  `{ policyId, scopeType, scopeId }`.
- **Placement** (`PlacementService.placeJob`):
  - a QUEUED job whose global, project or repo scope is paused is **cancelled** (`stateReason =
    'budget: <policyId>'`), never assigned. This closes the race with a dispatch that lands just after a pause.
  - a runner whose runner-scope policy is paused is not a candidate; its misfit reason is `budget paused`. A job
    pinned to it is cancelled with the same reason.
- `--max-cost` per job is unchanged and stays the innermost cap.

### 2.4 Resume and management

- `POST /fleet/budgets/:id/resume { amountUsd? }`: optionally set a new amount, then clear the pause, insert a
  `resumed` incident with `actorId`, and write a `FleetActivity` row. 400 `fleet.budgetAmountNotAboveSpend` if
  the resulting amount is ≤ the current window spend (the evaluator would pause it again at once). C8 will call
  the same service method.
- CRUD `GET/POST/PATCH/DELETE /fleet/budgets` with per-scope permission checks (B3). `GET` filters by `scopeType`
  and `scopeId` and returns each policy with its current window spend and pause state.
- Deleting a paused policy clears the pause. Every mutation writes a `FleetActivity` row.
- CLI: `koda fleet budget list | set | rm | resume`.
- Web:
  - `/admin/fleet/budgets`: global and runner policies (global ADMIN).
  - `/:project/fleet/budgets`: project and repo policies (read for members, edit for project ADMIN).
  - Each row shows spend against the amount, warn and pause state, refreshed on `fleet_job` notices.
  - A banner on the project's fleet pages when any policy covering the project is paused or past its warn
    threshold, linking to the policy.

### 2.5 Testing

- Unit: window start for both kinds, threshold math with decimals, scope resolution per job, the cancel set per
  scope and `runningJobs`, debounce coalescing.
- Integration (real Postgres, `KODA_DB_TESTS=1`): warn fires once per window; hard stop cancels QUEUED and leaves
  RUNNING under `finish`, cancels RUNNING under `cancel`; dispatch and requeue while paused → 409; placement
  cancels a job that slipped in after the pause; paused runner excluded with its misfit reason; month rollover
  clears a monthly pause and not a lifetime one; resume rejects an amount ≤ spend; each scope's permissions.

## 3. C4 schedules (slice 3)

### 3.1 Model

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
  disabledReason?: completed | no_progress | owner_lost_access | manual,
  createdById, updatedById, createdAt, updatedAt
}
FleetJob += scheduleId?, coalescedCount Int @default(0)
-- partial unique: FleetJob (scheduleId) WHERE state = 'QUEUED'
```

- The template is explicit columns, validated by the dispatch rules (`apps/api/src/fleet/jobs/dispatch-input.ts`).
  The command is always `RUN`.
- Cron: five fields, a valid IANA timezone, and at least **15 minutes** between consecutive fires, checked over
  the next 10 fires; otherwise 400 `fleet.scheduleCronTooFrequent`.

### 3.2 Ticker

`ScheduleTicker` in `apps/api/src/fleet/schedules/`, an `@Interval` every 60 s:

1. Load enabled schedules with `nextFireAt <= now`.
2. Claim each by compare-and-set: `UPDATE ... SET nextFireAt = <next fire after now>, lastFiredAt = now WHERE id
   = ? AND nextFireAt = <loaded value>`. Zero rows → another tick has it; skip. Missed fires while the API was
   down therefore collapse into one fire.
3. For a claimed schedule, take the first matching row:

| Schedule's jobs | Action |
|:--|:--|
| one is `QUEUED` | `coalescedCount + 1` on it, atomically. No new job. |
| one is `ASSIGNED`, `RUNNING` or `UPLOADING` | Skip; write a `schedule.tick_skipped` activity. |
| none active | Dispatch through `FleetJobsService.dispatch` with `requestedById = createdById` and `scheduleId` set. |

4. Dispatch outcomes:
   - 409 `fleet.budgetPaused` → skip the tick; the schedule stays enabled.
   - 409 active `(repoId, feature)` from a manual job → skip.
   - 403 or 404 (owner lost project access, repo removed) → disable with `owner_lost_access`.

The partial unique index backs the first row if two inserts race.

### 3.3 Auto-disable

Evaluated when a scheduled job reaches a terminal state, in the transaction that records it:

- `COMPLETED` (the runner maps finish results `opened`, `promoted`, `already-ready`, `nothing-to-finish` to it,
  `apps/runner/src/verdict/run-verdict.ts:10`) → disable with `completed`.
- Otherwise compare `progress.passed` at the end with `lastPassedCount`:
  - greater → `noProgressTicks = 0`, `lastPassedCount = progress.passed`;
  - not greater → `noProgressTicks + 1`; at `noProgressLimit` disable with `no_progress`.
  This also stops a feature stalled on `blocked` or `paused` stories, whose runs pass nothing.
- `CANCELLED` (by a user or a budget) changes neither counter. `CRASHED` and infrastructure `FAILED` (checkout,
  push) count as no progress, which stops crash loops.
- Every auto-disable writes a `FleetActivity` row and records outbox event `fleet.schedule.disabled`.
- Re-enabling resets `noProgressTicks` and `disabledReason` and recomputes `nextFireAt` from now.

### 3.4 API, CLI and web

- Permissions: create needs project DEVELOPER or higher (as dispatch); edit, enable, disable and delete need the
  owner or a project ADMIN; any project member reads.
- API: `/projects/:slug/fleet/schedules` CRUD plus `POST .../:id/enable` and `.../:id/disable`.
- CLI: `koda fleet schedule list | show | add | edit | rm | enable | disable`.
- Web:
  - `/:project/fleet/schedules`: name, repo and feature, cron in its timezone, next fire, enabled or disabled
    reason.
  - Schedule detail: the template, and the tick history (each job with state, stories passed delta, cost and
    `coalescedCount`, linking to the job page), plus cumulative cost. Live via `fleet_job` notices.

### 3.5 Testing

- Unit: cron validation and the 15-minute gap, timezone and DST next-fire, missed-fire collapse, the fire decision
  table, the auto-disable rules.
- Integration (real Postgres, fake clock): the compare-and-set claim fires once under two concurrent ticks;
  coalescing into a QUEUED job; skip while RUNNING; a budget 409 skips without disabling; disable on
  `COMPLETED`, after `noProgressLimit` ticks without progress, and when the owner is removed from the project;
  re-enable resets the counters.
- E2E (Playwright): create a schedule; a tick dispatches; the scripted runner (as in
  `tests/e2e/fleet-dispatch.e2e.spec.ts`) completes the job; the schedule shows disabled with `completed`.

## 4. Cross-cutting

- **Error codes** in 409/400 bodies, next to the existing fleet codes: `fleet.budgetPaused`,
  `fleet.budgetAmountNotAboveSpend`, `fleet.scheduleCronTooFrequent`.
- **i18n:** API messages in `apps/api/src/i18n/{en,zh}`, web strings in `apps/web/i18n/locales/{en,zh}.json`.
- **Outbox events:** `fleet.budget.warn`, `fleet.budget.hard_stop`, `fleet.schedule.disabled`, delivered to project
  webhooks by the existing fan-out registry. Global and runner policy events go to no project webhook; they show
  in activity and on the admin page.
- **Activity (C5):** every policy and schedule mutation, resume, rollover, auto-disable and skipped tick writes a
  `FleetActivity` row; automatic actions record the responsible user (the schedule owner, or the policy's last
  editor).
- **Migrations:** one per slice. Partial unique indexes are raw SQL in the migration and are also applied by the
  test global setup, as slice 2 of S1 did.
- **OpenAPI and CLI client:** regenerated in each slice that adds endpoints.

## 5. Delivery

One plan per slice, one PR each, in order:

1. Runner and protocol: WIP push, story list, web checklist (§1).
2. C1 budgets (§2).
3. C4 schedules (§3). Depends on 1 (continuation across runners) and 2 (budget 409 handling).

The S1 two-machine live check (`docs/deployment/runner.md`, "Live check") is still pending a koda deployment and
the GitHub App. When it runs after slice 1, it also covers a WIP push on one machine continued on the other.
