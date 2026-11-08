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
  its blob sha at `flow.specSha`; otherwise the flow stops `spec_changed`. A later feature is never re-asked: a
  `stale` calls or PRD-edits outcome while a later feature is active stops the flow `spec_changed` in the advance
  service instead of calling `reaskLocked` (the design's non-goal: a stopped flow is cloned, not restarted).
  `reaskLocked` itself is unchanged: its other callers (the first feature's preflight and the thread re-publish
  listener) only ever see a flow whose first feature is active.
- **The spec preflight belongs to the first feature.** `readSpecHead` and the `SPEC_REVIEW`/`PLAN` spec-sha check in
  `decide` compare the flow branch head with `flow.specSha`; once feature 1 has run, that branch carries its PLAN,
  RUN and FIX commits. Both run only while the active feature is the first; a later feature's spec was checked by
  its start pass.
- **Forge errors are classified as the calls already are** (`callsOutcomeForForgeError`): a `RepoCheckException`
  with reason `app_not_installed`, `app_permissions_insufficient` or `repo_not_found` stops the flow
  `dispatch_refused` with the reason as detail; any other reason ends the pass and the next tick retries.
- **`flow.specSha` stays the set's sha on the flow branch.** `PRD_REVIEW` calls and PRD edits of a later feature are
  committed on that feature's branch and do not move `flow.specSha`.
- **New feature states** `READY` (ready PR) and `MERGED`. A flow completes when no feature is `PENDING` and none is
  active; completion sets every non-`MERGED` feature to `COMPLETED` (a single-feature flow ends `COMPLETED`, as
  today).
- **`dependsOn` already names only earlier features**: `parseFlowInput` rejects a dependency it has not seen yet,
  so positions are the run order. New: for the nax entry, no feature after the first may have `feat/<feature>` equal
  to the flow branch (a create-time 400); the branch check runs where `branch` is validated, after the features.
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
  - Target: `PLAN` uses `input.feature.branch ?? flow.branch` as its ref; `SPEC_REVIEW` forwards
    `input.setSpecPaths` to `buildReviewTask`; the advance service sets `setSpecPaths` to every feature's spec path in
    position order when the flow has two or more features.
- `FleetFlowAdvanceService` (`fleet-flow-advance.service.ts`)
  - Baseline: `decide` returns early with `if (current.features.length !== 1) return;` (line 382); `lockLive` and
    `decide` accept only `APPROVED` and `RUNNING`; every step reads `flow.features[0]`.
  - Target: no early return; every `flow.features[0]` read becomes the active feature chosen by
    `nextFlowFeature`; a `start` pass and a merge-watch pass for `WAITING_MERGE` flows, whose record transaction
    re-reads the flow under the parent and flow locks and writes only while it is still `WAITING_MERGE` with the
    same `approvedAt`. The two new passes live in a new file `fleet-flow-feature-passes.ts` as functions that take
    the advance service's collaborators as arguments, so the service stays under 800 lines and its constructor does
    not change.
- `FleetFlowFeatureRecord` (`domain/fleet-flow.domain.ts`): gains `branch?: string | null` (the mapper in
  `prisma-fleet-flow.repository.ts` spreads the row, so the column reaches the record).
- `FleetReposService.findReviewRepo(id)`
  - Baseline: returns `Pick<FleetRepoRecord, 'id' | 'projectId' | 'owner' | 'name' | 'githubInstallationId'>`.
  - Target: the pick also includes `defaultBranch`.
- `BuildStepDispatchInput` (`flow-step-dispatch.ts`)
  - Baseline: `feature: { feature: string; specPath: string }`, no set paths.
  - Target: `feature: { feature: string; specPath: string; branch?: string | null }` and a top-level
    `setSpecPaths?: string[]`.
- `parseFlowInput(body, entry)` (`flow-input.ts`): one new validation failure for the nax entry, raised through its `fail(property)` helper (`ValidationAppException` with `reason` = the property path). A `dependsOn` naming the feature itself or a later feature is already rejected (`featureNames` holds only the features seen so far).
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
| `getPullRequest` or a start-pass forge call throws `RepoCheckException` with a transient reason | Pass ends; nothing written; next tick retries |
| Awaited PR closed without merge, or not found | Stop `pr_closed` |
| Spec blob at the base differs from `flow.specSha`, or the file is missing at either | Stop `spec_changed` |
| `createBranch` finds the branch already present at the base sha | Treated as created |
| `createBranch` finds the branch present at another sha | Stop `dispatch_refused`, detail `branch feat/<feature> already exists` |
| Thread-entry flow reaches a later feature's start | Stop `dispatch_refused`, detail `thread entry runs one feature` |
| A later feature's `PLAN` result branch differs from its feature branch | Stop `dispatch_refused`, detail `PLAN pushed <x>, expected <y>` |
| `stale` calls or PRD-edits head while a later feature is active | Stop `spec_changed` instead of re-ask |
| Creator lost dispatch access at the start pass | Stop `creator_lost_access` |
| Permanent forge reason (`app_not_installed`, `app_permissions_insufficient`, `repo_not_found`) in the start pass or merge watch | Stop `dispatch_refused`, detail = the reason |
| Repo has no GitHub installation (not connected) at the start pass or merge watch | Stop `dispatch_refused`, detail `repo not connected` |
| An awaited `READY` feature has no `prNumber` | Stop `dispatch_refused`, detail `feature <feature> has no PR` |

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
- Recovering a set `SPEC_REVIEW` calls pass in which two or more spec commits landed and nothing was recorded; the
  next pass sees a stale head and re-asks the flow (no feature is `READY` yet). A pass where only the first commit
  landed recovers through the existing already-applied check.
- US-009 only: a `SPEC_REVIEW` finding whose `feature` names no flow feature is not reported; it goes to the first
  feature's spec.

## Stories

### US-001: Feature-scoped flow jobs

No dependencies. Workdir: `apps/api`.

Migration `20261203090000_fleet_flow_features`: `FleetJob.flowFeatureId String?` with
`@@index([flowId, flowFeatureId, queuedAt])`, backfilled from the position-0 feature of each job's flow;
`FleetFlowFeature.branch String?`. `FleetJobsService.dispatch` writes `opts.flowFeatureId`; `adoptForFlow` takes the
feature id (service, repository and `FleetJobRecord`/domain interface). The step repository's job reads take a
`featureId` as their second argument and filter on `flowFeatureId`. The advance service passes `flow.features[0].id`
everywhere (single-feature behaviour unchanged).

### US-002: Feature branch and state persistence

Depends on US-001. Workdir: `apps/api`.

`FleetFlowFeatureRecord.branch`; step repository `setFeatureBranch`, `markFeatureState`, `setFlowState`;
`complete` leaves `MERGED` features `MERGED`; `recordCalls` with a null sha leaves `flow.specSha`.

### US-003: Flow branch rule for later features

No dependencies. Workdir: `apps/api`.

`parseFlowInput` (nax entry) rejects a later feature whose `feat/<feature>` equals the flow branch.

### US-004: Next-feature rule

No dependencies. Workdir: `apps/api`.

Pure `nextFlowFeature` in `flow-features.ts`, rules 1-5 of the Approach.

### US-005: Forge branch creation and repo default branch

No dependencies. Workdir: `apps/api`.

`GitHubAppClient.createBranch(token, owner, name, branch, sha)` and `FleetReposService.findReviewRepo` returning
`defaultBranch`.

### US-006: Step decision for later features

Depends on US-001. Workdir: `apps/api`.

`decideFlowStep` takes `firstFeature` instead of `featureCount`; the advance service's `decisionInput` passes
`firstFeature: true` (it still reads `flow.features[0]` until US-008). The new stop reasons `pr_closed` and
`spec_changed` join `FlowStopReason`.

### US-007: Set review task, per-feature findings, dispatch input and calls target

No dependencies. Workdir: `apps/api`.

`parseFlowVerdict` keeps a finding's `feature`; `buildReviewTask` builds the set task from `setSpecPaths`;
`buildStepDispatch` forwards `setSpecPaths` and plans from `feature.branch`; `FleetFlowCallsService.apply` and
`applyPrdEdits` take a `target`. The advance service passes `{ feature, specPath, branch: flow.branch }` of
`flow.features[0]` as the target until US-008.

### US-008: Advance runs the active feature

Depends on US-002, US-004, US-006, US-007. Workdir: `apps/api`.

`decide`'s single-feature early return is removed and `listAdvanceable` lists flows of any feature count.
`FleetFlowAdvanceService` selects the active feature with `nextFlowFeature` and feeds it to the decision, the
dispatch, the calls, rulings and PRD-edit passes, the stop payload and the waiting payload; the spec preflight runs
only for the first feature; the step decision's `complete` marks the feature `READY` and applies the next-feature
rule; a later feature's `stale` calls outcome stops `spec_changed`.

### US-009: Set SPEC_REVIEW calls pass

Depends on US-008. Workdir: `apps/api`.

The `apply_calls` pass for a multi-feature `SPEC_REVIEW` commits the findings spec by spec and records them.

### US-010: Start pass for a later feature

Depends on US-005, US-008. Workdir: `apps/api`.

The `start` action in `fleet-flow-feature-passes.ts`: base sha, spec blob check, branch creation, feature branch
recorded, `flow.feature_started`.

### US-011: Merge watch

Depends on US-005, US-008. Workdir: `apps/api`.

`listAdvanceable` also lists `WAITING_MERGE` flows; the merge-watch pass in `fleet-flow-feature-passes.ts` polls the
awaited PRs and records merges, resumes and `pr_closed` stops under its own locked re-read.

### US-012: Two-feature flows against the database

Depends on US-003, US-009, US-010, US-011. Workdir: `apps/api`.

An integration spec driving `FleetFlowTicker.tick` for two nax-entry flows with the forge stubbed: an independent
second feature that starts at the first's ready PR, and a dependent second feature that waits for the first's
merge.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`

**US-002**
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/flows/flow-input.ts`
- `apps/api/src/fleet/flows/flow-input.spec.ts`

**US-004**
- `apps/api/src/fleet/flows/flow-states.ts`

**US-005**
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts`
- `apps/api/src/fleet/repos/fleet-repos.service.ts`

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-007**
- `apps/api/src/fleet/flows/flow-verdict.ts`
- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/common/agent-jobs.ts`

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`
- `apps/api/src/fleet/flows/flow-features.ts` — created by US-004, consumed here
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/flows/flow-calls.ts`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/flow-features.ts` — created by US-004, consumed here
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/flows/flow-calls.ts`

**US-011**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts` — created by US-010, extended here with merge watch
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-012**
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts`
- `apps/api/test/helpers/fleet-fixtures.ts`

### Creates

**US-001**
- `apps/api/prisma/migrations/20261203090000_fleet_flow_features/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-features-migration.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/flows/flow-features.ts`
- `apps/api/src/fleet/flows/flow-features.spec.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance-set-calls.spec.ts`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts`
- `apps/api/src/fleet/flows/fleet-flow-feature-start.spec.ts`

**US-011**
- `apps/api/src/fleet/flows/fleet-flow-merge-watch.spec.ts`

**US-012**
- `apps/api/test/integration/fleet/fleet-flow-features.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.spec.ts` — calls `latestJobWithIngest('flow-1')` with one argument (lines 49, 57, 71, 75); the method now takes `(flowId, featureId)` and filters on `flowFeatureId`, so the calls gain a feature id and the asserted query gains the filter.
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — `latestJobForStep(flow.id, 'PLAN')` (line 89) uses the old positional signature; it becomes `latestJobForStep(flow.id, <feature id>, 'PLAN')`, and the seeded jobs carry `flowFeatureId`.
- `apps/api/test/integration/fleet/fleet-flow-verdicts-migration.integration.spec.ts` — `countJobsForStepSince(flow.id, 'PLAN', since)` (lines 134, 139) becomes `countJobsForStepSince(flow.id, <feature id>, 'PLAN', since)`, and the seeded jobs carry `flowFeatureId`.
- `apps/api/test/integration/fleet/fleet-job-flow-fields.integration.spec.ts` — `adoptForFlow(jobId, flowId, step)` (lines 96, 104) gains the feature id argument, and the adopted row is asserted to carry `flowFeatureId`.
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — `adoptForFlow` is asserted with `('j9', 'flow-1', 'REVIEW')` (line 199) and the dispatch options with exactly `{ flowId, flowStep: 'REVIEW', auditKey }` (line 164); they become `('j9', 'flow-1', <feature id>, 'REVIEW')` and options that also carry `flowFeatureId`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — `latestJobWithIngest` is asserted with `('flow-1')` (lines 530, 621); `countJobsForStepSince` doubles read `(_flowId, step)` (lines 1031, 1047, 1059) and assertions use `('flow-1', 'SPEC_REVIEW', APPROVED_AT)` (lines 1033, 1038); the dispatch options are asserted exactly as `{ flowId, flowStep, auditKey }` (lines 860, 904). The feature id becomes the second argument of each read and a `flowFeatureId` field of the options.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — `latestJobForStep` asserted with `('flow-1', 'PLAN')` (line 169), `countJobsForStepSince` with `('flow-1', 'PLAN', APPROVED_AT)` (line 274) and a `(_flowId, step)` double (line 247); each gains the feature id as the second argument.
- `apps/api/src/fleet/flows/fleet-flow-advance-answers.spec.ts` — the `latestJobForStep` double reads `(flowId, step)` (line 63) and assertions use `('flow-1', 'RUN')` (lines 116, 159); each gains the feature id as the second argument.
- `apps/api/src/fleet/flows/fleet-flow-advance-rulings.spec.ts` — the `latestJobForStep` double reads `(_flowId, step)` (line 129); after the change the second argument is the feature id, so the double reads `(_flowId, _featureId, step)`.
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts` — the `countJobsForStepSince` double reads `(_flowId, step)` (line 83); it becomes `(_flowId, _featureId, step)`.

**US-005**
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — "findReviewRepo exposes only the review projection" (line 35) asserts `toEqual({ id, projectId, owner, name, githubInstallationId })`; the projection now also carries `defaultBranch`, so the expected object gains it.
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — the `findReviewRepo` double is typed `vi.fn<FleetReposService['findReviewRepo']>` (line 70) and its `reviewRepo()` fixture has no `defaultBranch`; the fixture gains `defaultBranch: 'main'` so the double matches the widened return type.

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — the input fixture sets `featureCount: 1` (line 10) and a test asserts `skip` for `featureCount: 2` (line 22); the fixture now sets `firstFeature: true`, and the skip test is replaced by the later-feature `PLAN` test.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — two assertions match the decision input with `featureCount: 1` (lines 476, 523); `FlowStepInput` no longer has `featureCount`, so both match `firstFeature: true`.

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — `apply(flow, action, expectedHead)` and `applyPrdEdits(flow, action, expectedHead)` are called with three arguments and read the spec of `flow.features[0]` on `flow.branch`; every call gains a `target`, and the forge doubles are asserted against the target's path and branch.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — the `calls.apply` double is asserted with three arguments; it now receives the target `{ feature, specPath, branch }` as a fourth.
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts` — the `applyPrdEdits` double is asserted with three arguments; it now receives the target as a fourth.

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — "leaves multi-feature flows alone" (line 839) asserts that a two-feature flow writes nothing; a two-feature flow now advances its first feature, so the test asserts a `SPEC_REVIEW` dispatch for position 0.
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — "AC-6/7: multiple features remain approved and do not dispatch" (line 166) expects no job for a two-feature flow; it now expects one `SPEC_REVIEW` job for the first feature.
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — "AC-1/2/3 returns only APPROVED/RUNNING flows with exactly one feature" seeds a two-feature `APPROVED` flow and expects it omitted; it is now listed.

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — the same "AC-1/2/3" test seeds a `WAITING_MERGE` flow and expects it omitted; it is now listed.

### Seams

- `nextFlowFeature` (US-004) is consumed by `FleetFlowAdvanceService.advance` (US-008, US-010, US-011): seam ACs
  drive `advance` and assert the active feature, the start and the wait.
- `GitHubAppClient.createBranch` (US-005) is consumed by the start pass (US-010): a seam AC drives `advance` and
  asserts the call.
- `FleetFlowCallsService.apply`'s `target` (US-007) is consumed by the advance service (US-007, US-008, US-009).
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

1. [integration] A flow read through `IFleetFlowRepository.findById` returns each feature's `branch` (null until
   set).
2. [integration] `setFeatureBranch(featureId, 'feat/b')` persists `branch` `'feat/b'` on that feature only.
3. [integration] `markFeatureState(featureId, 'READY')` persists the feature's state `'READY'` and leaves the other
   features and the flow state unchanged.
4. [integration] `setFlowState(flowId, 'WAITING_MERGE')` persists the flow state and leaves the features unchanged.
5. [integration] `complete(flowId, now)` on a flow with one `MERGED` and one `READY` feature sets the flow
   `COMPLETED` with `endedAt` `now`, leaves the `MERGED` feature `MERGED` and sets the `READY` feature `COMPLETED`.
6. [integration] `recordCalls(flowId, featureId, jobId, null)` sets the feature's `callsJobId` and leaves
   `flow.specSha` unchanged.
7. [integration] `recordCalls(flowId, featureId, jobId, 'sha2')` sets the feature's `callsJobId` and `flow.specSha`
   `'sha2'`, as before.

### US-003

1. [unit] `parseFlowInput(body, 'NAX')` with branch `feat/b` and features `[a, b]` throws `ValidationAppException`
   with reason `features.1.feature`.
2. [unit] `parseFlowInput(body, 'NAX')` with branch `feat/a` and features `[a, b]` accepts the input (the first
   feature may use its own `feat/<feature>` as the flow branch).

### US-004

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

### US-005

1. [unit] `GitHubAppClient.createBranch(token, 'o', 'r', 'feat/b', 'sha1')` sends `POST /repos/o/r/git/refs` with
   body `{ ref: 'refs/heads/feat/b', sha: 'sha1' }` and returns `{ kind: 'created' }` on HTTP 201.
2. [unit] On HTTP 422, `createBranch` reads `getBranchHead` for `feat/b` and returns `{ kind: 'exists', sha:
   <head> }`.
3. [unit] On HTTP 403, `createBranch` throws `RepoCheckException` with `app_permissions_insufficient`.
4. [unit] On HTTP 404, `createBranch` throws `RepoCheckException` with `repo_not_found`.
5. [unit] On HTTP 500, `createBranch` throws `RepoCheckException` with `provider_error`.
6. [unit] `FleetReposService.findReviewRepo(id)` returns the repo's `defaultBranch` with `owner`, `name` and
   `githubInstallationId`.

### US-006

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
6. [unit] For a single-feature flow, `FleetFlowAdvanceService.advance` passes a decision input with `firstFeature`
   `true` and no `featureCount` field.

### US-007

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
7. [unit] `buildStepDispatch` for `SPEC_REVIEW` with input `setSpecPaths: ['.nax/features/a/spec.md',
   '.nax/features/b/spec.md']` returns an `agent.task` naming both paths.
8. [unit] `buildStepDispatch` for `PLAN` with `feature.branch` `'feat/b'` returns ref `'feat/b'`.
9. [unit] `buildStepDispatch` for `PLAN` with `feature.branch` null or absent returns ref `flow.branch`.
10. [unit] `FleetFlowCallsService.apply(flow, action, head, { feature: 'b', specPath: '.nax/features/b/spec.md',
    branch: 'feat/b' })` reads `getBranchHead` of `feat/b` and `getFile` of `.nax/features/b/spec.md`.
11. [unit] That `apply` call commits with `putFile` on branch `feat/b` at path `.nax/features/b/spec.md`.
12. [unit] `applyPrdEdits(flow, action, head, { feature: 'b', specPath, branch: 'feat/b' })` reads and writes
    `.nax/features/b/prd.json` on `feat/b`.

### US-008

1. [unit] For a two-feature flow, both `PENDING`, `advance` dispatches `SPEC_REVIEW` for the position-0 feature
   with `setSpecPaths` listing both spec paths in position order.
2. [unit] For a two-feature flow with position 0 `READY` and position 1 `RUNNING` with branch `feat/b` and no jobs,
   `advance` dispatches `PLAN` with ref `feat/b`, feature `b` and options carrying position 1's `flowFeatureId`.
3. [unit] In that case the flow branch head differs from `flow.specSha`, and `advance` neither reads
   `getBranchHead` of the flow branch nor calls `reaskLocked`.
4. [unit] The decision input for the position-1 feature carries `firstFeature: false` and that feature's
   `callsJobId`, `prNumber`, `questionsJobId` and `answers`.
5. [unit] When the active position-1 feature's latest `FIX` job is marked ready, `advance` calls
   `markFeatureState(<position 1 id>, 'READY')` and records activity `flow.feature_ready`.
6. [unit] When the step decision completes the position-0 feature and position 1 is independent, the flow stays
   `RUNNING` and `steps.complete` is not called.
7. [unit] When the step decision completes the position-0 feature and position 1 depends on it, `setFlowState(
   flowId, 'WAITING_MERGE')` is called and activity `flow.waiting_merge` is recorded with the awaited feature ids.
8. [unit] When the step decision completes the last feature, `steps.complete` is called and activity
   `flow.completed` is recorded.
9. [unit] For a single-feature flow, a ready `FIX` still ends the flow `COMPLETED` through `steps.complete`.
10. [unit] A stop of a two-feature flow while position 1 is active records the `fleet_flow_stopped` outbox event
    with `feature` `b`.
11. [unit] A `wait_answer` while position 1 is active stores the questions on position 1's feature row
    (`setWaiting(flowId, <position 1 id>, ...)`) and the `fleet_flow_questions` event carries `feature` `b`.
12. [unit] The `RULE` pass for the active position-1 feature reads `latestJobForStep(flowId, <position 1 id>,
    'RUN')` and records rulings on position 1's row.
13. [unit] A later feature's `PRD_REVIEW` whose latest `PLAN` result branch is not the feature branch stops the
    flow `dispatch_refused` with detail `PLAN pushed <x>, expected feat/b`, and `setBranch` is not called.
14. [unit] A `stale` outcome from `calls.apply` while position 1 is active stops the flow `spec_changed` and does
    not call `reaskLocked`.
15. [integration] `listAdvanceable` returns an `APPROVED` flow with two features.

### US-009

1. [unit] For a two-feature flow whose `SPEC_REVIEW` verdict has findings with `feature` `a` and `b`, the
   `apply_calls` pass calls `calls.apply` twice, first for `a` with `expectedHead` `flow.specSha`, then for `b` with
   `expectedHead` the commit sha of the first call.
2. [unit] Both calls in that pass target the flow branch, and each receives only the findings of its own feature.
3. [unit] A `SPEC_REVIEW` finding with no `feature`, or with a name no flow feature has, is committed into the first
   feature's spec.
4. [unit] After that pass, `recordCalls` is called for `a` and for `b`, the last call with the second commit's sha,
   and the first feature's `callsJobId` is the `SPEC_REVIEW` job id.
5. [unit] When the first `apply` of a set pass returns `failed`, the flow stops `calls_failed` and the second
   feature's `apply` is not called.
6. [unit] When the second `apply` returns `retry`, nothing is recorded and the next pass starts again from the
   first feature.
7. [unit] A set pass whose findings all target feature `b` commits only `b`'s spec and still sets the first
   feature's `callsJobId` to the job id, so the next decision moves past this review.

### US-010

1. [unit] For a `start` with `base: 'spec'`, the start pass calls `createBranch` for `feat/b` at `flow.specSha`
   when the spec blob shas at the base and at `flow.specSha` are equal.
2. [unit] For a `start` with `base: 'default'`, the start pass reads `getBranchHead` of the repo's `defaultBranch`
   and calls `createBranch` for `feat/b` at that sha.
3. [unit] When the spec blob shas at the base and at `flow.specSha` differ, the flow stops `spec_changed` with
   detail `.nax/features/b/spec.md differs from the approved spec` and `createBranch` is not called.
4. [unit] When the spec file is missing at the base, the flow stops `spec_changed`.
5. [unit] When the spec file is missing at `flow.specSha`, the flow stops `spec_changed`.
6. [unit] After `createBranch` returns `created`, under the locks the pass calls `setFeatureBranch(<id>, 'feat/b')`,
   `markFeatureState(<id>, 'RUNNING')` and records activity `flow.feature_started` with `feature`, `base`, `sha` and
   `branch`.
7. [unit] `createBranch` returning `exists` with the base sha is treated as created.
8. [unit] `createBranch` returning `exists` with another sha stops the flow `dispatch_refused` with detail
   `branch feat/b already exists`.
9. [unit] A thread-entry flow reaching a `start` stops `dispatch_refused` with detail `thread entry runs one
   feature` and makes no forge call.
10. [unit] A `RepoCheckException` with reason `provider_error` from any start-pass forge call ends the pass with no
    write and no stop.
11. [unit] A `RepoCheckException` with reason `app_permissions_insufficient` from `createBranch` stops the flow
    `dispatch_refused` with detail `app_permissions_insufficient`.
12. [unit] A repo with a null `githubInstallationId` stops the flow `dispatch_refused` with detail `repo not
    connected` and makes no forge call.
13. [unit] A creator without dispatch access at the start pass stops the flow `creator_lost_access` before any
    forge call.
14. [unit] When the flow is stopped between the forge calls and the record transaction, the record writes nothing.
15. [unit] The pass after a start dispatches that feature's `PLAN` (seam: `advance` twice, first `createBranch`,
    then `jobs.dispatch` with command `PLAN` and ref `feat/b`).

### US-011

1. [integration] `listAdvanceable` returns a `WAITING_MERGE` flow.
2. [integration] `listAdvanceable` does not return `PENDING`, `WAITING_ANSWER`, `COMPLETED` or `STOPPED` flows.
3. [unit] For a `WAITING_MERGE` flow awaiting position 0 with `prNumber` 31, `advance` mints a read-only token and
   calls `getPullRequest(token, owner, name, 31)`.
4. [unit] When that PR is `merged: true`, the pass calls `markFeatureState(<position 0 id>, 'MERGED')`, moves the
   flow to `RUNNING` with `setFlowState`, and records activity `flow.resumed`.
5. [unit] When the PR is open, the pass writes nothing and the flow stays `WAITING_MERGE`.
6. [unit] When the PR has `state: 'closed'` and `merged: false`, the flow stops `pr_closed` with detail `PR #31
   closed without merge`.
7. [unit] When `getPullRequest` returns null, the flow stops `pr_closed` with detail `PR #31 not found`.
8. [unit] When `getPullRequest` throws `RepoCheckException` with reason `provider_error`, the pass ends with no
   write.
9. [unit] When `getPullRequest` throws `RepoCheckException` with reason `repo_not_found`, the flow stops
   `dispatch_refused` with detail `repo_not_found`.
10. [unit] A repo with a null `githubInstallationId` stops the flow `dispatch_refused` with detail `repo not
    connected`.
11. [unit] An awaited `READY` feature with a null `prNumber` stops the flow `dispatch_refused` with detail `feature a
    has no PR`.
12. [unit] With two awaited features, one merged and one open, the pass marks the merged one `MERGED` and the flow
    stays `WAITING_MERGE`.
13. [unit] A `WAITING_MERGE` pass dispatches no job (`jobs.dispatch` is not called), even when every awaited PR is
    merged; the next pass runs the start.
14. [unit] When the flow is no longer `WAITING_MERGE` at the record transaction's locked re-read (stopped
    meanwhile), the merge-watch pass writes nothing, and when it still is, the pass writes the merges and the
    `pr_closed` stop through `flows.stop`.

### US-012

1. [integration] A nax-entry flow with features `a` and independent `b`, driven by `FleetFlowTicker.tick` with the
   forge stubbed and each job completed by the test, dispatches `SPEC_REVIEW`, `PLAN`, `PRD_REVIEW`, `RUN`,
   `REVIEW` and `FIX` for `a`, each job carrying `a`'s `flowFeatureId`.
2. [integration] After `a`'s ready `FIX`, feature `a` is `READY`, the next tick creates `feat/b` at `flow.specSha`,
   and the following tick dispatches `PLAN` for `b` with ref `feat/b` and `b`'s `flowFeatureId`, while the stubbed
   flow-branch head differs from `flow.specSha`.
3. [integration] After `b`'s ready `FIX`, the flow is `COMPLETED` and both features are `COMPLETED`.
4. [integration] A second flow with `b` depending on `a` moves to `WAITING_MERGE` after `a`'s ready `FIX`, and a
   tick with `a`'s PR still open leaves it `WAITING_MERGE`.
5. [integration] A tick after the stubbed PR reports `merged: true` marks `a` `MERGED` and the flow `RUNNING`; the
   next tick creates `feat/b` at the stubbed default-branch head.
6. [integration] In that second flow, a tick where the stubbed PR reports closed without merge stops the flow
   `pr_closed` with `stopReason` persisted on the row.
7. [integration] Every forge call in both flows runs outside a database transaction.
