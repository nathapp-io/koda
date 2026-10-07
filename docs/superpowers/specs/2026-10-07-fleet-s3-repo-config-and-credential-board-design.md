# Fleet S3 — Repo Config Editing and Credential Board — Design

Builds fleet phase S3 (design doc §5): items (f) context/rules management and (k) config/profile/auth UI. S2b closed
with C9 (design doc §9.29). One spec, one plan (user ruling S3-1).

## Goal

From koda, a project member can read a fleet repo's nax setup (`.nax/` rules, context, config, repo profiles,
constitution), and a DEVELOPER+ can change it without a local checkout: the edit becomes a branch and a PR that a
runner prepares with the real nax toolchain (regenerated agent files, nax validation), so git stays the source of
truth and no broken config reaches a PR. A drift check finds repos whose generated agent files are stale. An admin
board shows, for the whole fleet, which runner can serve which provider and profile, and which credentials are about
to expire.

## Success criteria

1. Any project member opens `/[project]/fleet/repos/[id]/config` and sees the repo's allowlisted `.nax/` files from
   the default branch, read through the forge API with no runner involved.
2. A DEVELOPER+ edits, creates or deletes allowlisted files, reviews a per-file diff, and saves with a PR title; a
   `CONFIG_EDIT` job runs on a runner and ends with a PR whose diff contains the edits plus the regenerated agent
   files.
3. An edit that fails `nax rules lint` or nax config validation ends FAILED (`invalid`) with the nax output, opens
   no PR, and can be reopened in the editor.
4. An edit to a file that changed upstream since it was loaded ends FAILED (`conflict`) naming the files; edits to
   other files never conflict with unrelated upstream commits.
5. A drift check reports which generated files `nax generate` would change, and offers a regenerate PR.
6. `.nax/profiles/*.env` and every non-allowlisted path are never listed, read, written or committed by any S3 path.
7. An admin sees a provider x runner grid and a profile inventory, and an OAuth credential expiring within 7 days
   shows as `expiring` on the board and as a dashboard attention item.
8. No S3 path stores a provider credential in koda.

## Rulings (user, 2026-10-07)

| # | Ruling |
|---|---|
| S3-1 | **One spec** covering both (f)/(k) editing and the credential board (not split into S3a/S3b). |
| S3-2 | **Reads through the API, writes through a runner job** (option 1): the API reads files with the fleet broker's repo-scoped tokens; saving queues a runner job that regenerates, validates, commits, pushes and opens the PR. Supersedes design doc §3 (f)'s runner-only read path. |
| S3-3 | **File allowlist**: `.nax/rules/**/*.md`, `.nax/context.md`, `.nax/mono/**/context.md`, `.nax/config.json`, `.nax/mono/**/config.json`, `.nax/profiles/*.json`, `.nax/constitution.md`. Never `.nax/profiles/*.env` or anything else. Create, edit and delete allowed; multi-file edits in one PR; generated agent files are regenerated, never hand-edited. |
| S3-4 | **Validation failure blocks** (option A): job FAILED, no PR, draft kept for reopening. |
| S3-5 | **Per-file staleness** (option A): each edit carries the blob SHA it was loaded at; only a changed edited file conflicts. |
| S3-6 | **Permissions follow dispatch** (option A): READ for any project member; save, drift check and regenerate need `CREATE FleetJob` (DEVELOPER+); the board is admin-only. |
| S3-7 | **On-demand drift check** (option B): a "Check drift" button queues a read-only job; drift offers a regenerate PR. No scheduled drift check. |
| S3-8 | **Board = grid + profiles + 7-day OAuth expiry warning** (option A), the warning also a dashboard attention item. |

## Ground truth (verified on main `a61c11aa`)

- Job kinds are `RUN | PLAN` only: `FleetJob.command` is a string (`apps/api/prisma/schema.prisma`), mirrored in
  `packages/fleet-protocol/src/index.ts` (`FleetJobKindName`), `apps/api/src/common/enums.ts` (`FleetJobKind`), the
  dispatch DTO `@IsIn(['RUN','PLAN'])` and `apps/api/src/fleet/jobs/dispatch-input.ts`. Web and CLI branch on it.
- Every runner job spawns nax: `apps/runner/src/executor/host-executor.ts` branches on `command === 'PLAN'`;
  `nax-process.ts` builds the argv. `plan-commit.ts` commits an allowlist of files and pushes with back-off; it is the
  template for the config commit.
- Git for runner jobs is brokered: the runner asks for per-job tokens in the sync batch; the API mints a GitHub App
  installation token (`contents:write`, `pull_requests:write`) or serves the stored GitLab project token
  (`apps/api/src/fleet/git-broker/`). The runner's credential broker serves them to `git`, `gh` and `glab`. For RUN
  jobs nax's finish phase opens the PR with `gh`/`glab` on the runner.
- Placement already requires `git` plus `gh` (GitHub) or `glab` (GitLab) for every job
  (`apps/api/src/fleet/jobs/placement-rules.ts:71`), and refuses a second job on the same repo per runner
  (`busy_repo`).
- `FleetJob_active_repo_feature_key` is a partial unique index on `(repoId, feature)` for states QUEUED, ASSIGNED,
  RUNNING, UPLOADING.
- Runners report `RunnerCapabilities` (credentials with `stored.kind`, `expires`, `expired`, `available`; profiles
  with protocol, providers, sandbox, interaction; tools), stored in `Runner.capabilities`. The web already renders
  credential chips (`apps/web/lib/fleet-capabilities.ts`, `RunnerCapabilityChips.vue`) and an admin digest
  (`CredentialDigestChips.vue`); dashboard credential attention covers `missing`, `unavailable`, `expired` only.
- Nothing reads repo `.nax/` files today. The VCS module's contents call is bound to the project `VcsConnection` and
  used only by code-intel.
- nax (0.83.x): `nax rules lint` exits 1 on failure; `nax config --json` and `nax config --profile <p> --json` print
  `{error:{code,message}}` on invalid config (the runner already parses this output, never the exit code);
  `nax generate --dry-run` only previews and does not report staleness; `nax generate --all-packages` covers
  `.nax/mono/`. Repo profiles live at `<repo>/.nax/profiles/<name>.json` (and `.env`).
- `apps/web/components/MarkdownEditor.vue` exists (write/preview over a textarea); there is no code editor dependency.

## Out of scope

- Editing machine-global `~/.nax/` profiles or config (design doc §3 (k): report-only).
- Scheduled drift checks and drift dashboard items.
- Any credential storage or credential editing (C10 stays unscheduled).
- A code editor dependency (CodeMirror/Monaco); JSON is edited in a textarea.
- Editing generated agent files, `.nax/features/`, specs, or any non-allowlisted path.
- Merging PRs from koda; merge stays on the forge.
- Linking config jobs to tickets.

## 1. Data

One migration. No Prisma enums (repo rule); new values are strings.

- `FleetJob.command` gains `CONFIG_EDIT` and `CONFIG_DRIFT`. Config jobs fill the existing required columns with fixed
  values: `feature = 'nax-config'`, `ref = repo.defaultBranch`, `planFrom = null`, `profiles = []`, `maxCostUsd = 0`,
  `bashMode = 'raw'`, `approvalTimeoutSec = 600` (default, unused), `selectorLabels = []`, `pinnedRunnerId = null`.
  The config endpoints build the row themselves and do not go through the dispatch DTO (whose `maxCostUsd` has
  `@Min(0.0001)`). The existing active-job index therefore allows **at most one active config job per repo**; a
  second submit gets 409.
- New snapshot column `FleetJob.configResult Json?` holds the runner's `ConfigJobResult` (§3) as mirrored from
  snapshots; on the terminal state the API copies it into `FleetConfigEdit.result`.
- New table `FleetConfigEdit`, 1:1 with `FleetJob` (`jobId` unique, cascade delete):

| Column | Type | Meaning |
|---|---|---|
| `jobId` | String | the config job |
| `mode` | String | `edit` \| `regenerate` \| `drift` |
| `edits` | Json | `ConfigFileEdit[]`; empty for `regenerate` and `drift` |
| `prTitle` | String? | required for `edit` and `regenerate` |
| `prBody` | String? | optional |
| `baseSha` | String | default-branch commit the editor read |
| `result` | Json? | `ConfigJobResult` once reported |
| `createdAt` | DateTime | |

- `ConfigFileEdit = { path: string; op: 'put' | 'delete'; content?: string; baseSha: string | null }`. `baseSha` is
  the git blob SHA the file was loaded at, or `null` for a file that did not exist. `content` is required for `put`
  and forbidden for `delete`.
- Limits (server-validated): at most 50 edits, 256 KiB per file content, 1 MiB total content, UTF-8 text only (no
  NUL), unique paths, `prTitle` 1..200 chars, `prBody` at most 8 KiB.

## 2. Allowlist (shared)

A single module in `packages/fleet-protocol` (pure, no I/O), imported by the API, the runner and the web:

- `isAllowedNaxPath(path): boolean` accepts exactly the S3-3 set, matched on normalized POSIX repo-relative paths:
  `.nax/rules/**/*.md`, `.nax/context.md`, `.nax/mono/**/context.md`, `.nax/config.json`, `.nax/mono/**/config.json`,
  `.nax/profiles/*.json`, `.nax/constitution.md`.
- Rejects: absolute paths, backslashes, `.`/`..` segments, empty segments, NUL, any `.env` suffix, paths over 512
  chars. Matching is case-sensitive; a path differing from an allowed one only by case is rejected (macOS clones are
  case-insensitive).
- `naxPathGroup(path)`: `rules` | `context` | `config` | `profiles` | `constitution`, for the web tree.

## 3. Runner contract (`packages/fleet-protocol`, protocol v1, additive)

- `FleetJobKindName` gains `CONFIG_EDIT` and `CONFIG_DRIFT`. `AssignPayload` is unchanged in shape; config jobs carry
  the fixed values of §1 (`maxCostUsd = "0"`). It never carries file content. The runner's `parseAssign`
  (`apps/runner/src/supervisor/assign-parser.ts`) accepts the new kinds with `planFrom = null`, `profiles = []` and
  `maxCostUsd = "0"` (the plan checks `COST_RE` accepts `"0"`).
- **Old runners**: a runner that predates S3 rejects an ASSIGN with an unknown command. `RunnerCapabilities` gains
  `configJobs?: true`, reported by S3 runners; placement gives config jobs the permanent misfit `config_jobs` on a
  runner without it.
- New runner-authenticated `GET /fleet/runner/jobs/:jobId/config-edit?leaseEpoch=<n>` returns
  `{ mode, edits, prTitle, prBody, baseSha }`. It follows the bundle-upload pattern (`@RunnerRoute()` controller under
  `fleet/runner/jobs`, `RunnerPrincipal`, lease fence): the caller must hold the job at `leaseEpoch`, the job must be
  ASSIGNED or RUNNING; a fence miss calls `fence.abandon()` and answers 409. The runner fetches it before emitting
  RUNNING. `ServerClient` gains `getConfigEdit(jobId, leaseEpoch)`.
- **Result reporting rides the existing snapshot event** (`JobReport` stays `{ jobId, leaseEpoch, events }`): the
  snapshot payload gains `configResult: ConfigJobResult = { outcome: 'ok' | 'no_changes' | 'drift' | 'conflict' |
  'invalid' | 'push_failed' | 'pr_failed' | 'timeout'; files?: string[]; output?: string }`, `files` at most 50 paths
  of at most 512 chars (conflict files, drifted files, or committed files), `output` a nax output tail of at most 8 KiB
  so the snapshot stays under the 16 KiB event payload cap. `mirror()` (`apps/api/src/fleet/sync/event-payloads.ts`)
  and `FleetJobPatch` validate and store it in `FleetJob.configResult`; invalid shapes are dropped like other bad
  mirror fields. `resultBranch`, `resultSha`, `resultPrUrl` travel in the same snapshot through the existing validated
  mirror fields. The terminal `state` event carries `reason = outcome`, which sets `stateReason` as today.
- **States**: config jobs go ASSIGNED -> RUNNING -> UPLOADING -> COMPLETED | FAILED, with **no bundle upload** in
  UPLOADING (the runner emits UPLOADING then the terminal state directly). This keeps the server and runner transition
  tables unchanged (COMPLETED/FAILED are reachable only from UPLOADING); the plan verifies no server path waits for a
  bundle on a config job. Outcomes `ok`, `no_changes`, `drift` (including an empty file list) -> COMPLETED; every other
  outcome -> FAILED. A failure before RUNNING (fetch or clone) uses the existing ASSIGNED -> FAILED.
- **Liveness**: while RUNNING the runner emits a snapshot with `heartbeatAt` every 30 s, so the dashboard's
  `job_silent` rule and the silence sweep treat config jobs like other jobs.
- **Placement**: `PlacementJob` gains `command`, set by `toPlacementJob` (shared by placement, the dispatch preview and
  the dashboard dry-run). For config kinds `capabilityMisfit` skips everything except `tools` and the new
  `config_jobs` check (no profile, protocol, provider, sandbox, approvals-relay or base-config interaction checks), and
  `firstMisfit` skips `budget_paused` (config jobs spend nothing). `disabled`, `offline`, `executor`, `busy_repo` and
  `capacity` still apply. The runner's nax floor stays 0.83.1; the plan verifies `rules lint`, `generate`,
  `generate --all-packages` and `config --profile --json` behave as in Ground truth on that version.

## 4. API

### 4.1 Reads (READ on the project)

- `GET /projects/:slug/fleet/repos/:repoId/nax-files` -> `{ baseSha, defaultBranch, files: [{ path, size, blobSha, group }] }`,
  only allowlisted paths, sorted by group then path.
- `GET /projects/:slug/fleet/repos/:repoId/nax-files/content?path=&ref=` -> `{ path, blobSha, content }`. `path` must be
  allowlisted (400 otherwise); `ref` defaults to `baseSha` from the list call so content and SHAs are consistent.
  Files over 256 KiB or not valid UTF-8 return 422 and are shown read-only as "too large / binary".
- `FleetRepoFilesReader` interface with `GithubFleetRepoFilesReader` (git trees API at the default-branch commit,
  `recursive=1`, filtered to `.nax/`; blobs API for content) and `GitlabFleetRepoFilesReader` (repository tree
  `path=.nax&recursive=true`, paginated; repository files raw). Auth follows the C9 PR-state refresher: GitHub mints
  with `GitHubAppClient.mintInstallationToken(installationId, repoName)` directly (one mint per request; not through
  `GitTokenBroker.mint`, whose cache is keyed by job and epoch); GitLab uses `GitLabTokenSource.resolve`, i.e. the
  project's `VcsConnection` token, as the git broker does. The new REST calls (trees, blobs, repository tree, raw
  file) are added beside the existing `getPullRequest` / `getMergeRequest` helpers. No caching or storage. A forge
  error maps to 502 with a safe message; a repo whose token cannot be obtained (`vcs_connection_missing`,
  `vcs_connection_mismatch`, `vcs_encryption_key_missing`, no installation id, mint failure) maps to 409
  `repo_unreachable`.

### 4.2 Writes (`CREATE FleetJob` on the project)

- `POST /projects/:slug/fleet/repos/:repoId/config-edits` body `{ baseSha, edits, prTitle, prBody? }` -> `FleetJobDto`.
  Validates §1 limits and §2 allowlist on every path (400 with the offending path), then creates `FleetJob` +
  `FleetConfigEdit(mode=edit)` in one transaction. An empty `edits` is 400 (use regenerate).
- `POST /projects/:slug/fleet/repos/:repoId/config-edits/regenerate` body `{ prTitle, prBody? }` -> `FleetJobDto`
  (`mode=regenerate`, `baseSha` = current default-branch head read at submit).
- `POST /projects/:slug/fleet/repos/:repoId/drift-checks` -> `FleetJobDto` (`mode=drift`).
- All three: 409 `config_job_active` when the active-job index rejects the insert (message names the active job id);
  the repo must belong to the project (404 otherwise). Selector labels and runner pin are not accepted (any fitting
  runner).

### 4.3 Job reads

- `FleetJobDto` gains `configEdit?: { mode, files: string[] (edited paths), prTitle, result }` for config jobs; the
  edit contents are not in the DTO.
- `GET /projects/:slug/fleet/jobs/:id/config-edit` (READ) returns the full edit set, for "Reopen edits".

### 4.4 Credential board (admin)

- `GET /admin/fleet/credential-board` -> `{ generatedAt, runners: [{ id, name, enabled, online }],
  providers: [{ providerId, cells: { [runnerId]: Cell } }], profiles: [{ name, runners: { [runnerId]: ProfileCell } }] }`.
- `Cell = { state: 'ok' | 'expiring' | 'expired' | 'unavailable' | 'missing', kind: 'api-key' | 'oauth' | 'exec' |
  'ambient' | 'none', expires?: string }`. `expiring` = `stored.kind === 'oauth'`, not expired, `expires` within 7
  days of `generatedAt` (`FLEET_CREDENTIAL_EXPIRY_WARN_DAYS`, default 7). `missing` = a provider some runner reports
  that this runner does not.
- `ProfileCell = { present: boolean, needs?: { protocol, providers, sandbox, interaction }, misfit?: MisfitReason }`,
  `misfit` computed with the existing capability rules for that single profile.
- Pure derivation from `Runner.capabilities` (`credential-board.ts`), no new storage.
- Dashboard: `credentialConditions` (`apps/api/src/fleet/dashboard/attention-runners.ts`) today ignores OAuth expiry
  and its `why` is `missing | unavailable | expired`. It gains `why: 'expiring'` (warn), computed by the board's
  function: only for OAuth credentials that are not `expired`, and, like `expired`, also for a provider no profile of
  that runner references. Touch points: `RunnerCondition.why` in `dashboard.types.ts`, the DTO and `openapi.json`, and
  the web condition labels.

## 5. Runner execution

The job lifecycle lives in `apps/runner/src/supervisor/job-run.ts` (repo mutex -> `prepare` -> `spawn` ->
`watchUntilExit` -> `finish`), and `prepare`'s `prepareCheckout` requires a PRD for non-PLAN jobs. Config kinds are
routed in `JobRun.lifecycle` (`if (isConfigKind(command)) return this.runConfig()`), which keeps the repo mutex, log
registration, cleanup and `markDone` but skips `prepare`/`spawn`/`watchUntilExit`/`finish` (no job profile, no
`jobCheck`, no status watcher, no cost ledger, no bundle). `runConfig` delegates to a new `JobExecutor.runConfigJob`
implemented in `apps/runner/src/executor/config-job.ts` (steps split into small modules). The log shipper for a config
job has no `status.json` or nax run log; it ships only the step lines.

1. **Prepare**: fresh job directory under the trusted workspace root; fetch the edit set (§3); emit RUNNING; clone the
   default branch with the git credential broker (`credentials.acquire`, as `finishPlan` does). The broker's `binDir`
   (with the `gh`/`glab` shims) is put first on `PATH` for every later subprocess.
2. **Staleness** (edit mode): for each edit, `git rev-parse HEAD:<path>` must equal `baseSha`; a `null` `baseSha`
   requires the path to be absent; a delete requires the path to exist at `baseSha`. Any mismatch -> `conflict` with
   the files; nothing written.
3. **Apply**: re-check every path with `isAllowedNaxPath`, resolve it inside the clone (realpath of the parent must
   stay inside; existing symlinks are refused), write or delete.
4. **Regenerate**: `nax generate` when `.nax/context.md` exists (root files), then `nax generate --all-packages` when
   any `.nax/mono/*/context.md` exists (package files only; the two calls are complementary). A repo with neither
   skips regeneration.
5. **Drift mode**: `git status --porcelain` -> `drift` with the changed files (empty list allowed); stop.
6. **Validate** (edit, regenerate): `nax rules lint` (non-zero exit = invalid); `nax config --json` (`{error}` =
   invalid); `nax config --profile <name> --json` for each put `.nax/profiles/<name>.json`; for each put
   `.nax/mono/<pkg>/config.json`, the package config is validated the way nax loads it for that package (the plan
   pins the exact command, e.g. `nax config --json -d <pkg dir>`, against nax 0.83.x; if nax has no per-package
   validation entry point, a JSON parse check is used and the limitation is recorded). First failure -> `invalid` with
   the combined output tail. `rules lint` checks the whole repo, so a broken rule the edit did not touch also fails
   the job as `invalid`; the output names the file, and fixing it in the same edit is the remedy.
7. **Commit**: empty `git status --porcelain` -> `no_changes`. Otherwise commit all changes as `gitIdentity` with
   `prTitle` as the message on `nax-config/<jobId>`; push with the `plan-commit.ts` back-off; final failure ->
   `push_failed`.
8. **PR**: `gh pr create` / `glab mr create` against the default branch with `prTitle` and `prBody` (no footer: the
   existing `PrAttributionService` posts its "Dispatched by <name> via koda job <id>" comment on the PR when the job
   ends with a `resultPrUrl` on its own repo, which is the intended attribution for config PRs too). If creation fails
   and a PR for the branch exists, use its URL; otherwise `pr_failed` (branch stays pushed; message says so). Success
   -> `ok` with `resultBranch`, `resultSha`, `resultPrUrl`, `files` = committed paths.
9. **Report**: final snapshot with `configResult` (and result fields), then UPLOADING, then the terminal state with
   `reason = outcome` (§3).

Lifecycle:

- Hard timeout 10 minutes (`RUNNER_CONFIG_JOB_TIMEOUT_MS`), implemented inside the config executor (the runner has no
  generic per-job timeout): on expiry it kills the current subprocess group -> `timeout`.
- Cancel: each subprocess is spawned in its own process group and its pgid is recorded in the job's journal row
  (`pgid`) while it runs, so the existing cancel path (SIGTERM to the recorded pgid) works; the executor then stops
  with state CANCELLED.
- Runner loss: existing silence sweep -> CRASHED; requeue stays manual. Requeue is safe: the branch is per job and
  step 8 reuses an existing PR. A requeued job bumps `leaseEpoch` as today.
- Each step writes one log line through the existing job log stream.
- Only nax `error.message` and lint text are kept; the runner never logs file contents or config values. `.env` paths
  are rejected again in step 3.

## 6. Web

- **Project fleet page**: a Repos card lists the project's fleet repos with a "nax config" link, using the existing
  member-readable `GET /projects/:slug/fleet/repos` (`project-fleet-repos.controller.ts`); no new endpoint.
- **`/[project]/fleet/repos/[id]/config`**:
  - Left: file tree grouped by `naxPathGroup`; "New file" offers only allowed locations (rules dir, a mono package's
    `context.md`/`config.json`, a profile name, missing root files).
  - Right: `MarkdownEditor` for `.md`; a monospace textarea for `.json` with a client `JSON.parse` check that blocks
    save while invalid.
  - Local draft state: modified/new/deleted markers, a "Review changes" panel with a per-file unified diff against the
    loaded content, discard per file or all. The draft lives in page state only.
  - Save: dialog with PR title (required) and description -> submit -> navigate to the job page. "Check drift" ->
    submit -> job page.
  - Users without `CREATE FleetJob` see the page read-only (no save, new, delete, drift).
  - A 409 `config_job_active` shows a link to the active job.
- **Job page, config jobs**: a Config panel replaces stories/cost: mode, edited files, outcome, PR link on `ok`;
  `conflict` and `invalid` show files/output and "Reopen edits" (loads the latest files, re-applies the job's edits,
  flags conflicting files with both versions visible); `drift` shows drifted files and "Open regenerate PR" (dialog
  for title, DEVELOPER+).
- **`/admin/fleet/credentials`**: Grid tab (providers x runners, existing chip tones and kinds, expiry date; disabled
  or offline runners dimmed) and Profiles tab (profile x runners, needs, misfit reason). Linked from the runners page
  and the dashboard credential digest.
- Job list and dispatch-view filters know the two new kinds (labels "Config edit", "Drift check"). The dispatch form
  does not offer them (they start from the config page).
- **Other fleet surfaces**: fleet analytics (`analytics.domain.ts`) excludes config kinds from job counts, success
  rates and cost panels (they are not agent runs). Ticket effects need no change (config jobs have no linked tickets,
  so failure comments and PR links are no-ops). Budgets count their $0 cost as nothing. Strings under `fleet.config.*` and `fleet.credentials.*` in both `en` and `zh` web locales; new API error messages go through the API i18n files (`en`, `zh`).

## 7. CLI

Regenerated from `openapi.json`. New commands: `koda fleet nax-files <repo>`, `koda fleet drift-check <repo>`. Config
edits from the CLI are out of scope (the web is the editor).

## 8. Testing

- Unit: allowlist (traversal, backslash, `.env`, case variants, nesting depth, length); edit-set validation and
  limits; both readers against recorded forge responses (including GitLab pagination and 404 on a repo with no
  `.nax/`); board derivation (7-day boundary, oauth vs api-key, missing provider, profile misfit); attention
  `expiring` dashboard condition; placement for config kinds (skips profile checks and `budget_paused`, keeps `tools`/`busy_repo`, `config_jobs` misfit on old runners); `parseAssign` accepts config kinds; snapshot `configResult` mirror validation (caps, bad shapes dropped); each runner step with a
  fake nax and a real temp git repo (conflict cases, symlink refusal, generate output, `no_changes`, push retry,
  existing-PR fallback, timeout, cancel via recorded pgid, heartbeat snapshots, missing root `context.md`).
- Integration (real Postgres): submit -> job + `FleetConfigEdit`; 409 for a second active config job; fenced
  `config-edit` fetch (wrong runner, wrong epoch, terminal job); `configResult` mirroring, RUNNING -> UPLOADING -> terminal with no bundle, and state mapping; attribution comment posted for a config PR; analytics excludes config kinds;
  permissions VIEWER/DEVELOPER/ADMIN; board endpoint admin-only.
- Runner vs mock server: full CONFIG_EDIT, regenerate and CONFIG_DRIFT cycles with a fake `gh`.
- E2E: browse + edit + save -> job page; conflict -> Reopen edits; drift -> regenerate; admin board tabs; VIEWER
  read-only.
- Live check (koda-wk, `nathapp-io/koda-fleet-sandbox`, no LLM spend): (1) edit a rule and `context.md` -> PR with
  regenerated agent files; (2) bad rule frontmatter -> `invalid`, no PR; (3) upstream change to an edited file ->
  `conflict`, Reopen edits; (4) hand-edit `context.md` on the default branch -> drift -> regenerate PR; (5) board grid
  matches `nax auth list --json` on `wk-mac`.

## 9. Delivery

One plan. Suggested PR order (decided at plan time): (1) credential board (API + web, no contract change);
(2) contract + API + runner for both config kinds, exercised through API/CLI; (3) web config page and job panel, then
the live check.

## Decisions

| # | Decision |
|---|---|
| D465 | Config jobs reuse `FleetJob` with fixed `feature = 'nax-config'`, so the existing active-job index serializes config jobs per repo; no new lock. |
| D466 | Edit content lives in `FleetConfigEdit`, fetched by the runner through a lease-fenced endpoint; `AssignPayload` never carries file content. |
| D467 | The allowlist is one pure module in `packages/fleet-protocol`, enforced by API, runner and web; case-variant paths are rejected. |
| D468 | Repo file reads reuse the fleet auth paths, not cached: GitHub `mintInstallationToken` per request (not the job-keyed broker cache); GitLab `GitLabTokenSource.resolve` (the project `VcsConnection` token, as the git broker uses). |
| D469 | Drift is detected by running real `nax generate` in a fresh clone and reading `git status`, because `--dry-run` does not report staleness. |
| D470 | Config jobs skip all profile/agent placement checks and `budget_paused`, keep `tools`, `busy_repo`, `capacity` and the runner-state checks, and need the `configJobs` capability (permanent misfit `config_jobs`). |
| D471 | Outcomes `ok`, `no_changes`, `drift` are COMPLETED; `conflict`, `invalid`, `push_failed`, `pr_failed`, `timeout` are FAILED with `stateReason = outcome`. |
| D472 | The runner opens the PR with `gh`/`glab` through the broker shims (as nax finish does), reusing an existing PR for the branch on retry; no body footer, attribution comes from `PrAttributionService`. |
| D473 | `expiring` applies to OAuth credentials only, window `FLEET_CREDENTIAL_EXPIRY_WARN_DAYS` (default 7). |
| D474 | The editor draft is page state only; recovery after a failed job is "Reopen edits" from the stored edit set. |
| D475 | Results ride the snapshot event (`configResult`, output tail at most 8 KiB, at most 50 files), stored in `FleetJob.configResult` and copied to `FleetConfigEdit.result`; `JobReport` is unchanged. |
| D476 | Config jobs pass through UPLOADING with no bundle, so the server and runner transition tables stay unchanged. |
| D477 | Config kinds are routed in `JobRun.lifecycle`, skipping prepare/spawn/watch/finish; the config executor owns its 10-minute timeout, records each subprocess pgid for cancel, and emits a 30 s heartbeat snapshot. |
| D478 | The config-edit fetch uses the bundle-upload fence pattern (`?leaseEpoch=`, `fence.abandon()` on a miss), allowed in ASSIGNED and RUNNING. |
| D479 | Fleet analytics excludes config kinds. |
