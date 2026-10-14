# SPEC: Fleet Workflow Mode — Runner Verdict, Bundle, Ingest and Job Page for nax Workflow Runs

## Summary

The koda fleet reads the results of nax **workflow mode** (`execution.mode: "workflow"`, nax >= 0.88.0-canary.1) correctly.
In workflow mode nax pushes the feature branch and opens (then possibly promotes) the pull request itself, writes a
`workflow` block (`step`, `stories`, `outcome`, `url`) into `status.json` instead of `postRun.finish`, and writes the
machine-readable verdict to `<repo>/.nax/features/<feature>/workflow/<workflowRunId>/result.json`. The runner judges a RUN
from the `workflow` block (`ready` -> COMPLETED, `draft` -> ESCALATED, `local-only` or no outcome -> FAILED), takes the
reasons from `result.json`, reports nax's PR URL, never pushes its own progress commit on top of nax's push, and ships
`result.json`, `feature-report.md` and `decisions.jsonl` in the job bundle. The API ingests `result.json` into a new
`FleetJob.workflow` column, corrects a COMPLETED job whose workflow outcome is `draft` to ESCALATED, and the web job page
shows the outcome, the reasons and the open items.

## Motivation

koda issue #270. Workflow mode becomes nax's default at the stable 0.88.0 release (user ruling 2026-10-14), so every
fleet RUN will soon be a workflow run. Today the runner mis-reports them:

- `runVerdict` (`apps/runner/src/verdict/run-verdict.ts`) returns COMPLETED for `run.status === 'completed'` with no
  `postRun.finish`. nax writes `run.status: "completed"` even when the workflow ends as a draft (nax#2508), so a draft
  run reads as COMPLETED and no human is told.
- With no finish ledger, `JobRun.finish` (`apps/runner/src/supervisor/job-run.ts`) runs the #204 progress push, which
  commits the dirty tree (including the untracked `decisions.jsonl`, nax#2507) and pushes it onto the branch nax just
  published, adding a stray commit to nax's PR.
- `resultPrUrl` comes only from `postRun.finish.url`, so the job and its tickets never get nax's PR link; the bundle
  carries none of the workflow files, so reasons and open items are lost when the runner clone is reused.

## Design

### Rulings that bind every story

- **R1 (user, 2026-10-14):** a `draft` outcome maps to ESCALATED (the existing needs-a-human state and its
  notification). `ready` maps to COMPLETED; `local-only`, or a `workflow` block with no outcome, maps to FAILED.
- **R2 (user, 2026-10-14):** workflow mode becomes nax's default at stable 0.88.0. koda adds no profile injection and
  no per-project toggle; it reads workflow output whenever nax produces it, and keeps today's behaviour when it does not.
- **R3 (design, approved 2026-10-14):** nax owns the push and the PR. koda never creates a second PR for a workflow run.
  The existing guard already holds once `resultPrUrl` is set: `FleetJobTicketEffects.upsertPrLinks` writes the fleet PR
  link on the job's tickets, and `hasFleetOwnership` then makes `createPrForTicket` return early.
- **D1 (grounding):** nax's `status.json` `run.id` (for example `run-cb319c9d-2026-10-13T15-08-43.285`) is **not** the
  workflow run id that names the `workflow/<id>/` directory (the runtime UUID, for example
  `fab5b9af-d3a3-41f2-91ed-62372a733c03`). The runner therefore detects a workflow run from the `status.json` `workflow`
  block, never from a path built from `naxRunId`, and locates `result.json` as the newest regular file
  `workflow/*/result.json` whose modification time is at or after the job row's `createdAt`.
- **D2 (grounding):** the run-level report nax writes is `<runDir>/feature-report.md` (per-story reports live under
  `<runDir>/US-00N/`). The bundle carries it under its real name.
- **D3:** the API parses only `result.json`. `feature-report.md` and `decisions.jsonl` travel in the bundle (kept with
  the job's bundle artifact) and are not parsed.
- **D4:** the server keeps at most 500 characters of a runner state reason (`apps/api/src/fleet/sync/event-payloads.ts`),
  so the runner clips the whole workflow reason, prefix included, to 500 characters.

### nax inputs (read-only contract)

`status.json` (nax `src/execution/status-file.ts`, `WorkflowStatusBlock`), present only in workflow mode:

```json
{ "run": { "id": "run-cb319c9d-2026-10-13T15-08-43.285", "status": "completed" },
  "workflow": { "step": "done", "stories": { "US-001": { "state": "complete", "round": 1 } },
                "outcome": "draft", "url": "https://github.com/nathapp-io/koda/pull/269" } }
```

`result.json` (nax `src/workflow/types.ts`, `WorkflowResultFile`, `schemaVersion: 1`); `verdict` is absent until the
feature workflow publishes:

```json
{ "schemaVersion": 1, "runId": "fab5b9af-d3a3-41f2-91ed-62372a733c03", "feature": "fleet-s5a-thread-handoff",
  "stories": {},
  "verdict": { "workflowPassed": true, "outcome": "draft",
               "reasons": ["CI failed: test"],
               "openItems": [ { "id": "_run:cv1", "kind": "cannot-verify", "severity": "minor",
                                "file": "apps/api/src/x.ts", "line": 12, "issue": "DB-backed specs not run",
                                "suggestion": "run test:integration" } ] } }
```

`OpenItem.kind` is one of `finding | ruling | cannot-verify | gate`; `severity`, `file`, `line`, `suggestion` and
`ruling` are optional. `FeatureOutcome` is `ready | draft | local-only`. The run dir also holds `feature-report.md`;
`decisions.jsonl` sits in the feature dir.

### Integration

Symbols the feature only reads (verified on main `fca7fe33`):

- `JobRow` (`apps/runner/src/journal/types.ts`): `jobId`, `command`, `branch: string | null`, `createdAt: string`,
  `jobDir`, `assign.feature`, `resultBranch`, `resultSha`.
- `featureDirFor(repoDir, feature)` (`apps/runner/src/paths/safe-segment.ts`) -> `<repoDir>/.nax/features/<feature>`.
- `HostExecutor.dirs(job)` -> `{ repoDir, jobDir, outDir }`; `HostExecutor.readStatus(job)` reads `<outDir>/status.json`.
- `stashPlanOutputs(repoDir, jobDir, feature)` (`apps/runner/src/executor/plan-commit.ts`) — the pattern the workflow
  stash mirrors (copy into the job dir, never commit).
- `FakeExecutor` (`apps/runner/test/helpers/fake-executor.ts`) and `apps/runner/src/supervisor/job-run.spec.ts`, which
  drives the private `finish` through `start('finish')` and reads `lastSnapshot`.
- `FleetJobTicketEffects.upsertPrLinks` (`apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`) and
  `BundleIngestService` calling it after ingest fills `resultPrUrl` — unchanged.
- `FleetJobPostRun` / `postRun` (`fleet-job.domain.ts`, `prisma-fleet-job.repository.ts`, `fleet-job.dto.ts`) — the
  precedent the new `workflow` column follows (domain field, `Mutable` key, repository JSON mapping with `Prisma.DbNull`,
  DTO field null in `FleetJobDto.summary`, reset to null on requeue).
- `mountSfc` (`apps/web/tests/helpers/mount-sfc.ts`), as used by `apps/web/tests/pages/fleet-job-logs-page.spec.ts`.

Symbols the feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `StatusView` (`apps/runner/src/verdict/status-view.ts`)
  - Baseline: `{ run, progress?, cost?, current?, lastHeartbeat?, updatedAt?, postRun? }`; `parseStatusView` drops `workflow`.
  - Target: adds `readonly workflow?: WorkflowView` where
    `interface WorkflowView { readonly step: string; readonly outcome?: 'ready' | 'draft' | 'local-only'; readonly url?: string }`.
    `parseStatusView` sets it only when `raw.workflow` is an object with a string `step`; an `outcome` outside the three
    values is dropped (absent); `url` is kept only when it starts with `https://`.
- `runVerdict` (`apps/runner/src/verdict/run-verdict.ts`)
  - Baseline: `runVerdict(input: { cancelRequested: boolean; status: StatusView | null }): Verdict`.
  - Target: `runVerdict(input: { cancelRequested: boolean; status: StatusView | null; workflowReasons?: readonly string[] }): Verdict`.
    Rows in order: cancel -> CANCELLED; no status -> FAILED `no status.json`; **`status.workflow` present** -> the
    workflow table below; otherwise today's finish rows unchanged.
- `mapStatusToSnapshot` (`apps/runner/src/watcher/status-snapshot.ts`)
  - Baseline: `resultPrUrl` = `status.postRun?.finish?.url`.
  - Target: `resultPrUrl` = `status.postRun?.finish?.url ?? status.workflow?.url`.
- `JobExecutor` (`apps/runner/src/executor/job-executor.ts`), `HostExecutor` and `FakeExecutor`
  - Target adds `readWorkflowResult(job: JobRow): Promise<WorkflowResult | null>` and
    `readHead(job: JobRow): Promise<string | null>` (the checkout's `HEAD` sha, null when git fails).
  - `HostExecutor.collectBundle(job)` target: for a `RUN` it first calls `stashWorkflowOutputs(repoDir, jobDir, feature, sinceMs)`.
  - `FakeExecutor` target: scriptable `workflowResult` and `head` fields, and a recorded count of `readFinishLedger` calls.
- `ATTEMPT_FILES` (`apps/runner/src/executor/host-executor.ts`)
  - Baseline: `['nax-out', 'nax.stdout', 'nax.stderr', 'pre-plan', 'plan-out', 'plan-out.tmp', 'plan-logs', 'plan-logs.tmp', 'bundle.tar.gz', 'bundle.list', 'bundle-manifest.json']`.
  - Target: the same list plus `'workflow'`, so a requeued attempt never bundles the previous attempt's workflow files.
- `collectBundleEntries(jobDir, command)` (`apps/runner/src/bundle/build-bundle.ts`)
  - Baseline: `nax-out/**` minus prompt-audit, `nax.stdout`, `nax.stderr`, PLAN `plan-logs/*.jsonl`.
  - Target: additionally, for `RUN`, each of `workflow/result.json`, `workflow/feature-report.md`,
    `workflow/decisions.jsonl` that exists in `jobDir`.
- `JobRun.judge` / `JobRun.finish` (`apps/runner/src/supervisor/job-run.ts`): see "Runner finish" below.
- `BundleFiles` / `slotOf` (`apps/api/src/fleet/ingest/bundle-reader.ts`)
  - Target adds slot `workflowResult` for the exact name `workflow/result.json` and field
    `workflowResult: BundleFile | null`; `readBundleFiles` stores it as a single file (like `metrics` and `status`),
    not by appending to an array.
- `parseStatus` (`apps/api/src/fleet/ingest/parsers/finish.parser.ts`)
  - Baseline returns `{ runId, runStatus }`.
  - Target returns `{ runId, runStatus, workflowOutcome: 'ready' | 'draft' | 'local-only' | null, workflowUrl: string | null }`
    (`workflowUrl` https only, at most `INGEST_LIMITS.reasonText`).
- `ParsedBundle` / `parseBundle` (`apps/api/src/fleet/ingest/parse-bundle.ts`)
  - Target adds `workflow: FleetJobWorkflow | null` (from `parseWorkflowResult`), `workflowOutcome` and `workflowUrl`
    (from `parseStatus`), and the `files.workflow` outcome (`done` | `absent` | `invalid`).
- `CorrectionInput` / `computeCorrection` (`apps/api/src/fleet/ingest/ingest-corrections.ts`) and `BundleIngestService`
  (`apps/api/src/fleet/ingest/bundle-ingest.service.ts`): see "API ingest" below.
- `INGEST_PARSER_VERSION` (`apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts`): `1` -> `2`.
- `FleetJobRecord`, `Mutable`, `FleetJobPatch` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`): add
  `workflow: FleetJobWorkflow | null` and `'workflow'` to `Mutable`.
- `FleetJobsService.requeue` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts`): the requeue patch that resets the
  per-attempt fields (`resultPrUrl`, `postRun`, ...) also sets `workflow: null`.
- `FleetJobDto` (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`): add `workflow: FleetJobWorkflowDto | null`; `from` maps
  it; `summary` sets it to null (list pages).
- `FleetJobDto` (`apps/web/lib/fleet-types.ts`): add `workflow: FleetJobWorkflowDto | null`, with web types
  `FleetJobWorkflowDto` and `FleetJobWorkflowItemDto` mirroring the API DTO.

### Runner: workflow verdict (US-001)

New module `apps/runner/src/verdict/workflow-result.ts`:

```ts
export interface WorkflowResult {
  readonly runId: string;
  readonly outcome: 'ready' | 'draft' | 'local-only';
  readonly reasons: readonly string[];   // at most 20, each at most 500 characters
}
/** null unless raw is a schemaVersion 1 result with a verdict whose outcome is one of the three values. */
export function parseWorkflowResult(raw: unknown): WorkflowResult | null;
/** Newest-first over `<featureDir>/workflow/<id>/result.json` (real directories, regular files, at most 1 MiB, mtime >= sinceMs): the first that parses, with its run dir. */
export async function findWorkflowResult(featureDir: string, sinceMs: number): Promise<{ result: WorkflowResult; runDir: string } | null>;
```

Non-string reasons are dropped. `findWorkflowResult` lists `workflow/` with `readdir(..., { withFileTypes: true })` and
keeps only real directories (a symlinked directory is skipped), checks each `result.json` with `lstat` (only a regular file
of at most 1 MiB is read; a symlink is skipped), orders the candidates by mtime newest first, and returns the first that
`parseWorkflowResult` accepts. nax writes `result.json` before the verdict exists, so a newer verdict-less file is passed
over for an older one that has a verdict. `HostExecutor.readWorkflowResult(job)` =
`findWorkflowResult(featureDirFor(repoDir, feature), Date.parse(job.createdAt))`, null on any filesystem error.

Workflow rows of `runVerdict` (reasons = `workflowReasons` joined with `; `; the whole reason, prefix included, is clipped
to 500 characters):

| `status.workflow` | Verdict state | Reason |
|---|---|---|
| `outcome: 'ready'` | COMPLETED | null |
| `outcome: 'draft'` | ESCALATED | `workflow draft: <reasons>`, or `workflow draft` when there are no reasons |
| `outcome: 'local-only'` | FAILED | `workflow local-only: <reasons>`, or `workflow local-only` |
| no `outcome` | FAILED | `workflow ended at step <step>` |

`run.status` and `postRun` are not consulted for a workflow run. The reason prefixes never start with the budget-stop
text the web page parses (`budgetStopPolicyId`).

### Runner: finish and result fields (US-002)

`JobRun.judge(row)` reads `status`; when `row.command === 'RUN'` and `status.workflow` is present it also calls
`executor.readWorkflowResult(row)` and passes its `reasons` (or none) as `workflowReasons`. `judge` returns
`{ verdict, snapshot, workflow }`, where `workflow` is `status.workflow` (or undefined), so `finish` can branch on the
workflow outcome rather than on the verdict (a finish-ledger ESCALATED must still push).

`JobRun.finish()` for a `RUN` whose status carries a `workflow` block and whose verdict is not CANCELLED (a cancelled
RUN keeps today's path):

- outcome `ready` or `draft`: when `row.resultBranch` and `row.resultSha` are both non-null (a resumed finish), they are
  reused and `readHead` / `updateJob` are not called. Otherwise result branch = `row.branch`, result sha =
  `executor.readHead(row)`; when the sha is non-null both are journaled with
  `journal.updateJob(jobId, leaseEpoch, { resultBranch, resultSha })`; when it is null the report carries
  `resultBranch` = `row.branch` and no `resultSha`. **No progress push** (`pushRunProgress` is not called; `wipPush`
  stays unset). The finish ledger is not read.
- outcome `local-only` or no outcome: the finish ledger is not read and the progress push runs exactly as today
  (`pushRunProgress` owns journaling, so its resumed-finish guard keeps working).
- A RUN without a `workflow` block keeps today's path unchanged (finish ledger, then progress push when not COMPLETED or
  no ledger).

### Runner: stash and bundle (US-003)

`stashWorkflowOutputs(repoDir, jobDir, feature, sinceMs)` (new, `apps/runner/src/executor/workflow-stash.ts`): when
`findWorkflowResult(featureDirFor(repoDir, feature), sinceMs)` finds a result, copies that run dir's `result.json` and
`feature-report.md` (when present), and `<featureDir>/decisions.jsonl` (when present and its mtime is at or after
`sinceMs`), to `<jobDir>/workflow/` under the same three names. Each source is checked with `lstat`: anything that is not a
regular file, or is larger than 1 MiB, is skipped. It never writes inside `repoDir`, never runs git, and returns the
names it copied (empty, and no folder created, when there is no result). `HostExecutor.collectBundle` calls it for `RUN`
before `buildBundle`, with `sinceMs = Date.parse(job.createdAt)`.

### API: storage and parsing (US-004)

Migration `20261016090000_fleet_job_workflow` (sorts after `20261015090000_thread_handoff`):
`ALTER TABLE "FleetJob" ADD COLUMN "workflow" JSONB;` (nullable, no default).

```ts
// apps/api/src/fleet/jobs/domain/fleet-job.domain.ts
export interface FleetJobWorkflowItem { id: string; kind: string; issue: string; severity: string | null; file: string | null; line: number | null; suggestion: string | null }
export interface FleetJobWorkflow { runId: string; outcome: 'ready' | 'draft' | 'local-only'; workflowPassed: boolean; reasons: string[]; openItems: FleetJobWorkflowItem[] }
```

`parseWorkflowResult(file: BundleFile | null): FleetJobWorkflow | null` (new,
`apps/api/src/fleet/ingest/parsers/workflow.parser.ts`) uses the `fields.ts` readers: `schemaVersion` must be `1`,
`runId` a string (at most `INGEST_LIMITS.idText`), `verdict.outcome` one of the three values, `verdict.workflowPassed` a
boolean; `reasons` keeps at most 20 strings of at most 500 characters; `openItems` keeps at most 50 entries whose `id`,
`kind`, `issue` are strings (`id`/`kind`/`severity` at most `shortText`, `issue`/`suggestion` at most `reasonText`,
`file` at most 512, `line` via `nonNegInt`); missing optional fields become `null`; an item whose `id`, `kind` or
`issue` is missing or empty after trimming is dropped (the `str` reader returns null for an empty string). Anything else
-> `null`. `FleetJobDto.from` maps `workflow: r.workflow ?? null`.

`FleetJobWorkflowDto` / `FleetJobWorkflowItemDto` mirror the domain types with Swagger decorators; `openapi.json` is
regenerated (`bun run generate` at the repo root).

### API: ingest correction (US-005)

`parseBundle` sets `workflow`, `workflowOutcome`, `workflowUrl` and `files.workflow` (`absent` when no
`workflow/result.json`, `invalid` when present but `parseWorkflowResult` returns null, else `done`); `invalid` does not
make the ingest partial.

`computeCorrection` gains `workflow: FleetJobWorkflow | null`, `workflowOutcome` and `workflowUrl` inputs and
`job.workflow` in `CorrectionInput['job']`; `BundleIngestService` passes them from the parsed bundle. With the existing
lease-epoch guard first, for a `RUN` job:

1. `workflow` patch: set when `job.workflow` is null and the parsed `workflow` is non-null (fill-only, like `fill`).
2. `resultPrUrl`: filled from `workflowUrl` when `job.resultPrUrl` is null (fill-only).
3. State: when `workflowOutcome === 'draft'` and `job.state` is COMPLETED -> `{ state: ESCALATED, stateReason:
   'workflow draft (from status)' }` and `escalated: true`; `Correction` gains `escalatedFrom: 'finish-audit' | 'workflow' | null`.
4. The `NOTHING_PUSHED` reason is never applied when `workflowOutcome` is non-null.
5. The finish-based fields and escalation keep today's rules when `workflowOutcome` is null.

`BundleIngestService` records the escalation activity with `payload.source` equal to `escalatedFrom` (today the literal
`'finish-audit'`). Exported constant `ESCALATED_FROM_WORKFLOW = 'workflow draft (from status)'`.
`INGEST_PARSER_VERSION` becomes 2 so `rerun-outdated` can re-ingest older bundles.

### Web: job page (US-006)

New component `apps/web/components/fleet/FleetJobWorkflow.vue` (prop `workflow: FleetJobWorkflowDto`), rendered by the
job page `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` below the state row when `job.workflow` is non-null:

- outcome badge `data-testid="fleet-job-workflow-outcome"` with the text of `fleet.jobs.workflow.outcome.<ready|draft|localOnly>`;
- reasons list `data-testid="fleet-job-workflow-reasons"` (one `li` per reason), hidden when there are none;
- open items list `data-testid="fleet-job-workflow-open-items"`: one row per item showing `kind`, `severity` when
  present, `file:line` when `file` is present (`file` alone when `line` is null), and `issue`; hidden when empty.

The page imports `~/components/fleet/FleetJobWorkflow.vue` explicitly, as it does every sibling component (the test
mount helper has no Nuxt auto-import); the component is also added to `FLEET_COMPONENT_FILES` in
`apps/web/tests/helpers/mount-sfc.ts`. The page-level tests follow `fleet-job-logs-page.spec.ts`: they alias
`~/composables/useApi`, `~/composables/useFleetApprovals`, `~/components/fleet/JobAnalytics.vue` and
`~/components/fleet/config/ConfigPrDialog.vue` to stubs, provide the page's remaining composables (`useRoute`, `useI18n`,
`useAppToast`, `useAuth`, `useFleetJobs`, `useFleetDispatchOptions`, `useProjectMemberNames`, `useFleetRepoConfig`,
`useProjectViewerRole`, `useFleetJobLogs`, `useProjectEvents`) as globals, and load a full `FleetJobDto` fixture.

i18n keys in `apps/web/i18n/locales/en.json` and `zh.json` (parity is enforced by the existing
`tests/i18n/fleet-locale-parity.spec.ts` and `used-keys-exist.spec.ts`): `fleet.jobs.workflow.title`,
`fleet.jobs.workflow.outcome.ready`, `.draft`, `.localOnly`, `fleet.jobs.workflow.reasons`,
`fleet.jobs.workflow.openItems`. No new API calls: the page already loads the job with `GET` by id.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| `status.workflow` has an outcome outside `ready`/`draft`/`local-only` | outcome dropped; verdict FAILED `workflow ended at step <step>` | US-001 |
| `result.json` missing, unreadable, invalid, larger than 1 MiB, a symlink or under a symlinked directory | skipped; null when nothing else qualifies; verdict uses no reasons | US-001 |
| only `result.json` files older than the job's `createdAt` | ignored (null) | US-001 |
| `readHead` git failure | result sha null; verdict unchanged | US-002 |
| workflow file larger than 1 MiB, not a regular file, or a `decisions.jsonl` older than the job | skipped by the stash, others still copied | US-003 |
| requeue over the same job dir | `workflow` folder removed with the other attempt files | US-003 |
| requeue on the API | `workflow` reset to null | US-004 |
| `workflow/result.json` in the bundle invalid | `workflow` null, `files.workflow = invalid`, ingest not partial | US-005 |
| bundle of an older lease epoch | no correction (existing guard) | US-005 |
| non-https workflow `url` | not used for `resultPrUrl` (runner and API) | US-001, US-004 |

## Out of Scope

- The API creating or adopting a pull request for a workflow run (no find-or-create): nax owns the PR, and the existing `hasFleetOwnership` guard prevents a second PR once `resultPrUrl` is set.
- A per-project or per-job toggle, or the API/runner adding a `workflow` profile to a job: nax decides the mode.
- Parsing `feature-report.md` or `decisions.jsonl` on the API: they are only carried in the bundle.
- Fixing nax#2507 (untracked decisions.jsonl) or nax#2508 (run.status completed for a draft): koda works around both.
- PLAN jobs: their verdict, push and bundle are unchanged.
- The C3 thread page (action bar, RUN card): it reuses `FleetJobWorkflow.vue` later.
- New notification kinds: a draft uses the existing ESCALATED outcome notification.
- A runner nax-version gate: detection is by the presence of the `status.json` `workflow` block.
- Backfilling the `workflow` column for already-ingested jobs beyond what `rerun-outdated` does.
- Per-story workflow reports (`<runDir>/US-00N/report.md`) and the other run-dir files (`ledger.md`, `*.diff`, `branch-review.json`): not bundled.

## Stories

1. **US-001: Runner reads the workflow block and result and judges a workflow RUN** — `Workdir: apps/runner` — no
   dependencies. `StatusView.workflow` and its parsing, `workflow-result.ts` (`parseWorkflowResult`,
   `findWorkflowResult`), the workflow rows of `runVerdict`, and the snapshot `resultPrUrl` fallback.
2. **US-002: Runner finish: result fields and no stray push for a workflow RUN** — `Workdir: apps/runner` — depends on
   US-001. `JobExecutor.readWorkflowResult` / `readHead` (host and fake), `JobRun.judge` passing reasons, the
   `JobRun.finish` workflow branch.
3. **US-003: Runner stashes the workflow files into the job bundle** — `Workdir: apps/runner` — depends on US-001.
   `workflow-stash.ts`, `HostExecutor.collectBundle`, `collectBundleEntries`, `ATTEMPT_FILES`.
4. **US-004: API: FleetJob.workflow column, DTO and result.json parser** — `Workdir: apps/api` — no dependencies.
   Migration, domain/repository/DTO field, requeue reset, `workflow.parser.ts`, the `workflowResult` bundle slot,
   `parseStatus` workflow fields, `openapi.json`.
5. **US-005: API: ingest stores the workflow result and corrects a draft to ESCALATED** — `Workdir: apps/api` —
   depends on US-004. `parseBundle` wiring, `computeCorrection` workflow rules, `BundleIngestService` inputs and
   activity source, `ESCALATED_FROM_WORKFLOW`, `INGEST_PARSER_VERSION = 2`.
6. **US-006: Web: job page shows the workflow outcome, reasons and open items** — `Workdir: apps/web` — depends on
   US-004. `FleetJobDto.workflow` type, `FleetJobWorkflow.vue`, job page wiring, i18n keys.

Build gate for every story: `bun run type-check` and `bun run lint` in its Workdir. US-004 also runs `bunx prisma
validate` and `bun run db:generate` in `apps/api`, and regenerates `openapi.json` and the CLI client with
`bun run generate` at the repo root. API DB-backed specs need `bun run test:db:up` and `KODA_DB_TESTS=1`.

### Context Files

**US-001**
- `apps/runner/src/verdict/run-verdict.ts`
- `apps/runner/src/verdict/status-view.ts`
- `apps/runner/src/watcher/status-snapshot.ts`
- `apps/runner/src/verdict/verdict.spec.ts`

**US-002**
- `apps/runner/src/supervisor/job-run.ts`
- `apps/runner/src/supervisor/job-run.spec.ts`
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/executor/job-executor.ts`
- `apps/runner/test/helpers/fake-executor.ts`

**US-003**
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/bundle/build-bundle.ts`
- `apps/runner/src/executor/plan-commit.ts`
- `apps/runner/test/unit/host-executor.spec.ts`
- `apps/runner/src/verdict/workflow-result.ts` — created by US-001, integrated here

**US-004**
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/ingest/bundle-reader.ts`

**US-005**
- `apps/api/src/fleet/ingest/parse-bundle.ts`
- `apps/api/src/fleet/ingest/ingest-corrections.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts`
- `apps/api/src/fleet/ingest/parsers/workflow.parser.ts` — created by US-004, integrated here

**US-006**
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/lib/fleet-types.ts`
- `apps/web/tests/pages/fleet-job-logs-page.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/components/fleet/FleetJobStories.vue`

### Creates

**US-001**
- `apps/runner/src/verdict/workflow-result.ts`
- `apps/runner/src/verdict/workflow-result.spec.ts`

**US-003**
- `apps/runner/src/executor/workflow-stash.ts`
- `apps/runner/src/executor/workflow-stash.spec.ts`

**US-004**
- `apps/api/prisma/migrations/20261016090000_fleet_job_workflow/migration.sql`
- `apps/api/src/fleet/ingest/parsers/workflow.parser.ts`
- `apps/api/src/fleet/ingest/parsers/workflow.parser.spec.ts`

**US-006**
- `apps/web/components/fleet/FleetJobWorkflow.vue`
- `apps/web/tests/components/FleetJobWorkflow.spec.ts`
- `apps/web/tests/pages/fleet-job-detail-workflow.spec.ts`

### Modifies

**US-001**
- `apps/runner/src/verdict/verdict.spec.ts` — add the workflow rows; existing finish-row tests stay unchanged and must keep passing, since a status without a workflow block keeps today's verdict.

**US-002**
- `apps/runner/src/executor/job-executor.ts` — the JobExecutor interface gains readWorkflowResult and readHead.
- `apps/runner/test/helpers/fake-executor.ts` — implements the two new JobExecutor methods with scriptable workflowResult and head fields, and records how many times readFinishLedger is called, so job-run tests can script a workflow RUN and assert the ledger is not read.
- `apps/runner/src/supervisor/job-run.spec.ts` — add the workflow finish cases; existing finish cases (status without a workflow block) keep their expected snapshots.
- `apps/runner/test/unit/host-executor.spec.ts` — add the readWorkflowResult and readHead cases; existing cases keep their expectations.
- `apps/runner/src/watcher/status-snapshot.spec.ts` — add the case where resultPrUrl falls back to the workflow url; existing cases keep their expected snapshots.

**US-003**
- `apps/runner/src/bundle/build-bundle.spec.ts` — a test asserting the exact RUN entry list may need the three workflow file names when the job dir holds them; a RUN job dir without a workflow folder keeps today's exact list.
- `apps/runner/test/unit/host-executor.spec.ts` — add the collectBundle stash case and the requeue case that removes the workflow folder; existing cases keep their expectations.

**US-004**
- `apps/api/prisma/schema.prisma` — add a nullable Json workflow field to the FleetJob model next to postRun.
- `openapi.json` — regenerated for the new FleetJobDto workflow field.
- `apps/api/src/fleet/ingest/parsers/parsers.spec.ts` — the parseStatus test asserts the exact object with only runId and runStatus; parseStatus now also returns workflowOutcome and workflowUrl (null when the status has no workflow block), so the expected objects gain those two null fields.
- `apps/api/src/fleet/ingest/bundle-reader.spec.ts` — a test listing every slot gains the workflowResult slot for the bundle's workflow result file; other names stay unallowlisted.

**US-005**
- `apps/api/src/fleet/ingest/ingest-corrections.spec.ts` — CorrectionInput gains workflow inputs; existing cases pass a null workflow, workflowOutcome and workflowUrl and keep their expected patches.
- `apps/api/src/fleet/ingest/parse-bundle.spec.ts` — the expected files outcome map gains workflow 'absent' for bundles without a workflow result file.

**US-006**
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — import and render FleetJobWorkflow below the state row when the job has a workflow result.
- `apps/web/lib/fleet-types.ts` — FleetJobDto gains the workflow field with the FleetJobWorkflowDto and FleetJobWorkflowItemDto types.
- `apps/web/tests/helpers/mount-sfc.ts` — FLEET_COMPONENT_FILES gains FleetJobWorkflow so a mounted page resolves it.
- `apps/web/i18n/locales/en.json` — add the fleet.jobs.workflow keys.
- `apps/web/i18n/locales/zh.json` — add the fleet.jobs.workflow keys.

### Seams

- US-001 -> US-002: `findWorkflowResult` (via `HostExecutor.readWorkflowResult`) and `runVerdict`'s `workflowReasons` are
  consumed by `JobRun.judge`; the US-002 seam ACs enter at `JobRun.start('finish')` in `job-run.spec.ts`.
- US-001 -> US-003: `findWorkflowResult` is consumed by `stashWorkflowOutputs`; the US-003 seam AC enters at
  `HostExecutor.collectBundle`.
- US-004 -> US-005: `parseWorkflowResult` (API) and `parseStatus`' workflow fields are consumed by `parseBundle` and
  `computeCorrection`; the US-005 seam AC enters at `BundleIngestService` ingesting a real bundle.
- US-004 -> US-006: the `FleetJobDto.workflow` wire shape `{ runId, outcome, workflowPassed, reasons: string[],
  openItems: { id, kind, issue, severity|null, file|null, line|null, suggestion|null }[] }` is what the web renders.

## Acceptance Criteria

### US-001: Runner reads the workflow block and result and judges a workflow RUN

- AC-1 [unit]: `parseStatusView` of a status whose `workflow` is `{ step: "done", outcome: "draft", url: "https://github.com/o/r/pull/1" }` returns `workflow` equal to `{ step: "done", outcome: "draft", url: "https://github.com/o/r/pull/1" }`.
- AC-2 [unit]: `parseStatusView` of a status whose `workflow.outcome` is `"failed"` returns a `workflow` with `step` and no `outcome` key.
- AC-3 [unit]: `parseStatusView` of a status whose `workflow.url` is `"http://x/pull/1"` returns a `workflow` with no `url` key.
- AC-4 [unit]: `parseStatusView` of a status with no `workflow` key returns a view with no `workflow` key.
- AC-5 [unit]: `runVerdict` with `status.workflow.outcome` `"ready"` and `run.status` `"completed"` returns `{ state: "COMPLETED", reason: null }`.
- AC-6 [unit]: `runVerdict` with `status.workflow.outcome` `"draft"`, `run.status` `"completed"` and `workflowReasons` `["CI failed: test", "1 open finding"]` returns `{ state: "ESCALATED", reason: "workflow draft: CI failed: test; 1 open finding" }`.
- AC-7 [unit]: `runVerdict` with `status.workflow.outcome` `"draft"` and no `workflowReasons` returns reason `"workflow draft"`.
- AC-8 [unit]: `runVerdict` with `status.workflow.outcome` `"local-only"` and `workflowReasons` `["push failed"]` returns `{ state: "FAILED", reason: "workflow local-only: push failed" }`.
- AC-9 [unit]: `runVerdict` with `status.workflow` `{ step: "final-gates" }` (no outcome) returns `{ state: "FAILED", reason: "workflow ended at step final-gates" }`.
- AC-10 [unit]: `runVerdict` with `cancelRequested` true and `status.workflow.outcome` `"ready"` returns `{ state: "CANCELLED", reason: null }`.
- AC-11 [unit]: `runVerdict` with `status.workflow.outcome` `"draft"` and 30 reasons of 50 characters returns a reason of exactly 500 characters that starts with `"workflow draft: "`.
- AC-12 [unit]: `parseWorkflowResult` of a schemaVersion 1 object with `verdict.outcome` `"draft"`, 25 string reasons and one reason of 600 characters returns 20 reasons, none longer than 500 characters.
- AC-13 [unit]: `parseWorkflowResult` of an object with `schemaVersion` 2, or with no `verdict`, or with `verdict.outcome` `"failed"`, returns null.
- AC-14 [unit]: `findWorkflowResult` over a feature dir holding `workflow/a/result.json` (mtime before `sinceMs`), `workflow/b/result.json` (mtime after `sinceMs`) and `workflow/c/result.json` (a symlink, mtime after `sinceMs`) returns the result from `b` with `runDir` ending in `workflow/b`; with only `a` and `c` present it returns null.
- AC-15 [unit]: `findWorkflowResult` over `workflow/new/result.json` (newest, no `verdict`), `workflow/old/result.json` (older, valid draft verdict, both after `sinceMs`), `workflow/big/result.json` (newest of all, larger than 1 MiB) and `workflow/link` (a symlinked directory holding a valid result) returns the result from `old`.

### US-002: Runner finish: result fields and no stray push for a workflow RUN

- AC-1 [unit]: `HostExecutor.readWorkflowResult` for a job whose checkout holds `.nax/features/<feature>/workflow/<id>/result.json` written after the job row's `createdAt` returns that result's `outcome` and `reasons`.
- AC-2 [unit]: `HostExecutor.readHead` for a job whose repo dir is not a git checkout returns null.
- AC-3 [integration]: In `job-run.spec.ts`, a RUN `JobRun` started with `start('finish')` over a `FakeExecutor` whose status has `workflow.outcome` `"draft"` and whose `workflowResult` has reasons `["CI failed: test"]` reports the terminal state ESCALATED with reason `"workflow draft: CI failed: test"`.
- AC-4 [integration]: A RUN `JobRun` `start('finish')` with `workflow.outcome` `"ready"` and no finish ledger never calls `FakeExecutor.pushProgress`, and its last snapshot carries no `wipPush`.
- AC-5 [integration]: A RUN `JobRun` `start('finish')` with `workflow.outcome` `"draft"` never calls `FakeExecutor.pushProgress`.
- AC-6 [integration]: A RUN `JobRun` `start('finish')` with `workflow.outcome` `"local-only"` calls `FakeExecutor.pushProgress` once.
- AC-7 [integration]: A RUN `JobRun` `start('finish')` with `workflow.outcome` `"ready"`, `row.branch` `"feat/x"` and `FakeExecutor.head` `"abc123"` reports `resultBranch` `"feat/x"` and `resultSha` `"abc123"` and the fake records zero `readFinishLedger` calls.
- AC-8 [integration]: A RUN `JobRun` `start('finish')` with `workflow.outcome` `"ready"` and `FakeExecutor.head` `"abc123"` journals the row with `resultSha` `"abc123"`.
- AC-9 [integration]: A RUN `JobRun` `start('finish')` with a status that has no `workflow` block and a finish ledger `{ branch: "feat/y", headSha: "def456" }` reports `resultBranch` `"feat/y"` and `resultSha` `"def456"` (today's path).
- AC-10 [integration]: A RUN `JobRun` `start('finish')` with `workflow.outcome` `"ready"`, `row.branch` `"feat/x"` and `FakeExecutor.head` null reports the state COMPLETED, `resultBranch` `"feat/x"` and no `resultSha`.
- AC-11 [integration]: A resumed RUN `JobRun` `start('finish')` whose journal row already holds `resultBranch` `"feat/x"` and `resultSha` `"aaa111"`, with `workflow.outcome` `"ready"` and `FakeExecutor.head` `"bbb222"`, reports `resultSha` `"aaa111"`.
- AC-12 [integration]: A RUN `JobRun` `start('finish')` with a cancel requested and `workflow.outcome` `"ready"` reports CANCELLED and calls `FakeExecutor.pushProgress` once (today's cancelled path).
- AC-13 [unit]: `mapStatusToSnapshot` of a status with no `postRun.finish` and `workflow.url` `"https://github.com/o/r/pull/1"` returns `resultPrUrl` `"https://github.com/o/r/pull/1"`.

### US-003: Runner stashes the workflow files into the job bundle

- AC-1 [unit]: `stashWorkflowOutputs` over a checkout holding `workflow/<id>/result.json` and `workflow/<id>/feature-report.md` (both after `sinceMs`) and `decisions.jsonl` (after `sinceMs`) copies all three to `<jobDir>/workflow/` and returns the names `result.json`, `feature-report.md` and `decisions.jsonl` in any order.
- AC-2 [unit]: `stashWorkflowOutputs` with a `feature-report.md` larger than 1 MiB copies `result.json` and `decisions.jsonl` and not `feature-report.md`.
- AC-3 [unit]: `stashWorkflowOutputs` with `decisions.jsonl` whose mtime is before `sinceMs` copies `result.json` and not `decisions.jsonl`.
- AC-4 [unit]: `stashWorkflowOutputs` with `feature-report.md` being a symlink to a file outside the checkout does not copy `feature-report.md`.
- AC-5 [unit]: `stashWorkflowOutputs` creates, modifies or deletes no file inside `repoDir`.
- AC-6 [unit]: `stashWorkflowOutputs` over a feature dir with no `workflow/` folder returns an empty list and creates no `<jobDir>/workflow/` folder.
- AC-7 [unit]: `collectBundleEntries(jobDir, "RUN")` for a job dir holding `workflow/result.json` and `workflow/feature-report.md` includes both names.
- AC-8 [unit]: `collectBundleEntries(jobDir, "PLAN")` for a job dir holding `workflow/result.json` does not include it.
- AC-9 [integration]: `HostExecutor.collectBundle` of a RUN job whose checkout holds a workflow `result.json` written after `createdAt` produces a bundle whose manifest `entries` include `workflow/result.json`.
- AC-10 [integration]: `HostExecutor` preparing a requeued attempt (a new lease epoch over a job dir that holds `workflow/result.json`) leaves no `workflow` folder in the job dir before nax starts.

### US-004: API: FleetJob.workflow column, DTO and result.json parser

- AC-1 [unit]: `parseWorkflowResult` of a bundle file holding the Design's example `result.json` returns `{ runId: "fab5b9af-d3a3-41f2-91ed-62372a733c03", outcome: "draft", workflowPassed: true, reasons: ["CI failed: test"], openItems: [{ id: "_run:cv1", kind: "cannot-verify", issue: "DB-backed specs not run", severity: "minor", file: "apps/api/src/x.ts", line: 12, suggestion: "run test:integration" }] }`.
- AC-2 [unit]: `parseWorkflowResult` of an open item with only `id`, `kind` and `issue` returns that item with `severity`, `file`, `line` and `suggestion` all `null`.
- AC-3 [unit]: `parseWorkflowResult` of a result with 60 open items returns 50 items.
- AC-4 [unit]: `parseWorkflowResult` of a result whose `verdict.outcome` is `"failed"` returns null.
- AC-5 [unit]: `parseWorkflowResult` of a result whose `schemaVersion` is `2` returns null.
- AC-6 [unit]: `parseWorkflowResult` of a file whose text is not JSON returns null, and `parseWorkflowResult(null)` returns null.
- AC-7 [unit]: `slotOf("workflow/result.json")` returns `"workflowResult"`.
- AC-8 [unit]: `slotOf("workflow/feature-report.md")` and `slotOf("workflow/decisions.jsonl")` return null.
- AC-9 [unit]: `parseStatus` of a status file whose `workflow` is `{ step: "done", outcome: "ready", url: "https://github.com/o/r/pull/2" }` returns `workflowOutcome` `"ready"` and `workflowUrl` `"https://github.com/o/r/pull/2"`.
- AC-10 [unit]: `parseStatus` of a status file whose `workflow.url` is `"http://x"` returns `workflowUrl` null.
- AC-11 [unit]: `FleetJobDto.from` of a record whose `workflow` is non-null returns a DTO whose `workflow` equals that value.
- AC-12 [unit]: `FleetJobDto.summary` of a record whose `workflow` is non-null returns a DTO whose `workflow` is null.
- AC-13 [integration]: Updating a `FleetJob` through `PrismaFleetJobRepository` with a `workflow` patch and reading it back returns the same `workflow` object; a patch with `workflow: null` reads back null.
- AC-14 [integration]: Requeuing a FAILED RUN job whose `workflow` is set, through `FleetJobsService.requeue`, leaves the job QUEUED with `workflow` null.
- AC-15 [unit]: `INGEST_PARSER_VERSION` equals 2.

### US-005: API: ingest stores the workflow result and corrects a draft to ESCALATED

- AC-1 [unit]: `parseBundle` of bundle files whose `workflowResult` holds a valid draft result and whose status has `workflow.outcome` `"draft"` and `workflow.url` `"https://github.com/o/r/pull/5"` returns `workflow.outcome` `"draft"`, `workflowOutcome` `"draft"`, `workflowUrl` `"https://github.com/o/r/pull/5"` and `files.workflow` `"done"`.
- AC-2 [unit]: `parseBundle` of bundle files with no `workflowResult` returns `workflow` null and `files.workflow` `"absent"`.
- AC-3 [unit]: `parseBundle` of bundle files whose `workflowResult` text is invalid returns `workflow` null, `files.workflow` `"invalid"` and `partial` false when every other outcome is `done` or `absent`.
- AC-4 [unit]: `computeCorrection` for a COMPLETED RUN with `workflowOutcome` `"draft"` returns a patch with `state` `ESCALATED` and `stateReason` equal to `ESCALATED_FROM_WORKFLOW` (`"workflow draft (from status)"`), `escalated` true and `escalatedFrom` `"workflow"`.
- AC-5 [unit]: `computeCorrection` for an ESCALATED RUN with `workflowOutcome` `"draft"` returns a patch without `state`, `escalated` false and `escalatedFrom` null.
- AC-6 [unit]: `computeCorrection` for a RUN whose `job.workflow` is null and parsed `workflow` is non-null returns a patch whose `workflow` equals the parsed value.
- AC-7 [unit]: `computeCorrection` for a RUN whose `job.workflow` is already set returns a patch without `workflow`.
- AC-8 [unit]: `computeCorrection` for a RUN with `job.resultPrUrl` null and `workflowUrl` `"https://github.com/o/r/pull/3"` returns a patch with `resultPrUrl` `"https://github.com/o/r/pull/3"`.
- AC-9 [unit]: `computeCorrection` for a COMPLETED RUN with `workflowOutcome` `"ready"`, no finish record and `resultBranch` null returns a patch without `stateReason`.
- AC-10 [unit]: `computeCorrection` with `leaseEpoch` different from `job.leaseEpoch` and `workflowOutcome` `"draft"` returns an empty patch.
- AC-11 [unit]: `computeCorrection` for a PLAN job with `workflowOutcome` `"draft"` returns a patch without `state` and without `workflow`.
- AC-12 [unit]: `computeCorrection` for a COMPLETED RUN with no workflow inputs and a finish record whose status is `"escalated"` returns `escalatedFrom` `"finish-audit"`.
- AC-13 [integration]: Ingesting a real bundle whose `status.json` has `workflow.outcome` `"draft"` and `workflow.url` `"https://github.com/o/r/pull/4"` and whose `workflow/result.json` is a valid draft result, for a COMPLETED RUN job linked to one ticket, through `BundleIngestService`, leaves the job ESCALATED with `workflow.outcome` `"draft"` and `resultPrUrl` `"https://github.com/o/r/pull/4"`, and the ticket holds a fleet `pr` link to that URL.
- AC-14 [integration]: The same ingest records one job activity whose `payload.source` is `"workflow"`.

### US-006: Web: job page shows the workflow outcome, reasons and open items

- AC-1 [unit]: `FleetJobWorkflow` with `workflow.outcome` `"draft"` renders `fleet-job-workflow-outcome` with the text of `fleet.jobs.workflow.outcome.draft`.
- AC-2 [unit]: `FleetJobWorkflow` with `workflow.outcome` `"local-only"` renders `fleet-job-workflow-outcome` with the text of `fleet.jobs.workflow.outcome.localOnly`.
- AC-3 [unit]: `FleetJobWorkflow` with reasons `["CI failed: test", "1 open finding"]` renders two items in `fleet-job-workflow-reasons`.
- AC-4 [unit]: `FleetJobWorkflow` with empty reasons renders no `fleet-job-workflow-reasons` element.
- AC-5 [unit]: `FleetJobWorkflow` with an open item `{ kind: "finding", severity: "major", file: "src/a.ts", line: 7, issue: "unchecked null" }` renders a row in `fleet-job-workflow-open-items` containing `finding`, `major`, `src/a.ts:7` and `unchecked null`.
- AC-6 [unit]: `FleetJobWorkflow` with an open item whose `file` is `"src/b.ts"` and `line` null renders `src/b.ts` and not `src/b.ts:`.
- AC-7 [unit]: `FleetJobWorkflow` with empty open items renders no `fleet-job-workflow-open-items` element.
- AC-8 [unit]: The job detail page mounted with `mountSfc` (as `fleet-job-logs-page.spec.ts` mounts the logs page), with the job request resolving to a job whose `workflow` is non-null, renders `fleet-job-workflow-outcome`.
- AC-9 [unit]: The job detail page mounted the same way with a job whose `workflow` is null renders no `fleet-job-workflow-outcome`.
