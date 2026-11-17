# SPEC: Flow handoff - koda publishes and finishes a feature run in nax chat

## Summary

A nax-entry fleet flow can be created from a **handoff** instead of from specs: a feature already planned and run
by a `nax chat` chain, with its branch pushed and **no PR yet**, plus the chain's git-excluded nax run record. The
flow needs the usual koda approval, then its first step is a RUN job that restores the record on the runner and
runs `nax run --publish-only`, so koda publishes the PR under its own forge identity. From there the existing
`REVIEW -> RULE -> FIX` chain finishes it unchanged. This is the koda half of the approved design
`docs/superpowers/specs/2026-11-17-flow-handoff-design.md`; the nax half (the chain's `handoff` step and the
`nax-flow__send` handoff form) is a separate nax feature, and the wire shape below is the contract it sends.

## Motivation

The 2026-11-04 ruling makes koda own the always-on flow, including the finish. A chat chain that runs a feature
ends with a draft PR held by open items, and koda cannot finish it: nax trusts only item-index and item-thread
comments its own login wrote (`ownComments`, nax `packages/nax/src/forge/marker.ts`), so a PR the owner's account
published can never be readied by koda's bot (`no nax item index on this PR`). The owner ruled (2026-11-17) that the
chain hands the feature over **before** publishing (approach A) and uploads its run record with the request
(transport T1). nax already has the mechanism: a run with `workflow.publish` set to `push` or `none` ends with
outcome `pushed` or `local-only`, and `nax run -f <feature> --publish-only` publishes it later from its record when
the record's `head` equals HEAD and no PRD story is pending (nax `packages/nax/src/workflow/publish-only.ts`,
`packages/nax/src/cli/publish-only-refusal.ts`). The record lives in `.nax/features/<feature>/workflow/<runId>/`
(`result.json`, `ledger.md`), which is git-excluded, so it must travel with the request.

## Design

### Wire shape of the handoff create body (contract for the nax sender)

`POST /api/fleet/flows` (the existing nax-entry create) accepts a second body form. A body carries either
`features` (the existing spec form, unchanged) or `handoff` (this form), never both. `remoteUrl`, `branch`, `roles`
and `costCapUsd` stay top-level, exactly as in the spec form:

```json
{
  "remoteUrl": "https://github.com/acme/widgets",
  "branch": "feat/chat-layout-overflow",
  "roles": { "reviewer": "acp:claude", "supervisor": "acp:claude" },
  "costCapUsd": "5",
  "handoff": {
    "feature": "chat-layout-overflow",
    "headSha": "0123456789abcdef0123456789abcdef01234567",
    "record": [
      { "runId": "8bd38595-ffbf-4092-89d0-f1ebbf375786", "file": "result.json", "mtimeMs": 1763370000000, "content": "{...}" },
      { "runId": "8bd38595-ffbf-4092-89d0-f1ebbf375786", "file": "ledger.md", "mtimeMs": 1763370000000, "content": "..." }
    ]
  }
}
```

- `record` holds every run directory of the feature's `workflow/` folder that has a `result.json`: earlier runs
  carry story records and ledger items that `--publish-only` still reads (`collectStoryRecords`,
  `collectLedgerItems` walk every run directory, newest first by `result.json` mtime).
- `file` is `result.json` or `ledger.md`. `content` is the file's UTF-8 text. `mtimeMs` is the file's mtime on the
  sender's machine, an integer from 0 to `8640000000000000` (the Date range `utimes` accepts); the runner restores
  it, so nax's newest-first order is the sender's order.
- `headSha` is 40 lowercase hex characters.
- `remoteUrl`, `branch`, `roles` and `costCapUsd` follow exactly the rules `parseFlowInput` applies to the spec form.
  The implementation extracts those checks from `flow-input.ts` into one shared helper both parsers call.
- The **newest run** is the run whose `result.json` entry has the largest `mtimeMs`; two `result.json` entries with
  the same largest `mtimeMs` are refused, so "newest" is never ambiguous. Its `result.json` parses as a JSON object
  with `schemaVersion: 1` and a `featureWorkflow` object whose `step` is `"done"`, whose `outcome` is `"pushed"` or
  `"local-only"`, and whose `head` equals `handoff.headSha`. These are `publishOnlyStart`'s own preconditions.

`NormalizedHandoffFlowInput` keeps the input's shape: `{ remoteUrl, branch, roles, costCapUsd, handoff: { feature,
headSha, record } }`. `parseFlowHandoffInput` is therefore idempotent: parsing its own output returns an equal
object. This is what lets the approval command re-parse the stored body, as the spec form does today.

Limits. The values live in `packages/fleet-protocol/src/index.ts` (the runner imports them). The API image does not
ship that package at runtime (it imports it type-only, see `apps/api/src/fleet/common/protocol.spec.ts`), so
`apps/api/src/fleet/flows/flow-handoff-input.ts` keeps its own copies and a spec pins them equal to the protocol's:

- `HANDOFF_MAX_RUNS = 20` distinct run ids.
- `HANDOFF_RECORD_MAX_BYTES = 524288`: the sum of the UTF-8 byte lengths of every `content`. Fastify's default
  1 MiB body limit applies (no `bodyLimit` override); a body over it is refused with 413 before the handler, which
  the nax sender avoids by enforcing the same content cap.
- `HANDOFF_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` (a path segment; nax run ids are UUIDs). Two entries
  whose run ids are equal ignoring case and whose `file` is the same are duplicates, and two run ids equal ignoring
  case but spelled differently are refused, because a macOS runner's filesystem folds case.
- `HANDOFF_RECORD_FILES = ['result.json', 'ledger.md']`.

### Storage

- `FleetFlowFeature` gains `handoff Boolean @default(false)` and `handoffRecord Json?`. Every flow read the
  repository returns (`create`, `findById`, `lockById`, `findPage`, `findLiveForThread`, `findLiveForSpec`,
  `findLiveForBranch`) loads features with `omit: { handoffRecord: true }` (Prisma 7.10 supports `omit` without a
  preview flag), and `toFeature` / `toDomain` are typed against the omitted row. So the record is never re-read on
  every advance tick and never reaches `FleetFlowFeatureDto.from` or the approval details, and
  `expect(await repo.findById(id)).toEqual(created)` keeps holding.
- A new repository method `IFleetFlowRepository.findHandoffRecord(featureId): Promise<HandoffRecordFile[] | null>`
  reads the record for the RUN dispatch only.
- `FleetFlowFeatureRecord` gains an optional `handoff?: boolean` (the repository always sets it). `CreateFleetFlow`
  gains an optional `handoff?: { record: HandoffRecordFile[] }` that the repository writes onto the flow's first
  feature (`handoff: true`, `handoffRecord: record`). `CreateFlowInput.handoff` is the single carrier from the route
  to the repository; feature inputs never carry the record.
- `FleetJob` gains `handoff Json?`. `FleetJobRecord` and `NewFleetJob` (`jobs/domain/fleet-job.domain.ts`) gain an
  optional `handoff?: HandoffRecordFile[] | null`, typed with the protocol's `HandoffRecordFile` (no import from
  `flows/` into `jobs/`). `createJob` (`jobs/prisma-fleet-job.repository.ts`) writes it as
  `Prisma.InputJsonValue`, and `Prisma.DbNull` when absent, as it writes `agentInput`; `toJob` maps it back.
- The record is stored on the approval request input, the flow feature and the RUN job, and sent once in the
  ASSIGN payload: at most four copies of at most 512 KiB, accepted. The approval request's stored `input` is
  readable to whoever can read that approval, the same exposure as any create body.

### Integration

Symbols the feature reads, unchanged:

- `parseFlowRemoteUrl` (`apps/api/src/fleet/flows/flow-remote-url.ts`), `FEATURE_RE` and `GIT_REF_RE`
  (`apps/api/src/fleet/jobs/dispatch-input.ts`).
- `GitHubAppClient.mintThreadReadToken` (contents, pull_requests and metadata read), `.getBranchHead`, `.getFile`,
  `.listOpenPullRequests` (`apps/api/src/fleet/git-broker/github-app-client.ts`; `OpenPullRequest` carries `number`,
  `headSha` and `headRepoFullName`, and the listing reads one page of 100). `mintReadOnlyToken` cannot list pull
  requests, so the handoff form never uses it.
- `GitLabRepoCredentials.call(repo, 'read', fn)` with `GitLabAccessChecker.getBranchHead`, `.getFile`,
  `.listOpenMergeRequests` (`apps/api/src/fleet/git-broker/gitlab-access-checker.ts`).
- `featureDirFor(repoDir, feature)` (`apps/runner/src/paths/safe-segment.ts`).

Symbols the feature changes. The baseline only locates the code; it is never the interface to implement.

- `FleetFlowsController.create` (`fleet-flows.controller.ts`). Baseline: parses with `parseFlowInput(body, 'NAX')`,
  checks the spec files at `specSha`, and maps `RepoCheckException` inline in its `catch`. Target: the inline
  mapping is extracted into one private method both forms call unchanged; when the body has a `handoff` key the
  route parses with `parseFlowHandoffInput(body)`, runs the handoff checks below, then opens the route gate with
  the variant `NAX_HANDOFF_FLOW_CREATE_VARIANT` and `input: { projectId, repoId, body: <normalized> }`; a body
  without `handoff` keeps the baseline path exactly.
- `FlowRouteCommands.onModuleInit` (`flow-route.commands.ts`). Target: also registers
  `NAX_HANDOFF_FLOW_CREATE_VARIANT = 'rest:fleet-nax-handoff-flow.create'`, whose `parse` runs
  `parseFlowHandoffInput` on the stored `body` (the normalized object) and whose `run` calls
  `FleetFlowsService.create` with `entry: 'NAX'`, `specSha: body.handoff.headSha` and
  `handoff: { record: body.handoff.record }`.
- `CreateFlowInput` (`fleet-flows.service.ts`). Target: gains `handoff?: { record: HandoffRecordFile[] }`.
- `FleetFlowsService.lockNaxEntry`. Baseline: refuses a live flow on `(repoId, branch, specSha)` with
  `fleet.flows.duplicate`. Target: for a handoff, refuses a live flow on `(repoId, branch)` whatever its sha, with
  `ConflictAppException({ flowId }, 'fleet.flows.branchBusy')`, through a new repository method
  `IFleetFlowRepository.findLiveForBranch(repoId, branch)`.
- `FleetFlowStartCommand.details` (`fleet-flow-start.command.ts`). Baseline: returns `features: flow.features`.
  Target: returns each feature mapped explicitly to `{ feature, specPath, dependsOn, handoff }`.
- `FlowStepInput` and `decideFlowStep` (`flow-step-decision.ts`). Target: input gains an optional
  `handoff?: boolean` (absent means false; `decisionInput` sets it from the feature); see Steps below.
- `BuildStepDispatchInput` and `buildStepDispatch` (`flow-step-dispatch.ts`). Baseline: `RUN` takes its ref from the
  PLAN job's `resultBranch` and throws without a PLAN. Target: input gains `handoff?: boolean`; a handoff `RUN` uses
  `ref: flow.specSha` (the head sha) and needs no PLAN.
- `FleetFlowAdvanceService` (`fleet-flow-advance.service.ts`). Target: the dispatch pass of a handoff `RUN` reads
  the record with `findHandoffRecord`; a null record stops the flow with reason `dispatch_refused` and detail
  `RUN: handoff record missing` instead of dispatching; a record is passed as `handoff` in the
  `FleetJobsService.dispatch` options. For every other dispatch the `handoff` key is **omitted** from the options
  object (never `undefined` or `null`), so the existing exact-options assertions keep passing. The crash-recovery
  rule (`recoverable`, near line 657) also covers a handoff feature's `RUN` job queued at or after `approvedAt`,
  exactly as it covers an adopted `SPEC_REVIEW`.
- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`jobs/fleet-jobs.service.ts`). Target: `opts` gains
  `handoff?: HandoffRecordFile[]`, stored on `FleetJob.handoff` only for `command: 'RUN'`.
  `DispatchFleetJobDto` does **not** gain the field: only a flow can dispatch a handoff RUN.
- `buildAssignPayload` (`jobs/assign-payload.ts`). Target: a RUN job with a non-null `handoff` adds
  `handoff: { record }` to the payload; every other command never does.
- `AssignPayload` (`packages/fleet-protocol/src/index.ts`). Target: gains `handoff?: HandoffAssign` with
  `HandoffAssign = { record: HandoffRecordFile[] }` and
  `HandoffRecordFile = { runId: string; file: 'result.json' | 'ledger.md'; mtimeMs: number; content: string }`,
  plus the four limit constants.
- `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts`). Target: validates and keeps `handoff` on a RUN
  with the protocol's limits and the same entry rules as the API; `bad('handoff')` for a malformed block or a
  non-RUN command carrying one.
- `buildNaxArgv` (`apps/runner/src/executor/nax-process.ts`). Baseline RUN argv:
  `[...naxCommand, 'run', '--headless', '--json', '-f', feature, '--profile', chain, '--max-cost', cap]`. Target: a
  RUN assign with `handoff` appends `'--publish-only'`.
- `jobProfileContent` and `writeJobProfile` (`apps/runner/src/executor/job-profile.ts`). Target: both gain a new
  **last** optional positional parameter `publishPr?: boolean`; when true the profile includes
  `workflow: { publish: 'pr' }`. The job profile deep-merges after the repo config, so the PR is published whatever
  the repo's `workflow.publish` says.
- `findWorkflowResult(featureDir, sinceMs)` (`apps/runner/src/verdict/workflow-result.ts`). Target: gains an
  optional third parameter `excludeRunIds?: ReadonlySet<string>`; a run directory whose name is in it is never
  returned, even when its `result.json` mtime is at or after `sinceMs`.
- `stashWorkflowOutputs` (`apps/runner/src/executor/workflow-stash.ts`). Target: gains an optional
  `excludeRunIds?: ReadonlySet<string>` passed through to `findWorkflowResult`.
- `HostExecutor.readWorkflowResult` and `HostExecutor.collectBundle` (`apps/runner/src/executor/host-executor.ts`).
  Target: for a RUN assign with `handoff`, both pass `handoffRunIds(job.assign)` as `excludeRunIds` (derived from
  the persisted assign, never from memory, so a daemon restart cannot lose them).

New symbols:

- In `apps/api/src/fleet/flows/flow-handoff-input.ts`: `parseFlowHandoffInput(body: unknown):
  NormalizedHandoffFlowInput`, the type `NormalizedHandoffFlowInput`, the four limit copies, and
  `readHandoffPrd(text: string): { branchName: string | null; pendingStoryIds: string[] } | null` (null when the
  text is not a JSON object with a `userStories` array). A story is pending by nax's own rule (`isPendingStory`,
  nax `packages/nax/src/prd/index.ts`): `passes` is not true and `status` is none of `passed`, `failed`,
  `skipped`, `blocked`, `paused`, `regression-failed`, `decomposed`. Parser errors are
  `ValidationAppException({ reason }, 'fleet.flowInput')` naming the property, as `parseFlowInput` does.
- In `apps/runner/src/executor/handoff-restore.ts`: `restoreHandoffRecord(repoDir: string, feature: string,
  record: readonly HandoffRecordFile[]): Promise<void>`, which removes `featureDirFor(repoDir, feature)/workflow`
  entirely (the runner's `clean -ffd` keeps git-ignored files, so earlier jobs' run directories survive in the
  clone), writes each file to `workflow/<runId>/<file>`, and sets each file's atime and mtime to `mtimeMs`; and
  `handoffRunIds(assign: AssignPayload): ReadonlySet<string>`, the distinct run ids of `assign.handoff.record`,
  empty when there is no handoff.

### Create checks for the handoff form (in order)

1. Body parse (`parseFlowHandoffInput`): 400 `fleet.flowInput` naming the property.
2. Repo resolution, project reach and `fleet.flow.create` permission: exactly as the spec form today.
3. `branch` equal to the repo's `defaultBranch`: 400 `fleet.flowInput` reason `branch`.
4. Forge reads with one read credential (GitHub: `mintThreadReadToken`; GitLab: the `read` credential):
   - branch head differs from `handoff.headSha`: 409 `fleet.flows.handoffHeadMoved`;
   - `.nax/features/<feature>/prd.json` absent at the head, or not readable by `readHandoffPrd`: 422
     `fleet.flows.prdMissing` with `{ path }`;
   - that PRD's `branchName` is null or differs from `branch`: 422 `fleet.flows.handoffBranchMismatch` (the runner
     checks out `prd.branchName`, so a mismatch would publish a different branch than the flow guards);
   - a pending story in that PRD: 422 `fleet.flows.handoffStoriesPending` with `{ storyIds }`;
   - an open PR from the same repository (GitHub `headRepoFullName` equal to the repo's `owner/name`; GitLab merge
     requests listed for the project) whose `headSha` equals `handoff.headSha`: 409 `fleet.flows.handoffPrOpen`
     with `{ prNumber }`. The listing reads one page of 100.
   - A forge failure maps through the extracted mapping exactly as the spec form maps it (`forgeUnavailable` 503,
     `repoNotConnected`, `gitlabNotConnected`, `branchNotFound`). Every read fails closed: no flow is created.
5. Route gate with `NAX_HANDOFF_FLOW_CREATE_VARIANT`, then `FleetFlowsService.create` with `entry: 'NAX'`,
   `specSha: headSha`, one feature `{ feature, specPath: '.nax/features/<feature>/spec.md', dependsOn: [] }`,
   `handoff: { record }`, and the live-branch refusal `fleet.flows.branchBusy`.

The flow is created `PENDING` with the `fleet.flow.start` ask, as every nax-entry flow is; nothing billed starts
before approval. New API i18n keys (`apps/api/src/i18n/{en,zh}`): `fleet.flows.handoffHeadMoved`,
`fleet.flows.prdMissing`, `fleet.flows.handoffBranchMismatch`, `fleet.flows.handoffStoriesPending`,
`fleet.flows.handoffPrOpen`, `fleet.flows.branchBusy`.

### Steps

A handoff feature skips SPEC_REVIEW, PLAN and PRD_REVIEW:

- No job yet, flow `APPROVED` or `RUNNING`: dispatch `RUN`.
- A handoff flow never dispatches `SPEC_REVIEW`.
- An `APPROVED` handoff flow whose `RUN` job exists (queued at or after `approvedAt`) is recovered to `RUNNING` at
  step `RUN` by the advance pass, as an adopted `SPEC_REVIEW` is today.
- Every later decision is the existing one: a finished RUN with `prNumber` and `resultSha` dispatches `REVIEW`, then
  `RULE` / `FIX` / complete / `WAITING_ANSWER` per #413, with one automatic RULE/FIX round. A RUN that fails stops
  with `step_failed`; a RUN that ends without a PR stops with `run_no_pr`.

### Runner

For a RUN assign with `handoff`, `HostExecutor`:

1. checks out as for every RUN (`prepareCheckout` reads `prd.json` at the ref, which is the head sha, and checks out
   `prd.branchName`; a leftover local branch ahead of origin can make HEAD differ from the head sha, which
   `--publish-only` then refuses);
2. calls `restoreHandoffRecord(repoDir, feature, handoff.record)` before nax starts;
3. writes the job profile with `publishPr: true`;
4. spawns `buildNaxArgv`, which appends `--publish-only`;
5. reads the workflow result and stashes the workflow outputs with `excludeRunIds = handoffRunIds(assign)`, so the
   restored `result.json` (which qualifies by mtime when the sender's clock runs ahead of the job's creation time)
   is never mistaken for the publish's own result.

### Failure Handling

| Case | Behaviour |
|:-----|:----------|
| Body has both `features` and `handoff` | 400 `fleet.flowInput` reason `handoff`; nothing read from the forge |
| Record file name, run id, duplicate, case collision, run count, byte cap, `mtimeMs` or `content` invalid, or record empty | 400 `fleet.flowInput` naming the property |
| Newest run ambiguous or not publishable (tie, not JSON, no `schemaVersion: 1`, `step` not `done`, outcome `ready`/`draft`, `head` != `headSha`) | 400 `fleet.flowInput` reason `handoff.record` |
| Branch head moved since the chain pushed | 409 `fleet.flows.handoffHeadMoved` |
| No `prd.json` at the head, or unreadable | 422 `fleet.flows.prdMissing` |
| PRD `branchName` null or different from `branch` | 422 `fleet.flows.handoffBranchMismatch` |
| A PRD story pending by nax's rule | 422 `fleet.flows.handoffStoriesPending` |
| Same-repo PR already open at that head | 409 `fleet.flows.handoffPrOpen` |
| Live flow already owns the branch | 409 `fleet.flows.branchBusy` |
| Forge unreachable during the checks | 503 `fleet.flows.forgeUnavailable`; no flow row (fail closed) |
| Process dies between the RUN insert and the step record | the next advance records the flow `RUNNING` at `RUN` |
| Handoff feature's record missing at dispatch | the flow stops with `dispatch_refused`, detail `RUN: handoff record missing` |
| Runner receives a malformed `handoff` block, or one on a non-RUN command | `parseAssign` returns `bad('handoff')`; nax never starts |
| `--publish-only` refuses on the runner (HEAD moved, record invalid) | the flow stops: `step_failed` when the RUN job fails, `run_no_pr` when it ends without a PR |

## Out of Scope

- The nax half: the chat chain's `handoff` step, a `run` step that does not publish, the `nax-flow__send` handoff form, and marking a local record as handed off. A separate nax feature delivers it, sending the wire shape in this spec.
- Adopting a draft PR that was already published from chat by another account; this feature refuses that case with `fleet.flows.handoffPrOpen`.
- Changing nax's own-login trust rule for item indexes and item threads.
- Merging, releasing or deploying the finished PR.
- A handoff from a fork or for a repository other than the registered `FleetRepo`.
- A handoff field on `DispatchFleetJobDto` or any public job-dispatch route: only a flow dispatches a handoff RUN.
- Validating the record's truth beyond its shape and the newest run's publish preconditions, including any feature name recorded inside `result.json`; the record gets the same trust as the specs `nax-flow__send` sends today.
- Open-PR detection beyond the first page of 100 open PRs on GitHub, and telling apart two branches that share the same head commit.
- Surfacing nax's own `--publish-only` refusal text in the flow's stop detail; the text stays in the RUN job's logs and the stop detail is the existing generic one.
- A runner capability gate for handoff RUNs: a runner older than this feature drops the `handoff` block and runs a plain `nax run` on a PRD whose stories are all done, a no-op that ends without a PR and stops the flow with `run_no_pr`.
- Web UI and CLI changes for handoff flows; they render as existing nax-entry flows.
- Thread-entry (`THREAD`) flows: the handoff form exists only on the nax entry.
- Clearing the stored record from the flow feature, the job or the approval request after the flow ends.

## Stories

### US-001: Handoff body and record shape

Workdir: `apps/api`. No dependencies.

Creates `flow-handoff-input.ts` with `parseFlowHandoffInput`, `NormalizedHandoffFlowInput`, the four limit copies,
the body-form rules and the record-shape rules; extracts the shared `remoteUrl` / `branch` / `roles` /
`costCapUsd` checks from `flow-input.ts` into a helper both parsers call.

### US-002: Newest-run rules and the PRD reader

Workdir: `apps/api`. Depends on US-001.

Adds the newest-run publishability rules to `parseFlowHandoffInput` and `readHandoffPrd` to the same file.

### US-003: Storage and protocol types

Workdir: `apps/api`. Depends on US-001.

Adds `HandoffAssign`, `HandoffRecordFile` and the four limit constants to `packages/fleet-protocol/src/index.ts`,
a spec pinning the API copies equal to them, the Prisma columns `FleetFlowFeature.handoff`,
`FleetFlowFeature.handoffRecord` and `FleetJob.handoff` with one migration, the domain fields, `omit` of
`handoffRecord` on every flow read, `findHandoffRecord`, `findLiveForBranch`, `CreateFleetFlow.handoff`
persistence, the `createJob` / `toJob` mapping, and `FleetFlowStartCommand.details` explicit feature mapping.

### US-004: Create a flow from a handoff on GitHub

Workdir: `apps/api`. Depends on US-002, US-003.

`FleetFlowsController.create` branches on the `handoff` key with the extracted forge-error mapping and runs the
GitHub handoff checks; `CreateFlowInput.handoff`; `lockNaxEntry`'s `fleet.flows.branchBusy`; the six new i18n keys
in `en` and `zh`.

### US-005: GitLab handoff checks, approval command and OpenAPI

Workdir: `apps/api`. Depends on US-004.

The GitLab branch of the handoff checks; `NAX_HANDOFF_FLOW_CREATE_VARIANT` in `FlowRouteCommands`; the OpenAPI
body schema documents the handoff form, and `openapi.json` plus the CLI client are regenerated with
`bun run generate`.

### US-006: A handoff flow starts at RUN with publish-only

Workdir: `apps/api`. Depends on US-003.

`FlowStepInput.handoff` and the `decideFlowStep` rules; `buildStepDispatch` handoff RUN; the advance pass reads the
record with `findHandoffRecord`, stops on a missing record and passes the record to `FleetJobsService.dispatch`;
the `recoverable` rule for a handoff RUN; `FleetJob.handoff` stored only for RUN; `buildAssignPayload` adds
`handoff` for a RUN with a record.

### US-007: Runner restores the record and publishes

Workdir: `apps/runner`. Depends on US-003.

`parseAssign` keeps `handoff`; `restoreHandoffRecord` and `handoffRunIds`; `buildNaxArgv` adds `--publish-only`;
`jobProfileContent` / `writeJobProfile` `publishPr`; `findWorkflowResult` and `stashWorkflowOutputs`
`excludeRunIds`; `HostExecutor` wires them for a handoff RUN.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-input.ts` - the spec-form parser this mirrors (errors, `FEATURE_RE`, `GIT_REF_RE`, cost rule)
- `apps/api/src/fleet/flows/flow-remote-url.ts` - `parseFlowRemoteUrl`

**US-002**
- `apps/api/src/fleet/flows/flow-input.ts` - error conventions

**US-003**
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` - `FleetFlowFeatureRecord`, `CreateFleetFlow`, `IFleetFlowRepository`
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` - `create`, `toFeature` and every flow read
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` - `FleetJobRecord`, `NewFleetJob`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` - `createJob`, `toJob`, the `agentInput` JSON precedent
- `apps/api/src/fleet/common/protocol.spec.ts` - the precedent for pinning API copies to `@nathapp/fleet-protocol`

**US-004**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` - the spec-form create and its forge error mapping
- `apps/api/src/fleet/flows/fleet-flows.service.ts` - `create`, `lockNaxEntry`
- `apps/api/src/fleet/git-broker/github-app-client.ts` - `mintThreadReadToken`, `listOpenPullRequests`, `getBranchHead`, `getFile`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` - endpoint coverage this story extends

**US-005**
- `apps/api/src/fleet/flows/flow-route.commands.ts` - `NAX_FLOW_CREATE_VARIANT` registration
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` - `listOpenMergeRequests`, `getBranchHead`, `getFile`
- `apps/api/src/fleet/flows/fleet-flows.controller.gitlab.spec.ts` - the GitLab create precedent

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.ts` - `decideFlowStep`, `FlowStepInput`
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` - `buildStepDispatch`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` - `advance`, `recoverable`, the dispatch pass and `decisionInput`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` - `dispatch` and its `opts`
- `apps/api/src/fleet/jobs/assign-payload.ts` - `buildAssignPayload`

**US-007**
- `apps/runner/src/supervisor/assign-parser.ts` - `parseAssign`, `bad`, the `ruleOverride` precedent
- `apps/runner/src/executor/host-executor.ts` - RUN prepare, profile write, spawn, `readWorkflowResult`, `collectBundle`
- `apps/runner/src/executor/nax-process.ts` - `buildNaxArgv`
- `apps/runner/src/executor/job-profile.ts` - `jobProfileContent`, `writeJobProfile`
- `apps/runner/src/executor/workflow-stash.ts` - `stashWorkflowOutputs`

### Creates

**US-001**
- `apps/api/src/fleet/flows/flow-handoff-input.ts`
- `apps/api/src/fleet/flows/flow-handoff-input.spec.ts`

**US-007**
- `apps/runner/src/executor/handoff-restore.ts`
- `apps/runner/src/executor/handoff-restore.spec.ts`

### Modifies

**US-003**
- `apps/api/src/fleet/flows/fleet-flow-start.command.spec.ts` - its `details` assertion may pin `features` as the repository's feature objects; `details` now maps each feature to `{ feature, specPath, dependsOn, handoff }`, so the expectation becomes that mapped shape, and the invariant is that the approval details never carry `handoffRecord`.

**US-005**
- `openapi.json` - regenerated by `bun run generate` after the create body schema documents the handoff form; never hand-edited.
- `apps/cli/src/generated/` - regenerated by `bun run generate` from the exported API spec; never hand-edited.

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` - only if an exact `dispatch` options assertion breaks: the invariant that replaces it is that a non-handoff dispatch's options object has no `handoff` key at all, and a handoff RUN's options carry `handoff` equal to the stored record.

### Seams

- US-001 -> US-004: `parseFlowHandoffInput` is called by `FleetFlowsController.create`; US-001 -> US-005: by the
  `NAX_HANDOFF_FLOW_CREATE_VARIANT` command's `parse`.
- US-002 -> US-004: `readHandoffPrd` is called by the create checks on the PRD read at the head.
- US-003 -> US-006: `FleetFlowFeatureRecord.handoff` drives `FlowStepInput.handoff`, and `findHandoffRecord`
  supplies the RUN dispatch's `opts.handoff`.
- US-006 -> US-007: `AssignPayload.handoff` produced by `buildAssignPayload` is the block `parseAssign` keeps; both
  sides use the protocol's limit constants.

## Acceptance Criteria

### US-001

1. [unit] `parseFlowHandoffInput` called with a body holding `remoteUrl`, `branch: 'feat/x'`, `roles`, `costCapUsd: '5'` and a `handoff` with one run whose `result.json` is `{ schemaVersion: 1, featureWorkflow: { step: 'done', outcome: 'pushed', head: <headSha> } }` returns an object deep-equal to `{ remoteUrl, branch: 'feat/x', roles, costCapUsd: '5', handoff: { feature, headSha, record } }` with `record` in input order.
2. [unit] `parseFlowHandoffInput` called with its own return value returns an object deep-equal to that value.
3. [unit] `parseFlowHandoffInput` called with a body that has both a `features` array and a `handoff` object throws `ValidationAppException` with key `fleet.flowInput` and reason `handoff`.
4. [unit] `parseFlowHandoffInput` called with a `handoff` value that is a string throws `ValidationAppException` with reason `handoff`.
5. [unit] `parseFlowHandoffInput` called with `handoff.feature` of `-bad` throws `ValidationAppException` with reason `handoff.feature`.
6. [unit] `parseFlowHandoffInput` called with `handoff.headSha` of `ABCDEF0123456789ABCDEF0123456789ABCDEF01` (uppercase) throws `ValidationAppException` with reason `handoff.headSha`.
7. [unit] `parseFlowHandoffInput` called with an empty `handoff.record` array throws `ValidationAppException` with reason `handoff.record`.
8. [unit] `parseFlowHandoffInput` called with a record entry whose `file` is `branch-review.json` throws `ValidationAppException` with reason `handoff.record.0.file`.
9. [unit] `parseFlowHandoffInput` called with a record entry whose `runId` is `../x` throws `ValidationAppException` with reason `handoff.record.0.runId`.
10. [unit] `parseFlowHandoffInput` called with a record entry whose `mtimeMs` is `1.5` throws `ValidationAppException` with reason `handoff.record.0.mtimeMs`.
11. [unit] `parseFlowHandoffInput` called with a record entry whose `content` is the number `5` throws `ValidationAppException` with reason `handoff.record.0.content`.
12. [unit] `parseFlowHandoffInput` called with entries `Run-A/result.json` and `run-a/ledger.md` throws `ValidationAppException` with reason `handoff.record`.
13. [unit] `parseFlowHandoffInput` called with record entries spanning 21 distinct run ids throws `ValidationAppException` with reason `handoff.record`.
14. [unit] `parseFlowHandoffInput` called with record contents whose UTF-8 byte lengths sum to `HANDOFF_RECORD_MAX_BYTES + 1` throws `ValidationAppException` with reason `handoff.record`.
15. [unit] `parseFlowHandoffInput` called with a handoff body whose `costCapUsd` is `0` throws `ValidationAppException` with reason `costCapUsd`, the reason `parseFlowInput` gives for that value.

### US-002

1. [unit] `parseFlowHandoffInput` called with a run id that has a `ledger.md` entry but no `result.json` entry throws `ValidationAppException` with reason `handoff.record`.
2. [unit] `parseFlowHandoffInput` called with two `result.json` entries sharing the largest `mtimeMs` throws `ValidationAppException` with reason `handoff.record`.
3. [unit] `parseFlowHandoffInput` called with a newest-run `result.json` whose content is not valid JSON throws `ValidationAppException` with reason `handoff.record`.
4. [unit] `parseFlowHandoffInput` called with a newest-run `result.json` whose `schemaVersion` is `2` throws `ValidationAppException` with reason `handoff.record`.
5. [unit] `parseFlowHandoffInput` called with a newest-run `featureWorkflow.step` of `publish` throws `ValidationAppException` with reason `handoff.record`.
6. [unit] `parseFlowHandoffInput` called with a newest-run `featureWorkflow.outcome` of `draft` throws `ValidationAppException` with reason `handoff.record`.
7. [unit] `parseFlowHandoffInput` called with a newest-run `featureWorkflow.head` different from `handoff.headSha` throws `ValidationAppException` with reason `handoff.record`.
8. [unit] `parseFlowHandoffInput` called with an older run whose `result.json` has outcome `draft` and a newer run (larger `mtimeMs`) with outcome `local-only` returns a normalized input, because only the newest run is checked.
9. [unit] `readHandoffPrd` called with a PRD whose `branchName` is `feat/x` and whose stories are one `{ status: 'passed' }`, one `{ status: 'failed' }` and one `{ status: 'pending', passes: false }` with id `US-003` returns `{ branchName: 'feat/x', pendingStoryIds: ['US-003'] }`.
10. [unit] `readHandoffPrd` called with a PRD that has no `branchName` returns an object whose `branchName` is null.
11. [unit] `readHandoffPrd` called with the text `not json` returns null.

### US-003

1. [unit] The API copies of `HANDOFF_MAX_RUNS`, `HANDOFF_RECORD_MAX_BYTES`, `HANDOFF_RUN_ID_RE` and `HANDOFF_RECORD_FILES` in `flow-handoff-input.ts` equal the constants exported by `@nathapp/fleet-protocol`.
2. [integration] `PrismaFleetFlowRepository.create` with `handoff: { record }`, followed by `findHandoffRecord` on the created flow's first feature, returns a list equal to the record.
3. [integration] `PrismaFleetFlowRepository.findById` on a flow created with `handoff: { record }` returns a first feature whose `handoff` is `true`.
4. [integration] `PrismaFleetFlowRepository.findById` on a flow created with `handoff: { record }` returns a first feature that has no `handoffRecord` key.
5. [integration] `PrismaFleetFlowRepository.create` with `handoff: { record }` returns a flow whose first feature has no `handoffRecord` key.
6. [integration] `PrismaFleetFlowRepository.findById` on a flow created without `handoff` returns features whose `handoff` is `false`.
7. [integration] `PrismaFleetFlowRepository.findLiveForBranch(repoId, branch)` returns the `RUNNING` flow on that repo and branch whose `specSha` differs from any value passed in.
8. [integration] `PrismaFleetFlowRepository.findLiveForBranch(repoId, branch)` returns null when the only flow on that repo and branch is `COMPLETED`.
9. [integration] The job repository's `createJob` with `handoff` set to a record, followed by `findById`, returns a job whose `handoff` equals the record.
10. [integration] The job repository's `createJob` without `handoff`, followed by `findById`, returns a job whose `handoff` is null.
11. [unit] `FleetFlowStartCommand.details` for a request on a handoff flow returns `features` whose first entry equals `{ feature, specPath, dependsOn: [], handoff: true }`.

### US-004

1. [integration] `POST /api/fleet/flows` with a valid handoff body for a GitHub repo, where the stubbed forge reports the branch head equal to `headSha`, a `prd.json` at the head whose `branchName` equals `branch` with no pending story, and no open PR, stores a flow whose `{ state, entry, specSha }` equals `{ state: 'PENDING', entry: 'NAX', specSha: headSha }`.
2. [integration] The flow stored by that valid GitHub handoff create has one feature equal on `{ feature, specPath, dependsOn, handoff }` to `{ feature: handoff.feature, specPath: '.nax/features/<feature>/spec.md', dependsOn: [], handoff: true }`.
3. [integration] The valid GitHub handoff create mints its GitHub token with `GitHubAppClient.mintThreadReadToken` and never calls `mintReadOnlyToken`.
4. [integration] The response body of the valid GitHub handoff create carries no `handoffRecord` key on any feature.
5. [integration] `POST /api/fleet/flows` with a handoff body whose `branch` equals the repo's `defaultBranch` returns 400 with reason `branch`.
6. [integration] `POST /api/fleet/flows` with a handoff body when the stubbed `GitHubAppClient.getBranchHead` returns a sha different from `headSha` returns 409 `fleet.flows.handoffHeadMoved`.
7. [integration] `POST /api/fleet/flows` with a handoff body when the stubbed `GitHubAppClient.getFile` returns null for `.nax/features/<feature>/prd.json` returns 422 `fleet.flows.prdMissing` with `path` equal to that file.
8. [integration] `POST /api/fleet/flows` with a handoff body when the `prd.json` at the head has `branchName` `feat/other` returns 422 `fleet.flows.handoffBranchMismatch`.
9. [integration] `POST /api/fleet/flows` with a handoff body when the `prd.json` at the head has story `US-002` with status `pending` and `passes: false` returns 422 `fleet.flows.handoffStoriesPending` with `storyIds: ['US-002']`.
10. [integration] `POST /api/fleet/flows` with a handoff body when the stubbed `GitHubAppClient.listOpenPullRequests` returns a pull request with `number: 42`, `headSha` equal to `handoff.headSha` and `headRepoFullName` equal to the repo's `owner/name` returns 409 `fleet.flows.handoffPrOpen` with `prNumber: 42`.
11. [integration] `POST /api/fleet/flows` with a handoff body when the stubbed `GitHubAppClient.listOpenPullRequests` throws `RepoCheckException('provider_error')` returns 503 `fleet.flows.forgeUnavailable`.
12. [integration] After the refused handoff creates of this story's 400, 409, 422 and 503 cases, the repository holds no flow for that repo and branch.
13. [integration] `POST /api/fleet/flows` with a handoff body while a `RUNNING` flow already exists on the same repo and branch with a different `specSha` returns 409 `fleet.flows.branchBusy` with that flow's id.
14. [integration] `POST /api/fleet/flows` with the existing spec-form body (with `features` and `specSha`, no `handoff`) still stores a `PENDING` flow whose features have `handoff: false`.
15. [unit] Each of `fleet.flows.handoffHeadMoved`, `fleet.flows.prdMissing`, `fleet.flows.handoffBranchMismatch`, `fleet.flows.handoffStoriesPending`, `fleet.flows.handoffPrOpen` and `fleet.flows.branchBusy` resolves to a translated message in both the `en` and `zh` API locales.

### US-005

1. [integration] `POST /api/fleet/flows` with a valid handoff body for a registered GitLab repo, with the stubbed `GitLabAccessChecker.getBranchHead` returning `headSha`, `getFile` returning a PRD with matching `branchName` and no pending story, and `listOpenMergeRequests` returning none, stores a `PENDING` flow whose first feature has `handoff: true`.
2. [integration] `POST /api/fleet/flows` with a handoff body for a GitLab repo when the stubbed `GitLabAccessChecker.listOpenMergeRequests` returns a merge request with `number: 9` and `headSha` equal to `handoff.headSha` returns 409 `fleet.flows.handoffPrOpen` with `prNumber: 9`.
3. [integration] `POST /api/fleet/flows` with a handoff body for a GitLab repo when the stubbed `GitLabAccessChecker.getBranchHead` returns a different sha returns 409 `fleet.flows.handoffHeadMoved`.
4. [unit] Executing the approval command registered for `NAX_HANDOFF_FLOW_CREATE_VARIANT` with a stored input `{ projectId, repoId, body }`, where `body` is a `parseFlowHandoffInput` result, calls `FleetFlowsService.create` once with `entry: 'NAX'`, `specSha` equal to `body.handoff.headSha` and `handoff` equal to `{ record: body.handoff.record }`.
5. [unit] Executing the approval command registered for `NAX_HANDOFF_FLOW_CREATE_VARIANT` with a stored `body` that has an empty `handoff.record` throws `ValidationAppException` with reason `handoff.record` and does not call `FleetFlowsService.create`.

### US-006

1. [unit] `decideFlowStep` with `handoff: true`, state `APPROVED` and no latest job returns `{ kind: 'dispatch', step: 'RUN' }`.
2. [unit] `decideFlowStep` with `handoff: true`, state `RUNNING` and no latest job returns `{ kind: 'dispatch', step: 'RUN' }`.
3. [unit] `decideFlowStep` with `handoff` absent, state `APPROVED`, a first feature and no latest job still returns a `SPEC_REVIEW` dispatch.
4. [unit] `buildStepDispatch` with step `RUN`, `handoff: true` and no `plan` returns a dispatch whose `{ command, ref, feature }` equals `{ command: 'RUN', ref: flow.specSha, feature: <feature name> }`.
5. [unit] `buildStepDispatch` with step `RUN`, no `handoff` and no `plan` throws an error whose message is `RUN requires the missing PLAN job`.
6. [integration] `FleetFlowAdvanceService.advance(flowId, now)` on an `APPROVED` handoff flow with no jobs calls the stubbed `FleetJobsService.dispatch` once with options whose `handoff` equals the record `findHandoffRecord` returns.
7. [integration] The same `advance` call passes `FleetJobsService.dispatch` a dto whose `command` is `RUN` and whose `ref` equals the flow's `specSha`.
8. [integration] `FleetFlowAdvanceService.advance(flowId, now)` on an `APPROVED` handoff flow whose only job is a `QUEUED` `RUN` queued at or after `approvedAt` leaves the flow in state `RUNNING`.
9. [integration] The same recovery `advance` call does not call `FleetJobsService.dispatch`.
10. [integration] `FleetFlowAdvanceService.advance(flowId, now)` on an `APPROVED` handoff flow whose `findHandoffRecord` returns null stops the flow with `stopReason` `dispatch_refused`.
11. [integration] `FleetFlowAdvanceService.advance(flowId, now)` on a non-handoff `RUNNING` flow whose next step is `PLAN` calls `FleetJobsService.dispatch` with an options object that has no `handoff` key.
12. [integration] `FleetJobsService.dispatch` with a `REVIEW` dto and `opts.handoff` set stores the job with `handoff: null`.
13. [unit] `buildAssignPayload` for a `RUN` job whose `handoff` is a record returns a payload whose `handoff.record` equals that record.
14. [unit] `buildAssignPayload` for a `RUN` job whose `handoff` is null returns a payload with no `handoff` key.
15. [unit] `decideFlowStep` with `handoff: true`, state `RUNNING` and a latest `RUN` job in state `FAILED` returns `{ kind: 'stop', reason: 'step_failed' }`.

### US-007

1. [unit] `parseAssign` with a `RUN` payload carrying a valid `handoff` block returns `ok: true` and an assign whose `handoff.record` equals the payload's record.
2. [unit] `parseAssign` with a `RUN` payload whose `handoff` record entry has `runId` `..` returns the result of `bad('handoff')`.
3. [unit] `parseAssign` with a `RUN` payload whose `handoff` record contents sum to `HANDOFF_RECORD_MAX_BYTES + 1` UTF-8 bytes returns the result of `bad('handoff')`.
4. [unit] `parseAssign` with a `REVIEW` payload carrying a `handoff` block returns the result of `bad('handoff')`.
5. [unit] `restoreHandoffRecord` on a repo dir whose `.nax/features/<feature>/workflow/` already holds a run directory `old-run` leaves no `old-run` directory after it returns.
6. [unit] `restoreHandoffRecord` writes each record entry's `content` to `.nax/features/<feature>/workflow/<runId>/<file>` under the repo dir.
7. [unit] `restoreHandoffRecord` sets each written file's mtime to the entry's `mtimeMs`.
8. [unit] `buildNaxArgv` for a `RUN` assign with a `handoff` block returns an argv whose last element is `--publish-only`.
9. [unit] `buildNaxArgv` for a `RUN` assign without a `handoff` block returns an argv that has no `--publish-only` element.
10. [unit] `jobProfileContent` called with `publishPr: true` as its last argument returns an object whose `workflow.publish` is `pr`.
11. [unit] `findWorkflowResult` with `excludeRunIds` holding the only run directory whose `result.json` mtime is at or after `sinceMs` returns null.
12. [integration] `HostExecutor.readWorkflowResult` on a handoff `RUN` job whose restored run's `result.json` mtime is at or after the job's `createdAt`, with no other run directory, returns null.
13. [integration] `HostExecutor.collectBundle` on that handoff `RUN` job creates no `workflow` folder in the job dir.
14. [integration] `HostExecutor` running a `RUN` assign with a `handoff` block, with git and the nax spawn stubbed, has written the record files under the checkout when it calls the spawn.
15. [integration] `HostExecutor` running that handoff `RUN` writes the job profile with `workflow.publish` equal to `pr`.
