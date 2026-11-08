<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Multi-feature fleet flows with merge waits

## Summary

A fleet flow today runs exactly one feature: the ticker skips any flow with more than one feature, and every
step reads `flow.features[0]`. This feature runs a flow's features **one at a time, in order**. The first feature
runs the existing chain on the flow branch. When a feature reaches a ready PR, the next feature starts. An
**independent** feature (empty `dependsOn`) starts at once, on a new branch `feat/<feature>` created at the flow's
spec sha. A **dependent** feature waits in `WAITING_MERGE` until every PR it depends on is merged, then starts on a
new branch created at the repo's default-branch head. The ticker polls GitHub for the awaited PRs. `SPEC_REVIEW`
runs once, for the whole set, and its calls are committed into each spec they target. The flow completes when no
feature is left to start.

## Motivation

The fleet flow design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, G6 and Steps 2.6) splits one
brainstorm into several specs and carries them to ready PRs with one approval. F1-F4 and the rulings and PRD-edit
features built and verified that chain for one feature (live flow 9 completed). A flow created with two or more
features is accepted, approved, and then never advanced: `listAdvanceable` filters on a feature count of 1 and
`decideFlowStep` returns `skip` when `featureCount !== 1`. This is the last engine piece before the flow page (F6).

## Design

### User rulings (2026-11-09)

1. One feature is active at a time. An independent feature (no `dependsOn`) starts as soon as the previous feature
   reaches a ready PR; it does not wait for a merge. A dependent feature waits (`WAITING_MERGE`) until every
   feature it names is merged.
2. Feature 1 keeps the flow branch. A dependent feature plans from the default branch after its dependencies are
   merged; an independent feature plans from the flow's spec sha. Each later feature gets its own `feat/<feature>`
   branch and PR.
3. The 30 s flow ticker polls GitHub (`getPullRequest`, read-only token) for the awaited PRs while the flow is in
   `WAITING_MERGE`. A PR closed without merge stops the flow (`pr_closed`).
4. `SPEC_REVIEW` is one AGENT job over the whole set: it names every spec path and asks for cross-spec consistency.
   Its calls and questions may target any feature's spec.

### Calls made while drafting (not user rulings)

- **Jobs are scoped to a feature by a new `FleetJob.flowFeatureId` column**, not by `FleetJob.feature`: a REVIEW
  job's `feature` is the canonical PR feature (`prNumberOfReviewFeature`), not the nax feature name. The migration
  backfills every existing flow job to its flow's position-0 feature, so single-feature flows read the same jobs.
- **The set's `SPEC_REVIEW` belongs to the first feature** (`flowFeatureId` = position 0). Later features start at
  `PLAN`.
- **The API creates each later feature's branch** (`GitHubAppClient.createBranch`, `POST /git/refs`) before its
  `PLAN`, because a flow `PLAN` carries `expectBranch: job.ref` (`assign-payload.ts:67`) and the runner refuses a PRD
  whose `branchName` differs from the ref. No runner change.
- **The branch base is checked against the approved spec**: the feature's spec file blob sha at the base must equal
  its blob sha at `flow.specSha`; otherwise the flow stops `spec_changed`. A later feature is never re-asked: once a
  feature is `READY` or `MERGED`, any spec change stops the flow with `spec_changed` instead of `reaskLocked`
  returning it to `PENDING` (the design's non-goal: a stopped flow is cloned, not restarted).
- **`flow.specSha` stays the set's sha on the flow branch.** `PRD_REVIEW` calls and PRD edits of a later feature are
  committed on that feature's branch and do not move `flow.specSha`.
- **New feature states** `READY` (ready PR) and `MERGED`. A flow completes when no feature is `PENDING` and none is
  active; completion sets every non-`MERGED` feature to `COMPLETED` (a single-feature flow ends `COMPLETED`, as
  today).
- **`dependsOn` must name earlier features** (positions are the run order), and no later feature's
  `feat/<feature>` may equal the flow branch. Both are create-time 400s.
- **Thread-entry flows with more than one feature** stop at the second feature's start with `dispatch_refused`
  (`thread entry runs one feature`): a thread's published spec sha exists only on its runner, so no branch can be
  created from it.

### Integration

Symbols this feature only reads (verified):

- `GitHubAppClient.getPullRequest(token, owner, name, number): Promise<VcsPrStatus | null>`
  (`apps/api/src/fleet/git-broker/github-app-client.ts:246`); `VcsPrStatus` (`apps/api/src/vcs/types.ts:39`) has
  `state`, `merged`, `mergedAt`, `headSha?`, `url`.
- `GitHubAppClient.getFile(token, owner, name, path, ref): Promise<ForgeFile | null>`, `ForgeFile.sha` is the blob
  sha (`git-broker/forge-tree.ts:10`).
- `GitHubAppClient.getBranchHead(token, owner, name, branch): Promise<string>`, `mintReadOnlyToken`,
  `mintInstallationToken`.
- `FleetRepoRecord.defaultBranch` (`apps/api/src/fleet/repos/domain/fleet-repo.domain.ts:12`).
- `prepareCheckout` and `checkPlanPrd` on the runner: a flow `PLAN` checks out its ref and refuses a PRD whose
  `branchName` is not the ref (`apps/runner/src/verdict/plan-verdict.ts:19`).
- `FleetFlowsService.recordAnswers` path already finds the `WAITING_ANSWER` feature by state
  (`fleet-flows.service.ts:112`).
- `canTransitionFlow` (`flow-states.ts`) already allows `RUNNING -> WAITING_MERGE` and `WAITING_MERGE -> RUNNING`.

Symbols this feature changes. The baseline exists only to locate the code; implement the target.

- `IFleetFlowStepRepository` (`apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`)
  - Baseline: `latestJobWithIngest(flowId)`, `latestJobForStep(flowId, step)`,
    `countJobsForStepSince(flowId, step, since)`, `recordCalls(flowId, featureId, jobId, specSha)`,
    `complete(flowId, now)`, `listAdvanceable(limit, afterId)` (feature count = 1, states APPROVED/RUNNING).
  - Target: `latestJobWithIngest(flowId, featureId)`, `latestJobForStep(flowId, featureId, step)`,
    `countJobsForStepSince(flowId, featureId, step, since)` filter on `FleetJob.flowFeatureId`;
    `recordCalls(flowId, featureId, jobId, specSha: string | null)` moves `flow.specSha` only when `specSha` is not
    null; `complete(flowId, now)` sets every feature not `MERGED` to `COMPLETED`; `listAdvanceable` selects
    `APPROVED`, `RUNNING` and `WAITING_MERGE` flows of any feature count. New: `setFeatureBranch(featureId,
    branch)`, `markFeatureState(featureId, state)`, `setFlowState(flowId, state)`.
- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:97`)
  - Baseline: `opts.flowId`, `opts.flowStep`.
  - Target: also `opts.flowFeatureId`, written with `flowId`.
- `FleetJobsService.adoptForFlow(jobId, flowId, step)` and the repository method of the same name
  - Target: `adoptForFlow(jobId, flowId, flowFeatureId, step)`, writing `flowFeatureId` in the same conditional
    update.
- `decideFlowStep(input: FlowStepInput)` (`flow-step-decision.ts`)
  - Baseline: `featureCount` input, `if (input.featureCount !== 1) return { kind: 'skip' }`; a null latest job
    dispatches `SPEC_REVIEW`.
  - Target: `featureCount` replaced by `firstFeature: boolean`; no skip; with a null latest job, the first feature
    dispatches `SPEC_REVIEW` and a later feature dispatches `PLAN`; `state === 'APPROVED'` handling applies to the
    first feature only.
- `FlowFinding` / `parseFlowVerdict` (`flow-verdict.ts`)
  - Target: an optional string `feature` field is kept on each finding when present.
- `buildReviewTask(step, specPath, feature, options)` (`flow-steps.ts`)
  - Target: `buildReviewTask(step, specPath, feature, options)` where `options.setSpecPaths?: string[]` (two or
    more paths) makes the `SPEC_REVIEW` task name every spec path, ask for cross-spec consistency, and ask each
    finding to carry `"feature":"<feature>"`.
- `FleetFlowCallsService.apply(flow, action, expectedHead)` and `applyPrdEdits(flow, action, expectedHead)`
  - Target: both take a fourth argument `target: { feature: string; specPath: string; branch: string }` and use it
    instead of `flow.features[0]` and `flow.branch`.
- `buildStepDispatch(input)` (`flow-step-dispatch.ts`)
  - Target: `PLAN` uses `input.feature.branch ?? flow.branch` as its ref; `SPEC_REVIEW` passes
    `setSpecPaths` when the flow has two or more features.
- `FleetFlowAdvanceService` (`fleet-flow-advance.service.ts`): every `flow.features[0]` read becomes the active
  feature chosen by `nextFlowFeature`; new passes `start_feature` and `merge_watch`.
- `parseFlowInput(body, entry)` (`flow-input.ts`): two new validation failures, raised through its `fail(property)` helper (`ValidationAppException` with `reason` = the property path).
- `FleetFlowsService.reaskLocked(flow, specSha, now)`: stops instead of re-asking once a feature is `READY` or
  `MERGED`.
- `FlowStopReason`: adds `pr_closed` and `spec_changed`.

Patterns to follow: the forge-outside-transaction split already used by `advanceCalls` and `advancePrdEdits`
(forge call, then `txManager.run` with `lockLive`); `RepoCheckException` from a forge read ends the pass quietly,
as in `decide`.

### Approach

A new pure module `flow-features.ts`:

```ts
export interface FlowFeatureView {
  id: string; position: number; feature: string; dependsOn: string[]; state: string; prNumber: number | null;
}
export type FlowFeatureAction =
  | { kind: 'active'; featureId: string }
  | { kind: 'start'; featureId: string; base: 'spec' | 'default' }
  | { kind: 'wait_merge'; featureIds: string[] }
  | { kind: 'complete' };

export function nextFlowFeature(features: readonly FlowFeatureView[]): FlowFeatureAction;
```

Rules, in order, over features sorted by `position`:

1. The first feature in `RUNNING` or `WAITING_ANSWER` is `active`.
2. The position-0 feature in `PENDING` is `active` (the flow has not started; it runs `SPEC_REVIEW`).
3. Otherwise take the first `PENDING` feature. None: `complete`.
4. If every feature its `dependsOn` names is `MERGED`: `start`, with `base: 'default'` when `dependsOn` is not empty
   and `base: 'spec'` when it is empty.
5. Otherwise `wait_merge`, with the ids of the named features that are not `MERGED`.

Advance, per pass (`FleetFlowAdvanceService.advance`):

- A `WAITING_MERGE` flow runs **merge watch**: outside any transaction, mint a read-only token and call
  `getPullRequest` for each awaited feature's `prNumber`. `merged: true` marks the feature `MERGED`; `state:
  'closed'` with `merged: false`, or a null result, stops the flow `pr_closed` with detail `PR #<n> closed without
  merge` or `PR #<n> not found`; an open PR changes nothing. Then, under the locks, write the merges and, when
  `nextFlowFeature` now returns `start`, move the flow to `RUNNING` (activity `flow.resumed`).
- An `APPROVED`/`RUNNING` flow decides with `nextFlowFeature`. `active`: the existing step decision, fed with the
  active feature's own jobs, ids and branch. `start`: the **start pass**. `complete`: complete the flow.
  `wait_merge`: move the flow to `WAITING_MERGE` (activity `flow.waiting_merge`).
- The step decision's `complete` for the active feature marks it `READY` (activity `flow.feature_ready`) and then
  applies `nextFlowFeature` in the same transaction: `complete` completes the flow, `wait_merge` moves it to
  `WAITING_MERGE`, `start` leaves it `RUNNING` for the next pass.
- **Start pass**, outside any transaction: refuse a thread-entry flow (`dispatch_refused`,
  `thread entry runs one feature`); resolve the base sha (`spec`: `flow.specSha`; `default`: `getBranchHead` of the
  repo's `defaultBranch`); read the feature's spec file at the base and at `flow.specSha` and compare their blob
  shas (different or missing: stop `spec_changed`, detail `<specPath> differs from the approved spec`); create
  `feat/<feature>` at the base sha. Then under the locks: `setFeatureBranch`, `markFeatureState(RUNNING)`, activity
  `flow.feature_started` with `{ feature, base, sha, branch }`. The next pass dispatches its `PLAN`.

`SPEC_REVIEW` calls for a set: the `apply_calls` pass groups the findings by `feature` (a missing or unknown name
goes to the first feature), and commits one spec at a time in position order, each with `expectedHead` = the
previous commit sha (the first: `flow.specSha`), on the flow branch. After the last commit, under the locks,
`recordCalls` for every target feature, the last one moving `flow.specSha` to the last commit, and the first
feature's `callsJobId` is set to the job id (the set marker the decision reads).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `getPullRequest` or a start-pass forge read throws `RepoCheckException` | Pass ends; nothing written; next tick retries |
| Awaited PR closed without merge, or not found | Stop `pr_closed` |
| Spec blob at the base differs from `flow.specSha`, or the file is missing at either | Stop `spec_changed` |
| `createBranch` finds the branch already present at the base sha | Treated as created |
| `createBranch` finds the branch present at another sha | Stop `dispatch_refused`, detail `branch feat/<feature> already exists` |
| Thread-entry flow reaches a later feature's start | Stop `dispatch_refused`, detail `thread entry runs one feature` |
| A later feature's `PLAN` result branch differs from its feature branch | Stop `dispatch_refused`, detail `PLAN pushed <x>, expected <y>` |
| Spec change (re-publish or stale head) after a feature is `READY` or `MERGED` | Stop `spec_changed` instead of re-ask |
| Creator lost dispatch access at the start pass | Stop `creator_lost_access` |

## Out of Scope

- Running two features at once, or two features' `RUN`s on different runners.
- Stacked PRs: building a feature on another feature's unmerged branch.
- Rebasing, merging or updating a feature branch when the default branch moves; a conflict fails a job and stops
  the flow like any failure.
- Webhook-driven merge detection; the ticker polls.
- Restarting or cloning a stopped multi-feature flow.
- Multi-feature thread-entry flows: they stop at the second feature's start.
- Web flow page and CLI display of feature branches, `READY`/`MERGED` states or the new stop reasons (F6).
- Runner changes; the existing flow `PLAN` checkout and `expectBranch` check are used as they are.
- A per-feature cost cap; the flow cap covers every feature.
- Recovering a crash between two spec commits of one set `SPEC_REVIEW` calls pass; the next pass sees a stale head
  and re-asks the flow (no feature is `READY` yet).
- US-007 only: a `SPEC_REVIEW` finding whose `feature` names no flow feature is not reported; it goes to the first
  feature's spec.

## Stories

### US-001: Feature-scoped flow jobs

No dependencies. Workdir: `apps/api`.

Migration `20261203090000_fleet_flow_features`: `FleetJob.flowFeatureId String?` with
`@@index([flowId, flowFeatureId, queuedAt])`, backfilled from the position-0 feature of each job's flow;
`FleetFlowFeature.branch String?`. `FleetJobsService.dispatch` writes `opts.flowFeatureId`; `adoptForFlow` takes the
feature id. The step repository's job reads take a `featureId` and filter on `flowFeatureId`. The advance service
passes `flow.features[0].id` everywhere (single-feature behaviour unchanged).

### US-002: Flow input order and branch rules

No dependencies. Workdir: `apps/api`.

`parseFlowInput` rejects a `dependsOn` that names a feature at the same or a later position, and a later
feature whose `feat/<feature>` equals the flow branch.

### US-003: Next-feature rule

No dependencies. Workdir: `apps/api`.

Pure `nextFlowFeature` in `flow-features.ts`, rules 1-5 of the Approach.

### US-004: Forge branch creation and repo default branch

No dependencies. Workdir: `apps/api`.

`GitHubAppClient.createBranch(token, owner, name, branch, sha)` and `FleetReposService.findReviewRepo` returning
`defaultBranch`.

### US-005: Step decision for later features

Depends on US-001. Workdir: `apps/api`.

`decideFlowStep` takes `firstFeature` instead of `featureCount`; the advance service's `decisionInput` passes
`firstFeature: true` (it still reads `flow.features[0]` until US-008). The new stop reasons `pr_closed` and
`spec_changed` join `FlowStopReason`.

### US-006: Set spec review task and per-feature findings

No dependencies. Workdir: `apps/api`.

`parseFlowVerdict` keeps a finding's `feature`; `buildReviewTask` builds the set task from `setSpecPaths`;
`buildStepDispatch` passes the set paths for a multi-feature `SPEC_REVIEW` and plans from the feature branch.

### US-007: Calls written to a target spec and branch

Depends on US-001, US-006. Workdir: `apps/api`.

`FleetFlowCallsService.apply` and `applyPrdEdits` take a `target`; the advance service's `apply_calls` pass commits
a set `SPEC_REVIEW`'s calls spec by spec and records them; `recordCalls` moves `flow.specSha` only when given a sha.

### US-008: Advance runs the active feature

Depends on US-003, US-005, US-007. Workdir: `apps/api`.

`FleetFlowAdvanceService` selects the active feature with `nextFlowFeature` and feeds it to the decision, the
dispatch, the calls, rulings and PRD-edit passes, the stop payload and the waiting payload; the step decision's
`complete` marks the feature `READY` and applies the next-feature rule.

### US-009: Start pass for a later feature

Depends on US-004, US-008. Workdir: `apps/api`.

The `start` action: base sha, spec blob check, branch creation, feature branch recorded, `flow.feature_started`.

### US-010: Merge watch and the ticker

Depends on US-004, US-008. Workdir: `apps/api`.

`listAdvanceable` selects `WAITING_MERGE` flows and multi-feature flows; the `WAITING_MERGE` pass polls the awaited
PRs; `reaskLocked` stops once a feature is `READY` or `MERGED`.

### US-011: Two-feature flows against the database

Depends on US-002, US-009, US-010. Workdir: `apps/api`.

An integration spec driving `FleetFlowTicker.tick` for two nax-entry flows with the forge stubbed: an independent
second feature that starts at the first's ready PR, and a dependent second feature that waits for the first's
merge.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/test/integration/fleet/fleet-flow-prd-edits-migration.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/flows/flow-input.ts`
- `apps/api/src/fleet/flows/flow-input.spec.ts`

**US-003**
- `apps/api/src/fleet/flows/flow-states.ts`

**US-004**
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts`
- `apps/api/src/fleet/repos/fleet-repos.service.ts`

**US-005**
- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-006**
- `apps/api/src/fleet/flows/flow-verdict.ts`
- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.ts`
- `apps/api/src/fleet/common/agent-jobs.ts`

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts`
- `apps/api/src/fleet/flows/flow-calls.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts`

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`
- `apps/api/src/fleet/flows/flow-features.ts` — created by US-003, consumed here
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/flow-features.ts` — created by US-003, consumed here
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/flows/fleet-flows.service.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts`
- `apps/api/test/helpers/fleet-fixtures.ts`

### Creates

**US-001**
- `apps/api/prisma/migrations/20261203090000_fleet_flow_features/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-features-migration.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/flows/flow-features.ts`
- `apps/api/src/fleet/flows/flow-features.spec.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance-features.spec.ts`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-merge-watch.spec.ts`

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-features.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.spec.ts` — calls `latestJobWithIngest('flow-1')` with one argument; the method now takes `(flowId, featureId)` and its query filters on `flowFeatureId`, so the calls gain a feature id and the asserted query gains the filter.
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — `latestJobForStep(flow.id, 'PLAN')` and the count reads use the old positional signature; they gain the feature id, and seeded jobs carry `flowFeatureId`.
- `apps/api/test/integration/fleet/fleet-job-flow-fields.integration.spec.ts` — `adoptForFlow(jobId, flowId, step)` gains the feature id argument, and the adopted row is asserted to carry `flowFeatureId`.
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — the `adoptForFlow` double is asserted with `(jobId, flowId, step)`; it now receives `(jobId, flowId, featureId, step)`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — the `jobs.dispatch` options object is matched with `expect.any(Object)` or exact `{ flowId, flowStep, auditKey }`; exact matches gain `flowFeatureId`.

**US-005**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — the input fixture sets `featureCount: 1` and one test asserts `skip` for `featureCount: 2`; the fixture now sets `firstFeature: true`, and the skip test is replaced by the later-feature `PLAN` test.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — two assertions match the decision input with `featureCount: 1` (the `toMatchObject` on `decisions.inputs.at(-1)` and the full input object); `FlowStepInput` no longer has `featureCount`, so both match `firstFeature: true` instead.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decisionInput` builds `featureCount: flow.features.length`; it now builds `firstFeature: true`.

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — `apply(flow, action, expectedHead)` and `applyPrdEdits(flow, action, expectedHead)` are called with three arguments and read the spec of `flow.features[0]` on `flow.branch`; every call gains a `target`, and the forge doubles are asserted against the target's path and branch.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — `recordCalls` is asserted with a sha for every calls pass; a later feature's `PRD_REVIEW` calls now record `null`.
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts` — the `applyPrdEdits` double is asserted with three arguments; it now receives the target as a fourth.

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — the test that a two-feature flow writes nothing (the `featureCount !== 1` early return) is replaced: a two-feature flow now advances its first feature.
- `apps/api/src/fleet/flows/fleet-flow-advance-answers.spec.ts` — the `complete` outcome is asserted to call `steps.complete`; for a single-feature flow it still does, after `markFeatureState(READY)`.
- `apps/api/src/fleet/flows/fleet-flow-advance-rulings.spec.ts` — `recordRulings` is asserted with `features[0].id`; it now receives the active feature's id, which is the same feature in these single-feature fixtures, so only fixtures that build flows without a `position` gain `position: 0`.

**US-010**
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — a test asserts that `listAdvanceable` omits a two-feature flow; the rule changes so a two-feature flow is listed, and `WAITING_MERGE` flows are listed too.
- `apps/api/src/fleet/flows/fleet-flow.ticker.spec.ts` — none of its assertions depend on the listed states; listed here because its repository double is typed against `IFleetFlowStepRepository`, whose method signatures change.

### Seams

- `nextFlowFeature` (US-003) is consumed by `FleetFlowAdvanceService` (US-008, US-009, US-010): seam ACs drive
  `advance` and assert the active feature, the start and the wait.
- `GitHubAppClient.createBranch` (US-004) is consumed by the start pass (US-009): a seam AC drives `advance` and
  asserts the call.
- `FleetFlowCallsService.apply`'s `target` (US-007) is consumed by the advance service (US-007, US-008).
- `FleetJobsService.dispatch`'s `flowFeatureId` (US-001) is consumed by `dispatchStep` (US-001, US-008).

## Acceptance Criteria

### US-001

1. [integration] After migration `20261203090000_fleet_flow_features`, a `FleetJob` row seeded before the migration
   with a `flowId` has `flowFeatureId` equal to the id of that flow's position-0 `FleetFlowFeature`.
2. [integration] After the migration, a `FleetJob` row with a null `flowId` has a null `flowFeatureId`.
3. [integration] After the migration, `FleetFlowFeature.branch` is null on every existing row.
4. [integration] `FleetJobsService.dispatch` called with `{ flowId: 'f1', flowStep: 'PLAN', flowFeatureId: 'ff2' }`
   inserts a job with `flowFeatureId` `'ff2'`.
5. [integration] `FleetJobsService.dispatch` called without `flowId` and with `flowFeatureId: 'ff2'` inserts a job
   with a null `flowFeatureId`.
6. [integration] `adoptForFlow(jobId, 'f1', 'ff2', 'REVIEW')` on a job with a null `flowId` returns `true` and the
   row has `flowId` `'f1'`, `flowStep` `'REVIEW'` and `flowFeatureId` `'ff2'`.
7. [integration] `adoptForFlow(jobId, 'f1', 'ff2', 'REVIEW')` on a job that already has a `flowId` returns `false`
   and leaves its `flowFeatureId` unchanged.
8. [integration] With jobs for features `ff1` and `ff2` of one flow, `latestJobWithIngest(flowId, 'ff1')` returns
   the newest `ff1` job even when an `ff2` job is newer.
9. [integration] `latestJobForStep(flowId, 'ff2', 'PLAN')` returns the newest `PLAN` job of `ff2` and ignores a
   newer `PLAN` job of `ff1`.
10. [integration] `countJobsForStepSince(flowId, 'ff2', 'PLAN', since)` counts only `ff2`'s `PLAN` jobs queued at
    or after `since`.
11. [unit] For a single-feature flow, `FleetFlowAdvanceService.advance` dispatches `SPEC_REVIEW` through
    `jobs.dispatch` with options containing `flowFeatureId` equal to the flow's only feature id.
12. [unit] For a single-feature flow, `advance` reads its latest job with `steps.latestJobWithIngest(flowId,
    <that feature id>)`.

### US-002

1. [unit] `parseFlowInput(body, 'NAX')` with features `[a, b]` where `a.dependsOn` is `['b']` throws
   `ValidationAppException` with reason `features.0.dependsOn`.
2. [unit] `parseFlowInput(body, 'NAX')` with features `[a, b]` where `b.dependsOn` is `['a']` returns
   `b.dependsOn` `['a']`.
3. [unit] `parseFlowInput(body, 'NAX')` with branch `feat/b` and features `[a, b]` throws `ValidationAppException`
   with reason `features.1.feature`.
4. [unit] `parseFlowInput(body, 'NAX')` with branch `feat/a` and features `[a, b]` accepts the input (the first feature may
   use its own `feat/<feature>` as the flow branch).

### US-003

1. [unit] `nextFlowFeature` with features at positions 0 and 1, both `PENDING`, returns `{ kind: 'active',
   featureId: <position 0 id> }`.
2. [unit] `nextFlowFeature` returns `active` for the position-1 feature when it is `RUNNING` and position 0 is
   `READY`.
3. [unit] `nextFlowFeature` returns `active` for a `WAITING_ANSWER` feature.
4. [unit] `nextFlowFeature` with position 0 `READY` and position 1 `PENDING` with empty `dependsOn` returns
   `{ kind: 'start', featureId: <position 1 id>, base: 'spec' }`.
5. [unit] `nextFlowFeature` with position 0 `MERGED` and position 1 `PENDING` with `dependsOn` naming position 0
   returns `{ kind: 'start', featureId: <position 1 id>, base: 'default' }`.
6. [unit] `nextFlowFeature` with position 0 `READY` and position 1 `PENDING` with `dependsOn` naming position 0
   returns `{ kind: 'wait_merge', featureIds: [<position 0 id>] }`.
7. [unit] `nextFlowFeature` with three features where position 2 depends on positions 0 and 1, position 0 `MERGED`
   and position 1 `READY`, returns `wait_merge` with only position 1's id.
8. [unit] `nextFlowFeature` with every feature `READY` or `MERGED` returns `{ kind: 'complete' }`.
9. [unit] `nextFlowFeature` reads features by `position`, not by array order: given `[position 1, position 0]`,
   both `PENDING`, it returns position 0 as `active`.

### US-004

1. [unit] `GitHubAppClient.createBranch(token, 'o', 'r', 'feat/b', 'sha1')` sends `POST /repos/o/r/git/refs` with
   body `{ ref: 'refs/heads/feat/b', sha: 'sha1' }` and returns `{ kind: 'created' }` on HTTP 201.
2. [unit] On HTTP 422, `createBranch` reads `getBranchHead` for `feat/b` and returns `{ kind: 'exists', sha:
   <head> }`.
3. [unit] On HTTP 403, `createBranch` throws `RepoCheckException` with `app_permissions_insufficient`.
4. [unit] On HTTP 404, `createBranch` throws `RepoCheckException` with `repo_not_found`.
5. [unit] On HTTP 500, `createBranch` throws `RepoCheckException` with `provider_error`.
6. [unit] `FleetReposService.findReviewRepo(id)` returns the repo's `defaultBranch` with `owner`, `name` and
   `githubInstallationId`.

### US-005

1. [unit] `decideFlowStep` with `firstFeature: false`, state `RUNNING` and no latest job returns `{ kind:
   'dispatch', step: 'PLAN' }`.
2. [unit] `decideFlowStep` with `firstFeature: true`, state `RUNNING` and no latest job returns `{ kind:
   'dispatch', step: 'SPEC_REVIEW' }`.
3. [unit] `decideFlowStep` with `firstFeature: true`, state `APPROVED` and no latest job returns `{ kind:
   'dispatch', step: 'SPEC_REVIEW' }`.
4. [unit] `decideFlowStep` with `firstFeature: false`, state `RUNNING` and a completed `PLAN` job with a result
   branch and sha returns `{ kind: 'dispatch', step: 'PRD_REVIEW' }`.
5. [unit] `decideFlowStep` with `firstFeature: false` and a `FIX` job whose `fixReady.markedReady` is `true` returns
   `{ kind: 'complete' }`.
6. [unit] A `FlowStopReason` value `'pr_closed'` and a value `'spec_changed'` are accepted where a stop action's
   `reason` is typed `FlowStopReason` (a stop action built with each compiles and is returned unchanged by a
   function typed to return `FlowStepAction`).

### US-006

1. [unit] `parseFlowVerdict` on `{"findings":[{"class":"minor","summary":"s","fix":"f","feature":"b"}]}` returns
   the finding with `feature: 'b'`.
2. [unit] `parseFlowVerdict` drops a non-string `feature` from a finding and keeps the finding.
3. [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a', { setSpecPaths: [
   '.nax/features/a/spec.md', '.nax/features/b/spec.md'] })` returns a task that starts with
   `/spec-review .nax/features/a/spec.md` and names `.nax/features/b/spec.md`.
4. [unit] That set task asks for cross-spec consistency and tells the reviewer to put `"feature":"<feature>"` on
   each finding, naming the features `a` and `b`.
5. [unit] `buildReviewTask('SPEC_REVIEW', path, 'a')` without `setSpecPaths` returns the same task as before this
   feature (no set wording).
6. [unit] The set task is cut to `AGENT_TASK_MAX_LENGTH` with the verdict instruction kept whole, as the
   single-spec task is.
7. [unit] `buildStepDispatch` for `SPEC_REVIEW` of a flow given two features passes both spec paths in position
   order as `setSpecPaths`.
8. [unit] `buildStepDispatch` for `PLAN` with `feature.branch` `'feat/b'` returns ref `'feat/b'`.
9. [unit] `buildStepDispatch` for `PLAN` with `feature.branch` null returns ref `flow.branch`.

### US-007

1. [unit] `FleetFlowCallsService.apply(flow, action, head, { feature: 'b', specPath: '.nax/features/b/spec.md',
   branch: 'feat/b' })` reads `getBranchHead` of `feat/b` and `getFile` of `.nax/features/b/spec.md`.
2. [unit] That `apply` call commits with `putFile` on branch `feat/b` at path `.nax/features/b/spec.md`.
3. [unit] `applyPrdEdits(flow, action, head, { feature: 'b', specPath, branch: 'feat/b' })` reads and writes
   `.nax/features/b/prd.json` on `feat/b`.
4. [unit] For a two-feature flow whose `SPEC_REVIEW` verdict has findings with `feature` `a` and `b`, the advance
   `apply_calls` pass calls `calls.apply` twice, first for `a` with `expectedHead` `flow.specSha`, then for `b` with
   `expectedHead` the commit sha of the first call.
5. [unit] Both calls in that pass target the flow branch, and each receives only the findings of its own feature.
6. [unit] A `SPEC_REVIEW` finding with no `feature`, or with a name no flow feature has, is committed into the first
   feature's spec.
7. [unit] After that pass, `recordCalls` is called for `a` and for `b`, the last call with the second commit's sha,
   and the first feature's `callsJobId` is the `SPEC_REVIEW` job id.
8. [unit] When the first `apply` of a set pass returns `failed`, the flow stops `calls_failed` and the second
   feature's `apply` is not called.
9. [unit] When the second `apply` returns `retry`, nothing is recorded and the next pass starts from the first
   feature again (its block is already applied).
10. [unit] For a later feature's `PRD_REVIEW` calls, `calls.apply` receives that feature's branch, and
    `recordCalls` is called with `specSha` null.
11. [integration] `recordCalls(flowId, featureId, jobId, null)` sets the feature's `callsJobId` and leaves
    `flow.specSha` unchanged.

### US-008

1. [unit] For a two-feature flow, both `PENDING`, `advance` dispatches `SPEC_REVIEW` for the position-0 feature
   (the former early return for `featureCount !== 1` is gone).
2. [unit] For a two-feature flow with position 0 `READY` and position 1 `RUNNING` with branch `feat/b` and no jobs,
   `advance` dispatches `PLAN` with ref `feat/b`, feature `b` and options carrying position 1's `flowFeatureId`.
3. [unit] The decision input for the position-1 feature carries `firstFeature: false` and that feature's
   `callsJobId`, `prNumber`, `questionsJobId` and `answers`.
4. [unit] When the active position-1 feature's latest `FIX` job is marked ready, `advance` calls
   `markFeatureState(<position 1 id>, 'READY')` and records activity `flow.feature_ready`.
5. [unit] When the step decision completes the position-0 feature and position 1 is independent, the flow stays
   `RUNNING` and `steps.complete` is not called.
6. [unit] When the step decision completes the position-0 feature and position 1 depends on it, `setFlowState(
   flowId, 'WAITING_MERGE')` is called and activity `flow.waiting_merge` is recorded with the awaited feature ids.
7. [unit] When the step decision completes the last feature, `steps.complete` is called and activity
   `flow.completed` is recorded.
8. [unit] For a single-feature flow, a ready `FIX` still ends the flow `COMPLETED` through `steps.complete`.
9. [integration] `steps.complete(flowId, now)` sets a `MERGED` feature's state unchanged and a `READY` feature's
   state to `COMPLETED`.
10. [unit] A stop of a two-feature flow while position 1 is active records the `fleet_flow_stopped` outbox event
    with `feature` `b`.
11. [unit] A `wait_answer` while position 1 is active stores the questions on position 1's feature row
    (`setWaiting(flowId, <position 1 id>, ...)`) and the `fleet_flow_questions` event carries `feature` `b`.
12. [unit] The `RULE` pass for the active position-1 feature reads `latestJobForStep(flowId, <position 1 id>,
    'RUN')` and records rulings on position 1's row.
13. [unit] A later feature's `PRD_REVIEW` whose latest `PLAN` result branch is not the feature branch stops the
    flow `dispatch_refused` with detail `PLAN pushed <x>, expected feat/b`, and `setBranch` is not called.

### US-009

1. [unit] For a `start` with `base: 'spec'`, the start pass calls `createBranch` for `feat/b` at `flow.specSha`.
2. [unit] For a `start` with `base: 'default'`, the start pass reads `getBranchHead` of the repo's `defaultBranch`
   and calls `createBranch` for `feat/b` at that sha.
3. [unit] The start pass reads `getFile(specPath)` at the base sha and at `flow.specSha`; when the blob shas are
   equal it creates the branch.
4. [unit] When those blob shas differ, the flow stops `spec_changed` with detail
   `.nax/features/b/spec.md differs from the approved spec` and `createBranch` is not called.
5. [unit] When the spec file is missing at the base, the flow stops `spec_changed`.
6. [unit] After `createBranch` returns `created`, under the locks the pass calls `setFeatureBranch(<id>, 'feat/b')`,
   `markFeatureState(<id>, 'RUNNING')` and records activity `flow.feature_started` with `feature`, `base`, `sha` and
   `branch`.
7. [unit] `createBranch` returning `exists` with the base sha is treated as created.
8. [unit] `createBranch` returning `exists` with another sha stops the flow `dispatch_refused` with detail
   `branch feat/b already exists`.
9. [unit] A thread-entry flow reaching a `start` stops `dispatch_refused` with detail `thread entry runs one
   feature` and makes no forge call.
10. [unit] A `RepoCheckException` from any start-pass forge call ends the pass with no write and no stop.
11. [unit] A creator without dispatch access at the start pass stops the flow `creator_lost_access` before any
    forge call.
12. [unit] When the flow is stopped between the forge calls and the record transaction, the record writes nothing
    (`lockLive` returns null).
13. [unit] The pass after a start dispatches that feature's `PLAN` (seam: `advance` twice, first `createBranch`,
    then `jobs.dispatch` with command `PLAN` and ref `feat/b`).

### US-010

1. [integration] `listAdvanceable` returns a `WAITING_MERGE` flow.
2. [integration] `listAdvanceable` returns a `RUNNING` flow with two features.
3. [integration] `listAdvanceable` does not return `PENDING`, `WAITING_ANSWER`, `COMPLETED` or `STOPPED` flows.
4. [unit] For a `WAITING_MERGE` flow awaiting position 0 with `prNumber` 31, `advance` mints a read-only token and
   calls `getPullRequest(token, owner, name, 31)`.
5. [unit] When that PR is `merged: true`, the pass calls `markFeatureState(<position 0 id>, 'MERGED')`, moves the
   flow to `RUNNING` with `setFlowState`, and records activity `flow.resumed`.
6. [unit] When the PR is open, the pass writes nothing and the flow stays `WAITING_MERGE`.
7. [unit] When the PR has `state: 'closed'` and `merged: false`, the flow stops `pr_closed` with detail `PR #31
   closed without merge`.
8. [unit] When `getPullRequest` returns null, the flow stops `pr_closed` with detail `PR #31 not found`.
9. [unit] When `getPullRequest` throws `RepoCheckException`, the pass ends with no write.
10. [unit] With two awaited features, one merged and one open, the pass marks the merged one `MERGED` and the flow
    stays `WAITING_MERGE`.
11. [unit] A `WAITING_MERGE` pass dispatches no job (`jobs.dispatch` is not called), even when every awaited PR is
    merged; the next pass runs the start.
12. [unit] `FleetFlowsService.reaskLocked` on a flow with a `READY` feature stops the flow `spec_changed` and does
    not open a new approval request.
13. [unit] `reaskLocked` on a flow with no `READY` or `MERGED` feature opens a new request and returns the flow to
    `PENDING`, as before.

### US-011

1. [integration] A nax-entry flow with features `a` and independent `b`, driven by `FleetFlowTicker.tick` with the
   forge stubbed and each job completed by the test, dispatches `SPEC_REVIEW`, `PLAN`, `PRD_REVIEW`, `RUN`,
   `REVIEW` and `FIX` for `a`, each job carrying `a`'s `flowFeatureId`.
2. [integration] After `a`'s ready `FIX`, feature `a` is `READY`, the next tick creates `feat/b` at `flow.specSha`,
   and the following tick dispatches `PLAN` for `b` with ref `feat/b` and `b`'s `flowFeatureId`.
3. [integration] After `b`'s ready `FIX`, the flow is `COMPLETED` and both features are `COMPLETED`.
4. [integration] A second flow with `b` depending on `a` moves to `WAITING_MERGE` after `a`'s ready `FIX`, and a
   tick with `a`'s PR still open leaves it `WAITING_MERGE`.
5. [integration] A tick after the stubbed PR reports `merged: true` marks `a` `MERGED` and the flow `RUNNING`; the
   next tick creates `feat/b` at the stubbed default-branch head.
6. [integration] In that second flow, a tick where the stubbed PR reports closed without merge stops the flow
   `pr_closed`.
7. [integration] Every forge call in both flows runs outside a database transaction.
