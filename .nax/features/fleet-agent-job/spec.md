<!-- spec-writing: completed-through-phase-5 -->
# SPEC: The AGENT fleet job kind (fleet flow F2)

## Summary

Add a fleet job command `AGENT`: a runner checks out a ref of a GitHub FleetRepo and runs `nax agents run <agent>
--task-file <file> --json` there, then reports the agent's result (status, output tail, denied asks, model, cost) back
to koda, which stores it on the job. It is dispatched through the existing job dispatch route under
`fleet.job.dispatch`, is placed only on runners whose nax supports `agents run`, gets a read-only git token, and never
pushes. The web labels `AGENT` jobs and shows the result on the job page. The fleet flow's review steps (F3, F4) are
built on this job; F2 itself adds no flow logic.

## Motivation

The fleet flow design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, section Steps) runs every judgment
step (spec review, PRD review, finding classification) as an `AGENT` job that runs `nax agents run` with the flow's
reviewer role. koda has no job that runs an arbitrary agent task and returns its text: `REVIEW` and `FIX` post to a
PR, `PLAN` and `RUN` produce a PRD or a branch, and config jobs run no agent. nax 0.91.8-canary.4 ships `nax agents
run` (unattended, denies asks, prints a JSON result), and the koda runner now uses that version, so the job kind can
be built.

## Design

### User rulings

- 2026-11-04 (design): roles reach the runner through the per-job profile `koda-job-<id>`: koda puts
  `agent.modelAliases` there so `nax agents run` resolves a role alias on any runner. `AGENT` jobs may report no
  cost; a job with unknown cost counts as 0 against a flow cap (F3 shows the gap).
- 2026-11-06: F2 is the second of six flow features (record, `AGENT` job, single-feature steps, verdicts, multi-feature,
  web).
- 2026-11-06 (this spec): `AGENT` is dispatched through the existing dispatch route (and the service method F3 will
  call); an `AGENT` job is read-only and never pushes (committing review fixes is F4); the web gets the command label
  and a result panel on the job page, nothing else.

### Calls made while drafting (not user rulings)

- **Input shape.** The dispatch body gains `agent: { name, task, model?, modelAliases?, timeoutSec? }`, stored on the
  job as one JSON column `agentInput`. `feature` stays required and follows the existing feature rules, so the
  existing one-active-job-per-`(repoId, feature)` rule applies to `AGENT` too. `ref` defaults to the repo's default
  branch as for `RUN` and `PLAN`. `NewFleetJob.agentInput` is optional (absent means null), so the config-job and
  thread job builders need no change.
- **Bounds, all in `normalizeDispatch`.** `name` matches `AGENT_NAME_RE` `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (a nax
  catalog name, plugin-qualified names included) and contains no `..`; `task` is 1-16,384 characters and not only
  whitespace (nax refuses an empty task); `model` is 1-200 non-whitespace characters; `modelAliases` holds at most 8
  entries, keys match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, and every value has nax's alias-target shape
  (`provider/model` or `acp:<claude|codex|cursor>[/<model>]`, optional `[effort]`, no whitespace), copied from nax
  `config/schemas-model-alias.ts` so a bad value fails at dispatch instead of failing nax's config load on the runner;
  `timeoutSec` is an integer 60-86,400. `normalizeDispatch` enforces every bound, because F3 calls the service with a
  DTO it builds itself and no validation pipe; `DispatchAgentDto` carries the same bounds as decorators for the
  OpenAPI document and the HTTP route. koda does not check that the agent or model exists: only the runner's catalog
  knows, and nax reports an unknown one as an error that fails the job.
- **Raw bash only, no tickets.** `AGENT` requires `bashMode` `raw` (an unattended agent denies every ask, so a relay
  adds nothing; the runner's assign parser enforces it too) and refuses `ticketRefs`, `planFrom` and `prNumber`.
- **GitHub only.** The read-only guarantee needs a read-only forge token, which only GitHub mints (the broker refuses
  any read-only or purpose request on GitLab rather than fall back to the write-capable stored token). `AGENT` on a
  GitLab repo is refused at dispatch with 422 `agent is GitHub-only`, as `REVIEW` and `FIX` are.
- **Read-only token.** The broker gains `purpose: 'read'`: GitHub only, cache key `<jobId>:<leaseEpoch>:read`, minted
  with `mintReadOnlyToken`, and returned without `repoId`, so the runner's token cache matches it to the job's default
  token request. The default-repo grant in `SyncService` passes `purpose: 'read'` for `AGENT`. The runner adds no
  publish step.
- **What the clone keeps.** The next job's `cleanWorkspace` resets tracked files and removes untracked ones, but not
  gitignored files or `.git` state; an agent with a write tool could leave those. The agent task and output are not
  redacted. Both are recorded in Out of Scope.
- **Cost and time.** `nax agents run` has no cost cap. `maxCostUsd` stays required on the dispatch body and is stored,
  but it is not enforced for `AGENT`; the job reports `costUsd` when nax priced the run. A flow checks its cap between
  jobs (F3). The runner always passes `--timeout`: `timeoutSec` when set, else 3,600 seconds (`AGENT_DEFAULT_TIMEOUT_SEC`,
  nax's own default turn limit), so a run is always bounded.
- **Task on a file.** The runner writes the task to `agent-task.md` in the job directory (mode 0600) and passes
  `--task-file`, so the task never meets argv limits or shows in the process list. The file is an attempt file (a
  new attempt starts without it) and `cleanup` deletes it. A task starting with `/<name>` is expanded by nax as a skill
  invocation; F3 relies on this for `/spec-review`.
- **Result.** nax prints one JSON object on stdout: `{ agent, model, status, output, deniedAsks, costUsd? }`. The
  runner reads at most 16 MiB of `nax.stdout` (`AGENT_STDOUT_MAX_BYTES`), turns the object into `AgentJobResult {
  status, model?, output, truncated, deniedAsks, deniedAsksTruncated, costUsd? }` and sends it as the snapshot field
  `agentResult`. A sync event payload is at most 16,384 bytes, so the result has a serialized budget of 12,288 bytes
  (the config-job precedent): `AGENT_RESULT_LIMITS = { budgetBytes: 12288, maxOutputBytes: 8192, maxDeniedAsks: 10,
  maxAskChars: 500, maxToolChars: 128, maxModelChars: 200 }`. `fitAgentResult` cuts `model` to 200 characters, keeps
  the first 10 denied asks with `text` and `summary` cut to 500 and `tool` to 128 characters, keeps the last 8,192
  UTF-8 bytes of `output` (the flow's verdict JSON sits at the end, F4), then drops denied asks from the end and then
  shortens the output tail further until `JSON.stringify(result)` fits the budget, setting `truncated` and
  `deniedAsksTruncated` when it cut. The whole stdout is in the job log. koda checks the same limits (its own copy,
  pinned equal to the protocol's) and drops the result whole when any fails (the `configResult` precedent).
- **Verdict.** Cancel requested: `CANCELLED`. Otherwise status `completed`: `COMPLETED`; status `failed`, `timeout` or
  `cancelled`: `FAILED` with reason `agent <status>`; no parseable result: `FAILED` with reason `agent result
  unreadable` plus `: ` and the first non-empty line of `nax.stderr` (at most 300 characters) when there is one. The
  job's `costSpentUsd` is the result's `costUsd` formatted by the runner's `formatCost`.
- **Capability.** The probe reports `agentsRun: true` when `nax agents run --help` exits 0 within its timeout and its
  output mentions `--task-file`. A runner without it gets misfit `agents_run`, which is recoverable (not in
  `PERMANENT_MISFITS`): a runner upgrade fixes it.
- **No bundle ingest, no analytics.** The runner still uploads its usual bundle; ingest's eligibility rule does not
  name `AGENT`, so it is not ingested. Fleet analytics (`NAX_JOBS`, `RUN`/`PLAN`) and the assistant's dispatch tool are
  unchanged. `AGENT` joins the budget hard stop list, so a paused scope cancels queued `AGENT` jobs.
- **Strict assign.** The runner's `parseAssign` rejects an `agent` block on any other command, as it rejects `review`,
  `thread` and `expectBranch` on the wrong kind.

### Integration

Read only (verified on main `d992bd58`):

- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:95`) and
  its `ReviewProviderException` (line 40); route `POST /api/projects/:slug/fleet/jobs`
  (`apps/api/src/fleet/jobs/fleet-jobs.controller.ts:25,37`).
- `PERMANENT_MISFITS` (`apps/api/src/fleet/jobs/placement-rules.ts:21`); `parseConfigResult` and
  `CONFIG_RESULT_LIMITS` (`apps/api/src/fleet/repo-config/config-result.ts`, `apps/api/src/fleet/common/config-jobs.ts:18`);
  `SYNC_LIMITS.payloadBytes` 16,384 (`apps/api/src/fleet/sync/sync-request.parser.ts:6`,
  `apps/runner/src/sync/batch.ts:4`).
- Runner: `prepareCheckout` (`apps/runner/src/executor/checkout.ts:25`), `HostExecutor.spawn`, `cleanup` and
  `collectBundle` (`apps/runner/src/executor/host-executor.ts:167,484,477`), `spawnNax`
  (`apps/runner/src/executor/nax-process.ts:59`), `formatCost` (`apps/runner/src/watcher/status-snapshot.ts`), the
  `fitConfigResult` budget precedent (`apps/runner/src/executor/config-job/result-fit.ts`), `TokenCache.apply`
  (`apps/runner/src/credentials/token-cache.ts:114`, matches on `(jobId, repoId)`).
- nax `agents run` (0.91.8-canary.4): `nax agents run <agent> (--task <text> | --task-file <path>) [--profile <names>]
  [--model <id>] [--json] [--timeout <seconds>]`; exit 0 when the status is `completed`, 1 for any other run status, 2
  for usage, config, trust or catalog errors (one stderr line, no JSON). With `--json`, stdout is one JSON object
  `{ agent, model, status: 'completed' | 'failed' | 'cancelled' | 'timeout', output, deniedAsks: [{ kind: 'approval',
  tool, summary } | { kind: 'question', text }], costUsd? }`; `costUsd` is omitted when unpriced.

Changed. The baseline locates the code; implement the target.

- `FleetJobKind` (`apps/api/src/common/enums.ts:162`): adds `AGENT`. `FleetJobDto` command enum
  (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:56`) adds `AGENT`; the misfit enum (line 140) adds `agents_run`.
- `packages/fleet-protocol/src/index.ts` (types only, edited by an `apps/api` story): `FleetJobKindName` (line 135)
  adds `'AGENT'`; `RunnerCapabilities` (line 64) adds `agentsRun?: true`; `SnapshotEventPayload` (line 155) adds
  `agentResult?: AgentJobResult`; `AssignPayload` (line 270) adds `agent?: AgentAssign`; new exported types
  `AgentAssign { name: string; task: string; model?: string; modelAliases?: Record<string, string>; timeoutSec?: number }`
  and `AgentJobResult` (shape above).
- `DispatchFleetJobDto.command` (`apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts:10`) — Baseline:
  `@IsIn(['RUN','PLAN','REVIEW','FIX'])`. Target: adds `'AGENT'`, plus an optional nested `agent` object
  (`DispatchAgentDto`).
- `normalizeDispatch(dto, defaultBranch)` (`apps/api/src/fleet/jobs/dispatch-input.ts:27`) — Baseline: returns no
  agent field. Target: returns `agentInput: AgentJobInput | null` (non-null only for `AGENT`).
- `NewFleetJob` / `FleetJobRecord` / `FleetJobPatch` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:149,74,180`):
  `NewFleetJob` gains optional `agentInput?: AgentJobInput | null`; `FleetJobRecord` gains `agentInput` and
  `agentResult`; `agentResult` joins the patch keys.
- `GitTokenBroker.mint(req)` (`apps/api/src/fleet/git-broker/git-token.broker.ts:35`) — Baseline: `purpose?: 'review' |
  'fix'`. Target: `purpose?: 'review' | 'fix' | 'read'`.
- `capabilityMisfit` (`apps/api/src/fleet/jobs/placement-rules.ts:124`) and `MisfitReason` (line 13): add `agents_run`.
- `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts:29`): adds `agent` for `AGENT`.
- `mirror` (`apps/api/src/fleet/sync/event-payloads.ts:93`): adds `agentResult`.
- `BUDGET_STOP_COMMANDS` (`apps/api/src/fleet/budgets/prisma-budget.repository.ts:22`): adds `AGENT`.
- Capability validator (`apps/api/src/fleet/common/capabilities-core.ts:164,194,221`): accepts `agentsRun`.
- Runner `buildNaxArgv(naxCommand, assign, opts)` (`apps/runner/src/executor/nax-process.ts:16`) — Target: `opts`
  gains `agentTaskPath?: string`, used only for `AGENT`.
- Runner `jobProfileContent(outputDir, projectName, relay?, botCostLimitUsd?)` and `writeJobProfile(naxHome, jobId,
  outputDir, projectName, relay?, botCostLimitUsd?)` (`apps/runner/src/executor/job-profile.ts:31,46`) — Target: one
  more optional last parameter `modelAliases?: Readonly<Record<string, string>>`.
- Runner `ATTEMPT_FILES` (`apps/runner/src/executor/host-executor.ts:65`): adds `agent-task.md`.
- Runner `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts:202`, the raw-bash rule at line 224),
  `prepareCheckout`, the supervisor re-adopt branch (`apps/runner/src/supervisor/supervisor.ts:183`), `JobRun.judge`
  (`apps/runner/src/supervisor/job-run.ts:457`) and `NaxCapabilityProbe.probe` (`apps/runner/src/capabilities/nax-probe.ts:168`):
  each gains an `AGENT` branch.
- Web `FleetJobKind` (`apps/web/lib/fleet-types.ts:162`) adds `'AGENT'`; the web `MisfitReason` union (line 156) adds
  `'agents_run'`; `FleetJobDto` type (line 277) adds `agent` and `agentResult`; the job page
  (`apps/web/pages/[project]/fleet/jobs/[id]/index.vue`) renders the result panel.

### Approach

The runner's `AGENT` argv, with `chain = [...profiles, 'koda-job-<jobId>'].join(',')`:

```text
[...naxCommand, 'agents', 'run', <name>, '--task-file', <jobDir>/agent-task.md, '--json', '--profile', <chain>,
 ('--model', <model>)?, '--timeout', <timeoutSec or 3600>]
```

It runs in the clone directory, as every nax job does, with the same environment `HostExecutor.spawn` builds (provider
key socket included). The per-job profile carries `agent.modelAliases` when the job has aliases, so a flow can pass
`model: 'reviewer'` with `modelAliases: { reviewer: 'acp:claude' }`.

### Failure Handling

| case | response |
|:---|:---|
| `AGENT` dispatch with no `agent` | 400 `fleet.dispatchInput`, reason `agent required for AGENT` |
| `agent` on another command | 400, reason `agent is only for AGENT` |
| `agent.name` fails `AGENT_NAME_RE` or contains `..` | 400, reason `agent.name` |
| `agent.task` empty, only whitespace, or over 16,384 characters | 400, reason `agent.task` |
| `agent.model` empty, over 200 characters or holding whitespace | 400, reason `agent.model` |
| `agent.modelAliases` over 8 entries, a bad key, or a value without the nax alias-target shape | 400, reason `agent.modelAliases` |
| `agent.timeoutSec` not an integer 60-86,400 | 400, reason `agent.timeoutSec` |
| `AGENT` with `bashMode` other than `raw` | 400, reason `bashMode must be raw for AGENT` |
| `AGENT` with `ticketRefs` | 400, reason `ticketRefs is not for AGENT` |
| `AGENT` on a GitLab repo | 422, reason `agent is GitHub-only` |
| no runner reports `agentsRun` | job stays `QUEUED`; misfit `agents_run` (recoverable) |
| `read` token mint on a GitLab repo (cannot happen after the dispatch check) | `provider_error`, as for `review` |
| runner receives an `AGENT` assign whose `agent` block fails the runner's re-validation, or an `agent` block on another command | assign rejected with detail `agent` |
| writing `agent-task.md` fails | the spawn fails through the existing spawn-failure path (`FAILED` with the spawn reason) |
| nax prints no parseable result (usage, catalog or config error, crash, stdout over 16 MiB) | `FAILED`, reason `agent result unreadable[: <stderr line>]` |
| nax result status `failed`, `timeout` or `cancelled` | `FAILED`, reason `agent <status>` |
| cancel requested | `CANCELLED` |
| `agentResult` in a snapshot fails a bound | the field is dropped; the job's other fields are mirrored |

## Out of Scope

- Pushing, committing or opening a PR from an `AGENT` job; the job is read-only (F4 adds spec edits on the flow branch).
- `AGENT` on GitLab repos: GitLab has no read-only fleet token, so dispatch refuses it.
- Any fleet flow step, verdict parsing or flow cost-cap logic (F3, F4).
- Enforcing `maxCostUsd` for `AGENT` (nax `agents run` has no cost cap); the stored value is informational.
- Checking on the server that the agent name or model exists on a runner; the runner's nax reports it.
- Redacting secrets from an `AGENT` job's task text (stored on the job, the runner journal and `agent-task.md` while it runs) or from its output (job log, bundle, `agentResult`).
- Removing gitignored files or `.git` state an agent leaves in the runner's clone; `cleanWorkspace` is unchanged.
- Running an `AGENT` job while another active job holds the same `(repoId, feature)`; the existing one-active-job rule refuses it, and F3 picks features accordingly.
- Dispatching `AGENT` from the web dispatch form, the koda assistant's dispatch tool or the CLI's hand-written commands;
  the generated CLI client is regenerated only.
- Including `AGENT` in fleet analytics (`NAX_JOBS`) or bundle ingest.
- Job-outcome notifications specific to `AGENT`; the existing generic behaviour applies.
- Keeping more than the last 8,192 bytes of agent output in `agentResult`; the full output is in the job log.
- A flow page or any web view beyond the command label, the `agents_run` misfit label and the job-page result panel (F6).
- Streaming partial agent output as a result; the result is reported once, at the end.

## Stories

### US-001: AGENT kind and dispatch shape

Workdir: `apps/api`. No dependencies.

Adds `AGENT` to the API enums and the protocol types, the optional nested `agent` dispatch object, and an `AGENT`
branch in `normalizeDispatch` that returns `agentInput` and refuses the fields `AGENT` does not take.

### US-002: Agent input bounds

Workdir: `apps/api`. Depends on US-001.

`normalizeDispatch` enforces every `agent` bound (name, task, model, model aliases, timeout) and `DispatchAgentDto`
mirrors them as decorators.

### US-003: AGENT job persistence

Workdir: `apps/api`. Depends on US-001.

New nullable JSON columns `FleetJob.agentInput` and `FleetJob.agentResult` (migration
`20261127090000_fleet_job_agent`), mapped through guards, written on insert, patched by the mirror, cleared on
requeue (`agentResult` only) and exposed on `FleetJobDto` as `agent` and `agentResult`.

### US-004: AGENT through the dispatch route

Workdir: `apps/api`. Depends on US-002, US-003.

`FleetJobsService.dispatch` accepts `AGENT` on GitHub repos, refuses it on GitLab, and stores `agentInput`; `AGENT`
joins the budget hard stop; the endpoint e2e and the OpenAPI contract cover it; `openapi.json` and the CLI client
are regenerated.

### US-005: Placement, assign and read-only token for AGENT

Workdir: `apps/api`. Depends on US-003.

Runners report `agentsRun`; an `AGENT` is placed only on a runner with it (misfit `agents_run`, recoverable); the
assign payload carries `agent`; the broker's new `read` purpose mints a GitHub read-only token for the job's default
token request, and the sync grant uses it for `AGENT`.

### US-006: AGENT result mirror

Workdir: `apps/api`. Depends on US-003.

`AGENT_RESULT_LIMITS` (API copy, pinned equal to the protocol's), `parseAgentResult` and the mirror's `agentResult`.

### US-007: Runner accepts AGENT

Workdir: `apps/runner`. Depends on US-005.

The capability probe reports `agentsRun`; `parseAssign` accepts `AGENT`, re-validates its `agent` block, forces raw
bash and rejects `agent` on other commands; checkout detaches at the ref; re-adopt after a restart treats `AGENT`
like `REVIEW`.

### US-008: AGENT spawn

Workdir: `apps/runner`. Depends on US-007.

The per-job profile carries `agent.modelAliases`; the task is written to `agent-task.md`, an attempt file that
`cleanup` deletes; `buildNaxArgv` builds the `agents run` argv with a timeout; `HostExecutor.spawn` passes the task
file.

### US-009: AGENT result reader

Workdir: `apps/runner`. Depends on US-008.

`AGENT_RESULT_LIMITS` (new runtime constant in `packages/fleet-protocol`); `readAgentResult` parses a bounded
`nax.stdout` and reads the first `nax.stderr` line on failure; `fitAgentResult` fits the result to the budget and
formats the cost.

### US-010: AGENT verdict

Workdir: `apps/runner`. Depends on US-009.

`JobRun.judge` maps an `AGENT` job's result to a verdict, the snapshot's `agentResult` and `costSpentUsd`.

### US-011: AGENT on the web job page

Workdir: `apps/web`. Depends on US-006.

The web types know `AGENT`, `agents_run`, `agent` and `agentResult`; en and zh label the command and the misfit; the
job page shows `FleetJobAgentResult` for an `AGENT` job.

### Context Files

**US-001**

- `apps/api/src/fleet/jobs/dispatch-input.ts` — the function this story extends
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the dispatch DTO
- `apps/api/src/fleet/common/config-jobs.ts` — a protocol-mirror constants file to follow
- `packages/fleet-protocol/src/index.ts` — the protocol types this story widens

**US-002**

- `apps/api/src/fleet/jobs/dispatch-input.ts` — the `AGENT` branch from US-001
- `apps/api/src/fleet/common/agent-jobs.ts` — created by US-001; this story adds the bound constants and `isModelAliasTarget`
- `apps/api/src/fleet/jobs/dto/dispatch-agent.dto.ts` — created by US-001; this story adds its validators

**US-003**

- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — insert, `toJob` and the patch writer
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — record and patch types
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto.from`
- `apps/api/test/integration/fleet/thread-modes-migration.integration.spec.ts` — migration test pattern
- `apps/api/src/fleet/common/agent-jobs.ts` — created by US-001, read here

**US-004**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — dispatch and `ReviewProviderException`
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint e2e file
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the OpenAPI contract test

**US-005**

- `apps/api/src/fleet/jobs/placement-rules.ts` — `capabilityMisfit`, `MisfitReason`
- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint` and `fresh`
- `apps/api/src/fleet/sync/sync.service.ts` — the token grant
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`
- `apps/runner/src/credentials/token-cache.ts` — how the runner matches a granted token to its request (read only)

**US-006**

- `apps/api/src/fleet/sync/event-payloads.ts` — `mirror`
- `apps/api/src/fleet/repo-config/config-result.ts` — the `parseConfigResult` precedent
- `apps/api/src/fleet/common/agent-jobs.ts` — created by US-001; this story adds `AGENT_RESULT_LIMITS` to it
- `apps/api/src/fleet/common/protocol.spec.ts` — the mirrored-constant pin precedent

**US-007**

- `apps/runner/src/capabilities/nax-probe.ts` — the probe and `botFix` precedent
- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`
- `apps/runner/src/executor/checkout.ts` — `prepareCheckout`
- `apps/runner/src/supervisor/supervisor.ts` — re-adopt
- `apps/runner/test/helpers/fake-nax-cli.ts` — the fake nax used by probe tests
- `apps/runner/src/credentials/token-cache.ts` — `TokenCache.apply`, pinned for the AGENT token shape

**US-008**

- `apps/runner/src/executor/job-profile.ts` — the per-job profile
- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv`
- `apps/runner/src/executor/host-executor.ts` — `spawn`, prepare, `ATTEMPT_FILES` and `cleanup`

**US-009**

- `apps/runner/src/executor/config-job/result-fit.ts` — the budget-fit precedent
- `apps/runner/src/watcher/status-snapshot.ts` — `formatCost`
- `packages/fleet-protocol/src/config-jobs.ts` — protocol constants precedent

**US-010**

- `apps/runner/src/supervisor/job-run.ts` — `judge`
- `apps/runner/src/executor/agent-job/agent-result.ts` — created by US-009, read here

**US-011**

- `apps/web/lib/fleet-types.ts` — web types
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the job page
- `apps/web/i18n/locales/en.json` — labels

### Creates

**US-001**

- `apps/api/src/fleet/common/agent-jobs.ts` — `AGENT_NAME_RE`, types `AgentJobInput` and `AgentJobResult`
- `apps/api/src/fleet/jobs/dto/dispatch-agent.dto.ts` — `DispatchAgentDto`

**US-003**

- `apps/api/prisma/migrations/20261127090000_fleet_job_agent/migration.sql`
- `apps/api/test/integration/fleet/fleet-job-agent-migration.integration.spec.ts`

**US-006**

- `apps/api/src/fleet/sync/agent-result.ts` — `parseAgentResult`

**US-008**

- `apps/runner/src/executor/agent-job/agent-task-file.ts` — `writeAgentTask`, `AGENT_TASK_FILE`

**US-009**

- `packages/fleet-protocol/src/agent-jobs.ts` — `AGENT_RESULT_LIMITS`
- `apps/runner/src/executor/agent-job/agent-result.ts` — `readAgentResult`, `fitAgentResult`, `AGENT_STDOUT_MAX_BYTES`

**US-011**

- `apps/web/components/fleet/FleetJobAgentResult.vue`

### Modifies

**US-001**

- `apps/api/src/common/enums.ts` — `FleetJobKind` gains `AGENT`.
- `apps/api/src/fleet/common/protocol.spec.ts` — the `kinds` record (`Record<FleetJobKindName, true>`, line 50) gains `AGENT: true`, so the API-constant-to-protocol-union check covers eight kinds.
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the `command` enum gains `AGENT` and the optional nested `agent` object.
- `apps/api/src/fleet/jobs/dispatch-input.ts` — `normalizeDispatch` returns `agentInput`.
- `apps/api/src/fleet/jobs/dispatch-input.spec.ts` — whole-object expectations on `normalizeDispatch` gain `agentInput: null` for non-`AGENT` commands.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `NewFleetJob` gains optional `agentInput?: AgentJobInput | null`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the command enum gains `AGENT`.
- `packages/fleet-protocol/src/index.ts` — types only: `FleetJobKindName`, `RunnerCapabilities.agentsRun`, `SnapshotEventPayload.agentResult`, `AssignPayload.agent`, `AgentAssign`, `AgentJobResult`.

**US-002**

- `apps/api/src/fleet/jobs/dispatch-input.ts` — the `AGENT` branch checks every `agent` bound.

**US-003**

- `apps/api/prisma/schema.prisma` — `FleetJob` gains `agentInput Json?` and `agentResult Json?`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobRecord` gains `agentInput` and `agentResult`; `agentResult` joins the mutable patch keys.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — insert writes `agentInput` (null when absent); `toJob` maps both columns; the patch writer handles `agentResult` (null as `Prisma.DbNull`).
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto` gains `agent` and `agentResult`; `from` maps them.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — requeue's reset patch gains `agentResult: null`.
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — exact expectations on the requeue reset patch gain `agentResult: null`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` — exact `FleetJobDto.from` expectations gain `agent: null` and `agentResult: null`.

**US-004**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch` refuses `AGENT` on GitLab and stores `agentInput`.
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS` gains `AGENT`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds the `AGENT` dispatch cases.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — adds the `AGENT` dispatch schema case.
- `openapi.json` — regenerated with `bun run generate` from the repo root.
- `apps/cli/src/generated/types.gen.ts` — regenerated with `bun run generate`; never edited by hand.

**US-005**

- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint` and `fresh` accept `purpose: 'read'`.
- `apps/api/src/fleet/jobs/placement-rules.ts` — `MisfitReason` and `capabilityMisfit` gain `agents_run`.
- `apps/api/src/fleet/common/capabilities-core.ts` — the validator accepts and copies `agentsRun`.
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload` adds `agent` for `AGENT`.
- `apps/api/src/fleet/sync/sync.service.ts` — the default-repo token grant passes `purpose: 'read'` for `AGENT`.
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — the misfit reason list gains `agents_run`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the misfit enum gains `agents_run`.

**US-006**

- `apps/api/src/fleet/sync/event-payloads.ts` — `mirror` adds `agentResult`.
- `apps/api/src/fleet/common/protocol.spec.ts` — adds a case pinning the API `AGENT_RESULT_LIMITS` equal to the protocol's.

**US-007**

- `apps/runner/src/capabilities/nax-probe.ts` — adds `agentsRun` to the probe result.
- `apps/runner/src/supervisor/assign-parser.ts` — accepts `AGENT` and its `agent` block; the raw-bash rule includes `AGENT`; an `agent` block on another kind is rejected.
- `apps/runner/src/executor/checkout.ts` — `AGENT` detaches at the ref.
- `apps/runner/src/supervisor/supervisor.ts` — re-adopt treats `AGENT` like `REVIEW`.
- `apps/runner/test/helpers/fake-nax-cli.ts` — gains an `agentsRun` result for `agents run --help` (default: unknown command), like `botFix`.

**US-008**

- `apps/runner/src/executor/job-profile.ts` — both functions gain the optional `modelAliases` parameter.
- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv` gains the `AGENT` branch and `opts.agentTaskPath`.
- `apps/runner/src/executor/host-executor.ts` — `ATTEMPT_FILES` gains the task file name; prepare passes `modelAliases` to `writeJobProfile`; `spawn` writes the task file and passes `agentTaskPath`; `cleanup` deletes the task file.

**US-009**

- `packages/fleet-protocol/src/index.ts` — re-exports `AGENT_RESULT_LIMITS` from the new protocol agent-jobs module.

**US-010**

- `apps/runner/src/supervisor/job-run.ts` — `judge` gains the `AGENT` branch.

**US-011**

- `apps/web/lib/fleet-types.ts` — `FleetJobKind` gains `'AGENT'`; `MisfitReason` gains `'agents_run'`; `FleetJobDto` gains `agent` and `agentResult`.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — renders `FleetJobAgentResult` for an `AGENT` job.
- `apps/web/i18n/locales/en.json` — `fleet.command.AGENT`, the `agents_run` misfit label and the result panel strings.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.

### Seams

- US-004 -> US-001: the dispatch route stores what `normalizeDispatch` returns as `agentInput`.
- US-005 -> US-003: `buildAssignPayload` reads `FleetJobRecord.agentInput`.
- US-005: the sync grant calls the broker's new `read` purpose for `AGENT`.
- US-006 -> US-003: the mirror's `agentResult` is written by the US-003 patch writer.
- US-008 -> US-007: `HostExecutor.spawn` reads the `agent` block `parseAssign` validated.
- US-010 -> US-009: `judge` calls `readAgentResult` and `fitAgentResult`.
- US-011 -> US-003: the web reads `FleetJobDto.agent` and `agentResult`.

## Acceptance Criteria

### US-001: AGENT kind and dispatch shape

- [unit] `FleetJobKind.AGENT` equals the string `'AGENT'`.
- [unit] `normalizeDispatch` with command `AGENT`, feature `flow-a`, no `ref`, and `agent` `{ name: 'spec-reviewer', task: 'Review the spec' }` on a repo whose default branch is `main` returns command `AGENT`, ref `main`, and `agentInput` `{ name: 'spec-reviewer', task: 'Review the spec' }` with no other keys.
- [unit] `normalizeDispatch` with command `AGENT`, `ref` `feat/flow-a` and `agent` `{ name: 'spec-reviewer', task: 'x', model: 'reviewer', modelAliases: { reviewer: 'acp:claude' }, timeoutSec: 600 }` returns ref `feat/flow-a` and an `agentInput` equal to that `agent` object.
- [unit] `normalizeDispatch` with command `RUN` returns `agentInput` null.
- [unit] `normalizeDispatch` with command `AGENT` and no `agent` throws `ValidationAppException` with reason `agent required for AGENT`.
- [unit] `normalizeDispatch` with command `PLAN` carrying an `agent` object throws `ValidationAppException` with reason `agent is only for AGENT`.
- [unit] `normalizeDispatch` with command `AGENT` and `bashMode` `gated` throws `ValidationAppException` with reason `bashMode must be raw for AGENT`.
- [unit] `normalizeDispatch` with command `AGENT` and `ticketRefs` `['KD-1']` throws `ValidationAppException` with reason `ticketRefs is not for AGENT`.
- [unit] `normalizeDispatch` with command `AGENT` and a `planFrom` throws `ValidationAppException` with reason `planFrom is only for PLAN`.
- [unit] `normalizeDispatch` with command `AGENT` and a `prNumber` throws `ValidationAppException` with reason `prNumber is only for REVIEW and FIX`.
- [unit] Validating a `DispatchFleetJobDto` with command `AGENT` and `agent` `{ name: 'spec-reviewer', task: 'Review' }` yields no validation errors.

### US-002: Agent input bounds

- [unit] For each `agent.name` in the table `-x`, `a b`, `a..b` and a 129-character name, `normalizeDispatch` with command `AGENT` throws `ValidationAppException` with reason `agent.name`.
- [unit] `normalizeDispatch` with command `AGENT` accepts `agent.name` `plugin:spec-reviewer` and keeps it.
- [unit] For each `agent.task` in the table the empty string, `'   \n'` and a 16,385-character string, `normalizeDispatch` with command `AGENT` throws `ValidationAppException` with reason `agent.task`.
- [unit] `normalizeDispatch` with command `AGENT` accepts an `agent.task` of exactly 16,384 characters.
- [unit] For each `agent.model` in the table `fast model` (holding a space), the empty string and a 201-character string, `normalizeDispatch` with command `AGENT` throws `ValidationAppException` with reason `agent.model`.
- [unit] `normalizeDispatch` with command `AGENT` accepts `agent.model` `acp:claude` and keeps it.
- [unit] For each `agent.modelAliases` value in the table `not-a-model`, `acp:bogus`, `openai/gpt 5` and `acp:claude [high]`, `normalizeDispatch` with command `AGENT` throws `ValidationAppException` with reason `agent.modelAliases`.
- [unit] For each `agent.modelAliases` value in the table `acp:claude`, `acp:codex/gpt-5.4`, `openai/gpt-5.4[high]` and `opencode-go/deepseek-v4.1-flash`, `normalizeDispatch` with command `AGENT` accepts the alias and keeps it.
- [unit] `normalizeDispatch` with command `AGENT` and an `agent.modelAliases` key `-bad` throws `ValidationAppException` with reason `agent.modelAliases`.
- [unit] `normalizeDispatch` with command `AGENT` and `agent.modelAliases` holding nine entries throws `ValidationAppException` with reason `agent.modelAliases`; eight entries are accepted.
- [unit] For each `agent.timeoutSec` in the table 59, 86,401 and 60.5, `normalizeDispatch` with command `AGENT` throws `ValidationAppException` with reason `agent.timeoutSec`.
- [unit] `normalizeDispatch` with command `AGENT` accepts `agent.timeoutSec` 60 and, separately, 86,400.
- [unit] Validating a `DispatchFleetJobDto` with command `AGENT` and an `agent.task` of 16,385 characters yields a validation error on `agent.task`.

### US-003: AGENT job persistence

- [integration] Inserting a `NewFleetJob` with command `AGENT` and `agentInput` `{ name: 'spec-reviewer', task: 'x' }` through the fleet job repository and reading it back by id returns the same `agentInput` and `agentResult` null.
- [integration] Inserting a `RUN` job with no `agentInput` key returns a record with `agentInput` null and `agentResult` null.
- [integration] Updating an `AGENT` job with patch `agentResult` `{ status: 'completed', output: 'done', truncated: false, deniedAsks: [], deniedAsksTruncated: false, costUsd: '0.0123' }` and reading it back returns that `agentResult`.
- [integration] Updating a job that has an `agentResult` with patch `agentResult: null` reads back `agentResult` null.
- [unit] The repository's `agentResult` mapping returns null for a stored value whose `status` is `weird`.
- [unit] The repository's `agentInput` mapping returns null for a stored value with no `task`.
- [unit] `FleetJobDto.from` of an `AGENT` record returns `agent` equal to the record's `agentInput` and `agentResult` equal to the record's `agentResult`.
- [unit] `FleetJobDto.from` of a `RUN` record returns `agent` null and `agentResult` null.
- [integration] Requeueing a `FAILED` `AGENT` job that has an `agentResult` leaves the new attempt with `agentResult` null and the same `agentInput`.
- [integration] Applying migration `20261127090000_fleet_job_agent` over the preceding schema leaves an existing `FleetJob` row with `agentInput` and `agentResult` null.

### US-004: AGENT through the dispatch route

- [integration] `POST /api/projects/:slug/fleet/jobs` by a user holding `fleet.job.dispatch` with command `AGENT`, feature `flow-a`, `maxCostUsd` 1 and `agent` `{ name: 'spec-reviewer', task: 'Review' }` on a GitHub repo returns 201 with command `AGENT`, state `QUEUED`, `agent` equal to the sent object and `agentResult` null.
- [integration] The same request on a GitLab repo returns 422 with reason `agent is GitHub-only` and stores no job.
- [integration] The same request by a caller without `fleet.job.dispatch` returns 403.
- [integration] The request with command `AGENT` and no `agent` returns 400 with reason `agent required for AGENT`.
- [integration] A second `AGENT` request for the same repo and feature while the first is `QUEUED` returns 409 carrying the first job's id as `activeJobId`.
- [integration] `GET /api/projects/:slug/fleet/jobs/:id` for the dispatched `AGENT` job returns its `agent` object.
- [integration] A budget hard stop on the job's project cancels a `QUEUED` `AGENT` job in that scope.
- [unit] The exported OpenAPI document lists `AGENT` in the dispatch body's `command` enum and describes an `agent` object with `name` and `task` required.

### US-005: Placement, assign and read-only token for AGENT

- [unit] The capability validator keeps `agentsRun: true` from a runner's capabilities, drops the key when it is absent, and rejects `agentsRun: false` with field `agentsRun`.
- [unit] Placement of an `AGENT` job on a runner whose capabilities lack `agentsRun` returns misfit `agents_run`, and on a runner with `agentsRun: true` and otherwise fitting returns no misfit.
- [unit] `PERMANENT_MISFITS.has('agents_run')` is false, so a pinned `AGENT` dispatch to a runner without `agentsRun` is not refused at dispatch.
- [unit] `buildAssignPayload` for an `AGENT` record with `agentInput` `{ name: 'spec-reviewer', task: 'x', modelAliases: { reviewer: 'acp:claude' } }` returns `agent` equal to that object and no `review` block.
- [unit] `buildAssignPayload` for a `RUN` record returns no `agent` key.
- [unit] `GitTokenBroker.mint` with `purpose: 'read'` on a GitHub repo calls `mintReadOnlyToken` (not `mintInstallationToken`) and returns a token with no `repoId`.
- [unit] `GitTokenBroker.mint` with `purpose: 'read'` called twice for the same job and lease epoch returns the cached token the second time without minting again.
- [unit] `GitTokenBroker.mint` with `purpose: 'read'` on a GitLab repo returns `{ ok: false }` with reason `provider_error` and never resolves the stored GitLab token.
- [integration] A runner sync with a default git token request (no `repoId`) for an `ASSIGNED` `AGENT` job calls `GitTokenBroker.mint` once with `purpose: 'read'` for the job's repo.
- [integration] The same sync for an assigned `RUN` job calls `GitTokenBroker.mint` with no `purpose`.
- [unit] The fleet dashboard's misfit reason list and the `FleetJobDto` misfit enum both include `agents_run`.

### US-006: AGENT result mirror

- [unit] The API's `AGENT_RESULT_LIMITS` equals the protocol's `AGENT_RESULT_LIMITS`, `{ budgetBytes: 12288, maxOutputBytes: 8192, maxDeniedAsks: 10, maxAskChars: 500, maxToolChars: 128, maxModelChars: 200 }`.
- [unit] `parseAgentResult` of `{ status: 'completed', model: 'acp:claude', output: 'ok', truncated: false, deniedAsks: [{ kind: 'question', text: 'Which?' }], deniedAsksTruncated: false, costUsd: '0.0100' }` returns an equal object.
- [unit] `parseAgentResult` of a result with no `costUsd` returns a result with no `costUsd`.
- [unit] `parseAgentResult` returns null when `status` is not one of `completed`, `failed`, `cancelled`, `timeout`.
- [unit] `parseAgentResult` returns null when `output` exceeds 8,192 UTF-8 bytes.
- [unit] `parseAgentResult` returns null when the serialized result exceeds 12,288 bytes although each field is within its own limit.
- [unit] For each `deniedAsks` in the table 11 entries, and one entry whose `kind` is `other`, `parseAgentResult` returns null.
- [unit] For each denied ask in the table an approval whose `summary` has 501 characters and an approval whose `tool` has 129 characters, `parseAgentResult` returns null.
- [unit] For each `costUsd` in the table `1.23456` and `-1`, `parseAgentResult` returns null.
- [unit] `interpretEvent('snapshot', { agentResult: <valid result> })` returns a patch whose `agentResult` equals the parsed result.
- [unit] `interpretEvent('snapshot', { agentResult: { status: 'weird' }, costSpentUsd: '0.5000' })` returns a patch with no `agentResult` key and `costSpentUsd` `0.5000`.
- [integration] A runner sync carrying a snapshot event with a valid `agentResult` for a held `AGENT` job stores it, and `GET /api/projects/:slug/fleet/jobs/:id` returns it.

### US-007: Runner accepts AGENT

- [unit] `NaxCapabilityProbe.probe` reports `agentsRun: true` when the fake nax's `agents run --help` exits 0 with output mentioning `--task-file`.
- [unit] For each fake `agents run --help` in the table exit 1, timed out, and exit 0 without `--task-file` in its output, `NaxCapabilityProbe.probe` reports no `agentsRun` key.
- [unit] `parseAssign` of an `AGENT` assign with `agent` `{ name: 'spec-reviewer', task: 'Review' }` returns ok with `assign.agent` equal to that object.
- [unit] `parseAssign` of an `AGENT` assign with no `agent` block returns `{ ok: false, detail: 'agent' }`.
- [unit] For each `agent` in the table name `../x`, a 16,385-character task, a `modelAliases` value holding a space, and `timeoutSec` 59, `parseAssign` of an `AGENT` assign returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of a `RUN` assign carrying an `agent` block returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of an `AGENT` assign with `bashMode` `gated` returns `{ ok: false, detail: 'bashMode' }`.
- [unit] `prepareCheckout` for an `AGENT` assign at ref `main` checks out the ref's sha detached and returns `{ ok: true, branch: null, refSha }` without reading any `prd.json`.
- [unit] `prepareCheckout` for an `AGENT` assign whose ref does not resolve returns `{ ok: false, reason: 'checkout: ref not found' }`.
- [unit] After a daemon restart, the supervisor re-adopts an `AGENT` row whose recorded process is alive and matches as `watch`.
- [unit] After a daemon restart, the supervisor re-adopts an `AGENT` row whose recorded process is gone as `finish`.
- [unit] `TokenCache.apply` stores a granted token with no `repoId` against the default token request of an `AGENT` job with the same job id and lease epoch.

### US-008: AGENT spawn

- [unit] `jobProfileContent` with `modelAliases` `{ reviewer: 'acp:claude' }` returns a profile whose `agent.modelAliases` equals that object.
- [unit] For each `modelAliases` in the table absent and `{}`, `jobProfileContent` returns a profile with no `agent` key.
- [unit] `writeAgentTask(jobDir, 'Review the spec')` writes `agent-task.md` in `jobDir` holding exactly that text with file mode 0600, and returns its path.
- [unit] `buildNaxArgv(['nax'], <AGENT assign with agent { name: 'spec-reviewer', task: 'x' }, profiles ['p1'], jobId 'j1'>, { agentTaskPath: '/jobs/j1/agent-task.md' })` returns `['nax', 'agents', 'run', 'spec-reviewer', '--task-file', '/jobs/j1/agent-task.md', '--json', '--profile', 'p1,koda-job-j1', '--timeout', '3600']`.
- [unit] `buildNaxArgv` for an `AGENT` assign with `model` `reviewer` and `timeoutSec` 600 returns an argv ending `--model reviewer --timeout 600`.
- [unit] `buildNaxArgv` for an `AGENT` assign with `maxCostUsd` `5` returns an argv with no `--max-cost`.
- [unit] `buildNaxArgv` for an `AGENT` assign with no `agentTaskPath` throws an `Error`.
- [unit] `HostExecutor.spawn` of an `AGENT` job writes the task file into the job directory and calls `spawnNax` with the `agents run` argv carrying that file's path, the clone directory as `cwd`, and the provider-key socket variable it gives a `RUN`.
- [unit] Preparing an `AGENT` job whose `agent.modelAliases` is `{ reviewer: 'acp:claude' }` writes the `koda-job-<jobId>` profile with that `agent.modelAliases`, and preparing a `REVIEW` job writes it with no `agent` key.
- [unit] Preparing a new attempt of an `AGENT` job removes an `agent-task.md` left in the job directory by the previous attempt.
- [unit] `HostExecutor.cleanup` of an `AGENT` job deletes `agent-task.md` from the job directory.

### US-009: AGENT result reader

- [unit] `AGENT_RESULT_LIMITS` from `@nathapp/fleet-protocol` equals `{ budgetBytes: 12288, maxOutputBytes: 8192, maxDeniedAsks: 10, maxAskChars: 500, maxToolChars: 128, maxModelChars: 200 }`.
- [unit] `readAgentResult(jobDir)` with `nax.stdout` holding `{"agent":"spec-reviewer","model":"acp:claude","status":"completed","output":"ok","deniedAsks":[],"costUsd":0.0123}` returns `{ ok: true }` with that parsed result.
- [unit] `readAgentResult` with an empty `nax.stdout` and `nax.stderr` `\nerror: unknown agent x\nmore` returns `{ ok: false, stderrLine: 'error: unknown agent x' }`.
- [unit] For each `nax.stdout` in the table `not json`, `{"status":"weird"}` and a valid result padded past `AGENT_STDOUT_MAX_BYTES` (16 MiB), `readAgentResult` returns `{ ok: false }`.
- [unit] `readAgentResult` cuts a first `nax.stderr` line of 500 characters to 300 characters.
- [unit] `fitAgentResult` of a result whose output is 20,000 bytes returns `output` equal to a tail of the original of at most 8,192 bytes and `truncated: true`; a 10-byte output is kept whole with `truncated: false`.
- [unit] `fitAgentResult` of a result with 25 denied asks keeps at most the first 10 and sets `deniedAsksTruncated: true`.
- [unit] `fitAgentResult` cuts a denied question's `text` of 1,500 characters to 500 characters and an approval's `tool` of 200 characters to 128.
- [unit] `fitAgentResult` cuts a 300-character `model` to 200 characters.
- [unit] `fitAgentResult` of a result whose output is 20,000 `"` characters and with 10 denied asks of 500 characters each returns a result whose `JSON.stringify` is at most 12,288 bytes and whose `output` is still a tail of the original.
- [unit] `fitAgentResult` of a result with `costUsd` 0.0123 returns `costUsd` `0.0123`, and of a result with no `costUsd` returns no `costUsd`.

### US-010: AGENT verdict

- [unit] `JobRun.judge` for an `AGENT` job whose result status is `completed` returns verdict `COMPLETED` and a snapshot carrying the fitted `agentResult` and `costSpentUsd` `0.0123`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `timeout` returns verdict `FAILED` with reason `agent timeout` and still carries `agentResult`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `failed` returns verdict `FAILED` with reason `agent failed`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `cancelled` and no cancel request returns verdict `FAILED` with reason `agent cancelled`.
- [unit] `JobRun.judge` for an `AGENT` job whose result has no `costUsd` returns a snapshot with no `costSpentUsd`.
- [unit] `JobRun.judge` for an `AGENT` job with no readable result and stderr line `error: unknown agent spec-reviewer` returns `FAILED` with reason `agent result unreadable: error: unknown agent spec-reviewer` and no `agentResult`.
- [unit] `JobRun.judge` for an `AGENT` job with no readable result and no stderr line returns `FAILED` with reason `agent result unreadable`.
- [unit] `JobRun.judge` for an `AGENT` job with a cancel request returns verdict `CANCELLED`.

### US-011: AGENT on the web job page

- [unit] The job page for an `AGENT` job renders `FleetJobAgentResult` with the job's `agentResult`.
- [unit] The job page for a `RUN` job does not render `FleetJobAgentResult`.
- [unit] `FleetJobAgentResult` with status `completed` and output `line 1\nline 2` shows the translated status and the output as preformatted text with both lines.
- [unit] `FleetJobAgentResult` with output `<b>x</b>` shows the literal text `<b>x</b>` and renders no `b` element.
- [unit] `FleetJobAgentResult` with `truncated: true` shows the `fleet.agentResult.truncated` notice.
- [unit] `FleetJobAgentResult` with one denied approval `{ tool: 'Bash', summary: 'rm -rf x' }` and one denied question `{ text: 'Which?' }` lists both entries.
- [unit] `FleetJobAgentResult` with no `costUsd` shows the `fleet.agentResult.costUnknown` notice.
- [unit] `FleetJobAgentResult` with a null `agentResult` shows the `fleet.agentResult.pending` notice.
- [unit] The English label for command `AGENT` is `Agent task` and the English `agents_run` misfit label is `nax on this runner cannot run agent tasks`.
- [unit] The Chinese locale defines `fleet.command.AGENT` and the `agents_run` misfit label.
