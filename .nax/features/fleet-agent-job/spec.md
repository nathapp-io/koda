<!-- spec-writing: completed-through-phase-5 -->
# SPEC: The AGENT fleet job kind (fleet flow F2)

## Summary

Add a fleet job command `AGENT`: a runner checks out a ref of a FleetRepo and runs `nax agents run <agent> --task-file
<file> --json` there, then reports the agent's result (status, output, denied asks, model, cost) back to koda, which
stores it on the job. It is dispatched through the existing job dispatch route under `fleet.job.dispatch`, is placed
only on runners whose nax supports `agents run`, gets a read-only git token, and never pushes. The web labels `AGENT`
jobs and shows the result on the job page. The fleet flow's review steps (F3, F4) are built on this job; F2 itself
adds no flow logic.

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
  branch as for `RUN` and `PLAN`.
- **Bounds.** `name` matches `AGENT_NAME_RE` `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (a nax catalog name, plugin-qualified
  names included); `task` is 1-32,768 characters; `model` is 1-200 non-whitespace characters; `modelAliases` holds at
  most 8 entries, keys match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, and every value has nax's alias-target shape
  (`provider/model` or `acp:<claude|codex|cursor>[/<model>]`, optional `[effort]`, no whitespace), copied from nax
  `config/schemas-model-alias.ts` so a bad value fails at dispatch instead of failing nax's config load on the runner;
  `timeoutSec` is an integer 60-86,400. koda does not check that the agent or model exists: only the runner's catalog
  knows, and nax reports an unknown one as an error that fails the job.
- **Raw bash only, no tickets.** `AGENT` requires `bashMode` `raw` (an unattended agent denies every ask, so a relay
  adds nothing) and refuses `ticketRefs`, `planFrom` and `prNumber`.
- **Cost.** `nax agents run` has no cost cap. `maxCostUsd` stays required on the dispatch body and is stored, but it
  is not enforced for `AGENT`; the job reports `costUsd` when nax priced the run. A flow checks its cap between jobs
  (F3).
- **Task on a file.** The runner writes the task to `agent-task.md` in the job directory (mode 0600) and passes
  `--task-file`, so a 32 KiB task never meets argv limits or shows in the process list.
- **Read-only.** The sync token grant for an `AGENT` job carries `readOnly: true` (the PROJECT-thread precedent in
  `SyncService`), so the minted forge token cannot push. The runner adds no publish step. Whatever the agent changes
  in the clone is wiped by the next job's `cleanWorkspace`.
- **Result.** nax prints one JSON object on stdout: `{ agent, model, status, output, deniedAsks, costUsd? }`. The
  runner turns it into `AgentJobResult { status, model?, output, truncated, deniedAsks, deniedAsksTruncated, costUsd? }`
  and sends it as the snapshot field `agentResult`. `output` keeps its last 65,536 UTF-8 bytes (`truncated: true` when
  cut): the flow's verdict JSON sits at the end of the output (F4), and the whole stdout is in the job log anyway.
  `deniedAsks` keeps its first 20 entries, each text field capped at 1,000 characters. koda stores the result in a
  JSON column `agentResult`, dropping it whole when any bound fails (the `configResult` precedent).
- **Verdict.** Cancel requested: `CANCELLED`. Otherwise status `completed`: `COMPLETED`; status `failed`, `timeout` or
  `cancelled`: `FAILED` with reason `agent <status>`; no parseable result: `FAILED` with reason `agent result
  unreadable` plus the first non-empty line of `nax.stderr` (at most 300 characters) after `: ` when there is one. The
  job's `costSpentUsd` is the result's `costUsd` formatted by the runner's `formatCost`.
- **Capability.** The probe reports `agentsRun: true` when `nax agents run --help` exits 0 and its output mentions
  `--task-file`. A runner without it gets misfit `agents_run`, which is recoverable (not in `PERMANENT_MISFITS`): a
  runner upgrade fixes it.
- **No bundle ingest, no analytics.** The runner still uploads its usual bundle; ingest ignores `AGENT` (not eligible).
  Fleet analytics (`NAX_JOBS`, `RUN`/`PLAN`) and the assistant's dispatch tool are unchanged. `AGENT` joins the budget
  hard stop list, so a paused scope cancels queued `AGENT` jobs.

### Integration

Read only (verified on main `d992bd58`):

- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:95`);
  route `POST /api/projects/:slug/fleet/jobs` (`apps/api/src/fleet/jobs/fleet-jobs.controller.ts:25,37`).
- `GitTokenBroker.mint(req)` with `readOnly` (`apps/api/src/fleet/git-broker/git-token.broker.ts:35`).
- `PERMANENT_MISFITS` (`apps/api/src/fleet/jobs/placement-rules.ts:21`); `parseConfigResult` and
  `CONFIG_RESULT_LIMITS` (`apps/api/src/fleet/repo-config/config-result.ts`, `apps/api/src/fleet/common/config-jobs.ts:18`).
- Runner: `prepareCheckout` (`apps/runner/src/executor/checkout.ts:25`), `HostExecutor.spawn` and `collectBundle`
  (`apps/runner/src/executor/host-executor.ts:167,477`), `spawnNax` (`apps/runner/src/executor/nax-process.ts:59`),
  `formatCost` (`apps/runner/src/watcher/status-snapshot.ts`), `tailBytes` precedent in
  `apps/runner/src/executor/config-job/result-fit.ts`.
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
  add `agentInput` (new jobs and records) and `agentResult` (records and patches).
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
- Runner `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts:201`), `prepareCheckout`, the supervisor
  re-adopt branch (`apps/runner/src/supervisor/supervisor.ts:183`), `JobRun.judge` (`apps/runner/src/supervisor/job-run.ts:457`)
  and `NaxCapabilityProbe.probe` (`apps/runner/src/capabilities/nax-probe.ts:168`): each gains an `AGENT` branch.
- Web `FleetJobKind` (`apps/web/lib/fleet-types.ts:162`) adds `'AGENT'`; `FleetJobDto` type (line 277) adds `agent`
  and `agentResult`; the job page (`apps/web/pages/[project]/fleet/jobs/[id]/index.vue`) renders the result panel.

### Approach

The runner's `AGENT` argv, with `chain = [...profiles, 'koda-job-<jobId>'].join(',')`:

```text
[...naxCommand, 'agents', 'run', <name>, '--task-file', <jobDir>/agent-task.md, '--json', '--profile', <chain>,
 ('--model', <model>)?, ('--timeout', <timeoutSec>)?]
```

It runs in the clone directory, as every nax job does, with the same environment `HostExecutor.spawn` builds (provider
key socket included). The per-job profile carries `agent.modelAliases` when the job has aliases, so a flow can pass
`model: 'reviewer'` with `modelAliases: { reviewer: 'acp:claude' }`.

### Failure Handling

| case | response |
|:---|:---|
| `AGENT` dispatch with no `agent` | 400 `fleet.dispatchInput`, reason `agent required for AGENT` |
| `agent` on another command | 400, reason `agent is only for AGENT` |
| `agent.name` fails `AGENT_NAME_RE` | 400, reason `agent.name` |
| `agent.model` empty, over 200 characters or holding whitespace | 400, reason `agent.model` |
| `agent.modelAliases` over 8 entries, a bad key, or a value without the nax alias-target shape | 400, reason `agent.modelAliases` |
| `agent.task` empty or over 32,768 characters; `agent.timeoutSec` not an integer 60-86,400 | 400 validation error naming the property |
| `AGENT` with `bashMode` other than `raw` | 400, reason `bashMode must be raw for AGENT` |
| `AGENT` with `ticketRefs` | 400, reason `ticketRefs is not for AGENT` |
| no runner reports `agentsRun` | job stays `QUEUED`; misfit `agents_run` (recoverable) |
| runner receives an `AGENT` assign whose `agent` block fails the runner's re-validation | assign rejected with detail `agent` |
| nax prints no parseable result (usage, catalog or config error, crash) | `FAILED`, reason `agent result unreadable[: <stderr line>]` |
| nax result status `failed`, `timeout` or `cancelled` | `FAILED`, reason `agent <status>` |
| cancel requested | `CANCELLED` |
| `agentResult` in a snapshot fails a bound | the field is dropped; the job's other fields are mirrored |

## Out of Scope

- Pushing, committing or opening a PR from an `AGENT` job; the job is read-only (F4 adds spec edits on the flow branch).
- Any fleet flow step, verdict parsing or flow cost-cap logic (F3, F4).
- Enforcing `maxCostUsd` for `AGENT` (nax `agents run` has no cost cap); the stored value is informational.
- Checking on the server that the agent name or model exists on a runner; the runner's nax reports it.
- Dispatching `AGENT` from the web dispatch form, the koda assistant's dispatch tool or the CLI's hand-written commands;
  the generated CLI client is regenerated only.
- Including `AGENT` in fleet analytics (`NAX_JOBS`) or bundle ingest.
- Job-outcome notifications specific to `AGENT`; the existing generic behaviour applies.
- A flow page or any web view beyond the command label, the `agents_run` misfit label and the job-page result panel (F6).
- Streaming partial agent output as a result; the result is reported once, at the end.

## Stories

### US-001: AGENT dispatch input

Workdir: `apps/api`. No dependencies.

Adds `AGENT` to the API enums and the protocol types, the nested `agent` dispatch object with its bounds, and an
`AGENT` branch in `normalizeDispatch` that returns `agentInput`.

### US-002: AGENT job persistence

Workdir: `apps/api`. Depends on US-001.

New nullable JSON columns `FleetJob.agentInput` and `FleetJob.agentResult` (migration
`20261127090000_fleet_job_agent`), mapped through guards, written on insert, patched by the mirror, cleared on
requeue (`agentResult` only) and exposed on `FleetJobDto` as `agent` and `agentResult`.

### US-003: AGENT through the dispatch route

Workdir: `apps/api`. Depends on US-002.

`FleetJobsService.dispatch` accepts `AGENT` on GitHub and GitLab repos and stores `agentInput`; `AGENT` joins the
budget hard stop; the endpoint e2e and the OpenAPI contract cover it; `openapi.json` and the CLI client are
regenerated.

### US-004: Placement, assign and read-only token for AGENT

Workdir: `apps/api`. Depends on US-002.

Runners report `agentsRun`; an `AGENT` is placed only on a runner with it (misfit `agents_run`, recoverable); the
assign payload carries `agent`; the sync token grant for an `AGENT` is read-only.

### US-005: AGENT result mirror

Workdir: `apps/api`. Depends on US-002.

`parseAgentResult` checks the snapshot's `agentResult` against `AGENT_RESULT_LIMITS` and the mirror stores it.

### US-006: Runner accepts AGENT

Workdir: `apps/runner`. Depends on US-004.

The capability probe reports `agentsRun`; `parseAssign` accepts `AGENT` and re-validates its `agent` block; checkout
detaches at the ref; re-adopt after a restart treats `AGENT` like `REVIEW`.

### US-007: AGENT spawn

Workdir: `apps/runner`. Depends on US-006.

The per-job profile carries `agent.modelAliases`; the task is written to `agent-task.md`; `buildNaxArgv` builds the
`agents run` argv; `HostExecutor.spawn` passes the task file.

### US-008: AGENT verdict and result

Workdir: `apps/runner`. Depends on US-007.

`readAgentResult` parses `nax.stdout`, `fitAgentResult` applies `AGENT_RESULT_LIMITS` (new runtime constant in
`packages/fleet-protocol`), and `JobRun.judge` maps the result to a verdict, `agentResult` and `costSpentUsd`.

### US-009: AGENT on the web job page

Workdir: `apps/web`. Depends on US-005.

The web types know `AGENT`, `agent` and `agentResult`; en and zh label the command and the `agents_run` misfit; the
job page shows `FleetJobAgentResult` for an `AGENT` job.

### Context Files

**US-001**

- `apps/api/src/fleet/jobs/dispatch-input.ts` — the function this story extends
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the dispatch DTO
- `apps/api/src/fleet/common/config-jobs.ts` — a protocol-mirror constants file to follow
- `packages/fleet-protocol/src/index.ts` — the protocol types this story widens

**US-002**

- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — insert, `toJob` and the patch writer
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — record and patch types
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto.from`
- `apps/api/test/integration/fleet/thread-modes-migration.integration.spec.ts` — migration test pattern
- `apps/api/src/fleet/common/agent-jobs.ts` — created by US-001, read here

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — dispatch
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint e2e file
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the OpenAPI contract test

**US-004**

- `apps/api/src/fleet/jobs/placement-rules.ts` — `capabilityMisfit`, `MisfitReason`
- `apps/api/src/fleet/common/capabilities-core.ts` — the capability validator
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`
- `apps/api/src/fleet/sync/sync.service.ts` — the token grant
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — misfit reason list

**US-005**

- `apps/api/src/fleet/sync/event-payloads.ts` — `mirror`
- `apps/api/src/fleet/repo-config/config-result.ts` — the `parseConfigResult` precedent
- `apps/api/src/fleet/common/agent-jobs.ts` — created by US-001; this story adds `AGENT_RESULT_LIMITS` to it (same values as the protocol constant)

**US-006**

- `apps/runner/src/capabilities/nax-probe.ts` — the probe and `botFix` precedent
- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`
- `apps/runner/src/executor/checkout.ts` — `prepareCheckout`
- `apps/runner/src/supervisor/supervisor.ts` — re-adopt

**US-007**

- `apps/runner/src/executor/job-profile.ts` — the per-job profile
- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv`
- `apps/runner/src/executor/host-executor.ts` — `spawn` and prepare

**US-008**

- `apps/runner/src/supervisor/job-run.ts` — `judge`
- `apps/runner/src/executor/config-job/result-fit.ts` — the tail-fit precedent
- `apps/runner/src/watcher/status-snapshot.ts` — `formatCost`
- `packages/fleet-protocol/src/config-jobs.ts` — protocol constants precedent

**US-009**

- `apps/web/lib/fleet-types.ts` — web types
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the job page
- `apps/web/i18n/locales/en.json` — labels

### Creates

**US-001**

- `apps/api/src/fleet/common/agent-jobs.ts` — `AGENT_NAME_RE`, `AGENT_MODEL_RE`, `MODEL_ALIAS_KEY_RE`, `isModelAliasTarget`, `AGENT_TASK_MAX_CHARS`, `AGENT_MAX_ALIASES`, `AGENT_TIMEOUT_SEC`, types `AgentJobInput` and `AgentJobResult`
- `apps/api/src/fleet/jobs/dto/dispatch-agent.dto.ts` — `DispatchAgentDto`

**US-002**

- `apps/api/prisma/migrations/20261127090000_fleet_job_agent/migration.sql`
- `apps/api/test/integration/fleet/fleet-job-agent-migration.integration.spec.ts`

**US-005**

- `apps/api/src/fleet/sync/agent-result.ts` — `parseAgentResult`

**US-007**

- `apps/runner/src/executor/agent-job/agent-task-file.ts` — `writeAgentTask`

**US-008**

- `packages/fleet-protocol/src/agent-jobs.ts` — `AGENT_RESULT_LIMITS`
- `apps/runner/src/executor/agent-job/agent-result.ts` — `readAgentResult`, `fitAgentResult`

**US-009**

- `apps/web/components/fleet/FleetJobAgentResult.vue`

### Modifies

**US-001**

- `apps/api/src/common/enums.ts` — `FleetJobKind` gains `AGENT`; a closed-world assertion on its keys becomes the eight kinds including `AGENT`.
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the `command` enum gains `AGENT` and the optional nested `agent` object.
- `apps/api/src/fleet/jobs/dispatch-input.ts` — `normalizeDispatch` returns `agentInput`; existing tests that compare its whole return value gain `agentInput: null`.
- `apps/api/src/fleet/jobs/dispatch-input.spec.ts` — whole-object expectations on `normalizeDispatch` gain `agentInput: null` for non-`AGENT` commands.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `NewFleetJob` gains `agentInput: AgentJobInput | null`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the command enum gains `AGENT`.
- `packages/fleet-protocol/src/index.ts` — types only: `FleetJobKindName`, `RunnerCapabilities.agentsRun`, `SnapshotEventPayload.agentResult`, `AssignPayload.agent`, `AgentAssign`, `AgentJobResult`.

**US-002**

- `apps/api/prisma/schema.prisma` — `FleetJob` gains `agentInput Json?` and `agentResult Json?`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobRecord` gains `agentInput` and `agentResult`; `agentResult` joins the mutable patch keys.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — insert writes `agentInput`; `toJob` maps both columns; the patch writer handles `agentResult` (null as `Prisma.DbNull`).
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto` gains `agent` and `agentResult`; `from` maps them.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — requeue's reset patch gains `agentResult: null`; tests that pin the reset patch exactly gain that key.
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — exact expectations on the requeue reset patch gain `agentResult: null`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` — exact `FleetJobDto.from` expectations gain `agent: null` and `agentResult: null`.

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch` stores `agentInput` for `AGENT`.
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS` gains `AGENT`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds the `AGENT` dispatch cases.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — adds the `AGENT` dispatch schema case.
- `openapi.json` — regenerated with `bun run generate` from the repo root.
- `apps/cli/src/generated/types.gen.ts` — regenerated with `bun run generate`; never edited by hand.

**US-004**

- `apps/api/src/fleet/jobs/placement-rules.ts` — `MisfitReason` and `capabilityMisfit` gain `agents_run`.
- `apps/api/src/fleet/common/capabilities-core.ts` — the validator accepts and copies `agentsRun`.
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload` adds `agent` for `AGENT`.
- `apps/api/src/fleet/sync/sync.service.ts` — the default-repo token grant adds `readOnly: true` for `AGENT`.
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — the misfit reason list gains `agents_run`; a closed-world assertion on the list gains it.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the misfit enum gains `agents_run`.

**US-005**

- `apps/api/src/fleet/sync/event-payloads.ts` — `mirror` adds `agentResult`.

**US-006**

- `apps/runner/src/capabilities/nax-probe.ts` — adds `agentsRun` to the probe result.
- `apps/runner/src/supervisor/assign-parser.ts` — accepts `AGENT` and its `agent` block.
- `apps/runner/src/executor/checkout.ts` — `AGENT` detaches at the ref.
- `apps/runner/src/supervisor/supervisor.ts` — re-adopt treats `AGENT` like `REVIEW`.

**US-007**

- `apps/runner/src/executor/job-profile.ts` — both functions gain the optional `modelAliases` parameter.
- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv` gains the `AGENT` branch and `opts.agentTaskPath`.
- `apps/runner/src/executor/host-executor.ts` — prepare passes `modelAliases` to `writeJobProfile`; `spawn` writes the task file and passes `agentTaskPath`.

**US-008**

- `packages/fleet-protocol/src/index.ts` — re-exports `AGENT_RESULT_LIMITS` from the new protocol agent-jobs module.
- `apps/runner/src/supervisor/job-run.ts` — `judge` gains the `AGENT` branch.

**US-009**

- `apps/web/lib/fleet-types.ts` — `FleetJobKind` gains `'AGENT'`; `FleetJobDto` gains `agent` and `agentResult`.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — renders `FleetJobAgentResult` for an `AGENT` job.
- `apps/web/i18n/locales/en.json` — `fleet.command.AGENT`, the `agents_run` misfit label and the result panel strings.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.

### Seams

- US-003 -> US-001: the dispatch route stores what `normalizeDispatch` returns as `agentInput`.
- US-004 -> US-002: `buildAssignPayload` reads `FleetJobRecord.agentInput`.
- US-005 -> US-002: the mirror's `agentResult` is written by the US-002 patch writer.
- US-007 -> US-006: `HostExecutor.spawn` reads the `agent` block `parseAssign` validated.
- US-008 -> US-007: `judge` reads the `nax.stdout` the `AGENT` spawn produced.
- US-009 -> US-002: the web reads `FleetJobDto.agent` and `agentResult`.

## Acceptance Criteria

### US-001: AGENT dispatch input

- [unit] `FleetJobKind.AGENT` equals the string `'AGENT'`.
- [unit] `normalizeDispatch` with command `AGENT`, feature `flow-a`, no `ref`, and `agent` `{ name: 'spec-reviewer', task: 'Review the spec' }` on a repo whose default branch is `main` returns command `AGENT`, ref `main`, and `agentInput` `{ name: 'spec-reviewer', task: 'Review the spec' }` with no other keys.
- [unit] `normalizeDispatch` with command `AGENT`, `ref` `feat/flow-a` and `agent` `{ name: 'spec-reviewer', task: 'x', model: 'reviewer', modelAliases: { reviewer: 'acp:claude' }, timeoutSec: 600 }` returns ref `feat/flow-a` and an `agentInput` equal to that `agent` object.
- [unit] `normalizeDispatch` with command `RUN` returns `agentInput` null.
- [unit] `normalizeDispatch` with command `AGENT` and no `agent` throws `ValidationAppException` with reason `agent required for AGENT`.
- [unit] `normalizeDispatch` with command `PLAN` carrying an `agent` object throws `ValidationAppException` with reason `agent is only for AGENT`.
- [unit] For each `agent.name` in `-x`, `a b` and a 129-character name, `normalizeDispatch` with command `AGENT` throws `ValidationAppException` with reason `agent.name`; the name `plugin:spec-reviewer` is accepted.
- [unit] `normalizeDispatch` with command `AGENT` and `agent.model` `fast model` (holding a space) throws `ValidationAppException` with reason `agent.model`; `agent.model` `acp:claude` is accepted and kept.
- [unit] `normalizeDispatch` with command `AGENT` and `agent.modelAliases` `{ reviewer: 'not-a-model' }` throws `ValidationAppException` with reason `agent.modelAliases`; the values `acp:claude`, `acp:codex/gpt-5.4` and `openai/gpt-5.4[high]` are each accepted.
- [unit] `normalizeDispatch` with command `AGENT` and `agent.modelAliases` holding nine entries throws `ValidationAppException` with reason `agent.modelAliases`.
- [unit] `normalizeDispatch` with command `AGENT` and `bashMode` `gated` throws `ValidationAppException` with reason `bashMode must be raw for AGENT`.
- [unit] `normalizeDispatch` with command `AGENT` and `ticketRefs` `['KD-1']` throws `ValidationAppException` with reason `ticketRefs is not for AGENT`.
- [unit] `normalizeDispatch` with command `AGENT` and a `planFrom` throws `ValidationAppException` with reason `planFrom is only for PLAN`.
- [unit] Validating a `DispatchFleetJobDto` with command `AGENT` and `agent.task` of 32,769 characters yields a validation error on `agent.task`, and an empty `agent.task` yields one too.
- [unit] Validating a `DispatchFleetJobDto` with `agent.timeoutSec` 59, 86,401 or 60.5 yields a validation error on `agent.timeoutSec`; 60 and 86,400 validate.

### US-002: AGENT job persistence

- [integration] Inserting a `NewFleetJob` with command `AGENT` and `agentInput` `{ name: 'spec-reviewer', task: 'x' }` through the fleet job repository and reading it back by id returns the same `agentInput` and `agentResult` null.
- [integration] Inserting a `RUN` job returns a record with `agentInput` null and `agentResult` null.
- [integration] Updating an `AGENT` job with patch `agentResult` `{ status: 'completed', output: 'done', truncated: false, deniedAsks: [], deniedAsksTruncated: false, costUsd: '0.0123' }` and reading it back returns that `agentResult`.
- [integration] Updating a job that has an `agentResult` with patch `agentResult: null` reads back `agentResult` null.
- [unit] The repository's `agentResult` mapping returns null for a stored value whose `status` is `weird`, and the `agentInput` mapping returns null for a stored value with no `task`.
- [unit] `FleetJobDto.from` of an `AGENT` record returns `agent` equal to the record's `agentInput` and `agentResult` equal to the record's `agentResult`.
- [unit] `FleetJobDto.from` of a `RUN` record returns `agent` null and `agentResult` null.
- [integration] Requeueing a `FAILED` `AGENT` job that has an `agentResult` leaves the new attempt with `agentResult` null and the same `agentInput`.
- [integration] Applying migration `20261127090000_fleet_job_agent` over the preceding schema leaves an existing `FleetJob` row with `agentInput` and `agentResult` null.

### US-003: AGENT through the dispatch route

- [integration] `POST /api/projects/:slug/fleet/jobs` by a user holding `fleet.job.dispatch` with command `AGENT`, feature `flow-a`, `maxCostUsd` 1 and `agent` `{ name: 'spec-reviewer', task: 'Review' }` on a GitHub repo returns 201 with command `AGENT`, state `QUEUED`, `agent` equal to the sent object and `agentResult` null.
- [integration] The same request on a GitLab repo returns 201 (no `ReviewProviderException`).
- [integration] The same request by a caller without `fleet.job.dispatch` returns 403.
- [integration] The request with command `AGENT` and no `agent` returns 400 with reason `agent required for AGENT`.
- [integration] A second `AGENT` request for the same repo and feature while the first is `QUEUED` returns 409 carrying the first job's id as `activeJobId`.
- [integration] `GET /api/projects/:slug/fleet/jobs/:id` for the dispatched `AGENT` job returns its `agent` object.
- [integration] A budget hard stop on the job's project cancels a `QUEUED` `AGENT` job in that scope.
- [unit] The exported OpenAPI document lists `AGENT` in the dispatch body's `command` enum and describes an `agent` object with `name` and `task` required.

### US-004: Placement, assign and read-only token for AGENT

- [unit] The capability validator keeps `agentsRun: true` from a runner's capabilities and drops the key when it is absent.
- [unit] The capability validator rejects `agentsRun: false` with field `agentsRun`.
- [unit] Placement of an `AGENT` job on a runner whose capabilities lack `agentsRun` returns misfit `agents_run`.
- [unit] Placement of an `AGENT` job on a runner with `agentsRun: true` and otherwise fitting returns no misfit.
- [unit] `PERMANENT_MISFITS.has('agents_run')` is false, so a pinned `AGENT` dispatch to a runner without `agentsRun` is not refused at dispatch.
- [unit] `buildAssignPayload` for an `AGENT` record with `agentInput` `{ name: 'spec-reviewer', task: 'x', modelAliases: { reviewer: 'acp:claude' } }` returns `agent` equal to that object and no `review` block.
- [unit] `buildAssignPayload` for a `RUN` record returns no `agent` key.
- [integration] A runner sync with a git token request for an `ASSIGNED` `AGENT` job calls `GitTokenBroker.mint` once with `readOnly: true` for the job's repo.
- [integration] The same sync for an assigned `RUN` job calls `GitTokenBroker.mint` without `readOnly: true`.
- [unit] The fleet dashboard's misfit reason list and the `FleetJobDto` misfit enum both contain `agents_run`.

### US-005: AGENT result mirror

- [unit] `parseAgentResult` of `{ status: 'completed', model: 'acp:claude', output: 'ok', truncated: false, deniedAsks: [{ kind: 'question', text: 'Which?' }], deniedAsksTruncated: false, costUsd: '0.0100' }` returns an equal object.
- [unit] `parseAgentResult` of a result with no `costUsd` returns a result with no `costUsd`.
- [unit] `parseAgentResult` returns null when `status` is not one of `completed`, `failed`, `cancelled`, `timeout`.
- [unit] `parseAgentResult` returns null when `output` exceeds 65,536 UTF-8 bytes.
- [unit] `parseAgentResult` returns null when `deniedAsks` holds 21 entries, or an entry whose `kind` is neither `approval` nor `question`.
- [unit] `parseAgentResult` returns null when an approval ask's `summary` exceeds 1,000 characters.
- [unit] `parseAgentResult` returns null when `costUsd` is `1.23456` or `-1`.
- [unit] `interpretEvent('snapshot', { agentResult: <valid result> })` returns a patch whose `agentResult` equals the parsed result.
- [unit] `interpretEvent('snapshot', { agentResult: { status: 'weird' }, costSpentUsd: '0.5000' })` returns a patch with no `agentResult` key and `costSpentUsd` `0.5000`.
- [integration] A runner sync carrying a snapshot event with a valid `agentResult` for a held `AGENT` job stores it, and `GET /api/projects/:slug/fleet/jobs/:id` returns it.

### US-006: Runner accepts AGENT

- [unit] `NaxCapabilityProbe.probe` reports `agentsRun: true` when the stubbed `nax agents run --help` exits 0 with output mentioning `--task-file`.
- [unit] `NaxCapabilityProbe.probe` reports no `agentsRun` key when `nax agents run --help` exits 1, and when it exits 0 without `--task-file` in its output.
- [unit] `parseAssign` of an `AGENT` assign with `agent` `{ name: 'spec-reviewer', task: 'Review' }` returns ok with `assign.agent` equal to that object.
- [unit] `parseAssign` of an `AGENT` assign with no `agent` block returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of an `AGENT` assign whose `agent.name` is `../x` returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of an `AGENT` assign whose `agent.task` is 32,769 characters returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of an `AGENT` assign whose `agent.modelAliases` holds a value with a space returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of an `AGENT` assign whose `agent.timeoutSec` is 59 returns `{ ok: false, detail: 'agent' }`.
- [unit] `parseAssign` of a `RUN` assign carrying an `agent` block returns ok and drops `agent` from the parsed assign.
- [unit] `prepareCheckout` for an `AGENT` assign at ref `main` checks out the ref's sha detached and returns `{ ok: true, branch: null, refSha }` without reading any `prd.json`.
- [unit] `prepareCheckout` for an `AGENT` assign whose ref does not resolve returns `{ ok: false, reason: 'checkout: ref not found' }`.
- [unit] After a daemon restart, the supervisor re-adopts an `AGENT` row whose recorded process is alive and matches as `watch`, and one whose process is gone as `finish`.

### US-007: AGENT spawn

- [unit] `jobProfileContent` with `modelAliases` `{ reviewer: 'acp:claude' }` returns a profile whose `agent.modelAliases` equals that object.
- [unit] `jobProfileContent` with no `modelAliases`, and with an empty object, returns a profile with no `agent` key.
- [unit] `writeAgentTask(jobDir, 'Review the spec')` writes `agent-task.md` in `jobDir` holding exactly that text with file mode 0600, and returns its path.
- [unit] `buildNaxArgv(['nax'], <AGENT assign with agent { name: 'spec-reviewer', task: 'x' }, profiles ['p1'], jobId 'j1'>, { agentTaskPath: '/jobs/j1/agent-task.md' })` returns `['nax', 'agents', 'run', 'spec-reviewer', '--task-file', '/jobs/j1/agent-task.md', '--json', '--profile', 'p1,koda-job-j1']`.
- [unit] `buildNaxArgv` for an `AGENT` assign with `model` `reviewer` and `timeoutSec` 600 appends `--model reviewer --timeout 600` after the profile chain.
- [unit] `buildNaxArgv` for an `AGENT` assign never includes `--max-cost`.
- [unit] `buildNaxArgv` for an `AGENT` assign with no `agentTaskPath` throws an `Error`.
- [unit] `HostExecutor.spawn` of an `AGENT` job writes the task file into the job directory and calls `spawnNax` with the `agents run` argv carrying that file's path, the clone directory as `cwd`, and the same provider-key socket variable it gives a `RUN`.
- [unit] Preparing an `AGENT` job whose `agent.modelAliases` is `{ reviewer: 'acp:claude' }` writes the `koda-job-<jobId>` profile with that `agent.modelAliases`.
- [unit] Preparing a `REVIEW` job writes the `koda-job-<jobId>` profile with no `agent` key.

### US-008: AGENT verdict and result

- [unit] `AGENT_RESULT_LIMITS` from `@nathapp/fleet-protocol` equals `{ maxOutputBytes: 65536, maxDeniedAsks: 20, maxAskChars: 1000, maxModelChars: 200 }`.
- [unit] `readAgentResult(jobDir)` with `nax.stdout` holding `{"agent":"spec-reviewer","model":"acp:claude","status":"completed","output":"ok","deniedAsks":[],"costUsd":0.0123}` returns `{ ok: true }` with that parsed result.
- [unit] `readAgentResult` with an empty `nax.stdout` returns `{ ok: false }` carrying the first non-empty line of `nax.stderr`.
- [unit] `readAgentResult` with `nax.stdout` that is not JSON, or JSON whose `status` is `weird`, returns `{ ok: false }`.
- [unit] `fitAgentResult` of a result whose output is 70,000 bytes returns `output` equal to its last 65,536 bytes and `truncated: true`; a short output gives `truncated: false`.
- [unit] `fitAgentResult` of a result with 25 denied asks keeps the first 20 and sets `deniedAsksTruncated: true`.
- [unit] `fitAgentResult` cuts a denied question's `text` of 1,500 characters to 1,000 characters.
- [unit] `fitAgentResult` of a result with `costUsd` 0.0123 returns `costUsd` `0.0123`, and of a result with no `costUsd` returns no `costUsd`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `completed` returns verdict `COMPLETED` and a snapshot carrying the fitted `agentResult` and `costSpentUsd` `0.0123`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `timeout` returns verdict `FAILED` with reason `agent timeout` and still carries `agentResult`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `failed` returns verdict `FAILED` with reason `agent failed`.
- [unit] `JobRun.judge` for an `AGENT` job whose result status is `cancelled` and no cancel request returns verdict `FAILED` with reason `agent cancelled`.
- [unit] `JobRun.judge` for an `AGENT` job with no readable result and `nax.stderr` first line `error: unknown agent spec-reviewer` returns `FAILED` with reason `agent result unreadable: error: unknown agent spec-reviewer` and no `agentResult`.
- [unit] `JobRun.judge` for an `AGENT` job with no readable result and an empty `nax.stderr` returns `FAILED` with reason `agent result unreadable`.
- [unit] `JobRun.judge` for an `AGENT` job with a cancel request returns verdict `CANCELLED`.

### US-009: AGENT on the web job page

- [unit] The job page for an `AGENT` job renders `FleetJobAgentResult` with the job's `agentResult`.
- [unit] The job page for a `RUN` job does not render `FleetJobAgentResult`.
- [unit] `FleetJobAgentResult` with status `completed` and output `line 1\nline 2` shows the translated status and the output as preformatted text with both lines.
- [unit] `FleetJobAgentResult` with output `<b>x</b>` shows the literal text `<b>x</b>` and renders no `b` element.
- [unit] `FleetJobAgentResult` with `truncated: true` shows the `fleet.agentResult.truncated` notice.
- [unit] `FleetJobAgentResult` with one denied approval `{ tool: 'Bash', summary: 'rm -rf x' }` and one denied question `{ text: 'Which?' }` lists both entries.
- [unit] `FleetJobAgentResult` with no `costUsd` shows the `fleet.agentResult.costUnknown` notice.
- [unit] `FleetJobAgentResult` with a null `agentResult` shows the `fleet.agentResult.pending` notice.
- [unit] The English label for command `AGENT` is `Agent task` and the English `agents_run` misfit label is `nax on this runner cannot run agent tasks`; the Chinese locale has both keys.
