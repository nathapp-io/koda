# Fleet S2b (d) — Bundle Ingestion, Cost and Quality Analytics — Design

Builds the first S2b sub-project of the fleet plan: design doc §3 (d), "artifact aggregation + analytics". It also
covers the ledger reconciliation that S1b B2 and S2a L3 deferred ("record spend from `status.json` live, then
reconcile with the ledger at ingest", design doc §9.12 C1), and the koda side of #203, #204 and nax#2348, all found
in the first live checks (design doc §9.22).

S2b is split into separate spec -> plan -> build cycles (user ruling 2026-10-04): **(d) analytics (this document)**,
then (c) fleet dashboard, then (j) story DAG view, then C9 ticket work products (S1 spec §9.4). (c) and (j) are out
of scope here.

## Goal

A project member opens koda and sees where fleet money goes and what it buys: spend over time by model, stage,
session role, repo, runner, feature and story, next to run quality (first-pass success, attempts, review outcomes,
finish outcomes, escalation reasons). The data outlives the 30-day bundle retention.

## Success criteria

1. Every uploaded bundle of a terminal job is ingested once, automatically, within a minute of the job ending; a
   re-run never double-counts.
2. A job's cost in koda is never below what nax recorded in its cost ledger: PLAN jobs stop reporting $0 (#203), and
   finish-phase spend is counted (nax#2348).
3. A RUN whose nax finish escalated is shown as ESCALATED with its reason and PR link, even though `status.json`
   omitted the finish result (nax#2348).
4. A COMPLETED RUN that pushed nothing says so on the job page (#204, reporting half).
5. Analytics rows are kept indefinitely; deleting a bundle (retention) never deletes them.
6. The project Analytics page answers "where is the money going" and "what is it buying" for a chosen window; the
   job page shows the same breakdown for one run.
7. Bundles already stored when this ships can be backfilled.

## Rulings (user, 2026-10-04)

| # | Ruling |
|---|---|
| A1 | S2b order: (d) analytics, (c) dashboard, (j) DAG, C9 work products. Each is its own spec cycle. |
| A2 | (d) v1 scope is **cost + run quality** (option B): cost ledger, `metrics.json` per-story results, review-audit, finish-audit. Tool-audit and approval analytics are out (later, if (c) shows a need). |
| A3 | (d) ships **data + API + CLI + one web Analytics page** and a job-page breakdown. (c) owns live fleet health and links to the Analytics page. |
| A4 | Ingested rows are kept **forever, per call**, with an admin delete-on-demand. No rollups until the tables are actually large. |
| A5 | **The server parses the uploaded bundle** (approach 1). The runner and the runner protocol do not change. |
| A6 | A scheduled job corrected COMPLETED -> ESCALATED by ingest does **not** re-run schedule bookkeeping (`judgeEndedJob` already ran at the original end). |
| A7 | Money is **shown rounded to 4 decimal places** everywhere (API strings, CLI, web). Storage keeps full precision; sums are taken over unrounded values and rounded only at the edge. |

## Ground truth (verified on main `6740c6ba`)

- **Bundle build** (`apps/runner/src/bundle/build-bundle.ts:5-41`): the whole job `nax-out/` tree minus
  `prompt-audit`, plus `nax.stdout`, `nax.stderr`, and `plan-logs/*.jsonl` for PLAN; a `bundle-manifest.json`; then
  `tar -czf`. No per-file allowlist.
- **What nax 0.83.2 writes into `nax-out/`** (observed in the 2026-10-04 sandbox jobs):
  - `cost/<runUuid>.jsonl`, `schemaVersion: 8`. One row per model call: `ts`, `runId`, `agentName`, `model`,
    `modelTier`, `profile`, `stage`, `sessionRole`, `featureName`, `storyId`, `callId`, `scopeId`,
    `tokens{input,output,cacheRead,cacheWrite}`, `costUsd`, `estimatedCostUsd`, `exactCostUsd`, `confidence`,
    `pricingSource`, `durationMs`.
  - `metrics.json`: an array of runs; each has `runId`, `feature`, `totalCost`, and `stories[]` with `storyId`,
    `complexity`, `initialComplexity`, `modelTier`, `finalTier`, `modelUsed`, `agentUsed`, `attempts`, `success`,
    `firstPassSuccess`, `cost`, `durationMs`, `startedAt`, `completedAt` and
    `tokens{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens}`.
  - `review-audit/<feature>/<ts>-<session>.json`: one record with `recordId`, `runId`, `storyId`, `reviewer`,
    `passed`, `failOpen`, `result{passed,findings[]}`, `advisoryFindings`, `timestamp`.
  - `finish-audit/<feature>/<naxRunId>.result.json` with `status`, `escalationReason`, `branch`, `headSha`, `url`,
    `rounds[]`; and `last.json` with `branch`, `headSha`, `status`, `prUrl`, `runId`, `finishedAt`.
  - `status.json` (pre-finish values: nax#2348), `usage/`, `tool-audit/`, `approval-audit/`, `runs/`.
  - PLAN jobs: the same `cost/` ledger exists (one row in the observed job: $0.0044 while koda showed $0, #203).
- **Upload** (`apps/api/src/fleet/artifacts/bundle.service.ts:44`): fenced, job RUNNING or UPLOADING, hash-checked;
  creates `FleetJobArtifact` (schema.prisma:863: `jobId`, `leaseEpoch`, `kind='bundle'`, `storageKey`, `sizeBytes`,
  `sha256`, `expiredAt`; unique `(jobId, kind, leaseEpoch)`).
- **Tar reading**: `apps/api/src/fleet/logs/bundle-log-extractor.ts` streams with `tar-stream` 3 (streamx entries:
  advance on `close`, see its comment at line 17).
- **Retention** (`fleet-log-retention.processor.ts`, `@Cron('45 4 * * *')`, `FLEET_LOG_RETENTION_DAYS` default 30)
  deletes bundle files and sets `expiredAt`; job rows, events and cost fields stay.
- **Cost today**: `FleetJob.costSpentUsd` / `costCarriedUsd` (`Decimal(12,4)`), set from `status.json.cost.spent`
  (`apps/runner/src/watcher/status-snapshot.ts:30`); requeue moves spent into carried
  (`fleet-jobs.service.ts:211-213`). Budget spend is computed on demand by summing both over the window
  (`prisma-budget.repository.ts:106-110`); `BudgetEvaluator.evaluateScope(scopeKey)` / `evaluate(policyId)`
  (`budgets/budget-evaluator.ts:69,74`).
- **Job states**: `TERMINAL_STATES` = COMPLETED, FAILED, ESCALATED, CRASHED, CANCELLED (`jobs/job-state.ts:11`);
  `canTransition` has no terminal -> terminal edge, so the correction in §3.2 needs its own guarded path.
- **Schedules**: `judgeEndedJob` (`schedules/schedule-progress-rules.ts:24`) runs once when a job ends.
- **Web**: Nuxt + `shadcn-nuxt` 0.10 + `radix-vue`; no chart library; live events `fleet_job {jobId, state}`
  (`apps/api/src/live/live-event.ts`).

## Out of scope

- (c) fleet dashboard (live runners, active runs, stuck jobs), (j) story DAG, C9 ticket work products.
- Tool-audit, approval-audit, usage-stream and prompt-audit analytics.
- Pushing work stranded on a runner (#204 option 1).
- Fixing nax#2348 itself (nax side); this spec makes koda correct regardless.
- Rollups, caching, or an external analytics store.
- Correcting `costCarriedUsd` of earlier attempts of a requeued job (their ledger detail is still ingested).

## 1. Data model (slice 1a)

All new tables cascade-delete with their `FleetJob`. Context columns (`projectId`, `repoId`, `runnerId`) are copied
in at ingest so analytics never joins `FleetJob` for grouping. Per-call money is `Decimal(14,8)`.

### 1.1 `FleetBundleIngest`

One row per bundle artifact.

| Column | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `artifactId` | String, unique | -> `FleetJobArtifact` |
| `jobId`, `leaseEpoch` | | |
| `status` | String | `pending \| running \| done \| partial \| failed` |
| `parserVersion` | Int | bumped when the parser changes; drives `rerun --all` |
| `attempts` | Int | |
| `nextAttemptAt` | DateTime? | backoff (§2.5) |
| `claimedAt` | DateTime? | stale after 10 min (§2.2) |
| `files` | Json | per-file outcome, e.g. `{"cost":"done:v8","metrics":"done","review":"skipped:v3","finish":"absent"}` |
| `liveCostUsd` | Decimal(14,8)? | job cost for this attempt as reported live, at ingest time |
| `ledgerCostUsd` | Decimal(14,8)? | sum of this bundle's cost ledger |
| `error` | String? | trimmed to 500 chars, secrets masked |
| `ingestedAt` | DateTime? | |
| `createdAt`, `updatedAt` | | |

Index `(status, nextAttemptAt)`.

### 1.2 `FleetCostEvent`

One row per cost-ledger line.

Columns: `id`, `jobId`, `leaseEpoch`, `projectId`, `repoId`, `runnerId?`, `naxRunId`, `at`, `agentName`, `model`,
`modelTier?`, `profile?`, `stage`, `sessionRole?`, `featureName`, `storyId?`, `callId`, `inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheWriteTokens` (Int), `costUsd` Decimal(14,8), `pricingSource?`,
`confidence?`, `durationMs?`.

Unique `(jobId, leaseEpoch, callId)`. Indexes `(projectId, at)`, `(repoId, at)`, `(runnerId, at)`, `(model, at)`.

### 1.3 `FleetStoryResult`

One row per story per attempt, from `metrics.json` (the run whose `runId` matches the job's nax run; others in the
array are ignored).

Columns: `id`, `jobId`, `leaseEpoch`, `projectId`, `repoId`, `featureName`, `storyId`, `complexity?`,
`initialComplexity?`, `modelTier?`, `finalTier?`, `modelUsed?`, `agentUsed?`, `attempts`, `success`,
`firstPassSuccess`, `costUsd` Decimal(14,8), `durationMs?`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `startedAt?`, `completedAt?`.

Unique `(jobId, leaseEpoch, storyId)`. Index `(projectId, completedAt)`.

### 1.4 `FleetReviewResult`

One row per review-audit record.

Columns: `id`, `jobId`, `leaseEpoch`, `projectId`, `storyId?`, `reviewer`, `recordId`, `passed`, `failOpen`,
`findingCount`, `findingsBySeverity` Json (e.g. `{"error":1,"warning":2}`), `advisoryCount`, `at`.

Unique `(jobId, leaseEpoch, recordId)`. Index `(projectId, at)`.

### 1.5 Finish outcome

No new table. Ingest corrects existing `FleetJob` fields (§3.2).

## 2. Ingest pipeline (slice 1a)

### 2.1 Trigger

- `BundleService.upload` creates the `FleetBundleIngest` row (`pending`, `parserVersion` current) **in the same
  transaction** as the `FleetJobArtifact` row. A re-upload for the same `(jobId, leaseEpoch)` resets that row to
  `pending`.
- After commit, an in-process kick schedules an ingest pass. A sweeper (`@Interval(30_000)`, disabled under
  `NODE_ENV=test` unless enabled, the same switch pattern as `FLEET_SWEEP_ENABLED`) picks up anything left `pending`
  with `nextAttemptAt <= now`, and stale `running` claims.

### 2.2 Eligibility and claim

- A row is eligible only when its job is in `TERMINAL_STATES`. Bundles upload during UPLOADING, before the verdict
  state; waiting avoids racing the runner's report (and §3.2's correction).
- Claim one row at a time with `SELECT ... FOR UPDATE SKIP LOCKED`, set `running` + `claimedAt`. A `running` row with
  `claimedAt` older than 10 minutes is re-claimable. One ingest at a time per API process.

### 2.3 Parse

- Stream the tar.gz from `ArtifactStore` through `tar-stream`; never unpack to disk. Reuse the extractor's entry
  handling.
- Read only these entry paths (relative to the bundle root, normalised; anything with `..`, absolute paths or
  symlink/hardlink types is ignored):
  - `nax-out/cost/*.jsonl`
  - `nax-out/metrics.json`
  - `nax-out/review-audit/*/*.json`
  - `nax-out/finish-audit/*/*.result.json` and `nax-out/finish-audit/*/last.json`
  - `nax-out/status.json` (for the nax run id and the finish fallback)
- **Untrusted input.** Every row is validated by the typed field readers in `src/fleet/ingest/parsers/fields.ts`
  (plan D365), chosen by `schemaVersion` (cost ledger: v8; other files: shape-checked). Strings are capped
  (model/profile/stage/role 120 chars, ids 200, reasons 2,000). Numbers must be finite and `>= 0`. Per-file cap
  32 MiB; per-bundle cap 50,000 cost events, 2,000 story rows, 5,000 review rows. Anything over a cap stops that
  file and marks the bundle `partial` with the reason.
- An unknown `schemaVersion` -> that file is `skipped:v<n>`, the others continue, status `partial`.
- A missing file is `absent` (not an error): PLAN bundles have no `metrics.json`, review-audit or finish-audit.

### 2.4 Write

One transaction per bundle: delete this `(jobId, leaseEpoch)`'s existing analytics rows, insert the parsed rows,
apply §3 corrections, set the ingest row `done` or `partial`, `ingestedAt`, `files`, `liveCostUsd`, `ledgerCostUsd`.
Delete-then-insert inside one transaction makes re-ingest idempotent and lets a newer parser change row shapes.
After commit: publish `fleet_job {jobId, state}` (so an open job page refetches) and, when §3.1 raised cost, call
`BudgetEvaluator.evaluateScope` for the job's project, repo and runner scope keys.

### 2.5 Failure and retry

- Corrupt tar, I/O error or a thrown parser bug -> `attempts++`, back to `pending` with `nextAttemptAt` after 1 m,
  5 m, 30 m, 2 h; after 5 attempts -> `failed`.
- Bundle expired (`FleetJobArtifact.expiredAt` set or the file is missing) -> `failed`, `error = "bundle expired"`, no
  retry.
- A failed ingest never changes the job.

### 2.6 Backfill and re-ingest

- `POST /fleet/ingest/backfill`: create `pending` rows for every unexpired bundle artifact without one.
- `POST /fleet/ingest/jobs/:jobId/rerun`: reset that job's ingest rows to `pending` (attempts 0).
- `POST /fleet/ingest/rerun-outdated`: reset every `done`/`partial`/`failed` row whose `parserVersion` is older than
  the current one and whose bundle is unexpired.
- Each is recorded in `FleetActivity` (`ingest.backfill`, `ingest.rerun`).

## 3. Corrections applied by ingest (slice 1a)

### 3.1 Cost reconciliation

- `ledgerCostUsd` = the sum of this bundle's `FleetCostEvent.costUsd`.
- Only for the job's **latest** attempt (`leaseEpoch` equals the job's current epoch):
  `costSpentUsd = max(costSpentUsd, round4(ledgerCostUsd))`. Raises for finish spend (nax#2348) and PLAN jobs (#203);
  never lowers (the ledger can miss an in-flight session on SIGINT).
- Earlier attempts keep `costCarriedUsd`; their gap stays visible as `liveCostUsd` vs `ledgerCostUsd` on their ingest
  rows.
- If `costSpentUsd` rose, re-evaluate budgets (§2.4). A late warn or hard stop is correct: the money was spent.

### 3.2 Finish outcome

Source: `finish-audit/<feature>/<naxRunId>.result.json`; fallback `last.json` only when its `runId` equals the job's
`naxRunId`. Ignored for PLAN jobs and for runs whose `status.json` `run.status` is not `completed`.

- **Fill empty fields only**: `finishResult` (from `status`), `escalationReason`, `resultPrUrl` (from `url`/`prUrl`),
  `resultBranch` (`branch`), `resultSha` (`headSha`). Fields already set from `status.json` win.
- **One state correction: COMPLETED -> ESCALATED** when the finish status is `escalated`. A dedicated repository
  method updates the row only `WHERE state = 'COMPLETED'` (not through `canTransition`); sets
  `stateReason = "finish escalated (from finish-audit)"`; appends a `FleetJobEvent` (type `state`); writes
  `FleetActivity` `job.verdict_corrected` (actor SYSTEM). Schedule bookkeeping is not re-run (A6). No other state is
  ever changed by ingest.

### 3.3 Nothing pushed

When the job is COMPLETED, the command is RUN, the finish status is absent or `skipped`, and `resultBranch` is still
empty after §3.2: set `stateReason = "completed; nothing pushed (finish disabled or skipped)"` if `stateReason` is
empty. The state stays COMPLETED.

## 4. API and CLI (slice 1b)

Auth matches existing fleet routes: user principal only (agent keys -> 403, as today); project routes need project
membership (any role); admin routes need global ADMIN.

### 4.1 Common rules

- Window: `from`, `to` (ISO, UTC); default the last 30 days; max 366 days -> 400 beyond.
- `bucket`: `day | week | month` (UTC; weeks start Monday); default from the window (<= 31 d day, <= 182 d week,
  else month).
- `groupBy` / `sort` accept only the listed values -> 400 otherwise.
- **Money**: decimal strings with exactly 4 places, rounded half-up from the unrounded SQL sum (A7). Token counts are
  integers. `cacheShare` = cacheRead / (input + cacheRead), 4 places, null when the denominator is 0.
- Time attribution: cost events by `at`; story results by `completedAt`; reviews by `at`; job outcomes by the job's
  `finishedAt`.
- Queries are SQL `GROUP BY` over the indexed columns through a repository; no cache.

### 4.2 Project routes

- `GET /projects/:slug/fleet/analytics/spend?from&to&bucket&groupBy=model|stage|role|repo|runner|feature|story`
  -> `{ window, bucket, totals: {costUsd, tokens, cacheShare, jobs}, series: [{key, points: [{t, costUsd, tokens}]}] }`.
  Each series also carries `label` (repo owner/name, runner name, project slug, else the key), `folded` and its own
  `costUsd`/`tokens`; null dimensions use the key `(none)`; points are zero-filled for every bucket (plan D377, D378).
  Series beyond the top 12 keys by cost are folded into `key: "other"`. Both spend routes also take `top` (1..12,
  default 12: series kept before the fold), and `totals` carries `medianJobCostUsd`, the median of per-job unrounded
  spend in the window (plan D388).
- `GET /projects/:slug/fleet/analytics/quality?from&to&bucket`
  -> `{ firstPassRate, avgAttempts, stories, reviewByReviewer: [{reviewer, runs, passRate, findingsBySeverity}],
  finishOutcomes: {opened, promoted, escalated, skipped, other}, topEscalationReasons: [{reason, count}] (top 10,
  reasons normalised to their first line, 200 chars), firstPassSeries: [{t, rate}] }`. The response also carries
  `window` and `bucket` (plan D382).
- `GET /projects/:slug/fleet/analytics/stories?from&to&sort=cost|attempts&limit<=50`
  -> `{ window, rows }` with rows `{jobId, featureName, storyId, attempts, firstPassSuccess, success, costUsd,
  completedAt, leaseEpoch}`.
- `GET /projects/:slug/fleet/analytics/jobs?from&to&sort=cost&limit<=50`
  -> `{ window, rows }` with rows `{jobId, command, featureName, state, costUsd, ledgerCostUsd, driftUsd, finishedAt}`.
  `costUsd` = spent + carried; `ledgerCostUsd` sums the job's done/partial ingest rows (null before ingest);
  `driftUsd` = ledger - cost (plan D382).
- `GET /projects/:slug/fleet/analytics/ingest?from&to` -> `{ window, pending, failed }`: ingest rows of the
  project's jobs finished in the window; `pending` counts pending and running (plan D388).
- `GET /projects/:slug/fleet/jobs/:id/analytics`
  -> `{ ingest: {status, files, ingestedAt, error}, byStage, byRole, byModel: [{key, costUsd, tokens}], stories:
  [...], reviews: [...], liveCostUsd, ledgerCostUsd, corrected: boolean }`. 404 when the job is not in the project.
  Also `jobId`; `ingest` carries its `leaseEpoch`; slices, stories and reviews span every attempt, ingest and
  live/ledger describe the latest attempt (plan D383).

### 4.3 Admin routes

- `GET /fleet/ingest?status=pending|running|partial|failed&current&size` — ingest rows with job, project, error.
- `POST /fleet/ingest/backfill`, `POST /fleet/ingest/jobs/:jobId/rerun`, `POST /fleet/ingest/rerun-outdated`
  (§2.6) -> `{ queued: n }`. All ingest routes are `RequiredPermission('ADMIN')`.
- Admin analytics routes in slice 1b use `fleet/analytics/...` + `RequiredPermission('ADMIN')`: `GET
  /fleet/analytics/spend` — as 4.2 spend, across projects, `groupBy` also accepts `project` — and `DELETE
  /fleet/analytics?projectId&before` with body `{ confirm: "<projectSlug or 'ALL'>" }`, which deletes
  `FleetCostEvent`, `FleetStoryResult`, `FleetReviewResult` rows (by `at`/`completedAt` < `before`); ingest rows are
  kept and marked `files.deleted = "<before ISO>"`. `projectId` optional (omitted = every project, confirm `ALL`);
  stories with a null `completedAt` match through the job's `finishedAt` (plan D384). Recorded in `FleetActivity`
  (`analytics.deleted`, with counts).

### 4.4 CLI

- `koda fleet analytics spend|quality|stories|jobs [--project <slug>] [--from] [--to] [--bucket] [--group-by] [--sort] [--limit] [--json]`
  (table output prints money with 4 places).
- `koda fleet job analytics <jobId> [--json]`.
- `koda fleet ingest status [--status failed]`, `koda fleet ingest backfill`, `koda fleet ingest rerun <jobId> | --all`.
- The OpenAPI client is regenerated (`bun run generate`), as for every API change.
- `analytics spend --all-projects` uses the admin route; `--sort` exists on `stories` only; there is no CLI delete
  (plan D386).

## 5. Web (slice 2)

### 5.1 Charts

`@unovis/vue` + `@unovis/ts` in two thin client-only wrappers (stacked area, line); bar lists, tiles and tables are
plain HTML (plan D389), themed from the existing CSS tokens, rendered client-only (`*.client.vue`). The 8-slot
categorical palette: the spend chart asks for `top=7`, so at most 7 named series plus "other" (plan D390); light
and dark verified.

### 5.2 Project Analytics page `/<project>/fleet/analytics`

Sidebar: Fleet -> Analytics (all project members).

- Window picker: 7 / 30 / 90 days / custom; bucket follows 4.1's default.
- Summary tiles: total spend, jobs, median cost per job, first-pass rate, escalations.
- Spend over time: stacked area, group selector (model default; stage, role, repo, runner, feature).
- Where it goes: horizontal bars by stage and by role.
- Quality: first-pass rate line, review pass rate per reviewer, finish outcome bars, top escalation reasons list.
- Tables: most expensive stories, most-looping stories (attempts), most expensive jobs; rows link to the job page.
- Ingest notice when the window has pending or failed ingests ("N runs not yet analysed, M failed"); admins get a
  link to 5.3.
- Empty state when there is no data; error states per panel (one failing query does not blank the page).
- Refetch on load, window change and tab focus; no polling.

### 5.3 Admin page `/admin/fleet/analytics`

The same views across projects (`groupBy=project` available), plus the ingest health table (status, job, project,
error, attempts) with **Re-run** per row and **Backfill** / **Re-run all (parser upgrade)** actions. The admin page
shows spend only (tiles, spend over time, where it goes); quality and the top tables are project-only, and
delete-on-demand stays API-only (plan D395).

### 5.4 Job page section "Cost & quality"

Shown once the job has an ingest row:

- Ingest status badge (`pending`, `done`, `partial` with skipped files, `failed` with the error).
- Cost by stage, role and model (compact bars).
- Per-story table: attempts, first-pass, success, cost.
- Review results (reviewer, passed, findings by severity).
- "Outcome corrected from finish-audit" note when §3.2 changed the job; "Live $x / ledger $y" when they differ.
- Refreshes on the job's `fleet_job` live event (already wired on the page).

### 5.5 i18n and access

All strings through the fleet i18n files (the guard rejects `|` and `@`). Tables have header cells and keyboard
reachable links; charts have a text summary (`aria-label` with the totals) and the tables carry the same data.

## 6. Testing

- **Parser units** (slice 1a): fixtures built from the 2026-10-04 sandbox bundles (PLAN, RUN with finish disabled,
  RUN finish escalated, escalate run), scrubbed of paths and ids; plus hostile/malformed cases: corrupt gzip,
  truncated tar, unknown `schemaVersion`, oversized file, over-cap rows, `..`/absolute/symlink entries, non-finite
  numbers, wrong types.
- **Ingest integration** (shadow DB, slice 1a): idempotent re-run (counts unchanged), delete-then-insert on parser
  upgrade, eligibility waits for a terminal state, stale-claim recovery, backoff and `failed` after 5, expired bundle,
  §3.1 max rule (raise and never-lower) with the budget re-evaluation called, §3.2 COMPLETED -> ESCALATED and
  fill-empty-only, §3.3 nothing-pushed reason, cascade delete with the job, retention leaving analytics rows intact.
- **API** (slice 1b): contract/OpenAPI spec, window and enum validation (400s), 4-place money formatting and
  sum-before-round, top-12 fold, membership/admin/agent-key auth, delete-on-demand confirmation and activity.
- **CLI** (slice 1b): command parsing and table/JSON output.
- **Web** (slice 2): unit tests for each panel, empty/error states, window and group selectors, job-page section.
- **E2E** (slice 2): a scripted runner uploads a fixture bundle for a job that ends COMPLETED; ingest runs; the job
  page shows the cost breakdown and the corrected ESCALATED state; the Analytics page shows the expected totals.

## 7. Delivery

One PR per slice, in order:

1. **1a — data model + ingest pipeline + corrections + backfill endpoints** (API only; the admin ingest routes in
   §2.6 ship here so backfill can run on koda-wk right after deploy).
2. **1b — analytics query API + CLI.**
3. **2 — web: Analytics page, admin page, job-page section, E2E.**

After 1a deploys to koda-wk: run backfill and check the 2026-10-04 sandbox jobs (#203 PLAN cost raised; the
finish-escalated `substract` job corrected to ESCALATED with its PR link; the finish-disabled `subtract` job marked
"nothing pushed").
