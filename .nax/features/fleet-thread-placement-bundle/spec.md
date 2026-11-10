# SPEC: Thread placement refusals, queued-turn reasons, thread-flow review pass, repo rule overrides

Closes: #424, #425, #426, #375, #370

## Summary

This bundle closes the five open koda issues in one run.

- **#424:** thread create (REPO, PROJECT and WORKSPACE kinds) and `PATCH .../threads/:id/mode` refuse with 409
  when no enabled thread-capable runner can host the thread's kind, mode and backend together. The refusal names the
  cause with one i18n key per cause. The check reuses placement's thread rules through one new pure function,
  `threadCapabilityMisfit`, which `firstMisfit` now calls too.
- **#425:** a queued THREAD job that no runner can take is explained. The dashboard dry-run judges THREAD jobs (it
  skipped them), so they show as `job_unplaceable` with per-runner reasons. Thread detail gains `queuedTurn`, which
  the project and workspace thread pages render. Both read one shared verdict function, `judgeUnplaceable`.
- **#426:** a flow started from a thread (`entry = THREAD`) no longer stops on `minor` or `answered` review findings.
  It records them on the flow and moves to the next step, and it may commit PRD edits like a nax-entry flow.
  `ambiguous` findings still stop it.
- **#370 (C11):** a registered repo can carry a rule override: rule files laid out like `.nax/rules/`, an optional
  project-context file, and nax's combine modes. An admin sets it through approval-gated routes under a new key,
  `fleet.repo.rules.configure`. Placement sends it in the ASSIGN payload of every nax job, and the runner writes it
  into the job directory and points the per-job nax profile at it (`context.rules.overrideDir`,
  `context.projectContext.file`). The job records which override it was assigned.
- **#375:** a recorded decision that koda keeps its own thread skill tools.

## Motivation

- **#424.** #399 (PR #423) made thread create refuse a backend no runner offers, but placement (`firstMisfit`,
  `apps/api/src/fleet/jobs/placement-rules.ts:169`) has more hard thread rules create does not apply: a PROJECT thread
  needs `capabilities.projectThreads`, a WORKSPACE thread needs `capabilities.workspaceThreads`, and a REPO SESSION in
  `ask` or `full` mode needs `capabilities.threadModes`. A thread that misses one is accepted (201) and its first turn
  queues forever with `stateReason = null`. A later mode change to `ask` or `full` has the same hole.
- **#425.** A thread created while its backend was offered can still get stuck later: the runner drops the model, is
  disabled, or is downgraded. `fillRunnerThreads` (`apps/api/src/fleet/jobs/placement.service.ts:188`) skips the job on
  any misfit and records nothing, `jobUnplaceableItems`
  (`apps/api/src/fleet/dashboard/attention-unplaceable.ts:64`) returns nothing for `isThreadKind(job.command)`, and the
  thread page shows the message as pending with no explanation.
- **#426.** Live check §9.182 (2026-11-10, koda-wk `25d6536d`): flow A stopped `review_findings` at SPEC_REVIEW on 3
  minor findings, and flow B stopped at PRD_REVIEW on 2 minor findings. Each stop needs a person to read the ticket,
  get the spec fixed, republish, start a new flow and approve it again. The cause is
  `canApplyCalls: flow.entry === 'NAX'` (`apps/api/src/fleet/flows/fleet-flow-advance.service.ts:833`) feeding
  `decideFlowStep` (`apps/api/src/fleet/flows/flow-step-decision.ts:141`, `:151`, `:155`). Ruling (2026-11-10):
  options 2 and 3 of #426. A thread flow may apply PRD edits, because the PRD is the flow's own PLAN output and not the
  thread's spec. Non-question findings pass and are recorded on the flow. koda's verdict classes are only `answered`,
  `minor` and `ambiguous` (`FlowFindingClass`, `apps/api/src/fleet/flows/flow-verdict.ts:4`). There is no `major` or
  `blocker`, so "stop only on serious findings" means stop only on `ambiguous` findings (they ask a question nobody
  answered). Spec calls stay blocked for thread flows, because the thread owns the spec.
- **#370.** C11 was deferred on 2026-10-07 until nax could take rules and project context from outside the repo.
  nax #2377 is closed: `nax run --rules-dir` / `--context-file` exist, and the same settings are config keys a
  profile can carry: `context.rules.overrideDir` with `context.rules.overrideMode` (`merge` default or `replace`) and
  `context.projectContext.file` with `context.projectContext.mode` (`append` default or `replace`, file at most 32,768
  bytes) (nax `packages/nax/src/config/runtime-types-context.ts:184`). The installed nax (0.91.8-canary.7) has them.
  koda passes none (`buildNaxArgv`, `apps/runner/src/executor/nax-process.ts`). Designer calls (user asked for them,
  2026-11-10): rule sets are per repo only; the override is read when the job is assigned, like `fixTrustDetectedChecks`;
  it reaches nax through the per-job profile (`writeJobProfile`, `apps/runner/src/executor/job-profile.ts:48`) rather
  than argv, so every nax command the job runs (`run`, `plan`, `bot review`, `bot fix`, `agents run`) gets it; CONFIG
  jobs and threads never do. User ruling: its own permission key, `fleet.repo.rules.configure`.
- **#375.** nax's resource catalog and its skills provider live in the `@nathapp/nax` CLI package
  (`packages/nax/src/resources/skills-provider.ts`), not in `@nathapp/nax-agent`, which exports only the
  `ToolProvider`/`ProviderTool` types. The runner depends on nax-agent alone, and koda's thread skills are an API-side
  snapshot (`SkillsService.snapshotForProject`) delivered in the ASSIGN, not a disk scan. Serving them through the
  catalog would mean shipping the whole nax CLI in the runner or asking nax to move the catalog. Decision: keep
  `load_skill` / `read_skill_file` (`apps/runner/src/thread/tools/`) and record why.

## Design

### Integration

Symbols the feature only reads:

- `evaluateRunners(job, runners, loads, runnerPaused, now, offlineSec)`, `toPlacementJob(job, repo, thread?)`,
  `jobScopePause(job, match)`, `withVaultProviders(job, providers)`, `PERMANENT_MISFITS`, `EMPTY_LOAD` and
  `servesThreadBackend(backends, backend)` in `apps/api/src/fleet/jobs/placement-rules.ts`.
- `PlacementService.judgedJob(placementJob, runners, cache)` (vault providers for a job) and
  `IFleetJobRepository.findPlacementRunners(ids?)`, `findActiveLoads(runnerIds)`, `findRepo(repoId)`,
  `findThreadAssign(jobId)`, `findById(jobId)`.
- `BudgetGate.snapshot(now)` returning `runnerPaused(runnerId)` and `match(keys)`.
- `FleetConfig.jobQueuedWarnSec` (default 60, `apps/api/src/config/fleet.config.ts:169`), `threadsEnabled` and
  `runnerOfflineSec`.
- `ConflictAppException(args, key)` (`apps/api/src/common/exceptions/conflict-app.exception.ts`).
- `FLOW_CALLS_MAX_FINDINGS` (20), `FLOW_CALL_TEXT_MAX`, `safeFlowJsonText` and `truncateFlowText`
  (`apps/api/src/fleet/flows/flow-calls.ts`).
- The fix-unprotected precedent for a new approval-gated repo route with its own key (commit `db7ed657`):
  `FleetReposController.configureFixUnprotected`, `FleetRepoRouteCommands`, `NEW_KEY_SCOPES` in
  `apps/api/src/permissions/catalog.ts:126`, and `apps/web/components/fleet/RepoFixUnprotected.vue`.
- `ApprovalRouteGate.run<T>({ key, variant, projectId, input })`, `ApprovalPending`, `parseRouteInput`,
  `AuditService.record`.
- Web: `useGlobalPermissions()`, `extractApiError(err)`, `$api`, and the `fleet.misfit.*` label map
  (`apps/web/i18n/locales/en.json:1302`).

Symbols the feature changes. The baseline only locates the code; implement the target.

**US-001 (#424)**

- New `threadCapabilityMisfit(thread: PlacementThread, capabilities: RunnerCapabilities): ThreadCapabilityMisfit | null`
  in `placement-rules.ts`, with `type ThreadCapabilityMisfit = 'project_threads' | 'workspace_threads' | 'thread_modes' | 'thread_backend' | 'thread_write'`.
  It runs placement's capability-only thread rules in `firstMisfit`'s order: `kind === 'PROJECT'` without
  `projectThreads === true` gives `project_threads`; `kind === 'WORKSPACE'` without `workspaceThreads === true` gives
  `workspace_threads`; for `action` SESSION (absent means SESSION), `mode` `ask` or `full` without `threadModes === true`
  gives `thread_modes`, then `!servesThreadBackend(...)` gives `thread_backend`; for any other action,
  `threadWrite !== true` gives `thread_write`.
- `firstMisfit` (`placement-rules.ts:169`)
  - Baseline: the thread branch checks the five rules inline (lines 181-191).
  - Target: after `threads_disabled` and `protocol`, it returns `threadCapabilityMisfit(job.thread, runner.capabilities)`
    when that is non-null, then `trust_domain` and `thread_capacity` as today. Same results for every input.
- `ChatThreadRepository.anyRunnerServesBackend(backend)` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts:147`)
  - Baseline: `anyRunnerServesBackend(backend: ThreadBackend): Promise<boolean>`.
  - Target: `threadServeMisfit(need: ThreadServeNeed): Promise<ThreadCapabilityMisfit | null>`, with
    `interface ThreadServeNeed { backend: ThreadBackend; kind: ChatThreadKind; mode: ThreadMode; runnerId?: string | null; modesOnly?: true }`.
    `PrismaChatThreadRepository` reads `runner` rows with `enabled: true` and `protocolVersion >= THREAD_MIN_PROTOCOL_VERSION`,
    or, when `runnerId` is a string, only that runner's row (any `enabled` value; a missing row means nothing to judge).
    No rows: `null` (the #399 "fleet not set up" rule). Otherwise each row is judged with
    `threadCapabilityMisfit({ backend, kind, mode, enabled: true, action: 'SESSION' }, capabilities)`, or, when
    `modesOnly` is set, only by the mode rule (`mode` `ask`/`full` and `threadModes !== true` gives `thread_modes`,
    anything else `null`), so a backend change on the runner never refuses a mode change; any `null`
    verdict gives `null`. When every row misfits, the answer is the misfit of the runner that got furthest, by
    placement order `project_threads` = `workspace_threads` < `thread_modes` < `thread_backend` (the latest-ordered
    misfit wins).
- `assertBackendServed(threads, backend)` (`apps/api/src/fleet/threads/thread-backend-served.ts:17`)
  - Target: `assertThreadServed(threads: Pick<ChatThreadRepository, 'threadServeMisfit'>, need: ThreadServeNeed): Promise<void>`.
    `null` returns. `thread_backend` throws `ConflictAppException(refusalArgs(backend), 'threads.backendUnavailable')`
    exactly as today; `project_threads` throws `ConflictAppException({}, 'threads.projectThreadsUnavailable')`;
    `workspace_threads` throws `ConflictAppException({}, 'threads.workspaceThreadsUnavailable')`; `thread_modes` throws
    `ConflictAppException({ mode }, 'threads.modeUnavailable')`. `thread_write` cannot occur (the need is always a
    SESSION); the switch is exhaustive, and an unexpected value throws `Error('unexpected thread misfit')`.
- `ThreadsService.assertBackendServed(backend)` and `WorkspaceThreadsService.assertBackendServed(backend)` become
  `assertThreadServed(need)`. `ThreadsService.create` calls it with `{ backend, kind: 'PROJECT', mode: 'read' }` for a
  PROJECT thread and `{ backend, kind: 'REPO', mode: normalized.mode }` for a REPO thread; `WorkspaceThreadsService.create`
  with `{ backend, kind: 'WORKSPACE', mode: 'read' }`. `ThreadsController.create` and `WorkspaceThreadsController.create`
  call it before the approval gate with the normalized kind, and mode `normalized.mode` for a REPO thread or `'read'`
  for a PROJECT or WORKSPACE thread, as #399 does for the backend.
- New `ThreadsService.assertModeServed(projectId: string, threadId: string, mode: ThreadMode): Promise<void>`: for
  `mode === 'read'` it returns; otherwise it loads the thread (`threads.notFound` 404 when missing), returns when
  `thread.kind !== 'REPO'` (so the existing 400 `threads.input` for a non-REPO ask/full still wins), and calls
  `assertThreadServed({ backend: thread.backend, kind: 'REPO', mode, runnerId: thread.runnerId, modesOnly: true })`.
  `ThreadsController.changeMode` calls it before the approval gate, and `ThreadsService.changeMode` calls it again
  before `this.threads.changeMode(...)`.
- i18n `apps/api/src/i18n/{en,zh}/threads.json` gain `projectThreadsUnavailable`, `workspaceThreadsUnavailable` and
  `modeUnavailable` (`{mode}`), each with a `"409"` message. The 409 `@ApiResponse` descriptions on the create and
  mode routes name the new keys.

**US-002 (#425 dashboard)**

- New `apps/api/src/fleet/jobs/unplaceable-verdict.ts`:
  - `export const UNPLACEABLE_VERDICTS` and `export type UnplaceableVerdict`, moved unchanged from `dashboard.types.ts:102`
    (values `never`, `budget_paused`, `runners_paused`, `waiting_capacity`, `no_fit`, `no_runners`, `fits_not_placed`);
    `dashboard.types.ts` re-exports both, so `fleet-dashboard.dto.ts` and other importers keep working.
  - `export interface UnplaceableJudgement { verdict: UnplaceableVerdict; severity: 'error' | 'warning'; misfits: Array<{ runnerId: string; runnerName: string; reason: MisfitReason }> }`.
  - `export function judgeUnplaceable(input: { job: PlacementJob; scopePaused: boolean; pool: readonly PlacementRunner[]; loads: ReadonlyMap<string, RunnerLoad>; runnerPaused: (runnerId: string) => boolean; now: Date; offlineSec: number }): UnplaceableJudgement | null`.
    Order: `scopePaused` gives `budget_paused`/warning with no misfits; an empty `pool` gives `no_runners`/error; otherwise
    `evaluateRunners(...)`, and when some runner has `reason === null` the answer is `null` (delayed, not unplaceable).
    Misfits sort by `runnerName`, then `runnerId`. The classification is today's `classify`, with `thread_capacity`
    added to the waiting reasons (`capacity`, `busy_repo`, `trust_domain`, `thread_capacity`).
- `jobUnplaceableItems` (`attention-unplaceable.ts:64`)
  - Baseline: returns `[]` for `isThreadKind(job.command)`; classifies inline.
  - Target: a THREAD row with a `threadTurn` is judged like any other job, with
    `toPlacementJob(job, job, { ...job.threadTurn, enabled: input.threadsEnabled })`; a THREAD row with no `threadTurn`
    is skipped (placement skips such a broken row too). All rows go through `judgeUnplaceable`, and
    `RUNNER_FIXABLE_REASONS` handling stays.
- `DryRunInput` gains `threadsEnabled: boolean`; `DashboardService` passes `this.cfg.threadsEnabled`, and its
  `DashboardConfig` `Pick` (`dashboard.service.ts:12`) gains `'threadsEnabled'`.
- `DashboardJobRow` gains optional `threadTurn?: { backend: ThreadBackend; action: ThreadAction; kind: ChatThreadKind; mode: ThreadMode }`.
  `PrismaDashboardRepository.findQueuedWindow` fills it for THREAD rows from the job's `fleetThreadTurn` (`mode`
  absent means `read`, `backend`, `action`) and its thread's `kind` (`WORKSPACE`/`PROJECT`, otherwise `REPO`), the
  same mapping `findThreadAssign` uses.
- `DashboardRunnerRow` gains `protocolVersion: number` and `threadCapacity: number`, selected by `findRunners`;
  `toCandidate` copies both into the `PlacementRunner`.

**US-003 (#425 thread detail)**

- New `PlacementService.queuedVerdict(jobId: string, now: Date, minQueuedSec: number): Promise<QueuedVerdict | null>`,
  with `interface QueuedVerdict { jobId: string; queuedAt: Date; verdict: UnplaceableVerdict; reasons: Array<{ runnerName: string; reason: MisfitReason }> }`.
  Read-only: no transaction lock and no write. `null` when the job is missing, not `QUEUED`, or queued for
  `minQueuedSec` seconds or less, or when `judgeUnplaceable` answers `null`. Otherwise it loads the same inputs
  `placeJob` loads (repo, pause snapshot, `findPlacementRunners(pinned ? [pinned] : undefined)`, loads, thread assign),
  builds the job with `toPlacementJob` and `judgedJob`, and calls `judgeUnplaceable`.
- `ChatThreadDetail` (`chat-thread.domain.ts`) gains `queuedTurn: QueuedVerdict | null`. `ThreadsService.get` and
  `WorkspaceThreadsService.get` set it to
  `placement.queuedVerdict(activeJob.id, new Date(), config.jobQueuedWarnSec)` when `activeJob?.state === 'QUEUED'`,
  else `null`. Both services gain a `PlacementService` constructor dependency, appended as the last constructor parameter
  (already provided in the threads module through `FleetJobsModule`).
- New `QueuedTurnDto` (`apps/api/src/fleet/threads/dto/thread.dto.ts`): `jobId: string`, `queuedAt: string` (ISO),
  `verdict` (enum of `UnplaceableVerdict` without `fits_not_placed`, which `judgeUnplaceable` never returns), `reasons: QueuedTurnReasonDto[]` (`runnerName`, `reason`).
  `ThreadDetailDto` gains `@ApiProperty({ type: QueuedTurnDto, nullable: true }) queuedTurn: QueuedTurnDto | null`, which
  `WorkspaceThreadDetailDto` inherits.

**US-004 (#425 web)**

- `ThreadDetailDto` in `apps/web/lib/thread-types.ts` gains `queuedTurn?: ThreadQueuedTurn | null`, with
  `ThreadQueuedTurn { jobId: string; queuedAt: string; verdict: string; reasons: { runnerName: string; reason: string }[] }`.
- New `apps/web/components/fleet/threads/ThreadQueuedNotice.vue` (auto-registered as `FleetThreadsThreadQueuedNotice`),
  prop `thread: ThreadDetailDto`. It renders nothing when `thread.queuedTurn` is null or absent. Otherwise a
  `role="status"` section `data-testid="thread-queued-notice"` with `fleet.threads.queued.title`, the
  `fleet.threads.queued.verdict.<verdict>` text, and one list item per reason, the text of
  `fleet.threads.queued.reasonOn` with `{runner}` = `runnerName` and `{reason}` = `t('fleet.misfit.<reason>')`.
- Mounted above the timeline on `apps/web/pages/[project]/threads/[id].vue` and `apps/web/pages/threads/[id].vue`.
- While the loaded thread's `activeJob?.state` is `QUEUED`, each page reloads the thread detail every 30 seconds; it
  stops once it is not, and the timer is cleared when the page unmounts.
- `fleet.misfit` in `apps/web/i18n/locales/{en,zh}.json` gains the 7 thread reasons: `thread_capacity`,
  `thread_backend`, `thread_modes`, `threads_disabled`, `thread_write`, `project_threads`, `workspace_threads`.

**US-005 (#426)**

- `FlowStepAction`'s `dispatch` member (`flow-step-decision.ts:66`) gains `accepted?: FlowFinding[]`.
- `decideFlowStep`, for a COMPLETED SPEC_REVIEW or PRD_REVIEW job with a readable verdict:
  - Baseline: no findings with PRD edits applies them only when `canApplyCalls`; with findings, `!canApplyCalls`
    stops with `review_ambiguous` (any ambiguous finding) or `review_findings`.
  - Target, no findings: PRD_REVIEW with `prdEdits.length > 0` and `prdEditsJobId !== job.id` returns `apply_prd_edits`
    (`accepted: []`) whatever `canApplyCalls` is.
  - Target, findings with `canApplyCalls === false` (THREAD entry), in this order:
    1. any `ambiguous` finding: `stop` `review_ambiguous` (unchanged);
    2. more than `FLOW_CALLS_MAX_FINDINGS` findings: `stop` `review_findings` (unchanged);
    3. SPEC_REVIEW: `{ kind: 'dispatch', step: 'PLAN', accepted: verdict.findings }`;
    4. PRD_REVIEW with `prdEdits.length > 0` and `prdEditsJobId !== job.id`:
       `{ kind: 'apply_prd_edits', jobId, edits: verdict.prdEdits, accepted: verdict.findings }`;
    5. PRD_REVIEW with `prdEditsJobId === job.id`: `{ kind: 'dispatch', step: 'RUN' }` (the findings were recorded with the edits);
    6. PRD_REVIEW otherwise: `{ kind: 'dispatch', step: 'RUN', accepted: verdict.findings }`.
  - `canApplyCalls === true` (NAX entry) is unchanged in every branch.
- `FleetFlowAdvanceService.recordStep(flow, featureId, step, jobId, prNumber?)` (`fleet-flow-advance.service.ts:523`)
  - Target: `recordStep(flow, featureId, step, jobId, prNumber?, accepted?: readonly FlowFinding[])`. When `accepted` is
    non-empty, the `flow.step` activity payload gains
    `accepted: accepted.map((f) => truncateFlowText(safeFlowJsonText(f.summary), FLOW_CALL_TEXT_MAX))`, the treatment
    `advancePrdEdits` gives its accepted findings. The dispatch path (`:126`) passes `action.accepted`.
- `FleetFlowAdvanceService` passes `prdEdits: flow.entry === 'NAX'` to `buildStepDispatch`
  (`fleet-flow-advance.service.ts:463`). Target: `prdEdits: true`, so a THREAD-entry PRD_REVIEW task also carries
  `FLOW_PRD_EDITS_INSTRUCTION` (`flow-steps.ts:74`); without it the reviewer never emits edits.
- The RULE and FIX `canApplyCalls` gates (`flow-step-decision.ts:204`, `:231`) are unchanged.

**US-006 and US-007 (#370 validation, storage and routes)**

US-006 owns `apps/api/src/fleet/repos/rule-override.ts` alone (pure, no database). US-007 owns the model, migration,
repository methods, DTOs, service methods, routes, route-command variants, permission key and i18n entry.


- New Prisma model `FleetRepoRuleOverride` (`apps/api/prisma/schema.prisma`), migration
  `apps/api/prisma/migrations/20261204090000_fleet_repo_rule_override/migration.sql`:
  `repoId String @id` (relation to `FleetRepo`, `onDelete: Cascade`), `rules Json` (array of `{ path, content }`),
  `rulesMode String` (`merge` | `replace`), `contextContent String?`, `contextMode String?` (`append` | `replace`),
  `ruleFiles Int`, `sha256 String`, `updatedById String`, `updatedByType String`, `updatedAt DateTime @updatedAt`. `FleetRepo` gains
  `ruleOverride FleetRepoRuleOverride?`.
- New `apps/api/src/fleet/repos/rule-override.ts`:
  - `RULE_OVERRIDE_LIMITS = { maxFiles: 50, maxFileBytes: 32768, maxTotalBytes: 262144, maxContextBytes: 32768, maxPathLength: 200 }`.
  - `RULE_PATH_PATTERN = /^[a-z0-9_-]+(\/[a-z0-9_-]+){0,3}\.md$/` (lowercase only, one to four segments, `.md` file).
    Lowercase-only keeps two paths from naming one file on a case-insensitive filesystem (macOS runners).
  - `validateRuleOverride(raw: unknown): RuleOverrideInput`, with
    `RuleOverrideInput { rules: { path: string; content: string }[]; rulesMode: 'merge' | 'replace'; context: { content: string; mode: 'append' | 'replace' } | null }`.
    `rulesMode` defaults to `merge`, `context.mode` to `append`. Refusals throw `ValidationAppException({ reason }, 'fleet.ruleOverride')`
    (400), with `reason` one of: `rules` (not an array, or more than 50), `path` (fails the pattern or is longer than
    200), `duplicatePath`, `content` (not a string, empty, contains NUL, or over 32,768 UTF-8 bytes), `size` (all
    contents together over 262,144 bytes), `rulesMode`, `context` (not an object, content empty, contains NUL, or over
    32,768 bytes), `contextMode`, `empty` (no rules and no context).
  - `ruleOverrideSha256(input: RuleOverrideInput): string`: lowercase hex SHA-256 of
    `JSON.stringify({ rules: <rules sorted by path>, rulesMode, context })`, so the same content in any order hashes the same.
- `IFleetRepoRepository` gains `findRuleOverride(repoId): Promise<FleetRepoRuleOverrideRecord | null>`,
  `upsertRuleOverride(repoId, input, sha256, actor)` and `deleteRuleOverride(repoId): Promise<boolean>`.
  `FleetRepoRecord` gains optional `ruleOverride?: RuleOverrideSummary | null`, with
  `RuleOverrideSummary { sha256: string; ruleFiles: number; rulesMode: 'merge' | 'replace'; contextMode: 'append' | 'replace' | null; updatedAt: Date }`,
  read by `list` and `findById` from the row's scalar columns (`sha256`, `ruleFiles`, `rulesMode`, `contextMode`,
  `updatedAt`), never from the `rules` Json, so listing repos does not load rule bodies.
- `FleetRepoDto` gains `ruleOverride: RuleOverrideSummaryDto | null` (`updatedAt` as ISO string), from `FleetRepoDto.from`
  (absent gives `null`).
- `FleetReposService` gains `getRuleOverride(id)`, `setRuleOverride(principal, id, raw)` and
  `clearRuleOverride(principal, id)`. Set and clear run in `txManager.run`: unknown repo gives
  `NotFoundAppException({}, 'fleet.repos')`; set validates, hashes, upserts and records an audit entry
  `{ key: 'fleet.repo.rules.configure', resourceType: 'fleet-repo', resourceId: id, projectId, summary: 'rule override set (<n> files, <rulesMode>)' }`;
  clear deletes and records `summary: 'rule override cleared'` only when a row existed. Set and clear both return the
  updated `FleetRepoDto` (with its `ruleOverride` summary); `getRuleOverride` returns the full `RuleOverrideDto`
  (`rules`, `rulesMode`, `context`, `sha256`, `updatedAt`) or `null`.
- `FleetReposController` gains `GET :id/rule-override` (`@UseGuards(RequiresGuard)`, `@Requires('fleet.repo.rules.configure')`,
  not approval-gated, returns `RuleOverrideDto` or `null`, because it returns full rule bodies), `PUT :id/rule-override` and `DELETE :id/rule-override` (both `@HttpCode(200)`, `@UseGuards(RequiresGuard)`,
  `@Requires('fleet.repo.rules.configure')`, `@ApprovalGated()`, mirroring `configureFixUnprotected`), with Swagger
  responses 200/202/400/403/404. The PUT handler calls `validateRuleOverride(body)` before `routeGate.run`, so an invalid
  body answers 400 and never becomes an approval request; the service validates again at execution.
- `FLEET_REPO_ROUTE_VARIANTS` gains `ruleOverrideSet: 'rest:fleet-repos.rule-override.set'` and
  `ruleOverrideClear: 'rest:fleet-repos.rule-override.clear'`; `FleetRepoRouteCommands.onModuleInit` registers both
  for `fleet.repo.rules.configure`.
- `NEW_KEY_SCOPES` (`catalog.ts:126`) gains `'fleet.repo.rules.configure': 'global'` (high risk through the
  `fleet.repo.` prefix, so an agent caller waits for a human by default).
- i18n `apps/api/src/i18n/{en,zh}/fleet.json` gain a `ruleOverride` entry with `"-2"` and `"400"` messages naming
  `{reason}`, as `threads.json` `input` does.

**US-008 (#370 assignment)**

- `AssignPayload` (`packages/fleet-protocol/src/index.ts`, types only) gains
  `ruleOverride?: RuleOverrideAssign`, with
  `RuleOverrideAssign { sha256: string; rulesMode: 'merge' | 'replace'; rules: { path: string; content: string }[]; context?: { content: string; mode: 'append' | 'replace' } }`,
  documented as present only on RUN, PLAN, REVIEW, FIX and AGENT.
- `IFleetJobRepository` gains `findRuleOverride(repoId): Promise<RuleOverrideAssign | null>` and
  `setRuleOverrideSummary(jobId, summary: JobRuleOverrideSummary | null): Promise<void>`, with
  `JobRuleOverrideSummary { sha256: string; ruleFiles: number; rulesMode: 'merge' | 'replace'; contextMode: 'append' | 'replace' | null }`.
- `FleetJob` gains `ruleOverride Json?`, migration
  `apps/api/prisma/migrations/20261204100000_fleet_job_rule_override/migration.sql`. `FleetJobRecord` gains
  optional `ruleOverride?: JobRuleOverrideSummary | null` (absent means none), like `prRulings?`, so existing record
  literals stay valid.
- `buildAssignPayload(job, repo, cloneUrl, gitIdentity, thread?)` (`apps/api/src/fleet/jobs/assign-payload.ts:28`)
  - Target: `buildAssignPayload(job, repo, cloneUrl, gitIdentity, thread?, ruleOverride?: RuleOverrideAssign | null)`;
    spreads `{ ruleOverride }` when it is non-null and `job.command` is one of RUN, PLAN, REVIEW, FIX, AGENT. Otherwise
    the key is absent.
- `PlacementService.assign` (`placement.service.ts:263`)
  - Target: for those five commands it reads `this.repo.findRuleOverride(job.repoId)` inside the placement
    transaction, passes it to `buildAssignPayload`, and calls `setRuleOverrideSummary(job.id, summaryOf(override))`
    (`null` when there is none) right after `casAssign` and before `findById`, so the `after` record that
    `buildAssignPayload` and `transitions.record` use already carries the summary. THREAD and config-kind jobs read nothing and
    write nothing.
- `FleetJobDto` gains `@ApiPropertyOptional({ nullable: true }) ruleOverride: JobRuleOverrideSummaryDto | null` from
  `FleetJobDto.from`.

**US-009 (#370 runner)**

- `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts`)
  - Target: a top-level `ruleOverride` is accepted only on RUN, PLAN, REVIEW, FIX and AGENT. It must be an object with
    `sha256` (64 lowercase hex), `rulesMode` (`merge`|`replace`), `rules` (array of at most 50 `{ path, content }`, path
    matching `^[a-z0-9_-]+(\/[a-z0-9_-]+){0,3}\.md$`, content a string), and an optional `context`
    (`{ content: string, mode: 'append' | 'replace' }`). It is copied into the cleaned assign. Any other shape, or the
    key on another command, fails with `bad('ruleOverride')`.
- New `apps/runner/src/executor/rule-override.ts`:
  `materializeRuleOverride(jobDir: string, override: RuleOverrideAssign): Promise<JobProfileContext>`, with
  `JobProfileContext { rules: { overrideDir: string; overrideMode: 'merge' | 'replace' }; projectContext?: { file: string; mode: 'append' | 'replace' } }`.
  It removes `<jobDir>/koda-rules` and `<jobDir>/koda-context.md` first, writes every rule to
  `<jobDir>/koda-rules/<path>` (directories 0700, files 0600), writes `context.content` to `<jobDir>/koda-context.md`
  when present, and returns absolute paths. A path that resolves outside `<jobDir>/koda-rules` throws
  `Error('rule override path')`.
- `jobProfileContent(outputDir, projectName, relay?, botCostLimitUsd?, modelAliases?)` and `writeJobProfile(...)`
  (`job-profile.ts:31`, `:48`)
  - Target: both gain a last optional `context?: JobProfileContext`. When present, the profile JSON gains
    `context: { rules: { overrideDir, overrideMode }, projectContext?: { file, mode } }`; when absent the profile is
    unchanged.
- `HostExecutor.prepare` (`host-executor.ts:115`) and `HostExecutor.spawnFixStep` (`:212`): when
  `assign.ruleOverride` is present, call `materializeRuleOverride(jobDir, assign.ruleOverride)` and pass the result to
  `writeJobProfile`. `prepareConfigJob` and thread hosting are unchanged.

**US-010 (#370 web)**

- `FleetRepo` (`apps/web/lib/fleet-types.ts`) gains `ruleOverride: FleetRuleOverrideSummary | null`; `FleetJobDto`
  (`fleet-types.ts:295`) gains `ruleOverride?: FleetJobRuleOverride | null`; new `FleetRuleOverride` (full body).
- `useFleetRepos()` gains `getRuleOverride(id): Promise<FleetRuleOverride | null>` (`GET /fleet/repos/${id}/rule-override`),
  `setRuleOverride(id, body)` (`PUT`) and `clearRuleOverride(id)` (`DELETE`). The last two return
  `{ kind: 'pending', request }` when the answer has `permissionKey`, else `{ kind: 'saved', repo }` with the returned
  `FleetRepo`.
- New `apps/web/components/fleet/RepoRuleOverrideDialog.vue` (`FleetRepoRuleOverrideDialog`), prop `repo: FleetRepo`.
  A button `data-testid="fleet-repo-rules-<owner>-<name>"` labelled `fleet.repos.ruleOverride.open` (with the file
  count when `repo.ruleOverride` is set) opens a dialog that loads the override with `getRuleOverride`. It shows one
  row per rule file (path input, content textarea, remove button), an add-file button, a `rulesMode` select (merge,
  replace), a context textarea and a context-mode select (append, replace), plus Save and Clear buttons, all disabled
  without `fleet.repo.rules.configure` in the global permissions. Save sends
  `{ rules: [{ path, content }], rulesMode, context: { content, mode } | null }` (context `null` when the textarea is
  empty). A pending answer shows `fleet.repos.ruleOverride.pending`; a failure shows `extractApiError(err)` in
  `role="alert"`; a saved answer emits `saved` with the returned repo, which the page puts in its `repos` list, so the
  button's file count follows.
- `apps/web/pages/admin/fleet/repos.vue` mounts it in the actions cell for every repo.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` shows `data-testid="fleet-job-rule-override"` when
  `job.ruleOverride` is set: `fleet.jobs.ruleOverride.summary` (worded as the override the job was assigned) with `{files}`, `{mode}`, `{context}` and the first 8
  characters of `sha256`.
- i18n keys `fleet.repos.ruleOverride.*` and `fleet.jobs.ruleOverride.summary` in `en.json` and `zh.json`.

**US-011 (#375)**

- `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` §1.5 gains a decision paragraph.

### Approach

- Placement owns the thread rules. Create, mode change, the dashboard and thread detail all reach them through
  `threadCapabilityMisfit`, `evaluateRunners` and `judgeUnplaceable`, never a copy (`apps/api/CLAUDE.md` dashboard rule).
- Thread create still accepts a thread when no thread-capable runner is enrolled (#399's "fleet not set up" rule).
  Capacity, budget, online state and labels are not judged at create: they are not permanent, and the thread page now
  explains them through `queuedTurn`.
- The mode check judges the thread's own runner when it has one, because every later turn is pinned to it
  (`pinnedRunnerId: thread.runnerId`). A thread that has not run yet is judged against the fleet.
- Thread flows pass non-question findings without editing the spec. PRD edits commit to the flow's branch through the
  existing `FleetFlowCallsService.applyPrdEdits`, whose stale-head guard (head must equal the PLAN result sha) already
  protects a branch that moved under the flow. Every dispatch still goes through the cost-cap and creator-access guards
  in the decide pass, so a passing flow never exceeds `costCapUsd`, and no stop (and so no stop ticket) is written for
  findings the flow handled.
- The rule override travels with the ASSIGN, not a separate fetch, so a readopted job runs with the override it was
  assigned. Turning an override off or changing it affects jobs assigned after the change.
- Mixed versions: an older runner drops the unknown `ruleOverride` field (its parser copies an allow-list) and runs
  with the repo's own rules. An older API never sends it. The job's `ruleOverride` therefore records what was
  assigned, not proof that nax applied it.
- `.nax/` rule files are never edited by this feature. The override lives in the job directory only.

### Failure Handling

| Case | Behaviour |
|---|---|
| Create a PROJECT thread when every thread-capable runner lacks `projectThreads` | 409 `threads.projectThreadsUnavailable`; no thread row |
| Create a WORKSPACE thread when every thread-capable runner lacks `workspaceThreads` | 409 `threads.workspaceThreadsUnavailable`; no thread row |
| Create a REPO thread in `ask`/`full` when every runner offering the backend lacks `threadModes` | 409 `threads.modeUnavailable` with `{mode}`; no thread row |
| No thread-capable runner enrolled | create accepted (unchanged #399 rule) |
| Mode change to `ask`/`full` when the thread's runner lacks `threadModes` | 409 `threads.modeUnavailable`; mode unchanged |
| Mode change to `read` | never refused by this check |
| Queued THREAD job with a turn and no fitting runner, older than `jobQueuedWarnSec` | dashboard `job_unplaceable` item and thread `queuedTurn` |
| Queued THREAD job with no turn row | skipped by the dashboard (no item) |
| Thread flow review with an `ambiguous` finding | stop `review_ambiguous` (unchanged) |
| Thread flow review with more than 20 findings | stop `review_findings` (unchanged) |
| Thread flow passing findings with the cost cap spent | stop `cost_cap` (existing dispatch guard) |
| Rule override (PUT, before the approval gate) with a bad path, duplicate path, oversized content, NUL, bad mode or nothing in it | 400 `fleet.ruleOverride` with the `reason`; nothing stored |
| Rule override route by a caller without `fleet.repo.rules.configure` globally | 403 |
| Agent caller with the key and no approval policy | 202 approval request; nothing stored until a human approves |
| Unknown repo id on a rule-override route | 404 `fleet.repos` |
| ASSIGN with a malformed `ruleOverride`, or one on THREAD/CONFIG | runner `parseAssign` refuses with `bad('ruleOverride')` |
| Job assigned an override on a runner older than this feature | the runner drops the field and nax runs with the repo's rules; the job still shows the assigned summary |
| Rule path resolving outside the job's rules directory | `materializeRuleOverride` throws `rule override path`; the job fails in prepare |

## Out of Scope

- Organisation-wide, per-project and per-job rule sets; this feature adds per-repo overrides only.
- Validating rule-file frontmatter or running nax's neutrality lint in koda; nax checks the override directory when the job runs, and a refusal fails the job as any nax failure does.
- Applying a rule override to CONFIG jobs (`CONFIG_EDIT`, `CONFIG_DRIFT`, `CONFIG`) or to thread sessions.
- A runner capability for rule overrides; an older runner drops the field and runs with the repo's rules.
- A CLI command, assistant tool or MCP tool to read or change a rule override; this feature adds the REST routes and the web dialog only.
- Copying the override into the run bundle; the job's `ruleOverride` summary (sha, counts, modes) is the record.
- Editing `.nax/rules/` or `.nax/context.md` in any repo; the existing S3 config-edit flow still owns in-repo rule changes.
- Sending review findings back to the thread and resuming the flow on the next publish (#426 option 1).
- Writing review spec calls into a thread flow's spec; spec calls stay NAX-entry only.
- Changing the RULE and FIX steps' thread-entry gates (`flow-step-decision.ts:204`, `:231`).
- A new web view of the flow's accepted findings; they are recorded in the `flow.step` and `flow.prd_edits` activity payloads.
- Judging runner capacity, online state, labels or budget at thread create or mode change.
- Writing `FleetJob.stateReason` for a queued THREAD job; the reason is computed on read (dashboard, thread detail).
- Live push of the queued-turn reason; the thread page polls every 30 seconds while the turn is queued.
- Swapping koda's thread skill tools for nax's resource catalog (#375); the decision is recorded, no runtime change.
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` for `fleet.repo.rules.configure`; new keys live in `NEW_KEY_SCOPES`, as `fleet.repo.fix.unprotected` does.
- Concurrent writes of one repo's rule override; the last committed write wins.
- Re-recording accepted findings when the decide pass recovers a dispatch after a crash (`recordStep` recovery path); the replayed `flow.step` activity carries no `accepted` list.
- US-007 only: rate limiting the rule-override routes beyond the global throttler; they are global-admin, approval-gated writes.

## Stories

### US-001: Thread create and mode change refuse a thread no runner can host

No dependencies. Workdir: apps/api. Adds `threadCapabilityMisfit` and makes `firstMisfit` call it, replaces
`anyRunnerServesBackend` with `threadServeMisfit` and `assertBackendServed` with `assertThreadServed`, adds
`ThreadsService.assertModeServed` and wires it into the mode route and service, passes kind and mode from both create
routes and services, adds the three `threads.*Unavailable` i18n keys in en and zh, updates the 409 Swagger
descriptions, and regenerates `openapi.json` and the CLI types (`bun run generate`).

### US-002: The dashboard dry-run judges THREAD jobs

Depends on US-001. Workdir: apps/api. Adds `unplaceable-verdict.ts` (`judgeUnplaceable`, with `UnplaceableVerdict`
moved there and re-exported from `dashboard.types.ts`), routes `jobUnplaceableItems` through it without the THREAD
skip, adds `thread_capacity` to the waiting reasons, adds `threadTurn` to queued dashboard rows and
`protocolVersion`/`threadCapacity` to dashboard runner rows, and passes `threadsEnabled` into the dry-run.

### US-003: Thread detail explains a queued turn

Depends on US-002. Workdir: apps/api. Adds `PlacementService.queuedVerdict`, `ChatThreadDetail.queuedTurn`, the
`QueuedTurnDto`/`QueuedTurnReasonDto` classes and the `ThreadDetailDto.queuedTurn` field, sets it in
`ThreadsService.get` and `WorkspaceThreadsService.get`, and regenerates `openapi.json` and the CLI types.

### US-004: Thread pages show the queued-turn reason

Depends on US-003. Workdir: apps/web. Adds `ThreadDetailDto.queuedTurn`, the `FleetThreadsThreadQueuedNotice`
component mounted on both thread pages, the 30-second reload while the active turn is queued, the
`fleet.threads.queued.*` keys and the 7 thread `fleet.misfit.*` labels in en and zh.

### US-005: Thread-entry flows pass non-question review findings

No dependencies. Workdir: apps/api. Changes `decideFlowStep` and the `dispatch` action as in Design, and makes
`recordStep` record accepted findings.

### US-006: Rule override validation

No dependencies. Workdir: apps/api. Adds `apps/api/src/fleet/repos/rule-override.ts` with `RULE_OVERRIDE_LIMITS`,
`RULE_PATH_PATTERN`, `RuleOverrideInput`, `validateRuleOverride` and `ruleOverrideSha256`, as in Design. No database,
route or caller.

### US-007: Per-repo rule override storage and routes

Depends on US-006. Workdir: apps/api. Adds the `FleetRepoRuleOverride` model and migration, the repository methods,
`FleetRepoRecord.ruleOverride` and `FleetRepoDto.ruleOverride`, `FleetReposService.getRuleOverride`,
`setRuleOverride` and `clearRuleOverride`, the GET, PUT and DELETE `:id/rule-override` routes, the two route-command
variants, the `fleet.repo.rules.configure` key, the `fleet.ruleOverride` i18n entry in en and zh, and regenerates
`openapi.json` and the CLI types.

### US-008: Placement sends the rule override and the job records it

Depends on US-007. Workdir: apps/api. Adds `RuleOverrideAssign` and `AssignPayload.ruleOverride` to
`packages/fleet-protocol/src/index.ts` (types only), the `FleetJob.ruleOverride` column and migration, the two job
repository methods, the `buildAssignPayload` parameter, the `PlacementService.assign` read and summary write, and
`FleetJobDto.ruleOverride`, and regenerates `openapi.json` and the CLI types.

### US-009: The runner hands the rule override to nax

Depends on US-008. Workdir: apps/runner. `parseAssign` accepts `ruleOverride`, `materializeRuleOverride` writes it,
and `prepare` and `spawnFixStep` pass the result into the per-job profile.

### US-010: Admin web for rule overrides

Depends on US-007, US-008. Workdir: apps/web. Adds the web types, the three `useFleetRepos` calls, the
`FleetRepoRuleOverrideDialog` component on the admin Repos page, the job-page summary line and the en/zh keys.

### US-011: Record the thread skill tools decision

**No-test:** documentation only; no code path reads this file.

No dependencies. Workdir: . Adds a decision paragraph for #375 to §1.5 of
`docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md`: koda keeps `load_skill` and `read_skill_file`
because nax's resource catalog and skills provider are in the `@nathapp/nax` CLI package
(`packages/nax/src/resources/`), not exported by `@nathapp/nax-agent` (which exports only the `ToolProvider` and
`ProviderTool` types); the runner depends on nax-agent alone; and koda's skills are an API snapshot delivered in the
ASSIGN, not a disk scan. Revisit if nax-agent exports the catalog.

### Context Files

**US-001**

- `apps/api/src/fleet/jobs/placement-rules.ts` — `firstMisfit` and `servesThreadBackend`
- `apps/api/src/fleet/threads/thread-backend-served.ts` — `assertBackendServed`, `refusalArgs`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `anyRunnerServesBackend`
- `apps/api/src/fleet/threads/threads.service.ts` — `create`, `changeMode`
- `apps/api/test/integration/fleet/thread-backend-unavailable.integration.spec.ts` — #399 integration pattern

**US-002**

- `apps/api/src/fleet/dashboard/attention-unplaceable.ts` — `jobUnplaceableItems`, `classify`
- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts` — `findRunners`, `findQueuedWindow`
- `apps/api/src/fleet/dashboard/dashboard.service.ts` — dry-run input
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign` kind and mode mapping
- `apps/api/src/fleet/dashboard/attention-unplaceable.spec.ts` — existing dry-run tests

**US-003**

- `apps/api/src/fleet/jobs/placement.service.ts` — `placeJob` inputs and `judgedJob`
- `apps/api/src/fleet/threads/threads.service.ts` — `get`
- `apps/api/src/fleet/threads/workspace-threads.service.ts` — `get`
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDetailDto`
- `apps/api/src/fleet/jobs/unplaceable-verdict.ts` — created by US-002, called here

**US-004**

- `apps/web/lib/thread-types.ts` — `ThreadDetailDto`
- `apps/web/pages/[project]/threads/[id].vue` — project thread page
- `apps/web/pages/threads/[id].vue` — workspace thread page
- `apps/web/components/fleet/threads/ThreadStaleBanner.vue` — notice pattern
- `apps/web/lib/thread-controller.ts` — thread reload

**US-005**

- `apps/api/src/fleet/flows/flow-step-decision.ts` — `decideFlowStep`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `recordStep`, dispatch path, `advancePrdEdits`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — existing decision tests
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts` — PRD edit advance tests

**US-006**

- `apps/api/src/fleet/flows/flow-prd-edits.ts` — a pure validator of untrusted text in this codebase, for its style
- `apps/api/src/fleet/repos/dto/update-fix-checks.dto.ts` — DTO style in the repos module

**US-007**

- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `configureFixUnprotected`
- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — `configureFixUnprotected` route
- `apps/api/src/fleet/repos/fleet-repo-route.commands.ts` — variants and registration
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — `toDomain`, `list`, `findById`
- `apps/api/test/integration/fleet/fleet-repo-fix-unprotected-route.integration.spec.ts` — route integration pattern

**US-008**

- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`
- `apps/api/src/fleet/jobs/placement.service.ts` — `assign`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findRepo`, record mapping
- `apps/api/test/integration/fleet/placement-fix-trust.integration.spec.ts` — ASSIGN payload integration pattern

**US-009**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`
- `apps/runner/src/executor/job-profile.ts` — `jobProfileContent`, `writeJobProfile`
- `apps/runner/src/executor/host-executor.ts` — `prepare`, `spawnFixStep`
- `apps/runner/test/unit/host-executor.spec.ts` — executor test pattern

**US-010**

- `apps/web/components/fleet/RepoFixUnprotected.vue` — permission, pending and error pattern
- `apps/web/composables/useFleetRepos.ts` — `setFixUnprotected`
- `apps/web/pages/admin/fleet/repos.vue` — actions cell
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — job header

**US-011**

- `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` — §1.5 skill tools

### Creates

**US-001**

- `apps/api/test/integration/fleet/thread-capability-unavailable.integration.spec.ts`

**US-002**

- `apps/api/src/fleet/jobs/unplaceable-verdict.ts`
- `apps/api/src/fleet/jobs/unplaceable-verdict.spec.ts`
- `apps/api/test/integration/fleet/dashboard-thread-unplaceable.integration.spec.ts`

**US-003**

- `apps/api/src/fleet/jobs/placement-queued-verdict.spec.ts`
- `apps/api/test/integration/fleet/thread-queued-turn.integration.spec.ts`

**US-004**

- `apps/web/components/fleet/threads/ThreadQueuedNotice.vue`
- `apps/web/tests/components/thread-queued-notice.spec.ts`

**US-005**

- `apps/api/src/fleet/flows/flow-step-decision-thread-entry.spec.ts`

**US-006**

- `apps/api/src/fleet/repos/rule-override.ts`
- `apps/api/src/fleet/repos/rule-override.spec.ts`

**US-007**

- `apps/api/prisma/migrations/20261204090000_fleet_repo_rule_override/migration.sql`
- `apps/api/src/fleet/repos/fleet-repos.rule-override.spec.ts`
- `apps/api/test/integration/fleet/fleet-repo-rule-override-route.integration.spec.ts`

**US-008**

- `apps/api/prisma/migrations/20261204100000_fleet_job_rule_override/migration.sql`
- `apps/api/test/integration/fleet/placement-rule-override.integration.spec.ts`

**US-009**

- `apps/runner/src/executor/rule-override.ts`
- `apps/runner/src/executor/rule-override.spec.ts`

**US-010**

- `apps/web/components/fleet/RepoRuleOverrideDialog.vue`
- `apps/web/tests/components/repo-rule-override-dialog.spec.ts`

### Modifies

**US-001**

- `apps/api/src/fleet/threads/thread-backend-served.spec.ts` — its cases call `assertBackendServed` with a stub `anyRunnerServesBackend`; they move to `assertThreadServed` with a stub `threadServeMisfit` returning `'thread_backend'` or `null`, keeping the same `threads.backendUnavailable` field/value expectations, and gain the three new-cause cases.
- `apps/api/src/fleet/threads/threads.service.spec.ts` — the #399 cases mock `anyRunnerServesBackend`; they mock `threadServeMisfit` instead and expect it called with `{ backend, kind, mode }`; the repository mock in its `build()` gains `threadServeMisfit` in place of `anyRunnerServesBackend`.
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — the #399 case mocks `anyRunnerServesBackend`; it mocks `threadServeMisfit` and expects `{ backend, kind: 'WORKSPACE', mode: 'read' }`.
- `apps/api/src/fleet/threads/threads.controller.spec.ts` — the create case spies `assertBackendServed(backend)`; it spies `assertThreadServed` with `{ backend, kind, mode }`, and the service mock gains `assertModeServed` for the mode route.
- `apps/api/src/fleet/threads/workspace-threads.controller.keys.spec.ts` — its service mock exposes `assertBackendServed`; it exposes `assertThreadServed` instead.
- `apps/api/src/fleet/jobs/placement-rules.spec.ts` — gains the US-001 `threadCapabilityMisfit` cases; the existing `firstMisfit` thread cases stay unchanged because the results are the same.
- `apps/api/test/integration/fleet/thread-backend-unavailable.integration.spec.ts` — its runner fixtures advertise only `threadBackends`; fixtures that create PROJECT or WORKSPACE threads or ask/full REPO threads gain `projectThreads`, `workspaceThreads` or `threadModes: true` so they keep testing the backend refusal alone.
- `apps/api/test/integration/fleet/gated-project-thread-routes.integration.spec.ts` — runner fixtures gain `projectThreads: true` and `threadModes: true` where the case creates a PROJECT thread or an ask/full REPO thread, so the gate cases still reach the approval gate.
- `apps/api/test/integration/fleet/gated-thread-handoff-routes.integration.spec.ts` — runner fixtures gain `threadModes: true` where a case creates an ask/full REPO thread or changes mode to ask/full, so the gate cases still reach the gate.
- `apps/api/test/integration/fleet/gated-thread-session-routes.integration.spec.ts` — runner fixtures gain `threadModes: true` where a case creates an ask/full REPO thread or changes mode to ask/full, so the gate cases still reach the gate.
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts` — runner fixtures gain `workspaceThreads: true`, so workspace thread create still reaches its permission checks.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — runner fixtures used by thread create gain the capability for the thread kind and mode they create, so the endpoint cases still answer 201.
- `apps/api/src/fleet/threads/thread-mode-change.spec.ts` — `ThreadsService.changeMode` now calls `assertModeServed` before the repository; the service built at `:39` with `{} as never` collaborators gets a repository stub whose `get` returns the thread and whose `threadServeMisfit` resolves `null`, and the controller case at `:173-184` gives its service mock `assertModeServed`; existing expectations are unchanged.
- `apps/api/test/integration/fleet/thread-mode-change.integration.spec.ts` — the `live()` runner at `:29-30` keeps `threadModes: true`, which the mode-only check needs; any fixture that changes to ask/full on a runner without `threadModes` now expects 409 `threads.modeUnavailable`; existing 200 cases are unchanged.
- `apps/api/test/integration/fleet/workspace-turns.integration.spec.ts` — the `workspaceThreads=false` case (`:144-150`) creates its thread before it disables the other runners and inserts the runner with `workspaceThreads: false`, so create still answers 201 and the placement assertion is unchanged.
- `apps/api/test/integration/fleet/fleet-project-thread-placement.integration.spec.ts` — AC-6 and the cases at `:30-35` and `:87-92` create the PROJECT thread while a `projectThreads: true` runner is enabled (or before the lacking runner syncs), so create answers 201 when the file runs alone; placement assertions are unchanged.
- `apps/api/src/i18n/en/threads.json` — gains `projectThreadsUnavailable`, `workspaceThreadsUnavailable` and `modeUnavailable`; existing keys unchanged.
- `apps/api/src/i18n/zh/threads.json` — gains the same three keys in Chinese; existing keys unchanged.
- `openapi.json` — regenerated by `bun run generate` for the 409 descriptions; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.

**US-002**

- `apps/api/src/fleet/dashboard/attention-unplaceable.spec.ts` — the case asserting a QUEUED THREAD job yields no item now asserts a THREAD row without `threadTurn` yields no item; a THREAD row with a turn is judged (US-002 cases). Fixtures gain `threadsEnabled` in `DryRunInput`.
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — `UnplaceableVerdict` becomes a re-export from the new jobs module unplaceable-verdict; `DashboardJobRow` gains optional `threadTurn`; `DashboardRunnerRow` gains `protocolVersion` and `threadCapacity`.
- `apps/api/src/common/test-helpers/fleet-dashboard.ts` — its runner-row builder gains `protocolVersion: 4` and `threadCapacity: 2` defaults so existing dashboard tests still type-check.
- `apps/api/src/fleet/dashboard/attention-rules.spec.ts` — its `dryRun` fixture gains `threadsEnabled: true`; expectations are unchanged.
- `apps/api/src/fleet/dashboard/dashboard.service.spec.ts` — expects `buildAttention`'s dry-run input to carry `threadsEnabled` from config; runner rows gain the two fields.
- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.spec.ts` — `findRunners` select expectations gain `protocolVersion` and `threadCapacity`.
- `apps/api/src/fleet/dashboard/dashboard.service.ts` — its `DashboardConfig` `Pick` gains `'threadsEnabled'` and the dry-run input passes it.

**US-003**

- `apps/api/src/fleet/threads/threads.service.spec.ts` — `get` cases expect `queuedTurn` (null unless the active job is QUEUED); the `build()` helper and every positional `new ThreadsService(...)` site gain a trailing `PlacementService` mock with `queuedVerdict`.
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — `get` cases expect `queuedTurn`; every positional `new WorkspaceThreadsService(...)` site gains a trailing `PlacementService` mock.
- `apps/api/src/fleet/threads/thread-mode-change.spec.ts` — its positional `new ThreadsService(...)` call at `:39` gains the `PlacementService` argument (appended last); expectations unchanged.
- `apps/api/src/fleet/threads/workspace-turns.spec.ts` — its positional `new WorkspaceThreadsService(...)` calls (`:18`, `:59`, `:73`) gain the `PlacementService` argument (appended last); expectations unchanged.
- `apps/api/test/integration/thread-flow-preapproval.integration.spec.ts` — its positional service constructions (`:125`, `:131`) gain the `PlacementService` argument (appended last); expectations unchanged.
- `apps/api/src/fleet/threads/threads.module.spec.ts` — the module compile must still resolve `ThreadsService` and `WorkspaceThreadsService` with the new `PlacementService` dependency; a provider mock is added only if the compile needs one, and no assertion changes.
- `openapi.json` — regenerated for `QueuedTurnDto` and `ThreadDetailDto.queuedTurn`; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.

**US-004**

- `apps/web/i18n/locales/en.json` — gains `fleet.threads.queued.*` and the 7 thread `fleet.misfit.*` labels; existing keys unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys in Chinese.
- `apps/web/tests/helpers/mount-sfc.ts` — add `FleetThreadsThreadQueuedNotice` to the component-file maps and the component-name union so page tests can mount the real component; existing entries unchanged.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — gains the US-004 project-page notice and 30-second reload cases; its thread fixture gains `queuedTurn: null`, and existing assertions are unchanged.
- `apps/web/tests/pages/workspace-thread-detail-page.spec.ts` — gains the US-004 workspace-page notice case; its thread fixture gains `queuedTurn: null`, and existing assertions are unchanged.

**US-005**

- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — cases asserting a `canApplyCalls: false` SPEC_REVIEW or PRD_REVIEW with only `minor`/`answered` findings returns `stop` `review_findings` now expect the US-005 dispatch or `apply_prd_edits` actions; the case asserting no PRD edits for `canApplyCalls: false` with a clean verdict now expects `apply_prd_edits`; ambiguous and over-20 cases are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — `US-009 AC-8: thread PRD_REVIEW omits the PRD edits instruction` (`:1165`) flips to expect the THREAD-entry PRD_REVIEW task to contain `FLOW_PRD_EDITS_INSTRUCTION`; any THREAD-entry case that expects a `review_findings` stop on minor findings now expects the next step's dispatch; NAX-entry cases are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — `AC-15: thread-entry findings stop rather than applying calls` (`:282-287`, a `minor` finding on a THREAD flow) now expects a PLAN dispatch and no stop; `calls.apply` is still not called.
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — `AC-10: a SPEC_REVIEW finding stops the flow` (`:129-136`) uses one `minor` finding; for the THREAD flow it creates it now expects the flow `RUNNING` with a PLAN job dispatched; a stop case keeps its intent with an `ambiguous` finding.
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts` — a THREAD-entry flow now applies PRD edits; any case asserting THREAD entry skips them flips to expect the commit.

**US-006**

None. US-006 only creates `rule-override.ts` and its spec; no existing test pins a shape it changes.

**US-007**

- `apps/api/prisma/schema.prisma` — gains the `FleetRepoRuleOverride` model and the `FleetRepo.ruleOverride` relation.
- `apps/api/src/fleet/repos/fleet-repo-route.commands.spec.ts` — `Object.values(FLEET_REPO_ROUTE_VARIANTS)` length 6 becomes 8; the case table gains `ruleOverrideSet` and `ruleOverrideClear` (key `fleet.repo.rules.configure`), and the repos mock gains `setRuleOverride` and `clearRuleOverride`.
- `apps/api/src/fleet/repos/dto/fleet-repo.dto.spec.ts` — gains the `FleetRepoDto.from` `ruleOverride` cases (absent gives `null`); existing cases unchanged.
- `apps/api/src/permissions/catalog.spec.ts` — its `NEW_KEY_SCOPES` copy gains `'fleet.repo.rules.configure': 'global'`.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated for the new key's row cells; never hand-edited beyond the regenerated output.
- `apps/api/src/permissions/role-matrix.spec.ts` — `toHaveLength(245)` for each row's cells becomes 246.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — `gatedOperations` gains the put and delete operations on /api/fleet/repos/{id}/rule-override; the 146 count in the describe title and AC-5 becomes 148.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count 146 becomes 148, with the comment naming the two rule-override routes.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — gains cases for the three rule-override operations and rows for the PUT and DELETE routes with key `fleet.repo.rules.configure` in the global admin route table; existing cases unchanged.
- `apps/api/src/fleet/repos/fleet-admin-gates.spec.ts` — gains the two gated rule-override routes in its admin gate table; existing rows unchanged.
- `apps/api/src/i18n/en/fleet.json` — gains the `ruleOverride` entry with a `"400"` message; existing keys unchanged.
- `apps/api/src/i18n/zh/fleet.json` — gains the same entry in Chinese; existing keys unchanged.
- `openapi.json` — regenerated by `bun run generate`; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.

**US-008**

- `apps/api/prisma/schema.prisma` — gains `FleetJob.ruleOverride Json?`.
- `packages/fleet-protocol/src/index.ts` — gains `RuleOverrideAssign` and `AssignPayload.ruleOverride` (types only).
- `apps/api/src/fleet/jobs/assign-payload.spec.ts` — gains the US-008 `ruleOverride` cases; existing cases unchanged because an absent override leaves the payload as it is.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` — gains the `ruleOverride` mapping case; fixtures gain `ruleOverride: null`.
- `apps/api/src/fleet/jobs/placement.service.agents-run.spec.ts` — its job-repository mock gains `findRuleOverride` (resolving `null`) and `setRuleOverrideSummary`, because `assign` now calls them for AGENT jobs; existing assertions unchanged.
- `apps/api/src/fleet/jobs/placement.service.provider-vault.spec.ts` — its job-repository mock gains `findRuleOverride` (resolving `null`) and `setRuleOverrideSummary`, because `assign` now calls them for nax jobs; existing assertions unchanged.
- `apps/api/src/fleet/jobs/placement.service.queued-scan.spec.ts` — its job-repository mock gains `findRuleOverride` (resolving `null`) and `setRuleOverrideSummary`, because `assign` now calls them for nax jobs; existing assertions unchanged.
- `apps/api/src/fleet/jobs/placement.service.trust-domain.spec.ts` — its job-repository mock gains `findRuleOverride` (resolving `null`) and `setRuleOverrideSummary`, because `assign` now calls them for nax jobs; existing assertions unchanged.
- `openapi.json` — regenerated by `bun run generate`; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.

**US-009**

- `apps/runner/src/supervisor/assign-parser.spec.ts` — gains the US-009 `ruleOverride` cases; existing cases unchanged.
- `apps/runner/src/executor/job-profile.spec.ts` — gains the `context` cases; existing cases unchanged because an absent `context` leaves the profile as it is.
- `apps/runner/test/unit/host-executor.spec.ts` — gains the `prepare` and `spawnFixStep` cases with a `ruleOverride`; existing cases unchanged.

**US-010**

- `apps/web/lib/fleet-types.ts` — `FleetRepo` gains `ruleOverride`, `FleetJobDto` gains optional `ruleOverride`, new `FleetRuleOverride`.
- `apps/web/composables/useFleetRepos.ts` — gains the three rule-override calls.
- `apps/web/pages/admin/fleet/repos.vue` — mounts `FleetRepoRuleOverrideDialog` in the actions cell.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — shows the rule-override summary.
- `apps/web/i18n/locales/en.json` — gains `fleet.repos.ruleOverride.*` and `fleet.jobs.ruleOverride.summary`.
- `apps/web/i18n/locales/zh.json` — gains the same keys in Chinese.
- `apps/web/tests/helpers/mount-sfc.ts` — add `FleetRepoRuleOverrideDialog: 'RepoRuleOverrideDialog.vue'` to both component-file maps and the name union; existing entries unchanged.
- `apps/web/tests/pages/admin-fleet-repos.spec.ts` — its `FleetRepo` fixtures gain `ruleOverride: null`, and the page mounts the real `FleetRepoRuleOverrideDialog`; existing switch-count assertions unchanged.
- `apps/web/tests/components/repo-auto-review.spec.ts` — its `FleetRepo` fixture gains `ruleOverride: null` so it still matches the type.
- `apps/web/tests/components/repo-fix-checks.spec.ts` — its `FleetRepo` fixture gains `ruleOverride: null` so it still matches the type.
- `apps/web/tests/components/repo-fix-unprotected.spec.ts` — its `FleetRepo` fixture gains `ruleOverride: null` so it still matches the type.
- `apps/web/tests/composables/useFleetRepos.spec.ts` — gains the three rule-override cases; `FleetRepo` fixtures gain `ruleOverride: null`.

**US-011**

- `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` — §1.5 gains the #375 decision paragraph; nothing else in the document changes.

### Seams

- US-001 -> US-002: `threadCapabilityMisfit` is what `firstMisfit` calls, so the dashboard dry-run (through `evaluateRunners`) reports the same thread reasons placement uses; US-002's tests drive `jobUnplaceableItems`, not the helper.
- US-002 -> US-003: `PlacementService.queuedVerdict` calls `judgeUnplaceable`; US-003's unit test observes the verdict through `queuedVerdict`, the service entry point.
- US-003 -> US-004: wire field `queuedTurn` on `GET /api/projects/{slug}/threads/{id}` and `GET /api/threads/{id}`: `null` or `{ "jobId": string, "queuedAt": ISO string, "verdict": "never" | "waiting_capacity" | "runners_paused" | "no_fit" | "no_runners" | "budget_paused", "reasons": [{ "runnerName": string, "reason": MisfitReason }] }`.
- US-006 -> US-007: `setRuleOverride` calls `validateRuleOverride` and `ruleOverrideSha256`; US-007's integration ACs prove the route refuses what the validator refuses and stores the hash it computes.
- US-007 -> US-008: the `FleetRepoRuleOverride` row written by `setRuleOverride` is what `findRuleOverride` reads at assignment; US-008's integration ACs store it through the US-007 route.
- US-008 -> US-009: wire field `ruleOverride` at the top level of the ASSIGN command payload: `{ "sha256": 64-hex string, "rulesMode": "merge" | "replace", "rules": [{ "path": string, "content": string }], "context"?: { "content": string, "mode": "append" | "replace" } }`.
- US-007 -> US-010: the web sends `PUT /fleet/repos/{id}/rule-override` with JSON body `{ "rules": [{ "path": "api.md", "content": "..." }], "rulesMode": "merge", "context": { "content": "...", "mode": "append" } }` (context may be `null`), `DELETE` with no body; both answer `FleetRepoDto` (or an approval request). It reads `GET` as `RuleOverrideDto` or `null`, and reads `ruleOverride` from `FleetRepoDto`.
- US-008 -> US-010: the job page reads `ruleOverride` from `FleetJobDto` as `null` or `{ "sha256", "ruleFiles", "rulesMode", "contextMode" }`.

## Acceptance Criteria

### US-001

1. [unit] `threadCapabilityMisfit` for a PROJECT SESSION thread on capabilities that offer a native model but whose `projectThreads` is not `true` returns `'project_threads'`.
2. [unit] `threadCapabilityMisfit` for a WORKSPACE SESSION thread on capabilities whose `workspaceThreads` is not `true` returns `'workspace_threads'`.
3. [unit] `threadCapabilityMisfit` for a REPO SESSION in mode `ask` on capabilities whose `threadModes` is not `true` returns `'thread_modes'`.
4. [unit] `threadCapabilityMisfit` for a REPO SESSION in mode `read` on the same capabilities, with a served backend, returns `null`.
5. [unit] `threadCapabilityMisfit` for a REPO SESSION in mode `full` with `threadModes: true` and a backend model the capabilities do not offer returns `'thread_backend'`.
6. [unit] `assertThreadServed` with a stub `threadServeMisfit` resolving `'project_threads'` rejects with a 409 whose i18n key is `threads.projectThreadsUnavailable`.
7. [unit] `assertThreadServed` with the stub resolving `'workspace_threads'` rejects with key `threads.workspaceThreadsUnavailable`.
8. [unit] `assertThreadServed` with the stub resolving `'thread_modes'` for need mode `full` rejects with key `threads.modeUnavailable` and args `{ mode: 'full' }`.
9. [integration] With the test Postgres and one enabled runner at protocol 4 that offers a native model but not `projectThreads`, `POST /api/projects/:slug/threads` for a PROJECT thread answers 409 with the `threads.projectThreadsUnavailable` message.
10. [integration] With one enabled runner that offers the backend but not `workspaceThreads`, `POST /api/threads` for a WORKSPACE thread answers 409 with the `threads.workspaceThreadsUnavailable` message.
11. [integration] With one enabled runner that offers the backend without `threadModes`, `POST /api/projects/:slug/threads` for a REPO thread in mode `ask` answers 409 with the `threads.modeUnavailable` message naming `ask`.
12. [integration] With two enabled runners, one offering the backend without `threadModes` and one with `threadModes: true` that does not offer the backend, creating a REPO thread in mode `full` for that backend answers 409 with the `threads.backendUnavailable` message.
13. [integration] With no enabled runner at protocol 4 or later, `POST /api/projects/:slug/threads` for a PROJECT thread answers 201.
14. [integration] `PATCH /api/projects/:slug/threads/:id/mode` with `{ "mode": "ask" }` on a REPO thread whose `runnerId` names a runner without `threadModes` answers 409 with `threads.modeUnavailable` while another enabled runner has `threadModes: true`.
15. [integration] `PATCH /api/projects/:slug/threads/:id/mode` with `{ "mode": "ask" }` on a REPO thread whose runner has `threadModes: true` but no longer offers the thread's backend answers 200 (the mode check judges only `threadModes`).

### US-002

1. [unit] `judgeUnplaceable` with `scopePaused: true` returns `{ verdict: 'budget_paused', severity: 'warning', misfits: [] }`.
2. [unit] `judgeUnplaceable` with an empty `pool` returns `{ verdict: 'no_runners', severity: 'error', misfits: [] }`.
3. [unit] `judgeUnplaceable` returns `null` when at least one runner in the pool has no misfit.
4. [unit] `judgeUnplaceable` where every runner fails `thread_capacity` returns verdict `waiting_capacity` with severity `warning`.
5. [unit] `judgeUnplaceable` where every runner fails `disabled` returns verdict `never` with severity `error`.
6. [unit] `judgeUnplaceable` lists misfits sorted by `runnerName`, then `runnerId`.
7. [unit] `jobUnplaceableItems` for a QUEUED THREAD row queued 120 s ago (warn 60 s) whose `threadTurn` backend model no runner offers yields one `job_unplaceable` item whose `reasons` give `thread_backend` for every runner.
8. [unit] `jobUnplaceableItems` for a QUEUED THREAD row without `threadTurn` yields no item.
9. [unit] `jobUnplaceableItems` for a QUEUED THREAD row with `threadTurn` and `threadsEnabled: false` yields an item whose reasons are `threads_disabled` for every runner.
10. [unit] `jobUnplaceableItems` for a QUEUED THREAD row pinned to a runner whose `threadCapacity` is 1 and which holds one thread yields an item with verdict `waiting_capacity`.
11. [unit] `jobUnplaceableItems` for a QUEUED THREAD row that a runner at protocol 4, with a free thread slot and the backend, can take yields no item.
12. [integration] With the test Postgres, a QUEUED THREAD job whose turn's backend model no enabled runner offers, queued longer than `jobQueuedWarnSec`, appears in `GET /api/fleet/dashboard` `attention` as `job_unplaceable` with reason `thread_backend` for that runner.
13. [integration] `PrismaDashboardRepository.findRunners` returns each runner's `protocolVersion` and `threadCapacity`.
14. [integration] `PrismaDashboardRepository.findQueuedWindow` returns a THREAD row's `threadTurn` with the turn's `backend`, `action` and `mode` and the thread's `kind`.

### US-003

1. [unit] `PlacementService.queuedVerdict` returns `null` for a job whose state is `RUNNING`.
2. [unit] `queuedVerdict` returns `null` for a QUEUED job queued 30 s ago with `minQueuedSec` 60.
3. [unit] `queuedVerdict` for a QUEUED THREAD job queued 120 s ago whose only runner misses the turn's backend returns `{ jobId, queuedAt, verdict: 'no_fit', reasons: [{ runnerName, reason: 'thread_backend' }] }`.
4. [unit] `queuedVerdict` for a job pinned to runner `r1` asks `findPlacementRunners` for exactly `['r1']`.
5. [unit] `queuedVerdict` returns `null` for a QUEUED job queued 120 s ago when one runner fits it.
6. [unit] `ThreadsService.get` returns `queuedTurn: null` without calling `queuedVerdict` when the thread's `activeJob` is `RUNNING`.
7. [unit] `ThreadsService.get` with `activeJob` `{ id: 'j1', state: 'QUEUED' }` calls `queuedVerdict` with `'j1'`, a `Date` and the configured `jobQueuedWarnSec`, and returns its result as `queuedTurn`.
8. [unit] `WorkspaceThreadsService.get` with a QUEUED `activeJob` returns the result of `queuedVerdict` as `queuedTurn`.
9. [integration] With the test Postgres, a REPO thread whose QUEUED turn has been queued longer than `jobQueuedWarnSec` and whose pinned runner no longer offers the backend answers `GET /api/projects/:slug/threads/:id` with `queuedTurn.verdict` `no_fit` and one reason naming that runner with `thread_backend`.
10. [integration] The same thread with a turn queued less than `jobQueuedWarnSec` ago answers `queuedTurn: null`.
11. [unit] The committed `openapi.json` `ThreadDetailDto` schema has a `queuedTurn` property referencing `QueuedTurnDto`, whose properties are exactly `jobId`, `queuedAt`, `verdict` and `reasons`.

### US-004

1. [unit] `FleetThreadsThreadQueuedNotice` renders no `thread-queued-notice` element when `thread.queuedTurn` is `null`.
2. [unit] `FleetThreadsThreadQueuedNotice` renders no `thread-queued-notice` element when `thread.queuedTurn` is absent.
3. [unit] With `queuedTurn` `{ verdict: 'no_fit', reasons: [{ runnerName: 'r1', reason: 'thread_backend' }] }`, it renders a `role="status"` element `data-testid="thread-queued-notice"` that shows the `fleet.threads.queued.title` text.
4. [unit] With that `queuedTurn`, it shows the `fleet.threads.queued.verdict.no_fit` text.
5. [unit] With that `queuedTurn`, it renders one list item whose text is `fleet.threads.queued.reasonOn` with runner `r1` and the `fleet.misfit.thread_backend` label.
6. [unit] The project thread page `pages/[project]/threads/[id].vue` renders `thread-queued-notice` for a thread detail whose `queuedTurn` is set.
7. [unit] The workspace thread page `pages/threads/[id].vue` renders `thread-queued-notice` for a thread detail whose `queuedTurn` is set.
8. [unit] While the loaded thread's `activeJob.state` is `QUEUED`, advancing fake timers by 30 seconds makes the project thread page fetch the thread detail once more.
9. [unit] After a reload returns `activeJob: null`, advancing fake timers by another 30 seconds makes the project thread page fetch nothing.
10. [unit] While the loaded thread's `activeJob.state` is `QUEUED`, advancing fake timers by 30 seconds makes the workspace thread page fetch the thread detail once more.
11. [unit] After the project thread page unmounts with a QUEUED active turn, advancing fake timers by 30 seconds makes it fetch nothing.
12. [unit] The keys `fleet.misfit.thread_capacity`, `thread_backend`, `thread_modes`, `threads_disabled`, `thread_write`, `project_threads` and `workspace_threads` resolve to non-empty strings in both the `en` and `zh` locales.
13. [unit] `fleet.threads.queued.title`, `fleet.threads.queued.reasonOn` and `fleet.threads.queued.verdict.<v>` for each of `never`, `waiting_capacity`, `runners_paused`, `no_fit`, `no_runners` and `budget_paused` resolve to non-empty strings in both locales.

### US-005

1. [unit] `decideFlowStep` with `canApplyCalls: false` and a COMPLETED SPEC_REVIEW whose verdict has two `minor` findings returns `{ kind: 'dispatch', step: 'PLAN', accepted: <those two findings> }`.
2. [unit] `decideFlowStep` with `canApplyCalls: false` and a COMPLETED SPEC_REVIEW with one `answered` finding returns a PLAN dispatch whose `accepted` holds that finding.
3. [unit] `decideFlowStep` with `canApplyCalls: false` and a COMPLETED SPEC_REVIEW with one `minor` and one `ambiguous` finding returns `stop` with reason `review_ambiguous`.
4. [unit] `decideFlowStep` with `canApplyCalls: false` and 21 `minor` findings returns `stop` with reason `review_findings`.
5. [unit] `decideFlowStep` with `canApplyCalls: false`, a COMPLETED PRD_REVIEW with one `minor` finding, two `prdEdits` and a `prdEditsJobId` other than the job's returns `{ kind: 'apply_prd_edits', jobId, edits: <the two edits>, accepted: <the finding> }`.
6. [unit] The same PRD_REVIEW with `prdEditsJobId` equal to the job's id returns `{ kind: 'dispatch', step: 'RUN' }` with no `accepted` key.
7. [unit] `decideFlowStep` with `canApplyCalls: false`, a COMPLETED PRD_REVIEW with one `minor` finding and no `prdEdits` returns a RUN dispatch whose `accepted` holds the finding.
8. [unit] `decideFlowStep` with `canApplyCalls: false`, a COMPLETED PRD_REVIEW with no findings, one `prdEdit` and `prdEditsJobId` null returns `apply_prd_edits` with `accepted: []`.
9. [unit] `decideFlowStep` with `canApplyCalls: true` and a COMPLETED SPEC_REVIEW with one `minor` finding returns `apply_calls`.
10. [unit] `decideFlowStep` with `canApplyCalls: false` and a COMPLETED RULE job whose verdict has one question returns `stop` with reason `review_ambiguous`.
11. [unit] `FleetFlowAdvanceService` advancing a RUNNING THREAD-entry flow whose latest job is a COMPLETED SPEC_REVIEW with two `minor` findings records one `flow.step` activity for the PLAN dispatch whose payload `accepted` lists the two summaries, each cut to `FLOW_CALL_TEXT_MAX` characters.
12. [unit] That advance leaves the flow `RUNNING` and writes no `stop` decision.
13. [unit] Advancing a THREAD-entry flow whose spend has reached its `costCapUsd`, with the same SPEC_REVIEW verdict, writes a `stop` with reason `cost_cap`.
14. [unit] A `flow.step` activity for a dispatch without accepted findings has no `accepted` key in its payload.
15. [unit] Dispatching the PRD_REVIEW step of a RUNNING THREAD-entry flow sends an agent task that contains `FLOW_PRD_EDITS_INSTRUCTION`.

### US-006

1. [unit] `validateRuleOverride({ rules: [{ path: 'api.md', content: 'x' }] })` returns `{ rules: [{ path: 'api.md', content: 'x' }], rulesMode: 'merge', context: null }`.
2. [unit] `validateRuleOverride` with `context: { content: 'c' }` and no mode returns `context: { content: 'c', mode: 'append' }`.
3. [unit] `validateRuleOverride` refuses a rule path `../x.md` with a 400 whose `reason` is `path`.
4. [unit] `validateRuleOverride` refuses a rule path `a.txt` with reason `path`.
5. [unit] `validateRuleOverride` refuses the uppercase rule path `API.md` with reason `path`.
6. [unit] `validateRuleOverride` refuses two rules with the same path with reason `duplicatePath`.
7. [unit] `validateRuleOverride` refuses 51 rules with reason `rules`.
8. [unit] `validateRuleOverride` refuses a rule content of 32,769 UTF-8 bytes with reason `content`.
9. [unit] `validateRuleOverride` refuses a rule content containing a NUL character with reason `content`.
10. [unit] `validateRuleOverride` refuses nine rules of 30,000 bytes each (270,000 in total) with reason `size`.
11. [unit] `validateRuleOverride` refuses `rulesMode: 'append'` with reason `rulesMode`.
12. [unit] `validateRuleOverride` refuses `context: { content: 'c', mode: 'merge' }` with reason `contextMode`.
13. [unit] `validateRuleOverride` refuses `{ rules: [] }` with no context with reason `empty`.
14. [unit] `ruleOverrideSha256` returns the same 64-character lowercase hex string for the same two rules given in either order.
15. [unit] `ruleOverrideSha256` returns a different string when one rule's content changes.

### US-007

1. [integration] With the test Postgres, `PUT /api/fleet/repos/:id/rule-override` by a user holding `fleet.repo.rules.configure` globally, with two rules and a context, answers 200 with a `FleetRepoDto` whose `ruleOverride.sha256` equals `ruleOverrideSha256` of the validated input.
2. [integration] After that PUT, `GET /api/fleet/repos/:id/rule-override` returns the same rules, `rulesMode` and context.
3. [integration] After that PUT, `GET /api/fleet/repos` lists the repo with `ruleOverride` `{ sha256, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append', updatedAt }`.
4. [integration] An agent holding `fleet.repo.rules.configure` globally, with no approval policy, sending PUT with a rule path `../x.md` answers 400 with reason `path`, and no approval request is created.
5. [integration] `DELETE /api/fleet/repos/:id/rule-override` answers 200, and a following `GET .../rule-override` returns `null`.
6. [integration] A user without `fleet.repo.rules.configure` globally gets 403 on PUT, and no override row is written.
7. [integration] An agent holding `fleet.repo.rules.configure` globally, with no approval policy, gets 202 on PUT with an approval request whose `permissionKey` is `fleet.repo.rules.configure`, and no override row exists.
8. [integration] Approving that request through `POST /api/approvals/:id/decisions` with `{ "decision": "approve" }` writes the override row.
9. [integration] `GET /api/fleet/repos/:id/rule-override` by a user holding `fleet.repo.read` but not `fleet.repo.rules.configure` answers 403.
10. [integration] PUT on an unknown repo id answers 404.
11. [unit] `FleetReposService.setRuleOverride` records one audit entry with key `fleet.repo.rules.configure`, resource type `fleet-repo` and summary `rule override set (2 files, merge)` for two rules in merge mode.
12. [unit] `FleetReposService.clearRuleOverride` records one audit entry with summary `rule override cleared` when an override row existed.
13. [unit] `FleetReposService.clearRuleOverride` records no audit entry when the repo had no override.
14. [unit] `FleetRepoRouteCommands` registers a command for key `fleet.repo.rules.configure` at variant `rest:fleet-repos.rule-override.set` whose execution calls `FleetReposService.setRuleOverride` with the frozen id and body.
15. [unit] `FleetRepoRouteCommands` registers a command for key `fleet.repo.rules.configure` at variant `rest:fleet-repos.rule-override.clear` whose execution calls `FleetReposService.clearRuleOverride` with the frozen id.

### US-008

1. [unit] `buildAssignPayload` for a RUN job with a `ruleOverride` argument returns a payload whose `ruleOverride` equals that argument.
2. [unit] `buildAssignPayload` for a THREAD job with a `ruleOverride` argument returns a payload with no `ruleOverride` key.
3. [unit] `buildAssignPayload` for a `CONFIG_EDIT` job with a `ruleOverride` argument returns a payload with no `ruleOverride` key.
4. [unit] `buildAssignPayload` for a FIX job with `ruleOverride` `null` returns a payload with no `ruleOverride` key.
5. [integration] With the test Postgres, a repo with a rule override stored through `PUT /api/fleet/repos/:id/rule-override` and one online runner, dispatching a RUN through `POST /api/projects/:slug/fleet/jobs` writes one ASSIGN `FleetCommand` whose `payload.ruleOverride` has the stored `sha256`, `rulesMode`, `rules` and `context`.
6. [integration] After that dispatch, the `FleetJob` row's `ruleOverride` is `{ sha256, ruleFiles: <n>, rulesMode, contextMode }`.
7. [integration] After that dispatch, `GET /api/projects/:slug/fleet/jobs/:id` returns the same object as `ruleOverride`.
8. [integration] A RUN dispatched on a repo without an override writes an ASSIGN with no `ruleOverride` key and leaves the job's `ruleOverride` `null`.
9. [integration] A RUN queued while the only runner is at capacity, whose repo's override is cleared through `DELETE /api/fleet/repos/:id/rule-override` before the runner syncs with a free slot through `POST /api/fleet/runner/sync`, is assigned with no `ruleOverride` key in its ASSIGN.
10. [integration] A THREAD turn placed on a repo with an override writes an ASSIGN with no `ruleOverride` key.
11. [integration] `PrismaFleetJobRepository.findRuleOverride` maps a stored row to `{ sha256, rulesMode, rules, context: { content, mode } }`.
12. [integration] `PrismaFleetJobRepository.findRuleOverride` omits `context` for a row whose `contextContent` is null.
13. [integration] `PrismaFleetJobRepository.findRuleOverride` returns `null` for a repo with no row.

### US-009

1. [unit] `parseAssign` on a RUN ASSIGN with `ruleOverride` `{ sha256: <64 hex>, rulesMode: 'merge', rules: [{ path: 'api.md', content: 'x' }] }` returns ok with `assign.ruleOverride` equal to it.
2. [unit] `parseAssign` on a RUN ASSIGN whose `ruleOverride.rules[0].path` is `../x.md` fails with reason `ruleOverride`.
3. [unit] `parseAssign` on a RUN ASSIGN whose `ruleOverride.rulesMode` is `'append'` fails with reason `ruleOverride`.
4. [unit] `parseAssign` on a RUN ASSIGN whose `ruleOverride.sha256` has 63 characters fails with reason `ruleOverride`.
5. [unit] `parseAssign` on a THREAD ASSIGN carrying `ruleOverride` fails with reason `ruleOverride`.
6. [unit] `parseAssign` on a `CONFIG_EDIT` ASSIGN carrying `ruleOverride` fails with reason `ruleOverride`.
7. [unit] `materializeRuleOverride(jobDir, override)` with rules `api.md` and `pkg/web.md` and a context writes `<jobDir>/koda-rules/api.md`, `<jobDir>/koda-rules/pkg/web.md` and `<jobDir>/koda-context.md` with the given contents, and returns `{ rules: { overrideDir: <jobDir>/koda-rules, overrideMode: 'merge' }, projectContext: { file: <jobDir>/koda-context.md, mode: 'append' } }`.
8. [unit] `materializeRuleOverride` on a job dir that already holds `koda-rules/old.md` leaves only the new rule files under `koda-rules`.
9. [unit] `materializeRuleOverride` without a context, on a job dir that holds `koda-context.md`, removes that file and returns no `projectContext`.
10. [unit] The rule files `materializeRuleOverride` writes have mode 0600.
11. [unit] `materializeRuleOverride` given a rule path that resolves outside `<jobDir>/koda-rules` rejects with `rule override path` and writes no file.
12. [unit] `jobProfileContent(outDir, name, undefined, undefined, undefined, { rules: { overrideDir: '/j/koda-rules', overrideMode: 'replace' }, projectContext: { file: '/j/koda-context.md', mode: 'replace' } })` returns an object whose `context` equals `{ rules: { overrideDir: '/j/koda-rules', overrideMode: 'replace' }, projectContext: { file: '/j/koda-context.md', mode: 'replace' } }`.
13. [unit] `jobProfileContent(outDir, name)` returns an object with no `context` key.
14. [unit] `HostExecutor.prepare` for a RUN job whose assign has a `ruleOverride` writes the per-job profile with `context.rules.overrideDir` equal to `<jobDir>/koda-rules`, read back from the profile file in the injected nax home.
15. [unit] `HostExecutor.spawnFixStep` for a FIX job whose assign has a `ruleOverride` writes the per-job profile with `context.rules.overrideDir` equal to `<jobDir>/koda-rules`.

### US-010

1. [unit] `useFleetRepos().setRuleOverride('r1', body)` sends `PUT` to `/fleet/repos/r1/rule-override` with that body and, for a `FleetRepo` answer, returns `{ kind: 'saved', repo }`.
2. [unit] `setRuleOverride` returns `{ kind: 'pending', request }` when the answer carries `permissionKey`.
3. [unit] `clearRuleOverride('r1')` sends `DELETE` to `/fleet/repos/r1/rule-override` and returns `{ kind: 'saved', repo }`.
4. [unit] After a saved answer whose repo has `ruleOverride.ruleFiles` 3, the admin Repos page shows the dialog's open button with the file count 3.
5. [unit] `FleetRepoRuleOverrideDialog` shows the open button with the file count 2 when `repo.ruleOverride.ruleFiles` is 2.
6. [unit] Opening the dialog calls `getRuleOverride` with the repo id and renders one row per returned rule with its path and content.
7. [unit] Adding a file, typing path `web.md` and content `w`, and pressing Save calls `setRuleOverride` with `rules` ending in `{ path: 'web.md', content: 'w' }`.
8. [unit] Saving with an empty context textarea sends `context: null`.
9. [unit] Saving with context text `c` and mode `replace` sends `context: { content: 'c', mode: 'replace' }`.
10. [unit] Save and Clear are disabled when the global permissions lack `fleet.repo.rules.configure`.
11. [unit] A pending answer to Save shows the `fleet.repos.ruleOverride.pending` text.
12. [unit] A rejected Save shows the `extractApiError` message in an element with `role="alert"`.
13. [unit] The admin Repos page renders a `FleetRepoRuleOverrideDialog` open button for a GitLab repo.
14. [unit] The job page renders `data-testid="fleet-job-rule-override"` with the `fleet.jobs.ruleOverride.summary` text holding the file count, the rules mode and the first 8 characters of `sha256` when `job.ruleOverride` is set.
15. [unit] The `fleet.repos.ruleOverride.*` keys the dialog uses and `fleet.jobs.ruleOverride.summary` resolve to non-empty strings in both the `en` and `zh` locales.

### US-011

1. [review] `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` §1.5 "Runner fetch and agent access" has a paragraph naming #375 and the date 2026-11-10 that states koda keeps `load_skill` and `read_skill_file`.
2. [review] That paragraph names `@nathapp/nax` `packages/nax/src/resources/` as where nax's resource catalog and skills provider live, and states that `@nathapp/nax-agent` exports only the `ToolProvider` and `ProviderTool` types.
3. [review] That paragraph states that koda's thread skills are an API snapshot delivered in the ASSIGN rather than a disk scan, and that the decision is revisited if nax-agent exports the catalog.
