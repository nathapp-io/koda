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
  bookkeeping that follows loses nothing: the next tick sees the job. `FleetFlowFeature.state`, `currentStep` and
  `prNumber` are written after each dispatch; the `FIX` step reads `prNumber` from the feature.
- **Re-approval restarts at spec review.** An `APPROVED` flow dispatches `SPEC_REVIEW`, unless its latest job is a
  `SPEC_REVIEW` queued at or after `approvedAt` (a dispatch whose bookkeeping did not commit), which the engine adopts.
  A re-ask resets the feature's `state` to `PENDING` and `currentStep` to null.
- **Spec check only before the flow's first push.** Before dispatching `SPEC_REVIEW` or `PLAN` the engine compares the
  flow's `specSha` with the thread's `publishedSha` (thread entry) or the forge head of `flow.branch` (nax entry). Any
  difference re-asks through the F1 path (`PENDING`, new `fleet.flow.start` request, new `specSha`). After `PLAN`
  pushes, the branch moves by the flow's own commits and the PRD freezes the spec, so no later step checks. The forge
  head is read only when the next step can be `SPEC_REVIEW` or `PLAN`: the flow is `APPROVED`, has no flow job yet, or
  its latest job is a terminal `SPEC_REVIEW`.
- **Refs.** `SPEC_REVIEW` runs at `flow.specSha`. `PLAN` runs at `flow.branch` with `planFrom` = the spec path, and
  gets `expectBranch` like a thread `PLAN`, so a thread entry's local-only branch is used. `PRD_REVIEW` runs at the
  `PLAN` job's `resultSha` and reviews `.nax/features/<feature>/prd.json` (where `nax plan` writes it) against the spec.
  `RUN` runs at the `PLAN` job's `resultBranch`.
- **PR number.** When the latest job is a `RUN` with a `resultPrUrl`, `advance` reads the repo with
  `FleetReposService.findReviewRepo(flow.repoId)` and parses the number with
  `prNumberFor({ provider: 'github', owner, name }, resultPrUrl)` (flows are GitHub-only: `AGENT`, `REVIEW` and `FIX`
  refuse GitLab). The `REVIEW` claim key is the `RUN` job's `resultSha`: the head the `RUN` pushed; nothing else writes
  the feature branch between the `RUN` and the flow's `REVIEW`. The `FIX` needs only the PR number.
- **Every flow job is pinned** to `flow.pinnedRunnerId` when it is set (thread entry); nax-entry flows have none.
- **Actor.** Each flow is advanced inside `runAsSystem('flow', ..., { onBehalfOf: { type: createdByType, id: createdById } })`,
  as `FixFollowUpSubscriber` does, so `actorTypeFor` records an agent creator as `AGENT`. Flow jobs are dispatched
  through `FleetJobsService.dispatch` with `createdById` as requester and the new system key `system.flow.advance` as
  `auditKey`. The ticker declares `@SystemWriter('system.flow.advance')`.
- **Creator access.** Before each dispatch the creator must still exist, not be disabled, and hold `fleet.job.dispatch`
  in the flow's project (`mayDispatch` from `apps/api/src/fleet/schedules/schedule-access.ts` over the step repository's
  `creatorAccess` and `PermissionService.effectiveKeys`); otherwise the flow stops as `creator_lost_access`.
- **Audit.** Every flow write the engine makes is covered, inside the transaction that writes it: each stop,
  completion, step record and job adoption records an `AuditRecorder` entry with key `system.flow.advance`, resource
  type `flow`; `setSpent` runs under a new bookkeeping reason `fleet.flow-bookkeeping`; claim writes run under the
  existing `fleet.pr-review-bookkeeping`. `setSpent` is called only when the sum differs from the stored `spentUsd`.
- **Cap.** `spentUsd` is recomputed on every tick as the sum of `costSpentUsd + costCarriedUsd` over jobs with the
  flow's id. Before any dispatch, a remaining cap (`costCapUsd - spentUsd`, rounded down to 4 decimals) below `0.0001`
  stops the flow (`cost_cap`); otherwise the remaining cap is the job's `maxCostUsd`. A job with unknown cost adds 0.
- **`RUN` waits for its PR.** `resultPrUrl` is filled by bundle ingest, after the job ends. A `COMPLETED` or
  `ESCALATED` `RUN` (a draft PR escalates at ingest) with no PR yet waits until its `FleetBundleIngest` row for the
  job's lease is `done`, `partial` or `failed`, or until `FLEET_FLOW_PR_WAIT_MS` (default 1,800,000) has passed since
  `finishedAt`; then it stops as `run_no_pr`.
- **`REVIEW` claim states** (a new exported `FleetReviewClaimService` in the reviews module, since the review repository
  is module-private): no row → claimed; a row with a job → owned (adopted); a `pending` row younger than
  `prReviewPollMs` → busy (wait); an older `pending` row (a dead pass's claim, as `ReviewHeadDispatcher.reopenStaleClaim`
  treats it) → removed, then claimed; a `failed:*` row → stop `dispatch_refused`. Adoption (`FleetJobsService.adoptForFlow`)
  runs in the record transaction, after the flow-state check, with its audit entry. Any dispatch error after a claim
  releases the claim before the error is handled or rethrown.
- **Dispatch refusals stop.** `BudgetPausedException` stops as `budget_paused`; `ConflictAppException`,
  `ValidationAppException`, `NotFoundAppException` and `FleetDispatchException` stop as `dispatch_refused` with detail
  `<STEP>: <reason>`, where the reason is the `ValidationAppException`'s `args.reason` when it is a string and the
  exception's class name otherwise (the `ReviewHeadDispatcher` rule). Any other error propagates, the ticker logs it,
  and the next tick tries again.
- **A human stop does not cancel the running job** (design, Stops). The record phase writes nothing when the flow has
  meanwhile left `APPROVED`/`RUNNING`. `IFleetFlowRepository.stop` now also marks every feature `STOPPED`, for every
  caller.
- **Stop details** are at most 2,000 characters (`FLOW_STOP_DETAIL_MAX`).
- **Cross-table reads in the flow's repository.** The step repository reads `FleetJob`, `FleetBundleIngest`, `User` and
  `Agent` rows, as `PrismaScheduleRepository` already does for its cost totals and `findOwnerAccess`. The one write to
  `FleetJob` (adoption) goes through `FleetJobsService`.
- **Paging.** `listAdvanceable(limit, afterId)` returns single-feature `APPROVED`/`RUNNING` flows ordered by `id`, after
  the given id; the ticker pages 50 at a time until a short page, at most 10 pages per tick. A new index
  `FleetFlow(state, id)` serves it.
- **Config bounds.** `FLEET_FLOW_TICK_MS` 1,000-3,600,000; `FLEET_FLOW_PR_WAIT_MS` 60,000-86,400,000;
  `FLEET_FLOW_REVIEW_AGENT` must match `AGENT_NAME_RE`; all three are validated by the Joi schema in
  `apps/api/src/config/env.validation.ts`.
- **Verdict strictness.** The verdict is the text from the last `{"findings"` to the end, after removing a trailing code
  fence and whitespace; any other trailing text makes it unreadable, as the instruction asks for nothing after it.

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
  `flowId` is null, through a new `IFleetJobRepository.adoptForFlow(jobId, flowId, step): Promise<boolean>`
  (a conditional update; `FleetJobPatch` does not carry `flowId`).
- `NewFleetJob` and `FleetJobRecord` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`).
  Target: both add optional `flowId?: string | null` and `flowStep?: string | null`.
- `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts`).
  Baseline: `expectBranch: job.ref` only for a `PLAN` with `threadId`.
  Target: also for a `PLAN` with a non-null `flowId`.
- `FleetFlowsService.respec` (`apps/api/src/fleet/flows/fleet-flows.service.ts:129`).
  Target: its re-ask branch moves into a new public
  `reaskLocked(flow: FleetFlowRecord, specSha: string, now: Date): Promise<FleetFlowRecord>` (close the old request
  if any with reason `superseded`, open a new `fleet.flow.start` request, `flows.reask`, audit `system.flow.respec`,
  activity `flow.respec`), which `respec` calls; the caller holds the locks.
- `NEW_KEY_SCOPES` and `PENDING_SURFACE_KEYS` (`apps/api/src/permissions/catalog.ts`): append `system.flow.advance`
  (`'any'`) right after `system.flow.respec`; it is pending until the ticker declares it.
- `BOOKKEEPING_REASONS` (`apps/api/src/action-context/audit-coverage.reasons.ts`): adds `fleet.flow-bookkeeping`.
- `IFleetConfig`, `FleetConfigSchema` (`apps/api/src/config/fleet.config.ts`) and the Joi schema
  (`apps/api/src/config/env.validation.ts`): add `flowTickMs` (`FLEET_FLOW_TICK_MS`, default 30,000), `flowPrWaitMs`
  (`FLEET_FLOW_PR_WAIT_MS`, default 1,800,000) and `flowReviewAgent` (`FLEET_FLOW_REVIEW_AGENT`, default `Explore`).
- `FleetReviewsModule` (`apps/api/src/fleet/reviews/fleet-reviews.module.ts`): `exports` adds `FleetReviewClaimService`.
- `FlowsModule` (`apps/api/src/fleet/flows/flows.module.ts`): imports `FleetJobsModule` and `FleetReviewsModule`;
  provides the step repository, `FleetFlowAdvanceService` and `FleetFlowTicker`. Neither imported module reaches
  `FlowsModule`, so there is no import cycle.
- `FleetFlow` model: new `@@index([state, id])`.

**Read-only symbols**

- `FleetJobsService.dispatch(actorId, projectId, dto: DispatchFleetJobDto, opts)` returns `Promise<DispatchResultDto>`
  (`.job.id`); it runs no route gate and records its own audit entry with the job insert.
- `IFleetPrReviewRepository` (`apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts`): `insertPending`,
  `findHead`, `markDispatched`, `remove`; `FleetPrReviewRecord` has `jobId: string | null`, `outcome` (`pending`,
  `dispatched` or `failed:<reason>`) and `createdAt`.
- `prNumberFor(repo: { provider, owner, name }, url): number | null` (`apps/api/src/fleet/sync/pr-attribution.service.ts:13`).
- `TERMINAL_STATES`, `ACTIVE_STATES` (`apps/api/src/fleet/jobs/job-state.ts`).
- `ThreadsService.lockForFlowTransition(projectId, threadId)` (returns the thread with `publishedSha`, or null),
  `FleetReposService.lockById(id)`, `FleetReposService.findReviewRepo(id)` (id, projectId, owner, name,
  `githubInstallationId`), `IFleetFlowRepository.lockById(id)`; lock order is parent, then flow.
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)` and `getBranchHead(token, owner, name, branch)`;
  forge failures throw `RepoCheckException`.
- `runAsSystem(component, fn, { onBehalfOf })`, `currentContext()` and `actorTypeFor`
  (`apps/api/src/action-context/action-context.ts`); `bookkeeping(reason, fn)` (`apps/api/src/action-context/audit-coverage.ts:228`).
- `PermissionService.effectiveKeys(principal: PrincipalRef, scope)` (`apps/api/src/permissions/permission.service.ts:99`);
  `mayDispatch(access, keys)` (`apps/api/src/fleet/schedules/schedule-access.ts:12`).
- `AuditRecorder.record({ key, resourceType, resourceId, projectId, summary })` (inside a transaction) and
  `FleetActivityService.record` with `actorType: 'SYSTEM', actorId: 'flow'`, as `respec` uses them.
- `AGENT` verdict rule (F2): an `AGENT` job ends `COMPLETED` only when `nax agents run` reported status `completed`;
  `failed`, `timeout` and `cancelled` end the job `FAILED`. So a `COMPLETED` review job's `agentResult.status` is
  always `completed`, and `agentResult.output` keeps the last 8,192 bytes, where the verdict sits.
- `BudgetPausedException`, `FleetDispatchException`, `AGENT_NAME_RE`, `testFleetConfig` (`apps/api/src/common/test-helpers/fleet-config.ts`).

**New symbols**

- `apps/api/src/fleet/flows/flow-steps.ts` (pure): `FlowStep` (`'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX'`),
  `FLOW_VERDICT_INSTRUCTION`, `FLOW_STOP_DETAIL_MAX` (2000), `buildReviewTask`.
- `apps/api/src/fleet/flows/flow-verdict.ts` (pure): `FlowFinding`, `parseFlowVerdict`, `formatFindings`.
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

`FleetFlowTicker.poll()` returns at once while a pass runs; otherwise it calls `tick(new Date())`. `tick(now)` pages
through advanceable flows and, for each, runs `advance(id, now)` inside
`runAsSystem('flow', ..., { onBehalfOf: { type: createdByType, id: createdById } })`, logging and continuing on error.

`advance(flowId, now)` runs three phases.

1. **Decide (one transaction).** Unlocked read of the flow and its latest job. When the next step can be
   `SPEC_REVIEW` or `PLAN` on a nax-entry flow, read the repo with `findReviewRepo` and the forge head of
   `flow.branch` before the transaction (a `RepoCheckException` ends this pass for the flow with nothing written);
   when the latest job is a `RUN` with a `resultPrUrl`, read the repo for `prNumberFor`. Then lock parent and flow;
   return when the parent is gone or the state is not `APPROVED` or `RUNNING`; update `spentUsd` if the sum changed;
   build `FlowStepInput` from the latest flow job and call `decideFlowStep`. `stop` and `complete` actions are written
   here. A `dispatch` action passes the guards in order: cap, creator access, then (for `SPEC_REVIEW` and `PLAN`) the
   spec sha; the first failing guard stops or re-asks instead.
2. **Dispatch (no transaction held).** `REVIEW` goes through `FleetReviewClaimService`; every other step calls
   `jobs.dispatch(flow.createdById, flow.projectId, buildStepDispatch(...), { flowId, flowStep, auditKey: 'system.flow.advance' })`.
3. **Record (one transaction).** Lock parent and flow; if the flow is still `APPROVED` or `RUNNING`, adopt the job when
   the claim was owned, mark the step (`APPROVED` becomes `RUNNING` with activity `flow.started`), record activity
   `flow.step` and the audit entry.

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
| Nax-entry repo missing or not connected (`githubInstallationId` null) | stop `dispatch_refused`, detail `<STEP>: repo not connected` |
| Forge head read fails (nax entry) | this pass does nothing for the flow |
| Parent (thread or repo) row gone at lock time | this pass does nothing for the flow |
| `REVIEW` head claimed by a live pass with no job yet | wait |
| `REVIEW` head claim older than `prReviewPollMs` with no job | claim removed, head claimed again |
| `REVIEW` head claim settled `failed:<reason>` | stop `dispatch_refused`, detail `REVIEW: <outcome>` |
| `REVIEW` head's job already belongs to another flow | stop `dispatch_refused`, detail `REVIEW: head claimed by another flow` |
| Any `REVIEW` dispatch error after a claim | claim released, then handled as above |
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
- More than 500 advanceable flows in one tick: the ticker stops after 10 pages of 50 and continues on the next tick.
- Mapping a `flowId` foreign-key failure at dispatch (a flow deleted mid-pass) to anything but the existing `createJob` not-found path.
- Regenerating the CLI client and CLI commands for flows; `openapi.json` does not change.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Flow steps and review tasks

Workdir: `apps/api`. No dependencies. Pure module `flow-steps.ts`: `FlowStep`, `FLOW_VERDICT_INSTRUCTION`,
`FLOW_STOP_DETAIL_MAX` and `buildReviewTask(step, specPath, feature)`.

### US-002: The verdict parser

Workdir: `apps/api`. Depends on US-001. Pure module `flow-verdict.ts`: `FlowFinding`, `parseFlowVerdict(output)` and
`formatFindings(findings)`.

### US-003: Flow job columns and flow stop/re-ask

Workdir: `apps/api`. No dependencies. One migration adds `FleetJob.flowId` (nullable, relation to `FleetFlow` with
`onDelete: SetNull`, index on `flowId, queuedAt`), `FleetJob.flowStep` (nullable string), `FleetFlow.stopDetail`
(nullable string) and the index `FleetFlow(state, id)`. `FleetFlowRecord` gains optional `stopDetail`.
`PrismaFleetFlowRepository.stop` takes an optional `detail` and stops every feature; `reask` resets every feature to
`PENDING` with no `currentStep`.

### US-004: Flow fields on jobs and the system key

Workdir: `apps/api`. Depends on US-001, US-003. `FleetJobsService.dispatch` accepts `flowId` and `flowStep` and writes
them in the insert; its `auditKey` union gains `system.flow.advance`, appended to `NEW_KEY_SCOPES` (`'any'`) and added
to `PENDING_SURFACE_KEYS`. `FleetJobsService.adoptForFlow` links an existing job through a new repository method.
`buildAssignPayload` gives a flow `PLAN` `expectBranch`. `FleetJobRecord` carries `flowId` and `flowStep`.

### US-005: Step repository reads

Workdir: `apps/api`. Depends on US-003, US-004. `IFleetFlowStepRepository` (token `FLEET_FLOW_STEP_REPOSITORY`) and its
Prisma implementation, read half: `listAdvanceable(limit, afterId)`, `latestJob(flowId)`, `latestJobForStep(flowId, step)`,
`sumCost(flowId)` and `ingestSettled(jobId, leaseEpoch)`.

### US-006: Step repository writes and lookups

Workdir: `apps/api`. Depends on US-005. The step repository's other half: `setSpent(flowId, spentUsd)`,
`creatorAccess(ref)`, `markStep(flowId, featureId, step, data)` and `complete(flowId, now)`.

### US-007: Step decision, gating and job ends

Workdir: `apps/api`. Depends on US-002. Pure `decideFlowStep(input: FlowStepInput): FlowStepAction`, first part: the
single-feature gate, the `APPROVED` start and adoption rule, waiting on an active job, and the stop rules for failed,
cancelled, crashed and escalated jobs.

### US-008: Step decision, reviews and plan

Workdir: `apps/api`. Depends on US-007. `decideFlowStep` for `COMPLETED` `SPEC_REVIEW`, `PRD_REVIEW` and `PLAN` jobs:
the verdict rule and the `PLAN` result rule.

### US-009: Step decision, run, review and fix

Workdir: `apps/api`. Depends on US-008. `decideFlowStep` for `RUN`, `REVIEW` and `FIX` jobs: the `RUN` PR wait,
`REVIEW` then `FIX`, and the `FIX` ready rule.

### US-010: Step dispatch bodies and the remaining cap

Workdir: `apps/api`. Depends on US-001. Pure `remainingCapUsd(capUsd, spentUsd): string | null` and
`buildStepDispatch(input): DispatchFleetJobDto` producing each step's body.

### US-011: The review head claim service

Workdir: `apps/api`. No dependencies. `FleetReviewClaimService` in the reviews module, exported:
`claimHead(repoId, prNumber, headSha, now): Promise<HeadClaim>`, `markDispatched(claimId, jobId)` and `release(claimId)`,
all under the bookkeeping reason `fleet.pr-review-bookkeeping`.

### US-012: Advance, decide phase

Workdir: `apps/api`. Depends on US-004, US-006, US-009, US-010. `FleetFlowAdvanceService.advance(flowId, now)`: state
gate, locks, spend update under `fleet.flow-bookkeeping` (new bookkeeping reason), the PR-number lookup, and writing
`stop` and `complete` decisions with activity and audit.

### US-013: Advance, dispatch and record phases

Workdir: `apps/api`. Depends on US-012. `advance` dispatches every step but `REVIEW` through
`FleetJobsService.dispatch`, handles dispatch refusals, and records the step with activity and audit.

### US-014: Dispatch guards: cap and creator access

Workdir: `apps/api`. Depends on US-013. Before a dispatch, `advance` stops on a reached cap or a creator who lost
access, and passes the remaining cap as `maxCostUsd`.

### US-015: Spec change before PLAN

Workdir: `apps/api`. Depends on US-013. Before `SPEC_REVIEW` or `PLAN`, `advance` compares `flow.specSha` with the
thread's `publishedSha` or the forge head and re-asks through `FleetFlowsService.reaskLocked`, extracted from `respec`.

### US-016: REVIEW through the head claim

Workdir: `apps/api`. Depends on US-011, US-013. The `REVIEW` dispatch goes through `FleetReviewClaimService`: claim,
dispatch, record; release on any dispatch error; adopt a head's existing job in the record transaction; wait or stop
on the other claim states.

### US-017: The flow ticker and its config

Workdir: `apps/api`. Depends on US-014, US-015, US-016. `FleetFlowTicker` (`@SystemWriter('system.flow.advance')`)
with `poll()` and `tick(now)`; the three config values with their Joi bounds; `FlowsModule` wiring;
`system.flow.advance` leaves `PENDING_SURFACE_KEYS`.

### US-018: Flow ticks against the database

Workdir: `apps/api`. Depends on US-017. Integration tests that run `FleetFlowTicker.tick` over real flows, jobs and
review claims in the test database.

### Context Files

**US-001**

- `apps/api/src/fleet/common/agent-jobs.ts` — the `AGENT` task bound (16,384 characters)

**US-002**

- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-001; `FLOW_STOP_DETAIL_MAX`

**US-003**

- `apps/api/prisma/schema.prisma` — `FleetJob`, `FleetFlow` and `FleetFlowFeature` models
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — `stop` and `reask`
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — `FleetFlowRecord` and `IFleetFlowRepository`
- `apps/api/test/integration/fleet/thread-modes-migration.integration.spec.ts` — migration test pattern

**US-004**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `NewFleetJob`, `FleetJobRecord`, `IFleetJobRepository`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `createJob` and `toJob`
- `apps/api/src/fleet/jobs/assign-payload.ts` — `expectBranch`
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS`

**US-005**

- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — repository base pattern
- `apps/api/src/fleet/schedules/prisma-schedule.repository.ts` — the job cost aggregate precedent

**US-006**

- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — created by US-005; this story adds the other methods
- `apps/api/src/fleet/schedules/prisma-schedule.repository.ts` — `findOwnerAccess` precedent
- `apps/api/src/fleet/schedules/domain/schedule.domain.ts` — `OwnerAccess`

**US-007**

- `apps/api/src/fleet/flows/flow-verdict.ts` — created by US-002
- `apps/api/src/fleet/jobs/job-state.ts` — `TERMINAL_STATES`, `ACTIVE_STATES`

**US-008**

- `apps/api/src/fleet/flows/flow-step-decision.ts` — created by US-007; this story extends `decideFlowStep`
- `apps/api/src/fleet/flows/flow-verdict.ts` — created by US-002; `parseFlowVerdict`, `formatFindings`

**US-009**

- `apps/api/src/fleet/flows/flow-step-decision.ts` — created by US-007; this story completes `decideFlowStep`
- `apps/api/src/fleet/sync/event-payloads.ts` — the `fixReady` shape

**US-010**

- `apps/api/src/fleet/flows/flow-steps.ts` — created by US-001; `buildReviewTask`
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the body this story builds
- `apps/api/src/fleet/threads/threads.service.ts` — the thread `plan()` and `run()` bodies this mirrors

**US-011**

- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — claim, stale claim, `markDispatched` precedent
- `apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts` — `IFleetPrReviewRepository`
- `apps/api/src/fleet/reviews/fleet-reviews.module.ts` — the module whose exports grow
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`

**US-012**

- `apps/api/src/fleet/flows/fleet-flows.service.ts` — lock order, audit and activity pattern (`stop`, `respec`)
- `apps/api/src/fleet/flows/flow-step-decision.ts` — created by US-007
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — created by US-005
- `apps/api/src/action-context/audit-coverage.reasons.ts` — `BOOKKEEPING_REASONS`
- `apps/api/src/fleet/sync/pr-attribution.service.ts` — `prNumberFor`

**US-013**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-012
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` — created by US-010
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — dispatch exception handling precedent

**US-014**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-012
- `apps/api/src/fleet/schedules/schedule-access.ts` — `mayDispatch`
- `apps/api/src/permissions/permission.service.ts` — `effectiveKeys`

**US-015**

- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `respec`, `openStartRequest`
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — the nax-entry forge head read
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-012

**US-016**

- `apps/api/src/fleet/reviews/fleet-review-claim.service.ts` — created by US-011
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — created by US-012

**US-017**

- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `@SystemWriter` ticker precedent
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — `runAsSystem` with `onBehalfOf`
- `apps/api/src/config/fleet.config.ts` — config fields and env parsing
- `apps/api/src/config/env.validation.ts` — the Joi env schema
- `apps/api/src/permissions/catalog.ts` — `PENDING_SURFACE_KEYS`

**US-018**

- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — created by US-017
- `apps/api/test/integration/fleet-flow-respec.integration.spec.ts` — flow integration fixture pattern
- `apps/api/test/integration/fleet/fleet-fix-follow-up.integration.spec.ts` — review claim fixture pattern

### Creates

**US-001**

- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-steps.spec.ts`

**US-002**

- `apps/api/src/fleet/flows/flow-verdict.ts`
- `apps/api/src/fleet/flows/flow-verdict.spec.ts`

**US-003**

- `apps/api/prisma/migrations/20261128090000_fleet_flow_steps/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-steps-migration.integration.spec.ts`

**US-005**

- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-007**

- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-010**

- `apps/api/src/fleet/flows/flow-step-dispatch.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts`

**US-011**

- `apps/api/src/fleet/reviews/fleet-review-claim.service.ts`
- `apps/api/src/fleet/reviews/fleet-review-claim.service.spec.ts`

**US-012**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`

**US-017**

- `apps/api/src/fleet/flows/fleet-flow.ticker.ts`
- `apps/api/src/fleet/flows/fleet-flow.ticker.spec.ts`

**US-018**

- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts`

### Modifies

**US-004**

- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES` table ends at `system.flow.respec`; append `system.flow.advance: 'any'` after it so the table still equals the catalog's, in the same order.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role's map gains `"system.flow.advance": ["non-role-key","non-role-key"]` right after `system.flow.respec`, the same value that key has; no other entry changes.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `expectedPending` gains `system.flow.advance`, because `PENDING_SURFACE_KEYS` now holds it until the ticker declares it.

**US-011**

- `apps/api/src/fleet/reviews/fleet-reviews.module.spec.ts` — if it pins the module's exports, the list gains `FleetReviewClaimService`; nothing else changes.

**US-012**

- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — `EXPECTED_REASON_IDS` gains `fleet.flow-bookkeeping`, matching the new `BOOKKEEPING_REASONS` entry.

**US-017**

- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer list gains `[FleetFlowTicker, 'system.flow.advance']`, its `toHaveLength(40)` becomes `toHaveLength(41)`, and a pending-key assertion expects `PENDING_SURFACE_KEYS.has('system.flow.advance')` to be false.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `expectedPending` loses `system.flow.advance` again, now that the ticker declares it.
- `apps/api/src/common/test-helpers/fleet-config.ts` — `testFleetConfig` returns a full `IFleetConfig`; add `flowTickMs: 30000`, `flowPrWaitMs: 1800000` and `flowReviewAgent: 'Explore'` so it still type-checks.
- `apps/api/src/config/fleet.config.spec.ts` — where it pins the full resolved config or the env key set, add the three flow fields with their defaults.
- `apps/api/src/fleet/flows/flows.module.spec.ts` — the "compiles the real module" test stubs each import; add stubs for `FleetJobsModule`'s `FleetJobsService`, `FleetReviewsModule`'s `FleetReviewClaimService`, `PermissionService` and `FLEET_CFG`, and expect the three new providers.

### Seams

- US-004 → US-013: `advance` passes `flowId`, `flowStep` and `auditKey: 'system.flow.advance'` to `FleetJobsService.dispatch` (US-013 pins the call; US-018 proves the stored row).
- US-009/US-010 → US-013: `advance` dispatches exactly the body `buildStepDispatch` returns for the step `decideFlowStep` chose.
- US-011 → US-016: `advance` calls `FleetReviewClaimService.claimHead` before a `REVIEW` dispatch (US-016 pins; US-018 proves against the real table).
- US-012 → US-017: `FleetFlowTicker.tick` calls `FleetFlowAdvanceService.advance` once per advanceable flow inside `runAsSystem` on the creator's behalf (US-017 seam AC, entered at `tick`).
- US-015 → US-013: `advance` calls `FleetFlowsService.reaskLocked` before a `SPEC_REVIEW`/`PLAN` dispatch whose sha check fails.

## Acceptance Criteria

### US-001: Flow steps and review tasks

- [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')` returns `/spec-review .nax/features/a/spec.md`, a blank line, then `FLOW_VERDICT_INSTRUCTION`.
- [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a')` returns `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json`, a blank line, then `FLOW_VERDICT_INSTRUCTION`.
- [unit] `buildReviewTask('SPEC_REVIEW', p, 'a')` for a 400-character spec path `p` returns at most 16,384 characters.
- [unit] `FLOW_VERDICT_INSTRUCTION` includes the line `{"findings":[]}`.
- [unit] `FLOW_STOP_DETAIL_MAX` equals 2000.

### US-002: The verdict parser

- [unit] `parseFlowVerdict('Looks good.\n{"findings":[]}')` returns `{ ok: true, findings: [] }`.
- [unit] `parseFlowVerdict` of text ending in `{"findings":[{"id":"F1","summary":"Missing AC for 409"}]}` returns `ok` true with the one finding `{ id: 'F1', summary: 'Missing AC for 409' }`.
- [unit] `parseFlowVerdict('{"findings":[{"summary":"x"}]}\nmore text\n{"findings":[]}')` returns `ok` true with no findings.
- [unit] `parseFlowVerdict('{"findings":[]}\n```\n  ')` returns `ok` true with no findings.
- [unit] `parseFlowVerdict('{"findings":[]} thanks')` returns `{ ok: false }`.
- [unit] `parseFlowVerdict('All fine, no JSON.')` returns `{ ok: false }`.
- [unit] `parseFlowVerdict(null)` returns `{ ok: false }`.
- [unit] `parseFlowVerdict('{"findings": oops')` returns `{ ok: false }`.
- [unit] `parseFlowVerdict('{"findings":{"a":1}}')` returns `{ ok: false }`.
- [unit] `parseFlowVerdict('{"findings":[{"id":"F1"}]}')` returns `{ ok: false }`.
- [unit] `parseFlowVerdict('{"findings":[{"id":7,"summary":"s"}]}')` returns `ok` true with the one finding `{ summary: 's' }`.
- [unit] `formatFindings([{ id: 'F1', summary: 'a' }, { summary: 'b' }])` returns `2 findings: 1. [F1] a 2. b`.
- [unit] `formatFindings([{ summary: 'a' }])` returns `1 finding: 1. a`.
- [unit] `formatFindings` of 100 findings of 100 characters each returns exactly 2,000 characters ending in `…`.

### US-003: Flow job columns and flow stop/re-ask

- [integration] After the migration, a `FleetJob` inserted with `flowId` set to an existing flow's id and `flowStep` `'PLAN'` reads back with both values.
- [integration] Deleting a `FleetFlow` sets `flowId` to null on its jobs and deletes no job.
- [integration] `PrismaFleetFlowRepository.stop(id, 'cost_cap', now, 'spent 5 of cap 5')` returns a record with state `STOPPED`, `stopReason` `cost_cap` and `stopDetail` `spent 5 of cap 5`.
- [integration] After `stop(id, 'cost_cap', now, 'x')`, every feature of that flow has `state` `STOPPED`.
- [integration] `stop(id, 'human_stop', now)` without a detail stores `stopDetail` null.
- [integration] `stop` on a `PENDING` flow, as `FleetFlowsService.stop` calls it, also sets its features to `STOPPED`.
- [integration] `reask(id, { specSha, approvalRequestId })` on a `RUNNING` flow whose feature is `RUNNING` at `currentStep` `SPEC_REVIEW` leaves the feature with `state` `PENDING` and `currentStep` null.
- [integration] `findById` returns `stopDetail` from the row.

### US-004: Flow fields on jobs and the system key

- [integration] `FleetJobsService.dispatch` with `opts` `{ flowId, flowStep: 'PLAN', auditKey: 'system.flow.advance' }` creates a job whose stored `flowId` and `flowStep` equal those values.
- [integration] `FleetJobsService.dispatch` without `flowId` creates a job whose `flowId` and `flowStep` are null.
- [integration] A job created with `flowId` and read back through the job repository's `findById` carries `flowId` and `flowStep`.
- [integration] `FleetJobsService.adoptForFlow(jobId, flowId, 'REVIEW')` on a job with no `flowId` sets both fields and returns true.
- [integration] `adoptForFlow` on a job whose `flowId` is another flow's id writes nothing and returns false.
- [unit] `buildAssignPayload` for a `PLAN` job with `flowId` `flow-1`, no `threadId` and `ref` `feat/x` sets `expectBranch` `feat/x`.
- [unit] `buildAssignPayload` for a `RUN` job with `flowId` `flow-1` sets no `expectBranch`.
- [unit] `buildAssignPayload` for a `PLAN` job with neither `threadId` nor `flowId` sets no `expectBranch`.
- [unit] `findCatalogEntry('system.flow.advance')` returns an entry with `access` `system`.

### US-005: Step repository reads

- [integration] `listAdvanceable(50, null)` returns flows in state `APPROVED` or `RUNNING` that have exactly one feature, each as `{ id, createdByType, createdById }`, ordered by `id`.
- [integration] `listAdvanceable(50, null)` omits a two-feature `APPROVED` flow.
- [integration] `listAdvanceable(50, null)` omits flows in `PENDING`, `WAITING_MERGE`, `WAITING_ANSWER`, `COMPLETED` and `STOPPED`.
- [integration] `listAdvanceable(1, firstId)` with three eligible flows returns the second one.
- [integration] `latestJob(flowId)` returns the flow's job with the greatest `queuedAt`.
- [integration] `latestJob(flowId)` returns null for a flow with no jobs.
- [integration] `latestJobForStep(flowId, 'PLAN')` returns the newest job of that flow whose `flowStep` is `PLAN`, ignoring newer jobs of other steps.
- [integration] `sumCost(flowId)` over jobs with `costSpentUsd` `1.2500`/`costCarriedUsd` `0.5000` and `costSpentUsd` `2.0000`/`costCarriedUsd` `0` returns `'3.7500'`.
- [integration] `sumCost(flowId)` ignores a job with another `flowId`.
- [integration] `sumCost(flowId)` returns `'0.0000'` for a flow with no jobs.
- [integration] `ingestSettled(jobId, leaseEpoch)` returns true for a `FleetBundleIngest` row of that job and lease with status `done`.
- [integration] `ingestSettled` returns true for status `failed`.
- [integration] `ingestSettled` returns false for status `running`.
- [integration] `ingestSettled` returns false when the only row belongs to another lease.

### US-006: Step repository writes and lookups

- [integration] `setSpent(flowId, '3.7500')` stores `spentUsd` `3.7500` on the flow.
- [integration] `creatorAccess({ type: 'USER', id })` returns `{ exists: true, disabled: true }` for a disabled user.
- [integration] `creatorAccess({ type: 'USER', id })` returns `{ exists: false, disabled: false }` for an unknown id.
- [integration] `creatorAccess({ type: 'AGENT', id })` returns `exists` true for an existing agent.
- [integration] `creatorAccess({ type: 'AGENT', id })` returns `exists` false for an unknown agent.
- [integration] `markStep(flowId, featureId, 'REVIEW', { flowState: 'RUNNING', prNumber: 7 })` leaves the flow `RUNNING`.
- [integration] After that `markStep`, the feature has `state` `RUNNING`, `currentStep` `REVIEW` and `prNumber` 7.
- [integration] `markStep(flowId, featureId, 'PLAN', { flowState: 'RUNNING' })` keeps the feature's existing `prNumber`.
- [integration] `complete(flowId, now)` sets the flow state `COMPLETED` with `endedAt` `now`.
- [integration] `complete(flowId, now)` sets the feature's `state` `COMPLETED`.

### US-007: Step decision, gating and job ends

- [unit] `decideFlowStep` with `featureCount` 2 returns `{ kind: 'skip' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and no latest job returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and a latest `PLAN` job queued before `approvedAt` returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `APPROVED` and a latest `SPEC_REVIEW` job in `RUNNING` queued at `approvedAt` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with flow state `RUNNING` and no latest job returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest job in `QUEUED` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest job in `UPLOADING` returns `{ kind: 'wait' }`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest `PLAN` job `j1` in `FAILED` with `stateReason` `checkout: no .nax dir` returns a stop with reason `step_failed` and detail `PLAN job j1 FAILED: checkout: no .nax dir`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest job in `CANCELLED` returns a stop with reason `step_failed`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest job in `CRASHED` with `stateReason` null returns a stop whose detail ends `CRASHED: no reason`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest `REVIEW` job in `ESCALATED` returns a stop with reason `step_failed`.
- [unit] `decideFlowStep` with flow state `RUNNING` and a latest `RUN` job in `ESCALATED` with `prNumber` 12 returns a `REVIEW` dispatch, not a stop.

### US-008: Step decision, reviews and plan

- [unit] On a `RUNNING` flow, a `COMPLETED` `SPEC_REVIEW` job whose `agentOutput` ends in `{"findings":[]}` makes `decideFlowStep` return `{ kind: 'dispatch', step: 'PLAN' }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `PRD_REVIEW` job whose `agentOutput` ends in `{"findings":[]}` makes `decideFlowStep` return `{ kind: 'dispatch', step: 'RUN' }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `SPEC_REVIEW` job whose verdict has one finding makes `decideFlowStep` return a stop with reason `review_findings`.
- [unit] That `review_findings` stop's detail equals `formatFindings` of the verdict's findings.
- [unit] On a `RUNNING` flow, a `COMPLETED` `PRD_REVIEW` job whose verdict has one finding makes `decideFlowStep` return a stop with reason `review_findings`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `SPEC_REVIEW` job `j2` whose `agentOutput` is null makes `decideFlowStep` return a stop with reason `verdict_unreadable` and detail `SPEC_REVIEW job j2: no verdict JSON in the agent output`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `PRD_REVIEW` job whose `agentOutput` has no verdict makes `decideFlowStep` return a stop with reason `verdict_unreadable`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `PLAN` job with `resultBranch` and `resultSha` makes `decideFlowStep` return `{ kind: 'dispatch', step: 'PRD_REVIEW' }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `PLAN` job with no `resultSha` makes `decideFlowStep` return a stop with reason `plan_no_result`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `PLAN` job with no `resultBranch` makes `decideFlowStep` return a stop with reason `plan_no_result`.

### US-009: Step decision, run, review and fix

- [unit] On a `RUNNING` flow, a `COMPLETED` `RUN` job whose `prNumber` is 12 and `resultSha` is `abc1234` makes `decideFlowStep` return `{ kind: 'dispatch', step: 'REVIEW', pr: { number: 12, headSha: 'abc1234' } }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `RUN` job with no `prNumber`, `ingestSettled` false and `now - finishedAt` below `prWaitMs` makes `decideFlowStep` return `{ kind: 'wait' }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `RUN` job with no `prNumber` and `ingestSettled` true makes `decideFlowStep` return a stop with reason `run_no_pr`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `RUN` job with no `prNumber`, `ingestSettled` false and `now - finishedAt` equal to `prWaitMs` makes `decideFlowStep` return a stop with reason `run_no_pr`.
- [unit] On a `RUNNING` flow whose feature's `prNumber` is 12, a `COMPLETED` `REVIEW` job makes `decideFlowStep` return `{ kind: 'dispatch', step: 'FIX', pr: { number: 12 } }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `FIX` job whose `fixReady.markedReady` is true makes `decideFlowStep` return `{ kind: 'complete' }`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `FIX` job whose `fixReady` is `{ markedReady: false, readyHeld: 'no CI' }` makes `decideFlowStep` return a stop `pr_not_ready` with detail `no CI`.
- [unit] On a `RUNNING` flow, a `COMPLETED` `FIX` job whose `fixReady` is null makes `decideFlowStep` return a stop `pr_not_ready` with detail `FIX ended without a ready result`.

### US-010: Step dispatch bodies and the remaining cap

- [unit] `remainingCapUsd('10', '3.25')` returns `'6.7500'`.
- [unit] `remainingCapUsd('1', '0.33333')` returns `'0.6666'`.
- [unit] `remainingCapUsd('10', '9.99995')` returns null.
- [unit] `remainingCapUsd('5', '6')` returns null.
- [unit] `buildStepDispatch` for `SPEC_REVIEW` on a flow with `specSha` `s1`, `reviewerRole` `opus`, feature `f`, spec path `.nax/features/f/spec.md`, review agent `Explore` and remaining `'6.7500'` returns `{ repoId, command: 'AGENT', feature: 'f', ref: 's1', bashMode: 'raw', maxCostUsd: 6.75, agent: { name: 'Explore', task, model: 'opus' } }` with no other keys, where `task` is `buildReviewTask('SPEC_REVIEW', '.nax/features/f/spec.md', 'f')`.
- [unit] `buildStepDispatch` for `PLAN` on a flow with `branch` `feat/f` returns command `PLAN`, `ref` `feat/f`, `feature` `f`, `planFrom` the spec path, `profiles` `[]` and the remaining cap as `maxCostUsd`.
- [unit] `buildStepDispatch` for `PRD_REVIEW` returns command `AGENT`, `ref` equal to the given `PLAN` job's `resultSha`, and the task `buildReviewTask('PRD_REVIEW', specPath, feature)`.
- [unit] `buildStepDispatch` for `RUN` returns command `RUN`, `ref` equal to the given `PLAN` job's `resultBranch`, `feature` `f` and `profiles` `[]`.
- [unit] `buildStepDispatch` for `REVIEW` with `pr` `{ number: 12 }` returns command `REVIEW`, `prNumber` 12, `profiles` `[]` and no `ref` or `feature`.
- [unit] `buildStepDispatch` for `FIX` with `pr` `{ number: 12 }` returns command `FIX`, `prNumber` 12, `profiles` `[]` and no `ref` or `feature`.
- [unit] `buildStepDispatch` for `PLAN` on a flow with `pinnedRunnerId` `r1` sets `pinnedRunnerId` `r1`.
- [unit] `buildStepDispatch` for `PLAN` on a flow with `pinnedRunnerId` null has no `pinnedRunnerId` key.
- [unit] `buildStepDispatch` for `RUN` with no `PLAN` job throws an `Error` whose message names the missing plan.

### US-011: The review head claim service

- [unit] `claimHead(repoId, 12, 'h1', now)` when `insertPending` returns a row returns `{ kind: 'claimed', claimId }` with that row's id.
- [unit] `claimHead` when `insertPending` returns null and `findHead` returns a row with `jobId` `j9` returns `{ kind: 'owned', jobId: 'j9' }`.
- [unit] `claimHead` when the existing row is `pending`, has no job and was created less than `prReviewPollMs` before `now` returns `{ kind: 'busy' }`.
- [unit] `claimHead` when the existing row is `pending`, has no job and is older than `prReviewPollMs` calls `remove` with its id.
- [unit] In that stale case, `claimHead` calls `insertPending` again and returns `{ kind: 'claimed' }` with the new row's id.
- [unit] `claimHead` when the existing row's `outcome` is `failed:repo gone` returns `{ kind: 'failed', outcome: 'failed:repo gone' }`.
- [unit] `claimHead` when `insertPending` returns null and `findHead` returns null returns `{ kind: 'busy' }`.
- [unit] `markDispatched(claimId, jobId)` calls the review repository's `markDispatched` with both ids inside `bookkeeping('fleet.pr-review-bookkeeping', ...)`.
- [unit] `release(claimId)` calls the review repository's `remove(claimId)` inside `bookkeeping('fleet.pr-review-bookkeeping', ...)`.
- [unit] A test module that imports `FleetReviewsModule` resolves `FleetReviewClaimService`.

### US-012: Advance, decide phase

- [unit] `advance` on a flow in state `PENDING` dispatches nothing and writes nothing.
- [unit] `advance` on a flow in state `STOPPED` dispatches nothing and writes nothing.
- [unit] `advance` locks the thread with `ThreadsService.lockForFlowTransition` before `flows.lockById` for a thread-entry flow.
- [unit] `advance` locks the repo with `FleetReposService.lockById` before `flows.lockById` for a nax-entry flow.
- [unit] `advance` writes nothing when `lockForFlowTransition` returns null.
- [unit] `advance` calls `steps.setSpent(flowId, '3.7500')` inside `bookkeeping('fleet.flow-bookkeeping', ...)` when `sumCost` returns `'3.7500'` and the stored `spentUsd` is `'0.0000'`.
- [unit] `advance` does not call `steps.setSpent` when `sumCost` equals the stored `spentUsd`.
- [unit] When the latest job is a `RUN` with `resultPrUrl` `https://github.com/o/r/pull/12`, `advance` calls `findReviewRepo(flow.repoId)` and passes `prNumber` 12 to `decideFlowStep`.
- [unit] When the decision is a stop, `advance` calls `flows.stop(flowId, reason, now, detail)`.
- [unit] When the decision is a stop, `advance` records activity `flow.stopped` with payload `{ flowId, stopReason, detail, step, jobId }`.
- [unit] When the decision is a stop, `advance` records an `AuditRecorder` entry with key `system.flow.advance`, resource type `flow` and the flow's id.
- [unit] When the decision is `complete`, `advance` calls `steps.complete(flowId, now)` and records activity `flow.completed`.
- [unit] When the decision is `complete`, `advance` records an `AuditRecorder` entry with key `system.flow.advance`.
- [unit] When the decision is `wait`, `advance` dispatches nothing and writes no step, stop or audit entry.

### US-013: Advance, dispatch and record phases

- [unit] `advance` on an `APPROVED` single-feature flow whose decision is `dispatch SPEC_REVIEW` calls `FleetJobsService.dispatch` once with `flow.createdById`, `flow.projectId` and the body `buildStepDispatch` returns.
- [unit] That `dispatch` call's `opts` equal `{ flowId, flowStep: 'SPEC_REVIEW', auditKey: 'system.flow.advance' }`.
- [unit] After that dispatch returns job `j1`, `advance` calls `steps.markStep` with flow state `RUNNING` and step `SPEC_REVIEW`.
- [unit] After that dispatch, `advance` records activity `flow.started` with `approvalMode` and `approverId` in its payload, `actorType` `SYSTEM` and `actorId` `flow`.
- [unit] After that dispatch, `advance` records activity `flow.step` with payload `{ step: 'SPEC_REVIEW', jobId: 'j1' }`.
- [unit] After that dispatch, `advance` records an `AuditRecorder` entry with key `system.flow.advance` for the flow.
- [unit] `advance` on a `RUNNING` flow whose decision is `dispatch PLAN` records `flow.step` and no `flow.started`.
- [unit] `advance` stops with reason `budget_paused` when `dispatch` throws `BudgetPausedException`.
- [unit] `advance` stops with reason `dispatch_refused` and detail `PLAN: specMissing` when `dispatch` throws a `ValidationAppException` whose `args.reason` is `specMissing`.
- [unit] `advance` stops with reason `dispatch_refused` and detail `PLAN: FleetDispatchException` when `dispatch` throws a `FleetDispatchException`.
- [unit] `advance` stops with reason `dispatch_refused` when `dispatch` throws a `ConflictAppException`.
- [unit] `advance` rethrows an `Error` thrown by `dispatch` that is not a conflict, validation, not-found or dispatch exception.
- [unit] After that rethrow, no stop has been written.
- [unit] `advance` writes no step and no activity when the flow is `STOPPED` at the record phase after a successful dispatch.

### US-014: Dispatch guards: cap and creator access

- [unit] `advance` with `spentUsd` `'5.0000'`, `costCapUsd` `'5.0000'` and a dispatch decision stops with reason `cost_cap` and detail `spent 5.0000 of cap 5.0000`.
- [unit] In that `cost_cap` case, `advance` does not call `dispatch`.
- [unit] `advance` passes `maxCostUsd` 1.5 to `dispatch` when `costCapUsd` is `'5'` and `sumCost` returns `'3.5000'`.
- [unit] `advance` stops with reason `creator_lost_access` when `creatorAccess` returns `{ exists: true, disabled: true }`.
- [unit] `advance` stops with reason `creator_lost_access` when `creatorAccess` returns `{ exists: false, disabled: false }`.
- [unit] `advance` stops with reason `creator_lost_access` when the creator's `effectiveKeys` in the flow's project lack `fleet.job.dispatch`.
- [unit] In each `creator_lost_access` case, `advance` does not call `dispatch`.
- [unit] `advance` checks the cap before creator access: with the cap reached and the creator disabled, it stops with `cost_cap`.

### US-015: Spec change before PLAN

- [unit] `FleetFlowsService.reaskLocked(flow, 'newsha', now)` on an `APPROVED` flow with a request id closes that request with reason `superseded`.
- [unit] `reaskLocked` opens a new `fleet.flow.start` request and returns the record from `flows.reask(flow.id, { specSha: 'newsha', approvalRequestId })`.
- [unit] `FleetFlowsService.respec` with a re-ask case still produces a `PENDING` flow with the new sha and audit `system.flow.respec`, through `reaskLocked`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch SPEC_REVIEW` and whose thread `publishedSha` differs from `specSha` calls `reaskLocked(flow, publishedSha, now)` and does not call `dispatch`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch PLAN` and whose thread `publishedSha` differs calls `reaskLocked` and does not call `dispatch`.
- [unit] `advance` on a thread-entry flow whose decision is `dispatch RUN` dispatches `RUN` although `publishedSha` differs from `specSha`.
- [unit] `advance` on a nax-entry flow with no flow job reads `getBranchHead` with a token from `mintReadOnlyToken`, and with a head equal to `specSha` dispatches `SPEC_REVIEW`.
- [unit] `advance` on a nax-entry flow whose forge head differs from `specSha` calls `reaskLocked(flow, head, now)` and does not dispatch.
- [unit] `advance` on a nax-entry flow when `getBranchHead` throws `RepoCheckException` dispatches nothing and writes nothing.
- [unit] `advance` on a nax-entry flow when `getBranchHead` throws `RepoCheckException` resolves without throwing.
- [unit] `advance` on a nax-entry flow whose `findReviewRepo` returns a repo with `githubInstallationId` null stops with reason `dispatch_refused` and detail `SPEC_REVIEW: repo not connected`.
- [unit] `advance` on a nax-entry flow whose latest job is a `COMPLETED` `RUN` does not call `getBranchHead`.
- [unit] `advance` on a nax-entry flow whose latest job is a `RUNNING` `SPEC_REVIEW` does not call `getBranchHead`.

### US-016: REVIEW through the head claim

- [unit] `advance` with decision `dispatch REVIEW` for PR 12 at head `h1` calls `claimHead(repoId, 12, 'h1', now)`.
- [unit] On `{ kind: 'claimed', claimId: 'c1' }`, `advance` calls `dispatch` with the `REVIEW` body and `flowStep` `REVIEW`.
- [unit] After that dispatch returns job `j3`, `advance` calls `markDispatched('c1', 'j3')`.
- [unit] After that dispatch, `advance` calls `steps.markStep` with step `REVIEW` and `prNumber` 12.
- [unit] On `{ kind: 'owned', jobId: 'j9' }`, `advance` calls `FleetJobsService.adoptForFlow('j9', flowId, 'REVIEW')` in the record phase and does not call `dispatch`.
- [unit] After that adoption, `advance` calls `steps.markStep` with step `REVIEW` and `prNumber` 12, records `flow.step` with `jobId` `j9`, and records an audit entry with key `system.flow.advance`.
- [unit] On `{ kind: 'owned' }` when the flow is `STOPPED` at the record phase, `advance` does not call `adoptForFlow`.
- [unit] On `{ kind: 'owned' }` when `adoptForFlow` returns false, `advance` stops with reason `dispatch_refused` and detail `REVIEW: head claimed by another flow`.
- [unit] On `{ kind: 'busy' }`, `advance` dispatches nothing and writes no step or stop.
- [unit] On `{ kind: 'failed', outcome: 'failed:repo gone' }`, `advance` stops with reason `dispatch_refused` and detail `REVIEW: failed:repo gone`.
- [unit] When the `REVIEW` dispatch throws `ConflictAppException`, `advance` calls `release('c1')` and stops with reason `dispatch_refused`.
- [unit] When the `REVIEW` dispatch throws `BudgetPausedException`, `advance` calls `release('c1')` and stops with reason `budget_paused`.
- [unit] When the `REVIEW` dispatch throws a plain `Error`, `advance` calls `release('c1')` and rethrows.

### US-017: The flow ticker and its config

- [unit] `fleetConfig()` with no flow variables set returns `flowTickMs` 30000, `flowPrWaitMs` 1800000 and `flowReviewAgent` `Explore`.
- [unit] `fleetConfig()` with `FLEET_FLOW_REVIEW_AGENT` `plugin:reviewer` returns that name.
- [unit] `validate` from `env.validation.ts` throws for `FLEET_FLOW_REVIEW_AGENT` `../x`.
- [unit] `validate` throws for `FLEET_FLOW_TICK_MS` `0`.
- [unit] `FleetFlowTicker.onModuleInit` with `sweepEnabled` false starts no interval.
- [unit] `FleetFlowTicker.onModuleInit` with `sweepEnabled` true starts an interval of `flowTickMs`, and `onModuleDestroy` clears it.
- [unit] `FleetFlowTicker.tick(now)` calls `steps.listAdvanceable(50, null)` and then `FleetFlowAdvanceService.advance(id, now)` once for each returned flow, in order.
- [unit] When the first page has 50 flows, `tick` asks for the next page with the last id, and stops at a page shorter than 50.
- [unit] Inside `tick`, each `advance` call runs with a `currentContext()` whose actor is of type `SYSTEM` and whose `onBehalfOf` equals that flow's `{ type: createdByType, id: createdById }`.
- [unit] Inside `tick`, `actorTypeFor(createdById)` returns `AGENT` for an agent-created flow.
- [unit] `FleetFlowTicker.tick` continues with the next flow when `advance` throws for one flow, and logs the error with the flow id.
- [unit] A second `poll()` while the first is still running returns without calling `listAdvanceable` again.
- [unit] `FleetFlowTicker` declares the system writer `system.flow.advance`, and `PENDING_SURFACE_KEYS.has('system.flow.advance')` is false.
- [unit] Compiling `FlowsModule` resolves `FleetFlowTicker` and `FleetFlowAdvanceService`.

### US-018: Flow ticks against the database

- [integration] With an `APPROVED` single-feature thread-entry flow whose `specSha` equals its thread's `publishedSha`, `FleetFlowTicker.tick(now)` with the real `FleetJobsService` creates one `FleetJob` with `flowId` the flow's id, `flowStep` `SPEC_REVIEW`, command `AGENT` and `ref` the flow's `specSha`.
- [integration] After that tick the flow is `RUNNING`, its feature's `currentStep` is `SPEC_REVIEW`, and an audit row with key `system.flow.advance` exists for the flow.
- [integration] A second `tick` while that job is `QUEUED` creates no other job.
- [integration] With an `APPROVED` flow with two features, `tick(now)` creates no job and leaves the flow `APPROVED`.
- [integration] With a `RUNNING` flow whose latest `SPEC_REVIEW` job `j` is `FAILED` with reason `checkout: ref not found`, `tick(now)` leaves the flow `STOPPED` with `stopReason` `step_failed` and `stopDetail` `SPEC_REVIEW job j FAILED: checkout: ref not found`, without an unaudited-write error.
- [integration] With a `RUNNING` flow whose latest `SPEC_REVIEW` job is `COMPLETED` with `agentResult.output` ending in `{"findings":[]}`, `tick(now)` creates a `PLAN` job with `flowStep` `PLAN` for the flow.
- [integration] With a `RUNNING` flow whose latest `SPEC_REVIEW` job is `COMPLETED` with a verdict holding one finding, `tick(now)` leaves the flow `STOPPED` with `stopReason` `review_findings`.
- [integration] With a `RUNNING` flow whose latest `RUN` job is `COMPLETED` with `resultPrUrl` for PR 12 and `resultSha` `h1`, `tick(now)` creates a `FleetPrReview` row for the repo, PR 12 and head `h1` linked to a new `REVIEW` job whose `flowId` is the flow's id.
- [integration] With the same flow when a `FleetPrReview` row for PR 12 and head `h1` already links an auto-review `REVIEW` job, `tick(now)` creates no job, that job's `flowId` becomes the flow's id, and the feature's `prNumber` is 12.
