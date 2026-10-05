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
3. Four attention signals are raised (§2): a job with no heartbeat, a job waiting on an approval, a queued job no
   runner fits (with the reasons), and an unhealthy runner (offline, credential unavailable, stale nax version).
4. A silent job is flagged before the sweeper marks it CRASHED.
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

## Ground truth (verified on main `de5ecc81`)

- `Runner` (`apps/api/prisma/schema.prisma`) has `labels`, `capacity`, `enabled`, `bootId`, `bootedAt`, `lastSeenAt`,
  `daemonVersion` and `capabilities Json` (`RunnerCapabilities`, `packages/fleet-protocol/src/index.ts`). There is
  no stored online/status column.
- Online is computed: `isRunnerOnline(lastSeenAt, now, offlineSec)` in `apps/api/src/fleet/common/runner-online.ts`;
  `FLEET_RUNNER_OFFLINE_SEC` default 90 (`apps/api/src/config/fleet.config.ts`).
- The sweeper (`sync/fleet-sweeper.ts`, every 30 s) marks RUNNER_HELD jobs CRASHED ("runner silent") once the
  runner is silent for `FLEET_JOB_CRASH_SEC` (default 300). It never changes a runner.
- `FleetJob` mirrors runner reports (`sync/event-payloads.ts` `mirror()`): `progress`, `currentStoryId`,
  `currentPhase`, `costSpentUsd`, `lastHeartbeatAt`, `stories` (per-story status, at most 100 entries / 8 KiB),
  plus `state`, `stateReason`, `queuedAt`, `assignedAt`, `startedAt`, `finishedAt`, `maxCostUsd`, `resultPrUrl`,
  `runnerId`, `projectId`, `repoId`, `feature`, `command`. Indexes include `[state]` and `[runnerId, state]`.
- `heartbeatAt` comes from nax's `status.json` (`apps/runner/src/watcher/status-snapshot.ts:39`), not from the
  runner's own sync cadence.
- `RunnerCredential` = `{providerId, available, stored: {kind: 'api-key'|'oauth', expires?, expired} | null, exec?,
  ambient}`. `available` is nax's verdict and deliberately ignores OAuth access-token expiry; placement follows it.
- Placement rules are pure: `firstMisfit(job, runner, load, now, offlineSec)` and `PERMANENT_MISFITS` in
  `apps/api/src/fleet/jobs/placement-rules.ts`. `PlacementService` (`jobs/placement.service.ts`) computes misfits
  per dispatch but **does not store them**; it scans at most `QUEUED_SCAN_LIMIT = 50` queued jobs.
- `FleetApproval` has `type` (`budget_override_required | nax_bash_escalate`), `status` (`pending | ...`), nullable
  `jobId`, `requestedAt`, `expiresAt`; index `[projectId, status, requestedAt]`.
- The only SSE stream is project-scoped (`GET /projects/:slug/events`); `fleet_job` notices fire on state
  transitions only. Runners are global; jobs are project-scoped.
- Existing reads: `GET /fleet/runners` (global ADMIN, full `RunnerDto`); `GET /projects/:slug/fleet/runners`
  (member, `RunnerSummaryDto` without capacity, credentials or `lastSeenAt`); `GET /projects/:slug/fleet/jobs`
  (member, single-`state` filter). There is no cross-project jobs read.
- Web: admin fleet pages `pages/admin/fleet/{runners,repos,approvals,budgets,analytics}.vue` (no index page); the
  Runners page polls every 15 s via `useVisiblePolling` (`composables/useVisiblePolling.ts`). Project fleet pages
  live under `pages/[project]/fleet/`; breadcrumbs in `layouts/default.vue` `fleetLeaf()`. Web strings need en + zh
  in `apps/web/i18n/locales/{en,zh}.json`; API strings go through `apps/api/src/i18n/{en,zh}` (repo rule), so the
  dashboard API returns structured attention data and lets each client word it.
- CLI fleet commands live in `apps/cli/src/commands/fleet-*.ts` on the generated OpenAPI client
  (`apps/cli/src/generated/`, never hand-edited); shared helpers in `fleet-shared.ts`.

## Out of scope

- Push / SSE for the dashboard; any new live event type (B2).
- Notifications for new approvals (#208), acknowledge / snooze of attention items, attention history.
- Budget signals (B3), the story DAG view (j), C9 work products.
- Fixing the phase column (#206): the dashboard shows what is stored.
- Restyling other fleet pages (UX redesign slice 4).

## 1. Snapshot API (slice 1)

### 1.1 Routes

| Route | Guard | Scope |
|---|---|---|
| `GET /fleet/dashboard` | `@RequiredPermission('ADMIN')` (global) | all projects |
| `GET /projects/:slug/fleet/dashboard` | `ProjectMembershipGuard` | jobs of that project |

Both call `FleetDashboardService.snapshot(scope, now)` where `scope = {kind: 'global'} | {kind: 'project',
projectId}`. Read-only, no transaction; both keep the global throttle. A new `apps/api/src/fleet/dashboard/` module
holds the controller(s), service, repository reads, DTOs and rules.

### 1.2 `FleetDashboardDto`

- `generatedAt` — server time, taken **before** the first query (ages err older, never fresher than the data).
- `counts` — `{runnersOnline, runnersTotal, queued, running, attention}`; `running` = ASSIGNED + RUNNING +
  UPLOADING.
- `runners[]` — every runner, ordered by name, in both scopes (any runner can take the project's work):
  `id, name, os, arch, labels, enabled, online, lastSeenAt, capacity, activeJobs`. Admin scope adds `naxVersion`,
  `daemonVersion` and `credentials: [{providerId, available, kind, expiresAt?, expired}]` (a digest; raw
  `capabilities` are never returned). Project scope omits those three fields (B5). `activeJobs` counts all
  projects' jobs on the runner in both scopes (a busy runner is busy for everyone); job identities of other
  projects are not exposed.
- `activeJobs[]` — QUEUED, ASSIGNED, RUNNING, UPLOADING jobs in scope, oldest `queuedAt` first, capped at **200**
  (`activeTruncated: true` beyond): `id, projectSlug, repo (owner/name), feature, command, state, runnerId,
  runnerName, currentStoryId, currentPhase, storiesDone, storiesTotal, costSpentUsd, maxCostUsd, queuedAt,
  startedAt, lastHeartbeatAt, pendingApprovals`. `storiesDone/Total` derive from `stories` (null when absent).
  Money is a decimal string, as elsewhere in fleet DTOs.
- `recentJobs[]` — terminal jobs (COMPLETED, FAILED, ESCALATED, CRASHED, CANCELLED) with `finishedAt` within the
  last 24 h, newest first, capped at **20** (B6): `id, projectSlug, repo, feature, command, state, stateReason,
  runnerName, costSpentUsd, startedAt, finishedAt, resultPrUrl`.
- `attention[]` — §2 items, ordered errors first, then oldest `since` first.

### 1.3 Reads

About five queries per snapshot: runners; active jobs in scope (+ repo, project slug, runner name); per-runner
active counts across all projects (`[runnerId, state]` index); recent jobs in scope; pending approval counts and the
oldest `requestedAt` grouped by `jobId` for the active job ids (`status = 'pending'`, `jobId IS NOT NULL`). The
placement dry-run (§2.3) additionally reads the repos of the dry-run jobs and the budget pause snapshot. Everything
else is in memory.

### 1.4 Degradation

- A runner whose `capabilities` fail to read as `RunnerCapabilities` returns an empty credential digest and
  `naxVersion: null`; the snapshot never fails because of one runner. The web shows "capabilities unknown".
- A job whose runner no longer exists shows `runnerName: null`.
- Unknown slug: 404; not a member: 403 (existing guard behaviour).

## 2. Attention rules (slice 1)

Pure functions in `apps/api/src/fleet/dashboard/attention-rules.ts`, each `(input, now, config) => AttentionItem[]`.

```
AttentionItem = {
  key: string            // `${kind}:${subjectId}`, stable across polls
  kind: 'job_silent' | 'job_waiting_approval' | 'job_unplaceable' | 'runner_unhealthy'
  severity: 'error' | 'warning'
  subject: { type: 'job' | 'runner', id: string, name: string }   // job name = feature
  projectSlug: string | null   // null for runner items
  since: string          // ISO; when the condition started (best known)
  detail: AttentionDetail // structured; worded by the web (i18n) and the CLI (English)
}

AttentionDetail =
  | { kind: 'job_silent', runnerName: string | null, silentSec: number }
  | { kind: 'job_waiting_approval', pending: number, oldestSec: number }
  | { kind: 'job_unplaceable', verdict: 'never' | 'waiting_capacity' | 'no_fit' | 'no_runners',
      reasons: Array<{ runnerName: string, reason: MisfitReason }> }
  | { kind: 'runner_unhealthy', conditions: RunnerCondition[] }

RunnerCondition =                       // admin scope
  | { type: 'offline', jobsHeld: number }
  | { type: 'credential', providerId: string, why: 'unavailable' | 'expired' }
  | { type: 'stale_nax', version: string, latest: string }
                                        // project scope: only { type: 'offline', jobsHeld } and { type: 'configuration' }
```

The API returns no prose for attention items. The message examples below show the intended English wording; the
web renders them from `apps/web/i18n/locales/{en,zh}.json`, the CLI formats them itself.

New config keys (in `fleet.config.ts`, validated like the others): `FLEET_JOB_SILENT_SEC` default **120**,
`FLEET_JOB_QUEUED_WARN_SEC` default **60**.

### 2.1 `job_silent`

ASSIGNED, RUNNING or UPLOADING job whose `lastHeartbeatAt` (or `assignedAt` when no heartbeat yet) is older than
`jobSilentSec`. Severity `warning`; `error` once the age reaches `2/3 * jobCrashSec`. `since` = the last heartbeat
(or `assignedAt`). Wording: `No heartbeat for 3m 10s on wk-mac`.

The plan must measure nax's actual `status.json` heartbeat cadence (including during long phases, see #206) and
confirm `jobSilentSec` sits well above it; if not, it changes the default and records why. Config load rejects
`jobSilentSec >= jobCrashSec` (the warning must come before the crash).

### 2.2 `job_waiting_approval`

Active job with at least one pending `FleetApproval` (`jobId` set). Severity `error` (a missed ask auto-denies at
its timeout). `since` = the oldest pending `requestedAt`. Wording: `2 approvals pending, oldest 3m`. The web links
it to the approvals inbox.

### 2.3 `job_unplaceable`

For QUEUED jobs older than `jobQueuedWarnSec`, oldest first, at most 50 (matches `QUEUED_SCAN_LIMIT`): run
`firstMisfit` against every runner with the same inputs `PlacementService` uses (placement job from job + repo,
current loads, budget pause snapshot) but **without locks and without assigning**. If at least one runner fits, no
item (the next placement pass will take it). Otherwise one item:

- all misfits in `PERMANENT_MISFITS` -> verdict `never`, `error`: `No runner can ever run this: ...`;
- all misfits `capacity` or `busy_repo` -> verdict `waiting_capacity`, `warning`: `Waiting for a free runner`
  (normal queuing; never an error);
- otherwise verdict `no_fit`, `warning`: `No runner fits: wk-mac offline, linux-1 lacks a provider credential`.

`reasons` lists every runner's reason; a fleet with zero runners gives verdict `no_runners`, `error`: `No runners
enrolled`. `since` =
`queuedAt`. Reasons are shown in both scopes: they name runners and reason codes, not credential values. The shared
logic that builds a `PlacementJob` and loads must be extracted from `PlacementService` (not copied), so dispatch and
dashboard cannot drift.

### 2.4 `runner_unhealthy`

One item per runner, with the worst applicable condition as `severity` and every condition in `conditions`:

| Condition | Severity |
|---|---|
| enabled and offline | `warning`; `error` if a job is still ASSIGNED/RUNNING/UPLOADING on it |
| a provider needed by one of its `profiles` has `available: false`, or an `api-key` credential has `stored.expired` | `warning`; `error` if a queued job's §2.3 reasons include `provider_unavailable` or `provider_missing` on this runner |
| nax version below the highest version reported by any **online** runner (semver compare, not string) | `warning` |

OAuth `stored.expires` / `expired` are **ignored** (access tokens refresh; consistent with placement). Disabled
runners raise no item (deliberate admin action); the row shows "disabled". `since`: `lastSeenAt` for offline,
`generatedAt` otherwise (the snapshot cannot know when a credential broke).

Project scope (B5): the item is kept, but credential and stale-version conditions collapse into one
`{type: 'configuration'}` — worded `Runner wk-mac has a configuration problem` — with no provider names or versions.

## 3. CLI (slice 1)

`koda fleet status [--project <slug>] [--json]` in `apps/cli/src/commands/fleet-status.ts`, registered with the
other fleet commands. Without `--project` it calls the admin route (admin token hint via `ADMIN_TOKEN_HINT` on 403,
as other admin fleet commands do). Human output: one counts line, then attention items (severity, age, English
wording built from `detail`, project). `--json` prints the DTO unchanged. Exit code 0 regardless of attention (it is a report, not a gate).
Terminal output escapes control characters (`escapeControls`) since the output carries job and runner names.

## 4. Web (slice 2)

### 4.1 Pages and data

- `pages/admin/fleet/index.vue` — admin fleet overview, first entry in the admin fleet navigation.
- `pages/[project]/fleet/overview.vue` — project overview, a tab next to Jobs; breadcrumb via `fleetLeaf()`.
- `composables/useFleetDashboard.ts(scope)` returns `{data, error, pending, refresh}` and polls every 10 s with
  `useVisiblePolling`.
- Pure logic in `lib/fleet-dashboard.ts`: age formatting from `generatedAt` plus a ticking client clock, stories
  fraction, cost vs max, link targets per scope and item kind, row keys.

### 4.2 Components (`components/fleet/dashboard/`, presentational, props only)

- `DashboardTiles` — the counts; each tile scrolls to its section.
- `AttentionList` — server order; links: job item -> job page; approval item -> approvals inbox; runner item ->
  admin Runners page (admin scope only, plain text otherwise). Empty -> "All clear".
- `ActiveRunsTable` — feature, project (admin scope only), repo, runner, story, phase, stories done/total, cost /
  max, heartbeat age (advances between polls). Row -> job page.
- `RunnerHealthList` — online dot, busy / capacity, last seen; admin scope adds nax version and credential chips
  (reuse the `RunnerCapabilityChips` look).
- `RecentRunsList` — state, duration, cost, PR link; footer link to the Analytics page (project or admin).

Styling uses the UX slice 0 tokens (status colours, focus ring). Attention wording is built from `detail` in
`lib/fleet-dashboard.ts` with i18n keys; all new strings in en + zh (`apps/web/i18n/locales/`).

### 4.3 Errors

A failed poll keeps the last snapshot with a "stale since HH:MM" banner and keeps polling. 403 on the project route
shows the standard no-access state. "Updated Ns ago" derives from `generatedAt`.

## 5. Testing

- **Unit (API):** every rule in §2 — thresholds and severity escalation, the `jobSilentSec < jobCrashSec`
  validation, OAuth expiry ignored, api-key `expired` flagged, all-permanent -> error, capacity/busy-only ->
  warning, zero runners, semver comparison (`0.83.10 > 0.83.9`), project-scope detail genericity (no providerId or version in project scope); the scope filter
  never returns other projects' jobs or admin-only runner fields; capability degradation.
- **Integration (API, real Postgres):** two projects, several runners and jobs; assert both snapshots, the
  200 / 20 / 24 h bounds and flags, pending approval grouping, and that dispatch placement and the dry-run agree on
  the same fixture.
- **Contract:** OpenAPI contract spec covers the new DTOs; CLI client regenerated.
- **CLI:** human and `--json` output, 403 admin hint, control-character escaping.
- **Web (Jest):** `lib/fleet-dashboard.ts` and the components under the existing node-env `mountSfc` harness.
- **E2E (Playwright):** a scripted runner holds one job RUNNING with a stale heartbeat; a second job is QUEUED with
  an unsatisfiable selector label. The admin overview shows both attention items; the project overview of the other
  project shows neither job. Needs the usual consent for the `koda_e2e` reset at execution time.

## 6. Slices

One plan per PR, sequential; slice 2 branches from main after slice 1 merges.

1. **Slice 1 — API + CLI:** dashboard module, placement-input extraction, attention rules, both routes, config keys,
  contract, CLI `fleet status`, tests, `.nax`/context doc pointers.
2. **Slice 2 — Web + E2E:** composable, lib, components, both pages, navigation and breadcrumbs, i18n, E2E.
