<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Single-feature flow steps, stops and cost cap (fleet flow F3)

## Summary

An approved single-feature fleet flow now runs by itself. A ticker in the api advances each live flow every 30 s:
it dispatches the next job in a fixed order (spec review, `PLAN`, PRD review, `RUN`, `REVIEW`, `FIX`), waits while
that job runs, and moves on when it ends. The flow completes when the `FIX` marks the PR ready, and stops, with a
reason code and a detail text, on any failed job, any review finding, an unreadable verdict, a missing plan result or
PR, a PR the `FIX` left not ready, a refused dispatch, a creator who lost access, or the cost cap. A spec change before
`PLAN` sends the flow back to `PENDING` for a new approval. Every flow job carries the flow's id, so the flow's spend
is the sum of its jobs' costs.

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
5. **Drafting basis confirmed:** a 30 s ticker; stops recorded in activity, audit and a new `stopDetail` column (no
   notification or ticket until F4); any spec-sha change before `PLAN` returns the flow to `PENDING`.

### Calls made while drafting (not user rulings)

- **Ticker only, no event hook.** Nothing fires on approval or on a job's end; the ticker finds the work within one
  interval. Steps take minutes to hours, so up to 30 s of delay is acceptable, and a tick is crash-safe where an
  in-process event is not.
- **The job row is the source of truth.** Every flow job stores `flowId` and `flowStep` in the same insert that creates
  it. The engine reads the flow's latest job (by `queuedAt`) on every tick, so a crash between dispatch and the
  bookkeeping that follows loses nothing: the next tick sees the job. `FleetFlowFeature.state` and `currentStep` are a
  display copy written after each dispatch.
- **Re-approval restarts at spec review.** An `APPROVED` flow dispatches `SPEC_REVIEW`, unless its latest job is a
  `SPEC_REVIEW` queued at or after `approvedAt` (a dispatch whose bookkeeping did not commit), which the engine adopts.
  A re-ask resets the feature's `state` to `PENDING` and `currentStep` to null.
- **Spec check only before the flow's first push.** Before dispatching `SPEC_REVIEW` or `PLAN` the engine compares the
  flow's `specSha` with the thread's `publishedSha` (thread entry) or the forge head of `flow.branch` (nax entry). Any
  difference re-asks through the F1 path (`PENDING`, new `fleet.flow.start` request, new `specSha`). After `PLAN`
  pushes, the branch moves by the flow's own commits and the PRD freezes the spec, so no later step checks.
- **Refs.** `SPEC_REVIEW` runs at `flow.specSha`. `PLAN` runs at `flow.branch` with `planFrom` = the spec path, and
  gets `expectBranch` like a thread `PLAN`, so a thread entry's local-only branch is used. `PRD_REVIEW` runs at the
  `PLAN` job's `resultSha` and reviews `.nax/features/<feature>/prd.json` (where `nax plan` writes it) against the spec.
  `RUN` runs at the `PLAN` job's `resultBranch`. `REVIEW` and `FIX` take the PR number parsed from the `RUN` job's
  `resultPrUrl` with `prNumberFor`.
- **The `REVIEW` claim key is the `RUN` job's `resultSha`.** It is the head the `RUN` pushed and published; nothing else
  writes the feature branch between the `RUN` and the flow's `REVIEW`. The `FIX` needs only the PR number.
- **Every flow job is pinned** to `flow.pinnedRunnerId` when it is set (thread entry); nax-entry flows have none.
- **Actor.** Each flow is advanced inside `runAsSystem('flow', ..., { onBehalfOf: { type: createdByType, id: createdById } })`,
  as `FixFollowUpSubscriber` does, so `actorTypeFor` records an agent creator as `AGENT`. Flow jobs are dispatched
  through `FleetJobsService.dispatch` with `createdById` as requester and the new system key `system.flow.advance` as
  `auditKey`. The ticker declares `@SystemWriter('system.flow.advance')`.
- **Creator access.** Before each dispatch the creator must still exist, not be disabled, and hold `fleet.job.dispatch`
  in the flow's project (`mayDispatch` from `apps/api/src/fleet/schedules/schedule-access.ts` over the step repository's
  `creatorAccess` and `PermissionService.effectiveKeys`); otherwise the flow stops as `creator_lost_access`.
- **Audit.** Every flow write the engine makes is covered: each stop, completion, step record and job adoption records
  an `AuditRecorder` entry with key `system.flow.advance`, resource type `flow`; `setSpent` runs under a new
  bookkeeping reason `fleet.flow-bookkeeping`; claim writes run under the existing `fleet.pr-review-bookkeeping`.
  `setSpent` is called only when the sum differs from the stored `spentUsd`.
- **Cap.** `spentUsd` is recomputed on every tick as the sum of `costSpentUsd + costCarriedUsd` over jobs with the
  flow's id. Before any dispatch, a remaining cap (`costCapUsd - spentUsd`, rounded down to 4 decimals) below `0.0001`
  stops the flow (`cost_cap`); otherwise the remaining cap is the job's `maxCostUsd`. A job with unknown cost adds 0.
- **`RUN` waits for its PR.** `resultPrUrl` is filled by bundle ingest, after the job ends. A `COMPLETED` or
  `ESCALATED` `RUN` (a draft PR escalates at ingest) with no PR yet waits until its `FleetBundleIngest` row for the
  job's lease is `done`, `partial` or `failed`, or until `FLEET_FLOW_PR_WAIT_MS` (default 1,800,000) has passed since
  `finishedAt`; then it stops as `run_no_pr`.
- **`REVIEW` claim states** (a new exported `FleetReviewClaimService` in the reviews module, since the review repository
  is module-private): no row → claimed; a row with a job → adopted (the job gets the flow's id and step through
  `FleetJobsService.adoptForFlow`); a `pending` row younger than `prReviewPollMs` → wait; an older `pending` row (a dead
  pass's claim, as `ReviewHeadDispatcher.reopenStaleClaim` treats it) → removed, then claimed; a `failed:*` row → stop
  `dispatch_refused`.
- **Dispatch refusals stop.** `BudgetPausedException` stops as `budget_paused`; `ConflictAppException`,
  `ValidationAppException`, `NotFoundAppException` and `FleetDispatchException` stop as `dispatch_refused` with detail
  `<STEP>: <reason>`, where the reason is the `ValidationAppException`'s `args.reason` when it is a string and the
  exception's class name otherwise (the `ReviewHeadDispatcher` rule). Any other error propagates, the ticker logs it,
  and the next tick tries again.
- **A human stop does not cancel the running job** (design, Stops). The bookkeeping after a dispatch writes nothing
  when the flow has meanwhile left `APPROVED`/`RUNNING`. `IFleetFlowRepository.stop` now also marks every feature
  `STOPPED`, for every caller.
- **Stop details** are at most 2,000 characters (`FLOW_STOP_DETAIL_MAX`).
- **Cross-table reads in the flow's repository.** The step repository reads `FleetJob`, `FleetBundleIngest`, `User` and
  `Agent` rows, as `PrismaScheduleRepository` already does for its cost totals and `findOwnerAccess`. The one write to
  `FleetJob` (adoption) goes through `FleetJobsService`.
- **Paging.** `listAdvanceable(limit)` returns only single-feature flows, least recently updated first, so a flow
  advanced this tick moves behind the ones that were not; the ticker asks for 50 per tick.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `FleetFlowRecord` (`apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`).
  Baseline: no `stopDetail`.
  Target: adds `stopDetail?: string | null` (optional, so existing typed fixtures keep compiling).
- `IFleetFlowRepository.stop` and `reask` (same file; `PrismaFleetFlowRepository` in `prisma-fleet-flow.repository.ts`).
  Baseline: `stop(id: string, reason: string, now: Date)`; `reask` leaves features as they are.
  Target: `stop(id: string, reason: string, now: Date, detail?: string | null)` writes `stopDetail` (null when omitted)
  and sets every feature's `state` to `STOPPED`; `reask` also sets every feature's `state` to `PENDING` and
  `currentStep` to null.
- `FleetJobsService.dispatch` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:96`).
  Baseline: `opts: { scheduleId?; ticketActor?; threadId?; auditKey?: 'fleet.job.dispatch' | 'thread.plan' | 'thread.run' | 'system.schedule.dispatch' | 'system.pr-review.dispatch' | 'system.pr-fix.follow-up' }`.
  Target: `opts` adds `flowId?: string` and `flowStep?: FlowStep`, the `auditKey` union adds `'system.flow.advance'`,
  and both flow fields are written in the job insert. A new method
  `adoptForFlow(jobId: string, flowId: string, step: FlowStep): Promise<boolean>` sets them on an existing job whose
  `flowId` is null.
- `NewFleetJob` and `FleetJobRecord` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`).
  Target: both add optional `flowId?: string | null` and `flowStep?: string | null`.
- `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts:65`).
  Baseline: `expectBranch: job.ref` only for a `PLAN` with `threadId`.
  Target: also for a `PLAN` with a non-null `flowId`.
- `FleetFlowsService.respec` (`apps/api/src/fleet/flows/fleet-flows.service.ts:129`).
  Target: its re-ask branch moves into a new public
  `reaskLocked(flow: FleetFlowRecord, specSha: string, now: Date): Promise<FleetFlowRecord>` (close the old request
  if any with reason `superseded`, open a new `fleet.flow.start` request, `flows.reask`, audit `system.flow.respec`,
  activity `flow.respec`), which `respec` calls; the caller holds the locks.
- `NEW_KEY_SCOPES` and `PENDING_SURFACE_KEYS` (`apps/api/src/permissions/catalog.ts`): add `system.flow.advance`
  (`'any'`), pending until US-012's ticker declares it.
- `BOOKKEEPING_REASONS` (`apps/api/src/action-context/audit-coverage.reasons.ts`): adds `fleet.flow-bookkeeping`.
- `IFleetConfig` and `FleetConfigSchema` (`apps/api/src/config/fleet.config.ts`): add `flowTickMs`
  (`FLEET_FLOW_TICK_MS`, default 30,000), `flowPrWaitMs` (`FLEET_FLOW_PR_WAIT_MS`, default 1,800,000) and
  `flowReviewAgent` (`FLEET_FLOW_REVIEW_AGENT`, default `Explore`, must match `AGENT_NAME_RE`); each env field is
  `@IsOptional() @IsString()`.
- `FleetReviewsModule` (`apps/api/src/fleet/reviews/fleet-reviews.module.ts`): `exports` adds `FleetReviewClaimService`.
- `FlowsModule` (`apps/api/src/fleet/flows/flows.module.ts`): imports `FleetJobsModule` and `FleetReviewsModule`;
  provides the step repository, `FleetFlowAdvanceService` and `FleetFlowTicker`.

**Read-only symbols**

- `FleetJobsService.dispatch(actorId, projectId, dto: DispatchFleetJobDto, opts)` returns `Promise<DispatchResultDto>`
  (`.job.id`); it runs no route gate. `FleetJobsModule` exports `FleetJobsService` and does not import `FlowsModule`.
- `IFleetPrReviewRepository` (`apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts`): `insertPending`,
  `findHead`, `markDispatched`, `remove`; `FleetPrReviewRecord` has `jobId: string | null`, `outcome` (`pending`,
  `dispatched` or `failed:<reason>`) and `createdAt`.
- `prNumberFor(repo, url): number | null` (`apps/api/src/fleet/sync/pr-attribution.service.ts:13`).
- `TERMINAL_STATES` (`apps/api/src/fleet/jobs/job-state.ts`).
- `ThreadsService.lockForFlowTransition(projectId, threadId)` (returns the thread with `publishedSha`),
  `FleetReposService.lockById(id)`, `FleetReposService.findReviewRepo(id)` (id, projectId, owner, name,
  `githubInstallationId`), `IFleetFlowRepository.lockById(id)`; lock order is parent, then flow.
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)` and `getBranchHead(token, owner, name, branch)`;
  forge failures throw `RepoCheckException`.
- `runAsSystem(component, fn, { onBehalfOf })` and `actorTypeFor` (`apps/api/src/action-context/action-context.ts`);
  `bookkeeping(reason, fn)` (`apps/api/src/action-context/audit-coverage.ts:228`).
- `PermissionService.effectiveKeys(principal: PrincipalRef, scope)` (`apps/api/src/permissions/permission.service.ts:99`);
  `mayDispatch(access, keys)` (`apps/api/src/fleet/schedules/schedule-access.ts:12`).
- `AuditRecorder.record({ key, resourceType, resourceId, projectId, summary })` and `FleetActivityService.record` with
  `actorType: 'SYSTEM', actorId: 'flow'`, as `respec` uses them.
- `AGENT` verdict rule (F2): an `AGENT` job ends `COMPLETED` only when `nax agents run` reported status `completed`;
  `failed`, `timeout` and `cancelled` end the job `FAILED`. So a `COMPLETED` review job's `agentResult.status` is
  always `completed`, and `agentResult.output` keeps the last 8,192 bytes, where the verdict sits.
- `BudgetPausedException`, `FleetDispatchException`, `AGENT_NAME_RE`, `testFleetConfig` (`apps/api/src/common/test-helpers/fleet-config.ts`).

**New symbols**

- `apps/api/src/fleet/flows/flow-steps.ts` (pure): `FlowStep` (`'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX'`),
  `FLOW_VERDICT_INSTRUCTION`, `FLOW_STOP_DETAIL_MAX` (2000), `buildReviewTask`, `parseFlowVerdict`, `formatFindings`.
- `apps/api/src/fleet/flows/flow-step-decision.ts` (pure): `FlowJobView`, `FlowStepInput`, `FlowStepAction`,
  `FlowStopReason`, `decideFlowStep`.
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` (pure): `remainingCapUsd`, `buildStepDispatch`.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` + `prisma-fleet-flow-step.repository.ts`:
  `FLEET_FLOW_STEP_REPOSITORY`, `IFleetFlowStepRepository`, `AdvanceableFlow`.
- `apps/api/src/fleet/reviews/fleet-review-claim.service.ts`: `FleetReviewClaimService`, `HeadClaim`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`: `FleetFlowAdvanceService.advance(flowId: string, now: Date): Promise<void>`.
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts`: `FleetFlowTicker` with `poll(): Promise<void>` (single-flight,
  called by the interval) and `tick(now: Date): Promise<void>` (one pass).

### Approach

`FleetFlowTicker.poll()` returns at once while a pass runs; otherwise it calls `tick(new Date())`. `tick(now)` lists
advanceable flows and, for each, runs `advance(id, now)` inside
`runAsSystem('flow', ..., { onBehalfOf: { type: createdByType, id: createdById } })`, logging and continuing on error.

`advance(flowId, now)` runs three phases.

1. **Decide (one transaction).** Unlocked read of the flow. For a nax-entry flow whose latest job is null or a
   `SPEC_REVIEW` job, read the repo with `findReviewRepo` and the forge head of `flow.branch` before the transaction
   (a `RepoCheckException` ends this pass for the flow with nothing written). Then lock parent and flow; return unless
   the state is `APPROVED` or `RUNNING`; update `spentUsd` if the sum changed; build `FlowStepInput` from the latest
   flow job and call `decideFlowStep`. `stop` and `complete` actions are written here. A `dispatch` action passes the
   guards in order: cap, creator access, then (for `SPEC_REVIEW` and `PLAN`) the spec sha; the first failing guard
   stops or re-asks instead.
2. **Dispatch (no transaction held).** `REVIEW` goes through `FleetReviewClaimService`; every other step calls
   `jobs.dispatch(flow.createdById, flow.projectId, buildStepDispatch(...), { flowId, flowStep, auditKey: 'system.flow.advance' })`.
3. **Record (one transaction).** Lock parent and flow; if the flow is still `APPROVED` or `RUNNING`, mark the step
   (`APPROVED` becomes `RUNNING` with activity `flow.started`), and record activity `flow.step` and the audit entry.

```ts
// flow-step-decision.ts (shape, not final code)
export type FlowStepAction =
  | { kind: 'skip' }                                   // not single-feature
  | { kind: 'wait' }
  | { kind: 'complete' }
  | { kind: 'stop'; reason: FlowStopReason; detail: string }
  | { kind: 'dispatch'; step: FlowStep; pr?: { number: number; headSha?: string } };
```

Stop reasons: `step_failed`, `verdict_unreadable`, `review_findings`, `plan_no_result`, `run_no_pr`, `pr_not_ready`,
`cost_cap`, `creator_lost_access`, `budget_paused`, `dispatch_refused`.

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
| Review job `COMPLETED` with `agentResult` null or no parseable verdict | stop `verdict_unreadable`, detail `<STEP> job <id>: no verdict JSON in the agent output` |
| Review verdict has one or more findings | stop `review_findings`, detail from `formatFindings` |
| `PLAN` `COMPLETED` without `resultBranch` or `resultSha` | stop `plan_no_result` |
| `RUN` ended, no PR, ingest settled or wait elapsed | stop `run_no_pr` |
| `RUN` ended, no PR, ingest not settled and wait not elapsed | wait |
| `FIX` `COMPLETED` with `fixReady.markedReady` not true | stop `pr_not_ready`, detail = `readyHeld` or `FIX ended without a ready result` |
| Remaining cap below `0.0001` before a dispatch | stop `cost_cap`, detail `spent <spent> of cap <cap>` |
| Creator gone, disabled or without `fleet.job.dispatch` | stop `creator_lost_access` |
| Dispatch throws `BudgetPausedException` | stop `budget_paused` |
| Dispatch throws a conflict, validation, not-found or dispatch exception | stop `dispatch_refused`, detail `<STEP>: <reason>` |
| Dispatch throws anything else | error propagates; nothing written; the next tick retries |
| Spec sha changed before `SPEC_REVIEW`/`PLAN` | `reaskLocked` → `PENDING` with the new sha |
| Nax-entry repo missing or not connected (`githubInstallationId` null) | stop `dispatch_refused`, detail `SPEC_REVIEW: repo not connected` (or `PLAN:`) |
| Forge head read fails (nax entry) | this pass does nothing for the flow |
| `REVIEW` head claimed by a live pass with no job yet | wait |
| `REVIEW` head claim older than `prReviewPollMs` with no job | claim removed, head claimed again |
| `REVIEW` head claim settled `failed:<reason>` | stop `dispatch_refused`, detail `REVIEW: <outcome>` |
| `REVIEW` head's job already belongs to another flow | stop `dispatch_refused`, detail `REVIEW: head claimed by another flow` |
| Flow left `APPROVED`/`RUNNING` between dispatch and record | record writes nothing; the job keeps running |
| One flow's `advance` throws inside a tick | logged with the flow id; the tick continues with the next flow |

## Out of Scope

- Verdict classification (`answered`/`minor`/`ambiguous`), spec-fix jobs, batched questions, agent rulings on open PR items and the flow's ticket (fleet flow F4).
- Notifications on a flow stop or completion: until F4, a stop is visible only in flow activity, audit, `stopReason` and `stopDetail`.
- Flows with more than one feature, feature order, merge waits and independent features (fleet flow F5); F3 leaves such a flow `APPROVED`.
- Every web page and the `FleetFlowDto` fields for steps, jobs and `stopDetail` (fleet flow F6), including the "cap excludes N jobs with unknown cost" display.
- Running `REVIEW` and `FIX` on the reviewer role's model: flow `PLAN`, `RUN`, `REVIEW` and `FIX` jobs use the default profile chain (`profiles: []`).
- Cancelling a running job when a flow stops or returns to `PENDING`: by design the flow only starts nothing more.
- Retrying a failed step: any failure stops the flow; a stopped flow is never restarted in place.
- Re-checking the spec sha after `PLAN` has been dispatched, and reacting to a thread re-publish while a flow is `RUNNING` (the F1 listener ignores it).
- Reading the PR head from the forge for the `REVIEW` claim: the claim uses the `RUN` job's `resultSha`.
- Recomputing `spentUsd` after a flow has stopped or completed, when a late ingest raises a job's cost.
- Enforcing the cap inside `AGENT`, `PLAN`, `REVIEW` or `FIX` jobs beyond the `maxCostUsd` each job already receives.
- A durable outbox event for job ends; the ticker's interval is the only trigger.
- Running more than one api instance's ticker against the same database: the single-flight guard is per process, and duplicate dispatches are left to the existing one-active-job-per-`(repoId, feature)` 409 and the review head claim.
- Mapping a `flowId` foreign-key failure at dispatch (a flow deleted mid-pass) to anything but the existing `createJob` not-found path.
- Regenerating the CLI client and CLI commands for flows; `openapi.json` does not change.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Flow job columns and flow stop/re-ask

Workdir: `apps/api`. No dependencies. One migration adds `FleetJob.flowId` (nullable, relation to `FleetFlow` with
`onDelete: SetNull`, index on `flowId, queuedAt`), `FleetJob.flowStep` (nullable string) and `FleetFlow.stopDetail`
(nullable string). `FleetFlowRecord` gains optional `stopDetail`. `PrismaFleetFlowRepository.stop` takes an optional
`detail` and stops every feature; `reask` resets every feature to `PENDING` with no `currentStep`.

### US-002: The flow step repository

Workdir: `apps/api`. Depends on US-001. `IFleetFlowStepRepository` (token `FLEET_FLOW_STEP_REPOSITORY`) and its Prisma
implementation: `listAdvanceable(limit)`, `latestJob(flowId)`, `latestJobForStep(flowId, step)`, `sumCost(flowId)`,
`setSpent(flowId, spentUsd)`, `ingestSettled(jobId, leaseEpoch)`, `creatorAccess(ref)`, `markStep(flowId, featureId, step, data)`
and `complete(flowId, now)`.

### US-003: Flow fields on jobs and the system key

Workdir: `apps/api`. Depends on US-001. `FleetJobsService.dispatch` accepts `flowId` and `flowStep` and writes them in
the insert; its `auditKey` union gains `system.flow.advance`, added to `NEW_KEY_SCOPES` (`'any'`) and
`PENDING_SURFACE_KEYS`. `FleetJobsService.adoptForFlow` links an existing job. `buildAssignPayload` gives a flow `PLAN`
`expectBranch`. `FleetJobRecord` carries `flowId` and `flowStep`.

### US-004: Review tasks and the verdict parser

Workdir: `apps/api`. No dependencies. Pure module `flow-steps.ts`: `FlowStep`, `FLOW_VERDICT_INSTRUCTION`,
`FLOW_STOP_DETAIL_MAX`, `buildReviewTask(step, specPath, feature)`, `parseFlowVerdict(output)` and
`formatFindings(findings)`.

### US-005: Step decision, gating and job ends

Workdir: `apps/api`. Depends on US-004. Pure `decideFlowStep(input: FlowStepInput): FlowStepAction`, first half: the
single-feature gate, the `APPROVED` start and adoption rule, waiting on an active job, and the stop rules for failed,
cancelled, crashed and escalated jobs.

### US-006: Step decision, step order

Workdir: `apps/api`. Depends on US-005. `decideFlowStep`, second half: what follows each `COMPLETED` step — the review
verdict rule, the `PLAN` result rule, the `RUN` PR wait, `REVIEW` then `FIX`, and the `FIX` ready rule.

### US-007: Step dispatch bodies and the remaining cap

Workdir: `apps/api`. Depends on US-004. Pure `remainingCapUsd(capUsd, spentUsd): string | null` and
`buildStepDispatch(input): DispatchFleetJobDto` producing each step's body.

### US-008: The review head claim service

Workdir: `apps/api`. No dependencies. `FleetReviewClaimService` in the reviews module, exported:
`claimHead(repoId, prNumber, headSha, now): Promise<HeadClaim>`, `markDispatched(claimId, jobId)` and `release(claimId)`,
all under the bookkeeping reason `fleet.pr-review-bookkeeping`.

### US-009: Advancing a flow

Workdir: `apps/api`. Depends on US-002, US-003, US-006, US-007. `FleetFlowAdvanceService.advance(flowId, now)` with
the decide, dispatch and record phases for every step but `REVIEW`: locks, spend, stop, complete, dispatch through
`FleetJobsService.dispatch`, dispatch refusals, activity and audit. Adds the bookkeeping reason `fleet.flow-bookkeeping`.

### US-010: Dispatch guards: cap, creator access and spec change

Workdir: `apps/api`. Depends on US-009. Before a dispatch, `advance` stops on a reached cap or a creator who lost
access, and before `SPEC_REVIEW` or `PLAN` it compares `flow.specSha` with the thread's `publishedSha` or the forge head
and re-asks through `FleetFlowsService.reaskLocked`, extracted from `respec`.

### US-011: REVIEW through the head claim

Workdir: `apps/api`. Depends on US-008, US-009. The `REVIEW` dispatch goes through `FleetReviewClaimService`: claim,
dispatch, record; release on a refused dispatch; adopt a head's existing job; wait or stop on the other claim states.

### US-012: The flow ticker and its config

Workdir: `apps/api`. Depends on US-009. `FleetFlowTicker` (`@SystemWriter('system.flow.advance')`) with `poll()` and
`tick(now)`; the three config values; `FlowsModule` wiring; `system.flow.advance` leaves `PENDING_SURFACE_KEYS`.

### US-013: Flow ticks against the database

Workdir: `apps/api`. Depends on US-010, US-011, US-012. Integration tests that run `FleetFlowTicker.tick` over real
flows, jobs and review claims in the test database.

### Context Files

**US-001**

- `apps/api/prisma/schema.prisma` — `FleetJob`, `FleetFlow` and `FleetFlowFeature` models
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — `stop` and `reask`
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — `FleetFlowRecord` and `IFleetFlowRepository`
- `apps/api/test/integration/fleet/thread-modes-migration.integration.spec.ts` — migration test pattern

**US-002**

- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — repository base and lock pattern
- `apps/api/src/fleet/schedules/prisma-schedule.repository.ts` — `findOwnerAccess` and the job cost aggregate precedent
- `apps/api/src/fleet/schedules/domain/schedule.domain.ts` — `OwnerAccess`

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `NewFleetJob`, `FleetJobRecord`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `createJob` and `toJob`
- `apps/api/src/fleet/jobs/assign-payload.ts` — `expectBranch`
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS`

**US-004**

- `apps/api/src/fleet/common/agent-jobs.ts` — the `AGENT` task bound (16,384 characters)

**US-005**

- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-004
- `apps/api/src/fleet/jobs/job-state.ts` — `TERMINAL_STATES`, `ACTIVE_STATES`

**US-006**

- `apps/api/src/fleet/flows/flow-step-decision.ts` — created by US-005; this story completes `decideFlowStep`
- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-004; `parseFlowVerdict`, `formatFindings`
- `apps/api/src/fleet/sync/event-payloads.ts` — the `fixReady` shape

**US-007**

- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-004; `buildReviewTask`
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the body this story builds
- `apps/api/src/fleet/threads/threads.service.ts` — the thread `plan()` and `run()` bodies this mirrors

**US-008**

- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — claim, stale claim, `markDispatched` precedent
- `apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts` — `IFleetPrReviewRepository`
- `apps/api/src/fleet/reviews/fleet-reviews.module.ts` — the module whose exports grow
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`

**US-009**

- `apps/api/src/fleet/flows/fleet-flows.service.ts` — lock order, audit and activity pattern (`stop`, `respec`)
- `apps/api/src/fleet/flows/flow-step-decision.ts` — created by US-005
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` — created by US-007
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — created by US-002
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — dispatch exception handling precedent

**US-010**

- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `respec`, `openStartRequest`
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — the nax-entry forge head read
- `apps/api/src/fleet/schedules/schedule-access.ts` — `mayDispatch`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-009

**US-011**

- `apps/api/src/fleet/reviews/fleet-review-claim.service.ts` — created by US-008
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-009

**US-012**

- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `@SystemWriter` ticker precedent
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — `runAsSystem` with `onBehalfOf`
- `apps/api/src/fleet/reviews/fleet-pr-review.poller.ts` — single-flight interval precedent
- `apps/api/src/config/fleet.config.ts` — config fields and env parsing
- `apps/api/src/fleet/flows/flows.module.ts` — module wiring

**US-013**

- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — created by US-012
- `apps/api/test/integration/fleet-flow-respec.integration.spec.ts` — flow integration fixture pattern
- `apps/api/test/integration/fleet/fleet-fix-follow-up.integration.spec.ts` — review claim fixture pattern

### Creates

**US-001**

- `apps/api/prisma/migrations/20261128090000_fleet_flow_steps/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-steps-migration.integration.spec.ts`

**US-002**

- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-004**

- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-steps.spec.ts`

**US-005**

- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-007**

- `apps/api/src/fleet/flows/flow-step-dispatch.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts`

**US-008**

- `apps/api/src/fleet/reviews/fleet-review-claim.service.ts`
- `apps/api/src/fleet/reviews/fleet-review-claim.service.spec.ts`

**US-009**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`

**US-012**

- `apps/api/src/fleet/flows/fleet-flow.ticker.ts`
- `apps/api/src/fleet/flows/fleet-flow.ticker.spec.ts`

**US-013**

- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts`

### Modifies

**US-003**

- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES` table ends at `system.flow.respec`; add `system.flow.advance: 'any'` so the table still equals the catalog's.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role's map gains `"system.flow.advance": ["non-role-key","non-role-key"]`, the same value `system.flow.respec` has; no other entry changes.

**US-008**

- `apps/api/src/fleet/reviews/fleet-reviews.module.spec.ts` — if it pins the module's exports, the list gains `FleetReviewClaimService`; nothing else changes.

**US-009**

- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — `EXPECTED_REASON_IDS` gains `fleet.flow-bookkeeping`, matching the new `BOOKKEEPING_REASONS` entry.

**US-012**

- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer list gains `[FleetFlowTicker, 'system.flow.advance']`, its `toHaveLength(40)` becomes `toHaveLength(41)`, and the pending-key assertion now expects `PENDING_SURFACE_KEYS.has('system.flow.advance')` to be false.
- `apps/api/src/common/test-helpers/fleet-config.ts` — `testFleetConfig` returns a full `IFleetConfig`; add `flowTickMs: 30000`, `flowPrWaitMs: 1800000` and `flowReviewAgent: 'Explore'` so it still type-checks.
- `apps/api/src/config/fleet.config.spec.ts` — where it pins the full resolved config or the env key set, add the three flow fields with their defaults.
- `apps/api/src/fleet/flows/flows.module.spec.ts` — the "compiles the real module" test stubs each import; add stubs for `FleetJobsModule`'s `FleetJobsService`, `FleetReviewsModule`'s `FleetReviewClaimService`, `PermissionService` and `FLEET_CFG`, and expect the three new providers.

### Seams

- US-003 → US-009: `advance` passes `flowId`, `flowStep` and `auditKey: 'system.flow.advance'` to `FleetJobsService.dispatch` (US-009 pins the call; US-013 proves the stored row).
- US-006/US-007 → US-009: `advance` dispatches exactly the body `buildStepDispatch` returns for the step `decideFlowStep` chose.
- US-008 → US-011: `advance` calls `FleetReviewClaimService.claimHead` before a `REVIEW` dispatch (US-011 pins; US-013 proves against the real table).
- US-009 → US-012: `FleetFlowTicker.tick` calls `FleetFlowAdvanceService.advance` once per advanceable flow inside `runAsSystem` on the creator's behalf (US-012 seam AC, entered at `tick`).
- US-010 → US-009: `advance` calls `FleetFlowsService.reaskLocked` before a `SPEC_REVIEW`/`PLAN` dispatch whose sha check fails.

## Acceptance Criteria

### US-001: Flow job columns and flow stop/re-ask

- [integration] After the migration, a `FleetJob` inserted with `flowId` set to an existing flow's id and `flowStep` `'PLAN'` reads back with both values.
- [integration] Deleting a `FleetFlow` sets `flowId` to null on its jobs and deletes no job.
- [integration] `PrismaFleetFlowRepository.stop(id, 'cost_cap', now, 'spent 5 of cap 5')` returns a record with state `STOPPED`, `stopReason` `cost_cap` and `stopDetail` `spent 5 of cap 5`.
- [integration] After `stop(id, 'cost_cap', now, 'x')`, every feature of that flow has `state` `STOPPED`.
- [integration] `stop(id, 'human_stop', now)` without a detail stores `stopDetail` null.
- [integration] `stop` on a `PENDING` flow, as `FleetFlowsService.stop` calls it, also sets its features to `STOPPED`.
- [integration] `reask(id, { specSha, approvalRequestId })` on a `RUNNING` flow whose feature is `RUNNING` at `currentStep` `SPEC_REVIEW` leaves the feature with `state` `PENDING` and `currentStep` null.
- [unit] A `FleetFlowRecord` literal without `stopDetail` type-checks, and `findById` returns `stopDetail` from the row.

### US-002: The flow step repository

- [integration] `listAdvanceable(50)` returns flows in state `APPROVED` or `RUNNING` that have exactly one feature, each as `{ id, createdByType, createdById }`.
- [integration] `listAdvanceable(50)` omits a two-feature `APPROVED` flow and flows in `PENDING`, `WAITING_MERGE`, `WAITING_ANSWER`, `COMPLETED` and `STOPPED`.
- [integration] `listAdvanceable(1)` with two eligible flows returns the one with the older `updatedAt`.
- [integration] `latestJob(flowId)` returns the flow's job with the greatest `queuedAt`, and null for a flow with no jobs.
- [integration] `latestJobForStep(flowId, 'PLAN')` returns the newest job of that flow whose `flowStep` is `PLAN`, ignoring newer jobs of other steps.
- [integration] `sumCost(flowId)` over jobs with `costSpentUsd` `1.2500`/`costCarriedUsd` `0.5000` and `costSpentUsd` `2.0000`/`costCarriedUsd` `0` returns `'3.7500'`.
- [integration] `sumCost(flowId)` ignores a job with another `flowId`, and returns `'0.0000'` for a flow with no jobs.
- [integration] `setSpent(flowId, '3.7500')` stores `spentUsd` `3.7500` on the flow.
- [integration] `ingestSettled(jobId, leaseEpoch)` returns true for a `FleetBundleIngest` row of that job and lease with status `done`, `partial` or `failed`.
- [integration] `ingestSettled` returns false for status `pending` or `running`, for a row of another lease, and when no row exists.
- [integration] `creatorAccess({ type: 'USER', id })` returns `{ exists: true, disabled: true }` for a disabled user and `{ exists: false, disabled: false }` for an unknown id.
- [integration] `creatorAccess({ type: 'AGENT', id })` returns `exists` true for an existing agent and false for an unknown one.
- [integration] `markStep(flowId, featureId, 'REVIEW', { flowState: 'RUNNING', prNumber: 7 })` leaves the flow `RUNNING` and the feature `RUNNING` with `currentStep` `REVIEW` and `prNumber` 7.
- [integration] `complete(flowId, now)` sets the flow state `COMPLETED` with `endedAt` `now` and the feature's `state` `COMPLETED`.

### US-003: Flow fields on jobs and the system key

- [integration] `FleetJobsService.dispatch` with `opts` `{ flowId, flowStep: 'PLAN', auditKey: 'system.flow.advance' }` creates a job whose stored `flowId` and `flowStep` equal those values.
- [integration] `FleetJobsService.dispatch` without `flowId` creates a job whose `flowId` and `flowStep` are null.
- [integration] A job created with `flowId` and read back through the job repository's `findById` carries `flowId` and `flowStep`.
- [integration] `FleetJobsService.adoptForFlow(jobId, flowId, 'REVIEW')` on a job with no `flowId` sets both fields and returns true.
- [integration] `adoptForFlow` on a job whose `flowId` is another flow's id writes nothing and returns false.
- [unit] `buildAssignPayload` for a `PLAN` job with `flowId` `flow-1`, no `threadId` and `ref` `feat/x` sets `expectBranch` `feat/x`.
- [unit] `buildAssignPayload` for a `RUN` job with `flowId` `flow-1` sets no `expectBranch`.
- [unit] `buildAssignPayload` for a `PLAN` job with neither `threadId` nor `flowId` sets no `expectBranch`.
- [unit] `findCatalogEntry('system.flow.advance')` returns an entry with `access` `system`.
- [unit] `PENDING_SURFACE_KEYS.has('system.flow.advance')` is true.

### US-004: Review tasks and the verdict parser

- [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')` returns `/spec-review .nax/features/a/spec.md`, a blank line, then `FLOW_VERDICT_INSTRUCTION`.
- [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a')` returns `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json`, a blank line, then `FLOW_VERDICT_INSTRUCTION`.
- [unit] `buildReviewTask` for a 400-character spec path returns at most 16,384 characters.
- [unit] `FLOW_VERDICT_INSTRUCTION` includes the line `{"findings":[]}`.
- [unit] `parseFlowVerdict('Looks good.\n{"findings":[]}')` returns `{ ok: true, findings: [] }`.
- [unit] `parseFlowVerdict` of text ending in `{"findings":[{"id":"F1","summary":"Missing AC for 409"}]}` returns `ok` true with the one finding `{ id: 'F1', summary: 'Missing AC for 409' }`.
- [unit] `parseFlowVerdict('{"findings":[{"summary":"x"}]}\nmore text\n{"findings":[]}')` returns `ok` true with no findings, because the last `{"findings"` object wins.
- [unit] `parseFlowVerdict` accepts a verdict followed by a closing code fence and trailing whitespace.
- [unit] `parseFlowVerdict` returns `{ ok: false }` for output with no `{"findings"` text, and for null.
- [unit] `parseFlowVerdict` returns `{ ok: false }` when the text after the last `{"findings"` is not valid JSON.
- [unit] `parseFlowVerdict` returns `{ ok: false }` when `findings` is not an array.
- [unit] `parseFlowVerdict` returns `{ ok: false }` when a finding has no non-empty string `summary`.
- [unit] `parseFlowVerdict` drops a finding's non-string `id` and keeps its `summary`.
- [unit] `formatFindings([{ id: 'F1', summary: 'a' }, { summary: 'b' }])` returns `2 findings: 1. [F1] a 2. b`.
- [unit] `formatFindings` of 100 findings of 100 characters each returns exactly 2,000 characters ending in `…`.

### US-005: Step decision, gating and job ends

- [unit] `decideFlowStep` with `featureCount` 2 returns `{ kind: 'skip' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and no latest job returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and a latest `PLAN` job queued before `approvedAt` returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and a latest `SPEC_REVIEW` job in `RUNNING` queued at `approvedAt` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with flow state `RUNNING` and no latest job returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with a latest job in `QUEUED` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with a latest job in `UPLOADING` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with a latest `PLAN` job `j1` in `FAILED` with `stateReason` `checkout: no .nax dir` returns a stop with reason `step_failed` and detail `PLAN job j1 FAILED: checkout: no .nax dir`.
- [unit] `decideFlowStep` with a latest job in `CANCELLED` returns a stop with reason `step_failed`.
- [unit] `decideFlowStep` with a latest job in `CRASHED` and `stateReason` null returns a stop whose detail ends `CRASHED: no reason`.
- [unit] `decideFlowStep` with a latest `REVIEW` job in `ESCALATED` returns a stop with reason `step_failed`.
- [unit] `decideFlowStep` with a latest `RUN` job in `ESCALATED` does not return a `step_failed` stop.

### US-006: Step decision, step order

- [unit] `decideFlowStep` with a `COMPLETED` `SPEC_REVIEW` job whose `agentOutput` ends in `{"findings":[]}` returns `{ kind: 'dispatch', step: 'PLAN' }`.
- [unit] `decideFlowStep` with a `COMPLETED` `PRD_REVIEW` job whose `agentOutput` ends in `{"findings":[]}` returns `{ kind: 'dispatch', step: 'RUN' }`.
- [unit] `decideFlowStep` with a `COMPLETED` review job whose verdict has one finding returns a stop with reason `review_findings` and the `formatFindings` text as detail.
- [unit] `decideFlowStep` with a `COMPLETED` `SPEC_REVIEW` job `j2` whose `agentOutput` is null returns a stop with reason `verdict_unreadable` and detail `SPEC_REVIEW job j2: no verdict JSON in the agent output`.
- [unit] `decideFlowStep` with a `COMPLETED` `PLAN` job with `resultBranch` and `resultSha` returns `{ kind: 'dispatch', step: 'PRD_REVIEW' }`.
- [unit] `decideFlowStep` with a `COMPLETED` `PLAN` job with no `resultSha` returns a stop with reason `plan_no_result`.
- [unit] `decideFlowStep` with a `COMPLETED` `RUN` job whose `prNumber` is 12 and `resultSha` is `abc1234` returns `{ kind: 'dispatch', step: 'REVIEW', pr: { number: 12, headSha: 'abc1234' } }`.
- [unit] `decideFlowStep` with an `ESCALATED` `RUN` job with `prNumber` 12 also returns a `REVIEW` dispatch for PR 12.
- [unit] `decideFlowStep` with a `COMPLETED` `RUN` job with no `prNumber`, `ingestSettled` false and `now - finishedAt` below `prWaitMs` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with a `COMPLETED` `RUN` job with no `prNumber` and `ingestSettled` true returns a stop with reason `run_no_pr`.
- [unit] `decideFlowStep` with a `COMPLETED` `RUN` job with no `prNumber`, `ingestSettled` false and `now - finishedAt` equal to `prWaitMs` returns a stop with reason `run_no_pr`.
- [unit] `decideFlowStep` with a `COMPLETED` `REVIEW` job and the feature's `prNumber` 12 returns `{ kind: 'dispatch', step: 'FIX', pr: { number: 12 } }`.
- [unit] `decideFlowStep` with a `COMPLETED` `FIX` job whose `fixReady.markedReady` is true returns `{ kind: 'complete' }`.
- [unit] `decideFlowStep` with a `COMPLETED` `FIX` job whose `fixReady` is `{ markedReady: false, readyHeld: 'no CI' }` returns a stop `pr_not_ready` with detail `no CI`.
- [unit] `decideFlowStep` with a `COMPLETED` `FIX` job whose `fixReady` is null returns a stop `pr_not_ready` with detail `FIX ended without a ready result`.

### US-007: Step dispatch bodies and the remaining cap

- [unit] `remainingCapUsd('10', '3.25')` returns `'6.7500'`, and `remainingCapUsd('1', '0.33333')` rounds down to `'0.6666'`.
- [unit] `remainingCapUsd` returns null for `('10', '9.99995')`, `('5', '5')` and `('5', '6')`.
- [unit] `buildStepDispatch` for `SPEC_REVIEW` on a flow with `specSha` `s1`, `reviewerRole` `opus`, feature `f`, spec path `.nax/features/f/spec.md`, review agent `Explore` and remaining `'6.7500'` returns `{ repoId, command: 'AGENT', feature: 'f', ref: 's1', bashMode: 'raw', maxCostUsd: 6.75, agent: { name: 'Explore', task, model: 'opus' } }` with no other keys, where `task` is `buildReviewTask('SPEC_REVIEW', '.nax/features/f/spec.md', 'f')`.
- [unit] `buildStepDispatch` for `PLAN` on a flow with `branch` `feat/f` returns command `PLAN`, `ref` `feat/f`, `feature` `f`, `planFrom` the spec path, `profiles` `[]` and the remaining cap as `maxCostUsd`.
- [unit] `buildStepDispatch` for `PRD_REVIEW` returns command `AGENT`, `ref` equal to the given `PLAN` job's `resultSha`, and the task `buildReviewTask('PRD_REVIEW', specPath, feature)`.
- [unit] `buildStepDispatch` for `RUN` returns command `RUN`, `ref` equal to the given `PLAN` job's `resultBranch`, `feature` `f` and `profiles` `[]`.
- [unit] `buildStepDispatch` for `REVIEW` with `pr` `{ number: 12 }` returns command `REVIEW`, `prNumber` 12, `profiles` `[]` and no `ref` or `feature`.
- [unit] `buildStepDispatch` for `FIX` with `pr` `{ number: 12 }` returns command `FIX`, `prNumber` 12, `profiles` `[]` and no `ref` or `feature`.
- [unit] `buildStepDispatch` on a flow with `pinnedRunnerId` `r1` sets `pinnedRunnerId` `r1` for `PLAN`, and omits the key when the flow's is null.
- [unit] `buildStepDispatch` for `RUN` with no `PLAN` job throws an `Error` whose message names the missing plan.

### US-008: The review head claim service

- [unit] `claimHead(repoId, 12, 'h1', now)` when `insertPending` returns a row returns `{ kind: 'claimed', claimId }` with that row's id.
- [unit] `claimHead` when `insertPending` returns null and `findHead` returns a row with `jobId` `j9` returns `{ kind: 'owned', jobId: 'j9' }`.
- [unit] `claimHead` when the existing row is `pending`, has no job and was created less than `prReviewPollMs` before `now` returns `{ kind: 'busy' }`.
- [unit] `claimHead` when the existing row is `pending`, has no job and is older than `prReviewPollMs` removes it, calls `insertPending` again and returns `{ kind: 'claimed' }` with the new row's id.
- [unit] `claimHead` when the existing row's `outcome` is `failed:repo gone` returns `{ kind: 'failed', outcome: 'failed:repo gone' }`.
- [unit] `claimHead` when `insertPending` returns null and `findHead` returns null returns `{ kind: 'busy' }`.
- [unit] `markDispatched(claimId, jobId)` calls the review repository's `markDispatched` with both ids inside `bookkeeping('fleet.pr-review-bookkeeping', ...)`.
- [unit] `release(claimId)` calls the review repository's `remove(claimId)` inside `bookkeeping('fleet.pr-review-bookkeeping', ...)`.
- [unit] Compiling `FleetReviewsModule` and resolving `FleetReviewClaimService` from a module that imports it succeeds.

### US-009: Advancing a flow

- [unit] `advance` on a flow in state `PENDING`, `COMPLETED` or `STOPPED` dispatches nothing and writes nothing.
- [unit] `advance` locks the thread with `ThreadsService.lockForFlowTransition` before `flows.lockById` for a thread-entry flow.
- [unit] `advance` locks the repo with `FleetReposService.lockById` before `flows.lockById` for a nax-entry flow.
- [unit] `advance` calls `steps.setSpent(flowId, '3.7500')` inside `bookkeeping('fleet.flow-bookkeeping', ...)` when `sumCost` returns `'3.7500'` and the stored `spentUsd` is `'0.0000'`, and does not call it when they are equal.
- [unit] `advance` on an `APPROVED` single-feature flow whose decision is `dispatch SPEC_REVIEW` calls `FleetJobsService.dispatch` once with `flow.createdById`, `flow.projectId`, the body `buildStepDispatch` returns, and `opts` `{ flowId, flowStep: 'SPEC_REVIEW', auditKey: 'system.flow.advance' }`.
- [unit] After that dispatch returns job `j1`, `advance` calls `steps.markStep` with flow state `RUNNING` and step `SPEC_REVIEW`.
- [unit] After that dispatch, `advance` records activity `flow.started` (payload with `approvalMode` and `approverId`) and `flow.step` (payload `{ step: 'SPEC_REVIEW', jobId: 'j1' }`), both with `actorType` `SYSTEM` and `actorId` `flow`.
- [unit] After a dispatch, `advance` records an `AuditRecorder` entry with key `system.flow.advance`, resource type `flow` and the flow's id.
- [unit] `advance` on a `RUNNING` flow whose decision is `dispatch PLAN` records `flow.step` and no `flow.started`.
- [unit] `advance` when the decision is `wait` dispatches nothing and writes no step, stop or audit entry.
- [unit] `advance` when the decision is a stop calls `flows.stop(flowId, reason, now, detail)`, records activity `flow.stopped` with payload `{ flowId, stopReason, detail, step, jobId }`, and records an audit entry with key `system.flow.advance`.
- [unit] `advance` when the decision is `complete` calls `steps.complete(flowId, now)`, records activity `flow.completed`, and records an audit entry with key `system.flow.advance`.
- [unit] `advance` stops with reason `budget_paused` when `dispatch` throws `BudgetPausedException`.
- [unit] `advance` stops with reason `dispatch_refused` and detail `PLAN: specMissing` when `dispatch` throws a `ValidationAppException` whose `args.reason` is `specMissing`, and with detail `PLAN: FleetDispatchException` for a `FleetDispatchException`.
- [unit] `advance` rethrows an `Error` thrown by `dispatch` that is not a conflict, validation, not-found or dispatch exception, and writes no stop; and writes no step when the flow is `STOPPED` at the record phase after a successful dispatch.

### US-010: Dispatch guards: cap, creator access and spec change

- [unit] `advance` with `spentUsd` `'5.0000'`, `costCapUsd` `'5.0000'` and a dispatch decision stops with reason `cost_cap` and detail `spent 5.0000 of cap 5.0000`, and does not call `dispatch`.
- [unit] `advance` passes `maxCostUsd` 1.5 to `dispatch` when `costCapUsd` is `'5'` and `sumCost` returns `'3.5000'`.
- [unit] `advance` stops with reason `creator_lost_access` and does not dispatch when `creatorAccess` returns `{ exists: true, disabled: true }`.
- [unit] `advance` stops with reason `creator_lost_access` when the creator's `effectiveKeys` in the flow's project lack `fleet.job.dispatch`.
- [unit] `FleetFlowsService.reaskLocked(flow, 'newsha', now)` on an `APPROVED` flow with a request id closes that request with reason `superseded`, opens a new `fleet.flow.start` request, and returns the record from `flows.reask(flow.id, { specSha: 'newsha', approvalRequestId })`.
- [unit] `FleetFlowsService.respec` with a re-ask case still produces a `PENDING` flow with the new sha and audit `system.flow.respec`, through `reaskLocked`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch SPEC_REVIEW` and whose thread `publishedSha` differs from `specSha` calls `reaskLocked(flow, publishedSha, now)` and does not call `dispatch`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch PLAN` and whose thread `publishedSha` differs calls `reaskLocked` and does not call `dispatch`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch RUN` dispatches `RUN` although `publishedSha` differs from `specSha`.
- [unit] `advance` on a nax-entry flow with no latest job reads `getBranchHead` with a token from `mintReadOnlyToken` before opening its transaction, and with a head equal to `specSha` dispatches `SPEC_REVIEW`.
- [unit] `advance` on a nax-entry flow whose forge head differs from `specSha` calls `reaskLocked(flow, head, now)` and does not dispatch.
- [unit] `advance` on a nax-entry flow when `getBranchHead` throws `RepoCheckException` dispatches nothing, writes nothing, and does not throw.
- [unit] `advance` on a nax-entry flow whose `findReviewRepo` returns a repo with `githubInstallationId` null stops with reason `dispatch_refused` and detail `SPEC_REVIEW: repo not connected`.
- [unit] `advance` on a nax-entry flow whose latest job is a `COMPLETED` `RUN` does not call `getBranchHead`.

### US-011: REVIEW through the head claim

- [unit] `advance` with decision `dispatch REVIEW` for PR 12 at head `h1` calls `claimHead(repoId, 12, 'h1', now)` and, on `{ kind: 'claimed', claimId: 'c1' }`, calls `dispatch` with the `REVIEW` body and `flowStep` `REVIEW`.
- [unit] After that dispatch returns job `j3`, `advance` calls `markDispatched('c1', 'j3')` and `steps.markStep` with step `REVIEW` and `prNumber` 12.
- [unit] On `{ kind: 'owned', jobId: 'j9' }`, `advance` calls `FleetJobsService.adoptForFlow('j9', flowId, 'REVIEW')`, does not call `dispatch`, records `flow.step` with `jobId` `j9`, and records an audit entry with key `system.flow.advance`.
- [unit] On `{ kind: 'owned' }` when `adoptForFlow` returns false, `advance` stops with reason `dispatch_refused` and detail `REVIEW: head claimed by another flow`.
- [unit] On `{ kind: 'busy' }`, `advance` dispatches nothing and writes no step or stop.
- [unit] On `{ kind: 'failed', outcome: 'failed:repo gone' }`, `advance` stops with reason `dispatch_refused` and detail `REVIEW: failed:repo gone`.
- [unit] When the `REVIEW` dispatch throws `ConflictAppException`, `advance` calls `release('c1')` and stops with reason `dispatch_refused`.
- [unit] When the `REVIEW` dispatch throws `BudgetPausedException`, `advance` calls `release('c1')` and stops with reason `budget_paused`.

### US-012: The flow ticker and its config

- [unit] `fleetConfig()` with no flow variables set returns `flowTickMs` 30000, `flowPrWaitMs` 1800000 and `flowReviewAgent` `Explore`.
- [unit] `fleetConfig()` with `FLEET_FLOW_REVIEW_AGENT` `plugin:reviewer` returns that name.
- [unit] `fleetConfig()` with `FLEET_FLOW_REVIEW_AGENT` `../x` throws an `Error` whose message names `FLEET_FLOW_REVIEW_AGENT`.
- [unit] `FleetFlowTicker.onModuleInit` with `sweepEnabled` false starts no interval.
- [unit] `FleetFlowTicker.tick(now)` calls `steps.listAdvanceable(50)` and then `FleetFlowAdvanceService.advance(id, now)` once for each returned flow, in order.
- [unit] Inside `tick`, each `advance` call runs with `currentActor()` of type `SYSTEM` and an `onBehalfOf` equal to that flow's `{ type: createdByType, id: createdById }`, so `actorTypeFor(createdById)` returns `AGENT` for an agent-created flow.
- [unit] `FleetFlowTicker.tick` continues with the next flow when `advance` throws for one flow, and logs the error with the flow id.
- [unit] A second `poll()` while the first is still running returns without calling `listAdvanceable` again.
- [unit] `FleetFlowTicker` declares the system writer `system.flow.advance`, and `PENDING_SURFACE_KEYS.has('system.flow.advance')` is false.
- [unit] Compiling `FlowsModule` resolves `FleetFlowTicker` and `FleetFlowAdvanceService`.

### US-013: Flow ticks against the database

- [integration] With an `APPROVED` single-feature thread-entry flow whose `specSha` equals its thread's `publishedSha`, `FleetFlowTicker.tick(now)` with the real `FleetJobsService` creates one `FleetJob` with `flowId` the flow's id, `flowStep` `SPEC_REVIEW`, command `AGENT` and `ref` the flow's `specSha`.
- [integration] After that tick the flow is `RUNNING`, its feature's `currentStep` is `SPEC_REVIEW`, and an audit row with key `system.flow.advance` exists for the flow.
- [integration] A second `tick` while that job is `QUEUED` creates no other job.
- [integration] With an `APPROVED` flow with two features, `tick(now)` creates no job and leaves the flow `APPROVED`.
- [integration] With a `RUNNING` flow whose latest `SPEC_REVIEW` job `j` is `FAILED` with reason `checkout: ref not found`, `tick(now)` leaves the flow `STOPPED` with `stopReason` `step_failed` and `stopDetail` `SPEC_REVIEW job j FAILED: checkout: ref not found`, without an unaudited-write error.
- [integration] With a `RUNNING` flow whose latest `RUN` job is `COMPLETED` with `resultPrUrl` for PR 12 and `resultSha` `h1`, `tick(now)` creates a `FleetPrReview` row for the repo, PR 12 and head `h1` linked to a new `REVIEW` job whose `flowId` is the flow's id.
- [integration] With the same flow when a `FleetPrReview` row for PR 12 and head `h1` already links an auto-review `REVIEW` job, `tick(now)` creates no job and that job's `flowId` becomes the flow's id.
