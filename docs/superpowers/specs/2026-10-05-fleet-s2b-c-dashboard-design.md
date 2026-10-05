# Fleet S2b (c) — Fleet Dashboard — Design

Builds the second S2b sub-project of the fleet plan: design doc §3 (c), "fleet dashboard". S2b order (ruling A1 of
the (d) analytics spec): (d) analytics (done, #210 #213 #214), **(c) dashboard (this document)**, (j) story DAG view,
C9 ticket work products. (d) ruling A3: "(c) owns live fleet health and links to the Analytics page".

## Goal

One screen answers "is my fleet healthy and what is it doing right now": which machines are up, which credentials
are broken, what is running, how far along it is and what it costs, what is stuck or needs a human, and what just
finished. An operator spots a stalled job, a dead runner or a broken credential without opening job pages or the
admin Runners page.

## Success criteria

1. A global admin opens the admin fleet overview and sees every runner, every active job across all projects, jobs
   finished in the last 24 h, and a ranked "needs attention" list, refreshed every 10 s while the tab is visible.
2. A project member opens the project fleet overview and sees the same layout limited to that project's jobs, with
   runner health but no credential or version detail.
3. Four attention signals are raised (§2): a job whose nax heartbeat stalled (or that never started), a job waiting
   on an approval, a queued job that is not being placed (with the reasons), and an unhealthy runner (offline,
   credential unavailable, stale nax version).
4. A job whose nax heartbeat stalls on a healthy runner is flagged within `FLEET_JOB_SILENT_SEC` (120 s). The
   sweeper never crashes such a job (it only reacts to runner silence), so the dashboard is the only place it shows.
5. `koda fleet status [--project <slug>] [--json]` prints the same counts and attention list in a terminal.
6. No change to the runner, the runner protocol, the sync path or the database schema.

## Rulings (user, 2026-10-05)

| # | Ruling |
|---|---|
| B1 | **Both scopes**: a global admin page first, and a per-project view built from the same components, filtered to the project. |
| B2 | **Polling only** (10 s, visible tab), designed so push can be added later. No new SSE stream, no runner-level live event. |
| B3 | Attention signals in v1: **silent job, waiting on approval, queued with no fitting runner, runner problems**. Budget signals are out (budget pages and per-job cost already cover them). |
| B4 | **One server-side snapshot endpoint per scope** (approach A): attention rules are pure server functions, one request per tick. Not client-side composition, not persisted attention state. |
| B5 | Project members see runner online/busy and the misfit reasons for their queued jobs, but **not** credential expiry, nax/daemon versions or raw capabilities (admin-only). |
| B6 | Recent window: terminal jobs finished in the **last 24 h, capped at 20**. |
| B7 | **Keep the stale-nax-version warning.** |
| B8 | Include a small CLI `koda fleet status` (counts + attention list + `--json`) in slice 1. |

Spec review (2026-10-05, two read-only reviewers) corrections folded in: the sweeper clock (§2.1), pinned jobs and
the global scan window in the dry-run (§2.3), offline-runner double reporting (§2.1), ASSIGNED/UPLOADING false
positives (§2.1), scope-leak boundary stated (§1.5), flattened DTO for OpenAPI (§2), agent principals (§1.1).

## Ground truth (verified on main `de5ecc81`)

- `Runner` (`apps/api/prisma/schema.prisma`) has `labels`, `capacity`, `enabled`, `bootId`, `bootedAt`, `lastSeenAt`,
  `daemonVersion` and `capabilities Json` (`RunnerCapabilities`, `packages/fleet-protocol/src/index.ts`). There is
  no stored online/status column.
- Online is computed: `isRunnerOnline(lastSeenAt, now, offlineSec)` in `apps/api/src/fleet/common/runner-online.ts`;
  `FLEET_RUNNER_OFFLINE_SEC` default 90 (`apps/api/src/config/fleet.config.ts`).
- The sweeper (`sync/fleet-sweeper.ts:47-54`, every 30 s) marks RUNNER_HELD jobs CRASHED ("runner silent") when the
  **runner's** `lastSeenAt` is older than `FLEET_JOB_CRASH_SEC` (default 300). It never reads the job's
  `lastHeartbeatAt`, so a hung nax on a syncing runner is never crashed.
- `FleetJob` mirrors runner reports (`sync/event-payloads.ts` `mirror()`): `progress`, `currentStoryId`,
  `currentPhase`, `costSpentUsd`, `lastHeartbeatAt`, `stories` (`FleetJobStory {id, title, status, attempts,
  dependsOn}`, at most 100 entries / 8 KiB, `storiesTruncated`), plus `state`, `stateReason`, `queuedAt`,
  `assignedAt`, `startedAt`, `finishedAt`, `maxCostUsd`, `resultPrUrl`, `runnerId`, `projectId`, `repoId`,
  `feature`, `command`, `pinnedRunnerId`, `profiles`, `selectorLabels`, `bashMode`. States are string constants
  (`common/enums.ts`; sets `ACTIVE_STATES`, `RUNNER_HELD_STATES`, `TERMINAL_STATES` in `jobs/job-state.ts`); money
  is `Decimal` stringified by the repository mapper (`toJob`).
- `heartbeatAt` comes from nax's `status.json` (`apps/runner/src/watcher/status-snapshot.ts:39`).
- `RunnerCredential` = `{providerId, available, stored: {kind: 'api-key'|'oauth', expires?, expired} | null, exec?,
  ambient}`. `available` is nax's verdict and deliberately ignores OAuth access-token expiry; placement follows it.
- Placement (`jobs/placement-rules.ts`, `jobs/placement.service.ts`): `firstMisfit(job, runner, load, now,
  offlineSec)` and `PERMANENT_MISFITS` are pure; `toPlacementJob` is exported; `toLoads` and
  `QUEUED_SCAN_LIMIT = 50` are module-private; the per-runner evaluation is inline in `placeJob`. Non-locking reads
  exist: `findPlacementRunners(ids?)` (no ids = all runners), `findActiveLoads(runnerIds)`, `findRepo(repoId)`;
  `lockRunners` takes `FOR UPDATE` and must not be used here. `budgetPaused` comes from `BudgetGate.snapshot(now)`
  (`runnerPaused(id)`, `match(jobGateKeys(job))`). `fillRunner` runs on every runner sync with free slots and scans
  the globally oldest 50 QUEUED ids (`findQueuedIds`); a pinned job is skipped for any other runner.
- `FleetApproval`: `type` (`budget_override_required | nax_bash_escalate`), `status` (`pending | ...`), nullable
  `jobId`, `requestedAt`; `countPendingByJob(jobIds)` (`approvals/prisma-approval.repository.ts:81`) returns counts
  only.
- Auth conventions: global admin = `@RequiredPermission('ADMIN')` per method; project routes =
  `@Controller('projects/:slug/fleet')` + `@UseGuards(ProjectMembershipGuard)` + `@CurrentProject()` + `@ApiParam`
  slug (the contract spec `fleet-openapi.contract.spec.ts` requires it); sibling project fleet controllers 403 agent
  principals with `assertUser`. Responses use `JsonResponse.Ok(...)`; nested DTOs need `@ApiExtraModels`.
- No `semver` dependency in `apps/api`. nax reports versions like `0.83.3` and canaries like `0.83.3-canary.2`.
- Projects soft-delete (`Project.deletedAt`).
- The only SSE stream is project-scoped; runners are global; jobs are project-scoped.
- Web: admin fleet nav is hard-coded in `layouts/default.vue` (~153-161); project fleet links are sidebar links
  (~215-232), not tabs; `fleetLeaf()` falls through to the job-detail title for unknown paths.
  `useVisiblePolling(task, ms, deps?)` returns `{start, stop, runNow, isActive}` and runs at once when the tab
  becomes visible. `lib/fleet-age.ts` (`ageParts`) formats ages. `RunnerCapabilityChips` takes raw `capabilities`.
  Web strings in `apps/web/i18n/locales/{en,zh}.json`; API strings must go through `apps/api/src/i18n/{en,zh}` (repo
  rule), so the dashboard API returns structured attention data and lets each client word it.
- CLI: fleet commands register in `apps/cli/src/commands/fleet.ts` (`registerFleetX(fleet)`); generated client in
  `apps/cli/src/generated/` (never hand-edited); `ADMIN_TOKEN_HINT` and `ago()` in `fleet-shared.ts`;
  `escapeControls` exported from `fleet-job-logs.ts`; project commands use `withContext({projectSlug})`. No existing
  top-level `fleet status` command.

## Out of scope

- Push / SSE for the dashboard; any new live event type (B2).
- Notifications for new approvals (#208), acknowledge / snooze of attention items, attention history.
- Budget signals (B3) beyond reporting a budget-paused queued job's verdict, the story DAG view (j), C9.
- Fixing the phase column (#206): the dashboard shows what is stored.
- Restyling other fleet pages (UX redesign slice 4).

## 1. Snapshot API (slice 1)

### 1.1 Routes

| Route | Guard | Scope |
|---|---|---|
| `GET /fleet/dashboard` | `@RequiredPermission('ADMIN')` (global) | all projects (soft-deleted projects excluded) |
| `GET /projects/:slug/fleet/dashboard` | `ProjectMembershipGuard` + `assertUser` (agents 403) | jobs of that project |

Both call `FleetDashboardService.snapshot(scope, now)` where `scope = {kind: 'global'} | {kind: 'project',
projectId}`. Read-only, no transaction; both keep the global throttle. A new `apps/api/src/fleet/dashboard/` module
holds the controllers, service, repository reads, DTOs and rules.

### 1.2 `FleetDashboardDto`

- `generatedAt` — the single `now` taken **before** the first query; every rule and age uses it (ages err older,
  never fresher than the data).
- `counts` — `{runnersOnline, runnersTotal, queued, running, attention}` computed over the **full** scope (grouped
  counts, not the capped lists); `running` = ASSIGNED + RUNNING + UPLOADING; `attention` = `attention.length`.
- `runners[]` — every runner, ordered by name then id, in both scopes (any runner can take the project's work):
  `id, name, os, arch, labels, enabled, online, lastSeenAt, capacity, activeJobs`. Admin scope adds `naxVersion`,
  `daemonVersion` and `credentials: [{providerId, available, kind, expiresAt, expired}]` (`kind`/`expiresAt` null
  when not stored; a digest — raw `capabilities` are never returned). Project scope returns those three as `null` /
  `[]` (B5). `activeJobs` counts all projects' jobs on the runner in both scopes.
- `activeJobs[]` — QUEUED, ASSIGNED, RUNNING, UPLOADING jobs in scope, ordered `queuedAt`, then `id`, capped at
  **200** (`activeTruncated`): `id, projectSlug, repo ("owner/name"), feature, command, state, runnerId, runnerName,
  currentStoryId, currentPhase, storiesDone, storiesTotal, costSpentUsd, maxCostUsd, queuedAt, startedAt,
  lastHeartbeatAt, pendingApprovals`. `storiesDone` = stories with `status === 'passed'`, `storiesTotal` = stories
  length; both null when `stories` is null or `storiesTruncated`. Money is a decimal string from the repository
  mapper (never a Prisma `Decimal`).
- `recentJobs[]` — terminal jobs with `finishedAt` within the last 24 h, ordered `finishedAt` desc, then `id`, capped
  at **20** (`recentTruncated`) (B6): `id, projectSlug, repo, feature, command, state, stateReason, runnerName,
  costSpentUsd, startedAt, finishedAt, resultPrUrl`.
- `attention[]` — §2 items, ordered `severity` (error first), then `since` ascending (null last), then `key`.

### 1.3 Reads

New non-locking repository reads in the dashboard module (Prisma, `select` only what the DTO needs):

1. all runners (the `findPlacementRunners()` columns plus `os, arch, daemonVersion`);
2. active jobs in scope with repo owner/name, project slug, runner name (`project.deletedAt: null`);
3. per-runner held-job counts and repo ids across **all** projects (reuse `findActiveLoads`);
4. recent jobs in scope (`finishedAt >= now - 24h`, take 21 to set `recentTruncated`);
5. grouped counts per state in scope;
6. pending approvals per job: new `pendingSummaryByJob(jobIds)` → `{jobId, count, oldestRequestedAt}` (`status =
   'pending'`, `jobId IN (...)`);
7. the dry-run inputs (§2.3): the globally oldest 50 QUEUED jobs as full rows (new `findQueuedForDryRun(limit)`,
   same order as `findQueuedIds`), their repos, and `BudgetGate.snapshot(now)`.

### 1.4 Degradation

- Each runner's stored `capabilities` is re-read through `parseCapabilitiesCore` inside a try/catch; on failure the
  runner gets `naxVersion: null`, an empty credential digest, and is left out of the dry-run and the runner rules
  except `offline` (it shows "capabilities unknown"). The snapshot never fails because of one runner.
- A job whose runner no longer exists shows `runnerName: null`.
- Unknown slug: 404; not a member: 403; agent principal on the project route: 403.

### 1.5 Scope boundary (B5)

The project scope may reveal, about other projects, only: per-runner `activeJobs` counts, `jobsHeld` counts, and
the reason codes `capacity`, `busy_repo` and `budget_paused`. It never reveals another project's job ids,
features, repos, project slugs, nor any credential provider name, `expiresAt` or version.

## 2. Attention rules (slice 1)

Pure functions in `apps/api/src/fleet/dashboard/attention-rules.ts`, each `(input, now, config) => AttentionItem[]`.
The DTO is **flat** (one class with optional per-kind fields) so nest-swagger, `openapi.json` and the generated CLI
client stay simple; nested `AttentionReasonDto` and `RunnerConditionDto` are registered with `@ApiExtraModels`.

```
AttentionItem = {
  key: string                   // `${kind}:${subjectId}`, stable across polls
  kind: 'job_silent' | 'job_waiting_approval' | 'job_unplaceable' | 'runner_unhealthy'
  severity: 'error' | 'warning'
  subjectType: 'job' | 'runner'
  subjectId: string
  subjectName: string           // job: feature; runner: name
  projectSlug: string | null    // null for runner items
  since: string | null          // ISO; when the condition started; null = unknown
  // job_silent
  stage?: 'starting' | 'running'
  silentSec?: number
  runnerName?: string | null
  // job_waiting_approval
  pending?: number
  oldestSec?: number
  // job_unplaceable
  verdict?: 'never' | 'pinned_missing' | 'budget_paused' | 'waiting_capacity' | 'no_fit' | 'no_runners' | 'fits_not_placed'
  reasons?: Array<{ runnerName: string, reason: MisfitReason }>   // at most 20
  reasonsTotal?: number
  // runner_unhealthy
  conditions?: Array<{
    type: 'offline' | 'credential' | 'stale_nax' | 'configuration',
    jobsHeld?: number,                                      // offline
    providerId?: string, why?: 'unavailable' | 'expired',   // credential (admin scope only)
    version?: string, latest?: string                       // stale_nax (admin scope only)
  }>
}
```

The API returns no prose. The wording examples below are the intended English; the web renders them from
`apps/web/i18n/locales/{en,zh}.json`, the CLI formats them itself.

New config keys in `fleet.config.ts` (fields in `IFleetConfig`, `@IsOptional() @IsString()` entries in
`FleetConfigSchema`, `int(...)` defaults like the others; the shared test literal
`common/test-helpers/fleet-config.ts` gains them too):

| Key | Default | Meaning |
|---|---|---|
| `FLEET_JOB_SILENT_SEC` | 120 | RUNNING job heartbeat age before a warning |
| `FLEET_JOB_SILENT_ERROR_SEC` | 600 | heartbeat age before the warning becomes an error (read as `max(error, silent)`) |
| `FLEET_JOB_START_SEC` | 300 | ASSIGNED job age (since `assignedAt`) before a "not started" warning |
| `FLEET_JOB_QUEUED_WARN_SEC` | 60 | QUEUED job age before the dry-run reports it |

No cross-field validation is added; `max(...)` keeps the thresholds ordered.

### 2.1 `job_silent`

Evaluated only for jobs whose runner exists and is **online** (an offline runner's jobs are reported once, on the
runner item, via `jobsHeld` — no double reporting):

- `RUNNING`: age = `now - (lastHeartbeatAt ?? startedAt ?? assignedAt)`. Age > `jobSilentSec` → `warning`; age >
  `jobSilentErrorSec` → `error`. `stage: 'running'`. Wording: `No heartbeat for 3m 10s on wk-mac`.
- `ASSIGNED`: age = `now - assignedAt` > `jobStartSec` → `warning`, `stage: 'starting'`. Wording: `Assigned to
  wk-mac 6m ago, not started`.
- `UPLOADING`: not evaluated (nax has exited; a stuck upload on a silent runner is the runner item and the sweeper).

`since` = the timestamp the age is measured from. The plan must measure nax's actual `status.json` heartbeat cadence
(including during long phases, see #206) and confirm `jobSilentSec` sits well above it; if not, it changes the
default and records why.

### 2.2 `job_waiting_approval`

Active job with at least one pending `FleetApproval` (`jobId` set). Severity `error` (a missed ask auto-denies at
its timeout). `since` = oldest pending `requestedAt`; `pending`, `oldestSec` set. Wording: `2 approvals pending,
oldest 3m`. Link: the project approvals inbox (`/<slug>/fleet/approvals`) in both scopes.

### 2.3 `job_unplaceable`

Input: the globally oldest 50 QUEUED jobs (the same window `fillRunner` scans), evaluated in the global context and
then filtered to the scope. Jobs younger than `jobQueuedWarnSec` produce nothing. Per job, in order:

1. The job's own scope is budget-paused (`pauses.match(jobGateKeys(job))`) → verdict `budget_paused`, `warning`
   (placement will cancel it). Wording: `Budget paused; this job will be cancelled`.
2. Candidate runners: the pinned runner only when `pinnedRunnerId` is set (missing → verdict `pinned_missing`,
   `error`, wording `Pinned runner no longer exists`); otherwise every runner with readable capabilities. Zero
   candidates → verdict `no_runners`, `error`, wording `No runners enrolled`.
3. Evaluate the candidates with the shared `evaluateRunners` (below). If any runner fits → verdict
   `fits_not_placed`, `warning`, wording `A runner fits but the job has not been placed` (placement runs on every
   runner sync, so this means placement is not reaching it, e.g. a stuck runner sync).
4. Otherwise, from the misfit reasons:
   - all in `PERMANENT_MISFITS` → `never`, `error`: `No runner can ever run this: ...`;
   - all `capacity` or `busy_repo` → `waiting_capacity`, `warning`: `Waiting for a free runner` (normal queuing);
   - all `budget_paused` → `budget_paused`, `warning`: `All fitting runners are budget-paused`;
   - otherwise → `no_fit`, `warning`: `No runner fits: wk-mac offline, linux-1 lacks a provider credential`
     (any mix, e.g. disabled + offline).

`reasons` = the first 20 candidates by name, `reasonsTotal` = all candidates. `since` = `queuedAt`. QUEUED jobs
beyond the 50 window are not evaluated: placement itself does not reach them either, so this matches placement
exactly (a documented limit at home-fleet scale; `counts.queued` still counts them).

**Shared evaluation, extracted, not copied:** `placement-rules.ts` gains

```
evaluateRunners(job: PlacementJob, runners: readonly PlacementRunner[], loads: ReadonlyMap<string, RunnerLoad>,
                runnerPaused: (runnerId: string) => boolean, now: Date, offlineSec: number)
  => Array<{ runner: PlacementRunner; load: RunnerLoad; reason: MisfitReason | null }>
```

and `toLoads` and `QUEUED_SCAN_LIMIT` move there and are exported. `PlacementService.placeJob` is refactored to call
`evaluateRunners` (behaviour unchanged; its existing tests stay green); `fillRunner` keeps its single-runner
`firstMisfit` call.

### 2.4 `runner_unhealthy`

One item per runner with at least one condition; `severity` = the worst condition; `conditions` lists all:

| Condition | Severity | Scope |
|---|---|---|
| `offline`: enabled and not online; `jobsHeld` = its ASSIGNED/RUNNING/UPLOADING jobs (all projects) | `warning`; `error` if `jobsHeld > 0` | both |
| `credential`: a provider listed in the runner's own `capabilities.profiles[*].providers` has `available: false` (`why: 'unavailable'`), or any `api-key` credential has `stored.expired` (`why: 'expired'`) | `warning`; `error` if a global dry-run reason on this runner is `provider_unavailable` or `provider_missing` | admin |
| `stale_nax`: nax version below the highest version among **online** runners with parsable versions | `warning` | admin |

- Only the runner's reported `profiles` are checked (repo-provided profiles are unknowable before clone, matching
  `capabilityMisfit`). A runner with no profiles and an unavailable credential raises nothing.
- OAuth `stored.expires` / `expired` are **ignored** (access tokens refresh; consistent with placement).
- Version compare: numeric `major.minor.patch` of the core version; a prerelease suffix is ignored (a canary of the
  same core is not stale); an unparsable version is unknown and is neither flagged nor used as `latest`. One online
  runner can never be stale. `latest` = the highest online core version.
- Disabled runners raise no item; runners with unreadable capabilities only get the `offline` condition.
- `since`: `lastSeenAt` for offline; `null` otherwise (the snapshot cannot know when a credential broke).
- Project scope (B5): `credential` and `stale_nax` collapse into one `{type: 'configuration'}` (wording `Runner
  wk-mac has a configuration problem`), severity `warning` (the error escalation is admin-only).

## 3. CLI (slice 1)

`koda fleet status [--project <slug>] [--json]` in `apps/cli/src/commands/fleet-status.ts`, registered via
`registerFleetStatus(fleet)` in `fleet.ts`. Without `--project`: the admin route, with
`handleApiError(err, {forbiddenHint: ADMIN_TOKEN_HINT})`. With `--project`: the project route through
`withContext({projectSlug})`. Human output: one counts line (`runners 2/3 online · queued 1 · running 2 · attention
3`), then one line per attention item (severity, age via `ago()`, English wording built from the item fields,
project slug), or `All clear`. `--json` prints the DTO unchanged. Exit code 0 regardless of attention (a report,
not a gate). Names in the output pass through `escapeControls`.

## 4. Web (slice 2)

### 4.1 Pages and data

- `pages/admin/fleet/index.vue` — admin overview; first link in the admin fleet nav (`layouts/default.vue`).
- `pages/[project]/fleet/overview.vue` — project overview; a sidebar link above Jobs; `fleetLeaf()` gains an
  `overview` case.
- `composables/useFleetDashboard.ts(scope)` returns `{data, error, pending, lastSuccessAt, refresh}`; polls every
  10 s with `useVisiblePolling` (`start` in `onMounted`, `stop` in `onBeforeUnmount`; it refetches on becoming
  visible).
- Pure logic in `lib/fleet-dashboard.ts`: attention wording keys and params from item fields, ages from
  `generatedAt` plus a ticking client clock (clamped at 0, formatted with `lib/fleet-age.ts`), stories fraction, cost
  vs max, link targets per scope and kind, row keys (job id / item key).

### 4.2 Components (`components/fleet/dashboard/`, presentational, props only)

- `DashboardTiles` — the counts; each tile scrolls to its section.
- `AttentionList` — server order; links: job items → job page; approval items → project approvals inbox; runner
  items → admin Runners page (admin scope) or plain text (project scope). Empty → "All clear".
- `ActiveRunsTable` — feature, project (admin scope only), repo, runner, story, phase, stories done/total, cost /
  max, heartbeat age. Row → job page. Empty → "No active jobs".
- `RunnerHealthList` — online dot, busy / capacity, last seen; admin scope adds nax version and credential chips (a
  new `CredentialDigestChips`, reusing the `fleet.runners.chip.*` i18n keys and the existing chip styling).
  Empty → "No runners enrolled".
- `RecentRunsList` — state, duration, cost, PR link; footer link to the Analytics page. Empty → "No runs in the last
  24 h".

Styling uses the UX slice 0 tokens; all new strings in en + zh.

### 4.3 Errors

A failed poll keeps the last snapshot with a "stale since HH:MM" banner (client time of the last successful poll)
and keeps polling. 403 on the project route shows the standard no-access state. "Updated Ns ago" derives from
`generatedAt`.

## 5. Testing

- **Unit (API):** every rule in §2: thresholds and the `max(error, silent)` ordering; RUNNING vs ASSIGNED stages;
  UPLOADING never flagged; an offline runner suppresses `job_silent` and carries `jobsHeld`; approval grouping; every
  `job_unplaceable` verdict, including pinned (only the pinned runner evaluated; missing pin), job-scope budget
  pause, `fits_not_placed`, the reasons cap; OAuth expiry ignored, api-key `expired` flagged, credentials checked
  only for the runner's own profiles; version compare (`0.83.10 > 0.83.9`, canary not stale, unparsable ignored,
  single online runner); project-scope collapse to `configuration`; capability degradation; `evaluateRunners`
  parity with the old inline `placeJob` logic (existing placement tests stay green).
- **Scope leak (API):** the project snapshot of project A contains no id, feature, repo or slug of project B
  anywhere (runners, jobs, attention, reasons), and no provider name, `expiresAt` or version.
- **Integration (API, real Postgres):** two projects, several runners and jobs; both snapshots; the 200 / 20 / 24 h
  bounds and truncation flags; counts over the full set; a soft-deleted project excluded; a QUEUED job that
  `placeJob` cannot place gets a matching dry-run verdict on the same fixture; agent principal 403.
- **Contract:** the OpenAPI contract spec covers both routes (slug param) and the new DTOs; `bun run generate`
  regenerates `openapi.json` and the CLI client.
- **CLI:** human output (items and `All clear`), `--json`, admin 403 hint, project route, control-character escaping.
- **Web (Jest):** `lib/fleet-dashboard.ts` and the components under the existing node-env `mountSfc` harness.
- **E2E (Playwright):** a scripted runner **keeps syncing** (stays online) while holding one job RUNNING with a
  stale heartbeat; a second job is QUEUED with an unsatisfiable selector label. The admin overview shows both items;
  the project overview of another project shows neither job. Needs the usual consent for the `koda_e2e` reset at
  execution time.

## 6. Slices

One plan per PR, sequential; slice 2 branches from main after slice 1 merges (it consumes slice 1's DTO and the
regenerated `openapi.json`).

1. **Slice 1 — API + CLI:** `evaluateRunners` extraction, dashboard module (reads, rules, service, both routes),
  config keys, contract + regenerate, CLI `fleet status`, tests, `.nax` context pointers.
2. **Slice 2 — Web + E2E:** composable, lib, components, both pages, navigation and breadcrumbs, i18n, E2E.
