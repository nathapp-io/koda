<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Single-feature flow steps, stops and cost cap (fleet flow F3)

## Summary

An approved single-feature fleet flow now runs by itself. A ticker in the api advances each live flow every 30 s:
it dispatches the next job in a fixed order (spec review, `PLAN`, PRD review, `RUN`, `REVIEW`, `FIX`), waits while
that job runs, and moves on when it ends. The flow completes when the `FIX` marks the PR ready, and stops, with a
reason code and a detail text, on any failed job, any review finding, an unreadable verdict, a missing plan result or
PR, a PR the `FIX` left not ready, a refused dispatch, or the cost cap. A spec change before `PLAN` sends the flow back
to `PENDING` for a new approval. Every flow job carries the flow's id, so the flow's spend is the sum of its jobs' costs.

## Motivation

F1 (`fleet-flow-record`, #400) records flows and their one approval, and F2 (`fleet-agent-job`, #403) added the
`AGENT` job kind, but nothing moves an approved flow: `FleetFlowStartCommand.execute` and the thread tick both leave it
`APPROVED` and stop. The design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, Steps, Cost cap, Stops)
asks for a deterministic engine that chains the existing jobs, checks the cap between jobs and stops instead of
retrying. F3 builds that engine for one feature; verdict classification and spec fixes (F4), multi-feature order and
merge waits (F5) and the web pages (F6) build on it.

## Design

### User rulings (2026-11-07)

1. **Review steps stop strictly.** F3 reads only the final verdict JSON of a review `AGENT` job. No findings: the flow
   continues. Any finding, or no parseable verdict: the flow stops with the findings in its detail. F4 replaces "any
   finding stops" with classify, fix and ask.
2. **PR phase = `REVIEW` then one `FIX`.** `REVIEW` goes through the existing head claim, so auto-review cannot
   double-dispatch. A `FIX` whose `fixReady.markedReady` is true completes the feature; any other `FIX` end stops the
   flow as not ready. Agent rulings for open items are F4.
3. **Multi-feature flows wait.** F3 advances only flows with exactly one feature. A flow with more stays `APPROVED`
   and nothing is dispatched for it until F5.
4. **Review agent = api setting.** `FLEET_FLOW_REVIEW_AGENT` (default `Explore`) names the nax agent of both review
   steps; the model is always the flow's `reviewerRole`; the task starts with `/spec-review` so nax expands the skill.
5. **Drafting basis confirmed:** a 30 s ticker; stops recorded in activity and a new `stopDetail` column (no
   notification or ticket until F4); any spec-sha change before `PLAN` returns the flow to `PENDING`.

### Calls made while drafting (not user rulings)

- **Ticker only, no event hook.** Nothing fires on approval or on a job's end; the ticker finds the work within one
  interval. Steps take minutes to hours, so up to 30 s of delay is acceptable, and a tick is crash-safe where an
  in-process event is not.
- **The job row is the source of truth.** Every flow job stores `flowId` and `flowStep` in the same insert that creates
  it. The engine reads the flow's latest job (by `queuedAt`) on every tick, so a crash between dispatch and the
  bookkeeping that follows loses nothing: the next tick sees the job. `FleetFlowFeature.currentStep` and `state` are a
  display copy written after each dispatch.
- **Re-approval restarts at spec review.** An `APPROVED` flow dispatches `SPEC_REVIEW`, unless its latest job is a
  `SPEC_REVIEW` queued at or after `approvedAt` (a dispatch whose bookkeeping did not commit), which the engine adopts.
- **Spec check only before the flow's first push.** Before dispatching `SPEC_REVIEW` or `PLAN` the engine compares the
  flow's `specSha` with the thread's `publishedSha` (thread entry) or the forge head of `flow.branch` (nax entry). Any
  difference re-asks through the F1 path (`PENDING`, new `fleet.flow.start` request, new `specSha`). After `PLAN`
  pushes, the branch moves by the flow's own commits and the PRD freezes the spec, so no later step checks.
- **Refs.** `SPEC_REVIEW` runs at `flow.specSha` (exactly what was approved; the commit exists on the pinned runner for
  a thread entry and on origin for a nax entry). `PLAN` runs at `flow.branch` with `planFrom` = the spec path, and gets
  `expectBranch` like a thread `PLAN`, so a thread entry's local-only branch is used. `PRD_REVIEW` runs at the `PLAN`
  job's `resultSha`. `RUN` runs at the `PLAN` job's `resultBranch`. `REVIEW` and `FIX` take the PR number parsed from
  the `RUN` job's `resultPrUrl`.
- **Every flow job is pinned** to `flow.pinnedRunnerId` when it is set (thread entry); nax-entry flows have none.
- **Actor.** Flow jobs are dispatched through `FleetJobsService.dispatch` with the flow's `createdById` as requester
  and the new system key `system.flow.advance` as `auditKey`; the ticker runs under `@SystemWriter('system.flow.advance')`.
- **Cap.** `spentUsd` is recomputed on every tick as the sum of `costSpentUsd + costCarriedUsd` over jobs with the
  flow's id. Before any dispatch, `spentUsd >= costCapUsd` stops the flow (`cost_cap`); otherwise the job's
  `maxCostUsd` is the remaining cap (`costCapUsd - spentUsd`) rounded down to 4 decimals. A remainder below `0.0001`
  counts as reached. A job with unknown cost adds 0 (design, Cost cap).
- **`RUN` waits for its PR.** `resultPrUrl` is filled by bundle ingest, after the job ends. A `COMPLETED` or
  `ESCALATED` `RUN` (a draft PR escalates at ingest) with no PR yet waits until its `FleetBundleIngest` row for the
  job's lease is `done`, `partial` or `failed`, or until `FLEET_FLOW_PR_WAIT_MS` (default 1,800,000) has passed since
  `finishedAt`; then it stops as `run_no_pr`.
- **`REVIEW` adoption.** If `insertPending(repoId, prNumber, headSha)` returns null, another pass owns the head: the
  engine adopts the claim's job (sets its `flowId` and `flowStep`) when the claim has one, and waits when it does not.
- **Dispatch refusals stop.** `BudgetPausedException` stops as `budget_paused`; `ConflictAppException`,
  `ValidationAppException`, `NotFoundAppException` and `FleetDispatchException` stop as `dispatch_refused`. Any other
  error propagates, the ticker logs it, and the next tick tries again.
- **A human stop does not cancel the running job** (design, Stops). The bookkeeping after a dispatch writes nothing
  when the flow has meanwhile left `APPROVED`/`RUNNING`.
- **Stop details** are at most 2,000 characters (`FLOW_STOP_DETAIL_MAX`).

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `FleetFlowRecord` (`apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`).
  Baseline: no `stopDetail`.
  Target: adds `stopDetail?: string | null` (optional, so existing typed fixtures keep compiling).
- `IFleetFlowRepository.stop` (same file; `PrismaFleetFlowRepository.stop` in `prisma-fleet-flow.repository.ts`).
  Baseline: `stop(id: string, reason: string, now: Date): Promise<FleetFlowRecord>`.
  Target: `stop(id: string, reason: string, now: Date, detail?: string | null): Promise<FleetFlowRecord>`; writes
  `stopDetail` (null when omitted) and sets every feature's `state` to `STOPPED`.
- `FleetJobsService.dispatch` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:96`).
  Baseline: `opts: { scheduleId?; ticketActor?; threadId?; auditKey?: 'fleet.job.dispatch' | 'thread.plan' | 'thread.run' | 'system.schedule.dispatch' | 'system.pr-review.dispatch' | 'system.pr-fix.follow-up' }`.
  Target: `opts` adds `flowId?: string` and `flowStep?: FlowStep`, and the `auditKey` union adds `'system.flow.advance'`;
  both flow fields are written in the job insert.
- `NewFleetJob` and `FleetJobRecord` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`).
  Target: both add optional `flowId?: string | null` and `flowStep?: string | null`.
- `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts:65`).
  Baseline: `expectBranch: job.ref` only for a `PLAN` with `threadId`.
  Target: also for a `PLAN` with a non-null `flowId`.
- `FleetFlowsService.respec` (`apps/api/src/fleet/flows/fleet-flows.service.ts:129`).
  Target: its re-ask branch moves into a new public `reaskLocked(flow: FleetFlowRecord, specSha: string, now: Date): Promise<FleetFlowRecord>`
  (close the old ask if any, open a new `fleet.flow.start` request, `flows.reask`, audit `system.flow.respec`, activity
  `flow.respec`), which `respec` calls; the caller holds the locks.
- `NEW_KEY_SCOPES` and `PENDING_SURFACE_KEYS` (`apps/api/src/permissions/catalog.ts`): add `system.flow.advance`
  (`'any'`), pending until US-009's ticker declares it.
- `IFleetConfig` (`apps/api/src/config/fleet.config.ts`): adds `flowTickMs` (`FLEET_FLOW_TICK_MS`, default 30,000),
  `flowPrWaitMs` (`FLEET_FLOW_PR_WAIT_MS`, default 1,800,000) and `flowReviewAgent` (`FLEET_FLOW_REVIEW_AGENT`, default
  `Explore`).

**Read-only symbols**

- `FleetJobsService.dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto, opts)` returns
  `Promise<DispatchResultDto>` (`.job.id`); it runs no route gate.
- `IFleetPrReviewRepository` (`apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts`, token
  `FLEET_PR_REVIEW_REPOSITORY`): `insertPending(repoId, prNumber, headSha): Promise<FleetPrReviewRecord | null>`,
  `findHead(repoId, prNumber, headSha)`, `markDispatched(id, jobId)`, `remove(id)`; `FleetPrReviewRecord.jobId: string | null`.
- `prNumberFor(repo: Pick<FleetRepoRef, 'provider' | 'owner' | 'name'>, url: string): number | null` (`apps/api/src/fleet/sync/pr-attribution.service.ts:13`).
- `TERMINAL_STATES` (`apps/api/src/fleet/jobs/job-state.ts`): `COMPLETED`, `FAILED`, `ESCALATED`, `CRASHED`, `CANCELLED`.
- `ThreadsService.lockForFlowTransition(projectId, threadId)` (thread row lock, returns the thread with
  `publishedSha`), `FleetReposService.lockById(id)`, `IFleetFlowRepository.lockById(id)`; lock order is parent, then flow.
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)` and `getBranchHead(token, owner, name, branch)`
  (`apps/api/src/fleet/git-broker/github-app-client.ts`); forge failures throw `RepoCheckException`.
- `BudgetPausedException` (`apps/api/src/fleet/budgets/budget.exceptions.ts`), `FleetDispatchException`
  (`apps/api/src/fleet/jobs/fleet-dispatch.exception.ts`), `AGENT_NAME_RE` (`apps/api/src/fleet/common/agent-jobs.ts`).
- `SystemWriter` and `runAsSystemWriter` as used by `ScheduleTicker` (`apps/api/src/fleet/schedules/schedule-ticker.ts:55,95`);
  the single-flight `setInterval` + `unref` pattern of `FleetPrReviewPoller` (`apps/api/src/fleet/reviews/fleet-pr-review.poller.ts`).
- `FleetActivityService.record` with `actorType: 'SYSTEM', actorId: 'flow'` as `respec` uses it.

**New symbols**

- `apps/api/src/fleet/flows/flow-steps.ts` (pure): `FlowStep` (`'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX'`),
  `FLOW_VERDICT_INSTRUCTION`, `FLOW_STOP_DETAIL_MAX` (2000), `buildReviewTask`, `parseFlowVerdict`, `formatFindings`.
- `apps/api/src/fleet/flows/flow-step-decision.ts` (pure): `FlowJobView`, `FlowStepInput`, `FlowStepAction`, `decideFlowStep`.
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` (pure): `remainingCapUsd`, `buildStepDispatch`.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` + `prisma-fleet-flow-step.repository.ts`:
  `FLEET_FLOW_STEP_REPOSITORY`, `IFleetFlowStepRepository`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`: `FleetFlowAdvanceService.advance(flowId: string, now: Date): Promise<void>`.
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts`: `FleetFlowTicker` with `tick(now: Date): Promise<void>`.

### Approach

`advance(flowId, now)` runs three phases.

1. **Decide (one transaction).** Unlocked read of the flow; for a nax-entry flow whose next step could be
   `SPEC_REVIEW` or `PLAN`, read the forge head of `flow.branch` before the transaction (a `RepoCheckException` ends
   this tick with nothing written). Then lock parent and flow; return unless the state is `APPROVED` or `RUNNING`;
   write `spentUsd` = `sumCost(flowId)`; build `FlowStepInput` from the latest flow job and call `decideFlowStep`.
   `stop` and `complete` actions are written here. A `dispatch` action first checks the cap, then (for `SPEC_REVIEW`
   and `PLAN`) the spec sha, either of which may stop or re-ask instead.
2. **Dispatch (no transaction held).** `REVIEW` goes through the claim; every other step calls
   `jobs.dispatch(flow.createdById, flow.projectId, buildStepDispatch(...), { flowId, flowStep, auditKey: 'system.flow.advance' })`.
3. **Record (one transaction).** Lock parent and flow; if the flow is still `APPROVED` or `RUNNING`, mark the step
   (`APPROVED` becomes `RUNNING` with activity `flow.started`), and record activity `flow.step`.

```ts
// flow-step-decision.ts (shape, not final code)
export type FlowStepAction =
  | { kind: 'skip' }                                   // not single-feature
  | { kind: 'wait' }
  | { kind: 'complete' }
  | { kind: 'stop'; reason: FlowStopReason; detail: string }
  | { kind: 'dispatch'; step: FlowStep; pr?: { number: number; headSha: string } };
```

Stop reasons: `step_failed`, `verdict_unreadable`, `review_findings`, `plan_no_result`, `run_no_pr`, `pr_not_ready`,
`cost_cap`, `budget_paused`, `dispatch_refused`.

The verdict instruction appended to both review tasks:

```text
When you are done, end your reply with exactly one JSON object on its own line, with no text after it:
{"findings":[{"id":"<short id>","summary":"<one sentence>"}]}
Use {"findings":[]} when you found nothing that should change before the next step.
```

### Failure Handling

| Situation | Behaviour |
|---|---|
| Flow job ends `FAILED`, `CANCELLED` or `CRASHED` | stop `step_failed`, detail `<STEP> job <id> <state>: <stateReason or 'no reason'>` |
| Non-`RUN` job ends `ESCALATED` | stop `step_failed` with the same detail |
| Review job `COMPLETED` with no parseable verdict | stop `verdict_unreadable`, detail `<STEP> job <id>: no verdict JSON in the agent output` |
| Review verdict has one or more findings | stop `review_findings`, detail from `formatFindings` |
| `PLAN` `COMPLETED` without `resultBranch` or `resultSha` | stop `plan_no_result` |
| `RUN` ended, no PR, ingest settled or wait elapsed | stop `run_no_pr` |
| `RUN` ended, no PR, ingest not settled and wait not elapsed | wait |
| `FIX` `COMPLETED` with `fixReady.markedReady` not true | stop `pr_not_ready`, detail = `readyHeld` or `FIX ended without a ready result` |
| `spentUsd` reached the cap before a dispatch | stop `cost_cap`, detail `spent <spent> of cap <cap>` |
| Dispatch throws `BudgetPausedException` | stop `budget_paused` |
| Dispatch throws a conflict, validation, not-found or dispatch exception | stop `dispatch_refused`, detail `<STEP>: <exception code or reason>` |
| Dispatch throws anything else | error propagates; nothing written; the next tick retries |
| Spec sha changed before `SPEC_REVIEW`/`PLAN` | `reaskLocked` → `PENDING` with the new sha |
| Forge head read fails (nax entry) | this tick does nothing for the flow |
| `REVIEW` claim held by another pass with no job yet | wait |
| Flow left `APPROVED`/`RUNNING` between dispatch and record | record writes nothing; the job keeps running |
| One flow's `advance` throws inside a tick | logged; the tick continues with the next flow |

## Out of Scope

- Verdict classification (`answered`/`minor`/`ambiguous`), spec-fix jobs, batched questions, agent rulings on open PR items and the flow's ticket (fleet flow F4).
- Notifications on a flow stop or completion: until F4, a stop is visible only in flow activity, `stopReason` and `stopDetail`.
- Flows with more than one feature, feature order, merge waits and independent features (fleet flow F5); F3 leaves such a flow `APPROVED`.
- Every web page and the `FleetFlowDto` fields for steps, jobs and `stopDetail` (fleet flow F6), including the "cap excludes N jobs with unknown cost" display.
- Running `REVIEW` and `FIX` on the reviewer role's model: flow `PLAN`, `RUN`, `REVIEW` and `FIX` jobs use the default profile chain (`profiles: []`).
- Cancelling a running job when a flow stops or returns to `PENDING`: by design the flow only starts nothing more.
- Retrying a failed step: any failure stops the flow; a stopped flow is never restarted in place.
- Re-checking the spec sha after `PLAN` has been dispatched, and reacting to a thread re-publish while a flow is `RUNNING` (the F1 listener ignores it).
- Recomputing `spentUsd` after a flow has stopped or completed, when a late ingest raises a job's cost.
- Enforcing the cap inside `AGENT`, `PLAN`, `REVIEW` or `FIX` jobs beyond the `maxCostUsd` each job already receives.
- A durable outbox event for job ends; the ticker's interval is the only trigger.
- Running more than one api instance's ticker against the same database: the single-flight guard is per process, and duplicate dispatches are left to the existing one-active-job-per-`(repoId, feature)` 409.
- Regenerating the CLI client and CLI commands for flows; `openapi.json` does not change.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Flow job columns and the step repository

Workdir: `apps/api`. No dependencies. Adds `FleetJob.flowId` (nullable, relation to `FleetFlow` with
`onDelete: SetNull`, indexed with `queuedAt`) and `FleetJob.flowStep` (nullable string), and `FleetFlow.stopDetail`
(nullable string), in one migration. `FleetFlowRecord` gains optional `stopDetail`; `IFleetFlowRepository.stop` takes an
optional `detail` and stops every feature. A new `IFleetFlowStepRepository` (token `FLEET_FLOW_STEP_REPOSITORY`) holds
the engine's reads and writes: `listAdvanceable(limit)`, `latestJob(flowId)`, `latestJobForStep(flowId, step)`,
`sumCost(flowId)`, `setSpent(flowId, spentUsd)`, `ingestSettled(jobId, leaseEpoch)`, `linkJob(jobId, flowId, step)`,
`markStep(flowId, featureId, step, data)` and `complete(flowId, now)`.

### US-002: Flow fields on dispatch and the system key

Workdir: `apps/api`. Depends on US-001. `FleetJobsService.dispatch` accepts `flowId` and `flowStep` and writes them in
the insert; its `auditKey` union gains `system.flow.advance`, which is added to `NEW_KEY_SCOPES` (`'any'`) and
`PENDING_SURFACE_KEYS`. `buildAssignPayload` gives a flow `PLAN` `expectBranch`. `FleetJobRecord` exposes `flowId` and
`flowStep`.

### US-003: Review tasks and the verdict parser

Workdir: `apps/api`. No dependencies. Pure module `flow-steps.ts`: `FlowStep`, `FLOW_VERDICT_INSTRUCTION`,
`FLOW_STOP_DETAIL_MAX`, `buildReviewTask(step, specPath)`, `parseFlowVerdict(output)` and `formatFindings(findings)`.

### US-004: The step decision

Workdir: `apps/api`. Depends on US-003. Pure `decideFlowStep(input: FlowStepInput): FlowStepAction` applying the step
order, the job-end rules, the verdict rule, the `RUN` PR wait and the `FIX` ready rule from the Failure Handling table.

### US-005: Step dispatch bodies and the remaining cap

Workdir: `apps/api`. Depends on US-003. Pure `remainingCapUsd(capUsd, spentUsd): string | null` and
`buildStepDispatch(input): DispatchFleetJobDto` producing each step's body (refs, agent, model, `planFrom`, `prNumber`,
`maxCostUsd`, `pinnedRunnerId`).

### US-006: Advancing a flow

Workdir: `apps/api`. Depends on US-001, US-002, US-004, US-005. `FleetFlowAdvanceService.advance(flowId, now)` with
the decide, dispatch and record phases for every step but `REVIEW`: locks, spend, cap stop, job-end stops, complete,
dispatch through `FleetJobsService.dispatch`, dispatch refusals, and the `flow.started`, `flow.step`, `flow.stopped`
and `flow.completed` activity.

### US-007: Spec change before PLAN

Workdir: `apps/api`. Depends on US-006. Before dispatching `SPEC_REVIEW` or `PLAN`, `advance` compares `flow.specSha`
with the thread's `publishedSha` (thread entry) or the forge head of `flow.branch` (nax entry) and re-asks through
`FleetFlowsService.reaskLocked`, extracted from `respec`.

### US-008: REVIEW through the head claim

Workdir: `apps/api`. Depends on US-006. The `REVIEW` dispatch claims the head with `insertPending`, records the job with
`markDispatched`, removes the claim when the dispatch is refused, and adopts or waits for a head another pass holds.

### US-009: The flow ticker

Workdir: `apps/api`. Depends on US-006, US-007, US-008. `FleetFlowTicker` (`@SystemWriter('system.flow.advance')`)
runs `tick(now)` every `flowTickMs` when `sweepEnabled`, single-flight, and advances each advanceable flow under
`runAsSystemWriter`; the three config values are added; `FlowsModule` wires the ticker, the advance service and the
step repository; `system.flow.advance` leaves `PENDING_SURFACE_KEYS`.

### Context Files

**US-001**

- `apps/api/prisma/schema.prisma` — `FleetJob`, `FleetFlow` and `FleetFlowFeature` models
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — the flow repository whose `stop` changes
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — `FleetFlowRecord` and `IFleetFlowRepository`
- `apps/api/test/integration/fleet/thread-modes-migration.integration.spec.ts` — migration test pattern

**US-002**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `NewFleetJob`, `FleetJobRecord`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `createJob` and `toJob`
- `apps/api/src/fleet/jobs/assign-payload.ts` — `expectBranch`
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS`

**US-003**

- `apps/api/src/fleet/common/agent-jobs.ts` — the `AGENT` task bounds the review task must respect

**US-004**

- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-003; `parseFlowVerdict` and `formatFindings` are used here
- `apps/api/src/fleet/jobs/job-state.ts` — `TERMINAL_STATES`
- `apps/api/src/fleet/sync/event-payloads.ts` — the `fixReady` shape

**US-005**

- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-003; `buildReviewTask`
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the body this story builds
- `apps/api/src/fleet/threads/threads.service.ts` — the thread `plan()` and `run()` bodies this mirrors

**US-006**

- `apps/api/src/fleet/flows/fleet-flows.service.ts` — lock order and activity pattern (`stop`, `respec`)
- `apps/api/src/fleet/flows/flow-step-decision.ts` — created by US-004
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` — created by US-005
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — created by US-001
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — dispatch exception handling precedent

**US-007**

- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `respec`, `openStartRequest`
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — the nax-entry forge head read
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-006

**US-008**

- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — claim, dispatch, `markDispatched` precedent
- `apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts` — `IFleetPrReviewRepository`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-006

**US-009**

- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `@SystemWriter` + `runAsSystemWriter` ticker precedent
- `apps/api/src/fleet/reviews/fleet-pr-review.poller.ts` — single-flight interval precedent
- `apps/api/src/config/fleet.config.ts` — config fields and env parsing
- `apps/api/src/fleet/flows/flows.module.ts` — module wiring
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the declared-writer list

### Creates

**US-001**

- `apps/api/prisma/migrations/20261128090000_fleet_flow_steps/migration.sql`
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-003**

- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-steps.spec.ts`

**US-004**

- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-005**

- `apps/api/src/fleet/flows/flow-step-dispatch.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts`

**US-006**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`

**US-009**

- `apps/api/src/fleet/flows/fleet-flow.ticker.ts`
- `apps/api/src/fleet/flows/fleet-flow.ticker.spec.ts`
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts`

### Modifies

**US-002**

- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES` table ends at `system.flow.respec`; add `system.flow.advance: 'any'` so the table still equals the catalog's.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role's map gains `"system.flow.advance": ["non-role-key","non-role-key"]`, the same value `system.flow.respec` has; no other entry changes.

**US-009**

- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer list gains `[FleetFlowTicker, 'system.flow.advance']`, and the pending-key assertion now expects `PENDING_SURFACE_KEYS.has('system.flow.advance')` to be false.

### Seams

- US-002 → US-006: `advance` passes `flowId`, `flowStep` and `auditKey: 'system.flow.advance'` to `FleetJobsService.dispatch` (US-006 pins the call; US-009's integration test proves the stored row).
- US-004/US-005 → US-006: `advance` dispatches exactly the body `buildStepDispatch` returns for the step `decideFlowStep` chose.
- US-006 → US-009: `FleetFlowTicker.tick` calls `FleetFlowAdvanceService.advance` once per advanceable flow (US-009 seam AC, entered at `tick`).
- US-007 → US-006: `advance` calls `FleetFlowsService.reaskLocked` before a `SPEC_REVIEW`/`PLAN` dispatch whose sha check fails.

## Acceptance Criteria

### US-001: Flow job columns and the step repository

- [integration] After the migration, inserting a `FleetJob` with `flowId` set to an existing flow's id and `flowStep` `'PLAN'` and reading it back returns both values.
- [integration] Deleting a `FleetFlow` sets `flowId` to null on its jobs and deletes no job.
- [integration] `PrismaFleetFlowRepository.stop(id, 'cost_cap', now, 'spent 5 of cap 5')` returns a record with state `STOPPED`, `stopReason` `cost_cap`, `stopDetail` `spent 5 of cap 5`, `endedAt` equal to `now`, and every feature's `state` `STOPPED`.
- [integration] `PrismaFleetFlowRepository.stop(id, 'human_stop', now)` without a detail stores `stopDetail` null.
- [integration] `listAdvanceable(50)` returns the ids of flows in state `APPROVED` or `RUNNING`, oldest `createdAt` first, and omits flows in `PENDING`, `WAITING_MERGE`, `WAITING_ANSWER`, `COMPLETED` and `STOPPED`.
- [integration] `listAdvanceable(1)` with two `APPROVED` flows returns only the older one.
- [integration] `latestJob(flowId)` returns the flow's job with the greatest `queuedAt`, and null for a flow with no jobs.
- [integration] `latestJobForStep(flowId, 'PLAN')` returns the newest job of that flow whose `flowStep` is `PLAN`, ignoring newer jobs of other steps.
- [integration] `sumCost(flowId)` over jobs with `costSpentUsd` `1.2500`/`costCarriedUsd` `0.5000` and `costSpentUsd` `2.0000`/`costCarriedUsd` `0` returns `'3.7500'`, and ignores a job with another `flowId`.
- [integration] `sumCost(flowId)` for a flow with no jobs returns `'0.0000'`.
- [integration] `ingestSettled(jobId, leaseEpoch)` returns true when a `FleetBundleIngest` row for that job and lease has status `done`, `partial` or `failed`, and false when it is `pending` or `running` or no row exists.
- [integration] `linkJob(jobId, flowId, 'REVIEW')` sets the job's `flowId` and `flowStep` only when its `flowId` was null, and returns false without writing when the job already has a different `flowId`.
- [integration] `markStep(flowId, featureId, 'REVIEW', { flowState: 'RUNNING', prNumber: 7 })` sets the flow state `RUNNING`, the feature's `state` `RUNNING`, `currentStep` `REVIEW` and `prNumber` 7.
- [integration] `complete(flowId, now)` sets the flow state `COMPLETED` with `endedAt` `now` and the feature's `state` `COMPLETED`.

### US-002: Flow fields on dispatch and the system key

- [integration] `FleetJobsService.dispatch` with `opts` `{ flowId, flowStep: 'PLAN', auditKey: 'system.flow.advance' }` creates a job whose stored `flowId` and `flowStep` equal those values.
- [integration] `FleetJobsService.dispatch` without `flowId` creates a job whose `flowId` and `flowStep` are null.
- [unit] `FleetJobRecord` returned by the job repository's `toJob` carries `flowId` and `flowStep` from the row (null when unset).
- [unit] `buildAssignPayload` for a `PLAN` job with `flowId` `flow-1`, no `threadId` and `ref` `feat/x` sets `expectBranch` `feat/x`.
- [unit] `buildAssignPayload` for a `RUN` job with `flowId` `flow-1` sets no `expectBranch`.
- [unit] `buildAssignPayload` for a `PLAN` job with neither `threadId` nor `flowId` sets no `expectBranch`.
- [unit] `findCatalogEntry('system.flow.advance')` returns an entry with `access` `system`.
- [unit] `PENDING_SURFACE_KEYS.has('system.flow.advance')` is true.

### US-003: Review tasks and the verdict parser

- [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md')` returns `/spec-review .nax/features/a/spec.md`, a blank line, then `FLOW_VERDICT_INSTRUCTION`.
- [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md')` returns `/spec-review --prd .nax/features/a/spec.md`, a blank line, then `FLOW_VERDICT_INSTRUCTION`.
- [unit] `FLOW_VERDICT_INSTRUCTION` includes the example line `{"findings":[]}`, and `buildReviewTask` output for a 400-character spec path is at most 16,384 characters.
- [unit] `parseFlowVerdict` of `Looks good.\n{"findings":[]}` returns `{ ok: true, findings: [] }`.
- [unit] `parseFlowVerdict` of text ending in `{"findings":[{"id":"F1","summary":"Missing AC for 409"}]}` returns `ok` true with one finding `{ id: 'F1', summary: 'Missing AC for 409' }`.
- [unit] `parseFlowVerdict` uses the last `{"findings"` object when the output contains two, so `{"findings":[{"summary":"x"}]}\n...\n{"findings":[]}` returns no findings.
- [unit] `parseFlowVerdict` accepts the verdict when it is followed by a closing code fence and trailing whitespace.
- [unit] `parseFlowVerdict` returns `{ ok: false }` for output with no `{"findings"` text.
- [unit] `parseFlowVerdict` returns `{ ok: false }` when the text after the last `{"findings"` is not valid JSON.
- [unit] `parseFlowVerdict` returns `{ ok: false }` when `findings` is not an array, or an element has no non-empty string `summary`.
- [unit] `parseFlowVerdict` drops a finding's non-string `id` and keeps its `summary`.
- [unit] `formatFindings` of two findings `{ id: 'F1', summary: 'a' }` and `{ summary: 'b' }` returns `2 findings: 1. [F1] a 2. b`.
- [unit] `formatFindings` of 100 findings of 100 characters each returns a string of exactly `FLOW_STOP_DETAIL_MAX` (2000) characters ending in `…`.

### US-004: The step decision

- [unit] `decideFlowStep` with `featureCount` 2 returns `{ kind: 'skip' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and no latest job returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and a latest `PLAN` job queued before `approvedAt` returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and a latest `SPEC_REVIEW` job in `RUNNING` queued at or after `approvedAt` returns `{ kind: 'wait' }`.
- [unit] For each latest-job state `QUEUED`, `ASSIGNED`, `RUNNING` and `UPLOADING` on a `RUNNING` flow, `decideFlowStep` returns `{ kind: 'wait' }`.
- [unit] For each latest-job state `FAILED`, `CANCELLED` and `CRASHED`, `decideFlowStep` returns a stop with reason `step_failed` and detail `PLAN job j1 FAILED: checkout: no .nax dir` for a `PLAN` job `j1` with that `stateReason` (state name varying), and `no reason` when `stateReason` is null.
- [unit] `decideFlowStep` with a latest `REVIEW` job in `ESCALATED` returns a stop with reason `step_failed`.
- [unit] `decideFlowStep` with a `COMPLETED` `SPEC_REVIEW` job whose output ends in `{"findings":[]}` returns `{ kind: 'dispatch', step: 'PLAN' }`, and the same for `PRD_REVIEW` returns `{ kind: 'dispatch', step: 'RUN' }`.
- [unit] `decideFlowStep` with a `COMPLETED` review job whose verdict has one finding returns a stop with reason `review_findings` and the `formatFindings` text as detail.
- [unit] `decideFlowStep` with a `COMPLETED` review job whose output is null or has no verdict returns a stop with reason `verdict_unreadable` and detail `SPEC_REVIEW job <id>: no verdict JSON in the agent output`.
- [unit] `decideFlowStep` with a `COMPLETED` `PLAN` job with `resultBranch` and `resultSha` returns `{ kind: 'dispatch', step: 'PRD_REVIEW' }`, and with either missing returns a stop with reason `plan_no_result`.
- [unit] `decideFlowStep` with a `COMPLETED` or `ESCALATED` `RUN` job whose `prNumber` is 12 and `resultSha` is `abc1234` returns `{ kind: 'dispatch', step: 'REVIEW', pr: { number: 12, headSha: 'abc1234' } }`.
- [unit] `decideFlowStep` with a `COMPLETED` `RUN` job with no `prNumber` returns `{ kind: 'wait' }` when `ingestSettled` is false and `now - finishedAt` is below `prWaitMs`, and a stop with reason `run_no_pr` when `ingestSettled` is true or `now - finishedAt` equals `prWaitMs`.
- [unit] `decideFlowStep` with a `COMPLETED` `REVIEW` job returns `{ kind: 'dispatch', step: 'FIX', pr: { number, headSha } }` carrying the feature's `prNumber` and the `REVIEW` job's head sha.
- [unit] `decideFlowStep` with a `COMPLETED` `FIX` job returns `{ kind: 'complete' }` when `fixReady.markedReady` is true, a stop `pr_not_ready` with detail `no CI` when `fixReady` is `{ markedReady: false, readyHeld: 'no CI' }`, and a stop `pr_not_ready` with detail `FIX ended without a ready result` when `fixReady` is null.

### US-005: Step dispatch bodies and the remaining cap

- [unit] `remainingCapUsd('10', '3.25')` returns `'6.7500'`; `remainingCapUsd('10', '9.99995')` returns null; `remainingCapUsd('5', '5')` returns null; `remainingCapUsd('5', '6')` returns null.
- [unit] `remainingCapUsd('1', '0.33333')` rounds down and returns `'0.6666'`.
- [unit] `buildStepDispatch` for `SPEC_REVIEW` on a flow with `specSha` `s1`, `reviewerRole` `opus`, feature `f`, spec path `.nax/features/f/spec.md`, review agent `Explore` and remaining `'6.7500'` returns `{ repoId, command: 'AGENT', feature: 'f', ref: 's1', bashMode: 'raw', maxCostUsd: 6.75, agent: { name: 'Explore', task: buildReviewTask('SPEC_REVIEW', '.nax/features/f/spec.md'), model: 'opus' } }` with no other keys.
- [unit] `buildStepDispatch` for `PLAN` on a flow with `branch` `feat/f` returns command `PLAN`, `ref` `feat/f`, `feature` `f`, `planFrom` the spec path, `profiles` `[]` and the remaining cap as `maxCostUsd`.
- [unit] `buildStepDispatch` for `PRD_REVIEW` returns command `AGENT`, `ref` = the given `PLAN` job's `resultSha`, and a task equal to `buildReviewTask('PRD_REVIEW', specPath)`.
- [unit] `buildStepDispatch` for `RUN` returns command `RUN`, `ref` = the given `PLAN` job's `resultBranch`, `feature` `f`, `profiles` `[]` and the remaining cap as `maxCostUsd`.
- [unit] `buildStepDispatch` for `REVIEW` with `pr` `{ number: 12 }` returns command `REVIEW`, `prNumber` 12, `profiles` `[]` and no `ref` or `feature`.
- [unit] `buildStepDispatch` for `FIX` with `pr` `{ number: 12 }` returns command `FIX`, `prNumber` 12, `profiles` `[]` and no `ref` or `feature`.
- [unit] `buildStepDispatch` on a flow with `pinnedRunnerId` `r1` sets `pinnedRunnerId` `r1` for every step, and omits the key when the flow's is null.
- [unit] `buildStepDispatch` for `PRD_REVIEW` or `RUN` with no `PLAN` job throws an `Error` naming the missing plan.

### US-006: Advancing a flow

- [unit] `advance` on a flow in state `PENDING`, `COMPLETED` or `STOPPED` dispatches nothing and writes nothing.
- [unit] `advance` locks the thread with `ThreadsService.lockForFlowTransition` before `flows.lockById` for a thread-entry flow, and `FleetReposService.lockById` before `flows.lockById` for a nax-entry flow.
- [unit] `advance` calls `steps.setSpent(flowId, '3.7500')` when `sumCost` returns `'3.7500'` and the flow's `spentUsd` is `'0.0000'`.
- [unit] `advance` on an `APPROVED` single-feature flow with `specSha` equal to the thread's `publishedSha` calls `FleetJobsService.dispatch` once with `flow.createdById`, `flow.projectId`, the body `buildStepDispatch` returns for `SPEC_REVIEW`, and `opts` `{ flowId, flowStep: 'SPEC_REVIEW', auditKey: 'system.flow.advance' }`.
- [unit] After that dispatch returns job `j1`, `advance` calls `steps.markStep` with flow state `RUNNING` and step `SPEC_REVIEW`, and records activity `flow.started` (payload with `approvalMode` and `approverId`) and `flow.step` (payload `{ step: 'SPEC_REVIEW', jobId: 'j1' }`), both with `actorType` `SYSTEM` and `actorId` `flow`.
- [unit] `advance` on a `RUNNING` flow whose decision is `dispatch PLAN` records `flow.step` and no `flow.started`.
- [unit] `advance` when the decision is `wait` dispatches nothing and writes nothing but `spentUsd`.
- [unit] `advance` when the decision is a stop calls `flows.stop(flowId, reason, now, detail)` and records activity `flow.stopped` with payload `{ flowId, stopReason, detail, step, jobId }`.
- [unit] `advance` when the decision is `complete` calls `steps.complete(flowId, now)` and records activity `flow.completed`.
- [unit] `advance` with `spentUsd` `'5.0000'` and `costCapUsd` `'5.0000'` and a dispatch decision stops with reason `cost_cap` and detail `spent 5.0000 of cap 5.0000`, and does not call `dispatch`.
- [unit] `advance` passes `maxCostUsd` 1.5 to `dispatch` when `costCapUsd` is `'5'` and `sumCost` returns `'3.5000'`.
- [unit] `advance` stops with reason `budget_paused` when `dispatch` throws `BudgetPausedException`.
- [unit] `advance` stops with reason `dispatch_refused` and a detail starting `PLAN:` when `dispatch` throws `ConflictAppException`, `ValidationAppException`, `NotFoundAppException` or `FleetDispatchException`.
- [unit] `advance` rethrows an `Error` thrown by `dispatch` that is none of those, and writes no stop.
- [unit] `advance` writes no step and no activity when the flow is `STOPPED` at the record phase after a successful dispatch.

### US-007: Spec change before PLAN

- [unit] `FleetFlowsService.reaskLocked(flow, 'newsha', now)` on an `APPROVED` flow closes the flow's old request with reason `superseded`, opens a new `fleet.flow.start` request, and returns the record from `flows.reask(flow.id, { specSha: 'newsha', approvalRequestId })` in state `PENDING`.
- [unit] `FleetFlowsService.respec` with a re-ask case still produces a `PENDING` flow with the new sha and audit `system.flow.respec`, now through `reaskLocked`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch SPEC_REVIEW` and whose thread `publishedSha` differs from `specSha` calls `reaskLocked(flow, publishedSha, now)` and does not call `dispatch`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch PLAN` and whose thread `publishedSha` differs calls `reaskLocked` and does not call `dispatch`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch RUN` does not compare `publishedSha` and dispatches `RUN` although it differs.
- [unit] `advance` on a nax-entry flow whose decision could be `SPEC_REVIEW` reads `getBranchHead` with a read-only token before opening its transaction, and with a head equal to `specSha` dispatches `SPEC_REVIEW`.
- [unit] `advance` on a nax-entry flow whose forge head differs from `specSha` calls `reaskLocked(flow, head, now)` and does not dispatch.
- [unit] `advance` on a nax-entry flow when `getBranchHead` throws `RepoCheckException` dispatches nothing, writes nothing, and does not throw.
- [unit] `advance` on a nax-entry flow whose latest job is a `COMPLETED` `RUN` does not call `getBranchHead`.

### US-008: REVIEW through the head claim

- [unit] `advance` with decision `dispatch REVIEW` for PR 12 at head `h1` calls `insertPending(repoId, 12, 'h1')`, then `dispatch` with the `REVIEW` body and `flowStep` `REVIEW`, then `markDispatched(claim.id, jobId)`.
- [unit] After that dispatch, `advance` calls `steps.markStep` with step `REVIEW` and `prNumber` 12.
- [unit] When `insertPending` returns null and `findHead` returns a row with `jobId` `j9`, `advance` calls `steps.linkJob('j9', flowId, 'REVIEW')`, does not call `dispatch`, and records `flow.step` with `jobId` `j9`.
- [unit] When `insertPending` returns null and `findHead` returns a row with `jobId` null, `advance` dispatches nothing and writes no step.
- [unit] When the `REVIEW` dispatch throws `ConflictAppException`, `advance` calls `remove(claim.id)` and stops the flow with reason `dispatch_refused`.
- [unit] When the `REVIEW` dispatch throws `BudgetPausedException`, `advance` calls `remove(claim.id)` and stops the flow with reason `budget_paused`.
- [unit] When `linkJob` returns false (the job belongs to another flow), `advance` stops the flow with reason `dispatch_refused` and detail `REVIEW: head claimed by another flow`.

### US-009: The flow ticker

- [unit] `fleetConfig()` with no flow variables set returns `flowTickMs` 30000, `flowPrWaitMs` 1800000 and `flowReviewAgent` `Explore`.
- [unit] `fleetConfig()` with `FLEET_FLOW_REVIEW_AGENT` `plugin:reviewer` returns that name, and with `FLEET_FLOW_REVIEW_AGENT` `../x` throws an error naming `FLEET_FLOW_REVIEW_AGENT`.
- [unit] `FleetFlowTicker.onModuleInit` with `sweepEnabled` false starts no interval.
- [unit] `FleetFlowTicker.tick(now)` calls `steps.listAdvanceable(50)` and then `FleetFlowAdvanceService.advance(id, now)` once for each returned id, in order.
- [unit] `FleetFlowTicker.tick` continues with the next flow when `advance` throws for one flow, and logs the error with the flow id.
- [unit] A second `poll()` while the first is still running returns without calling `listAdvanceable` again.
- [unit] `FleetFlowTicker` declares the system writer `system.flow.advance`, and `PENDING_SURFACE_KEYS.has('system.flow.advance')` is false.
- [integration] With an `APPROVED` single-feature thread-entry flow whose `specSha` equals its thread's `publishedSha`, and `FleetJobsService.dispatch` spied, `FleetFlowTicker.tick(now)` calls `dispatch` once with command `AGENT` and `opts.flowId` equal to the flow's id, and the flow is `RUNNING` with its feature's `currentStep` `SPEC_REVIEW` afterwards.
- [integration] With the same flow and the real `FleetJobsService`, `tick(now)` creates one `FleetJob` with `flowId` the flow's id, `flowStep` `SPEC_REVIEW`, command `AGENT` and `ref` the flow's `specSha`; a second `tick` while that job is `QUEUED` creates no other job.
- [integration] With an `APPROVED` flow with two features, `tick(now)` creates no job and leaves the flow `APPROVED`.
- [integration] With a `RUNNING` flow whose latest `SPEC_REVIEW` job is `FAILED` with reason `checkout: ref not found`, `tick(now)` leaves the flow `STOPPED` with `stopReason` `step_failed` and `stopDetail` `SPEC_REVIEW job <id> FAILED: checkout: ref not found`.
