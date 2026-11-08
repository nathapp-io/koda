<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Flow reviews follow the manual loop (two spec passes, phase 9 edits the PRD)

## Summary

A nax-entry flow's review steps now run the way the spec, plan and phase-9 loop is run by hand. `SPEC_REVIEW` runs at
most two passes: pass 1's findings are committed as Flow's calls and a second `SPEC_REVIEW` reads them; pass 2's
findings are committed as calls and the flow goes to `PLAN` without a third review. `PRD_REVIEW` (spec-review
phase 9) now fixes the PRD itself: its verdict carries `prdEdits` (exact-text replacements on a story's description,
acceptance criteria and context files), koda applies them to `prd.json` on the flow branch in one contents-API commit,
and the flow goes to `RUN`. Only a finding the PRD cannot absorb (the spec itself must change) re-plans, once; after
the re-plan the next `PRD_REVIEW`'s edits are applied and its remaining findings are accepted, never a stop. Ambiguous
findings still wait for the human. Thread-entry flows are unchanged.

## Motivation

Live flows 6, 10 and 11 (fleet design doc §9.173, and the 2026-11-08 flow 10/11 checks) stopped `review_findings` at
the second `PRD_REVIEW` round on minor findings whose verdicts read "ready": an `analysis` miscount (a field rendered
into no prompt), a planner-added context file, and "exactly four tests" against six PRD ACs. Flows 8 and 9 passed only
because their second round came back empty. The rule "any finding in the second PRD round stops the flow" has no
counterpart in the manual process the flow automates:

1. Spec review runs pass 1, the findings are verified and folded, pass 2 runs, and its findings are folded without a
   third review. A second pass never stops.
2. `nax plan` runs once.
3. Phase 9 runs once with permission to edit `prd.json`; it patches the PRD surgically against a pre-edit snapshot and
   ends READY-WITH-EDITS, and the run starts.
4. A re-plan happens only when the spec needs new content: a re-plan drops qualifiers added to existing text, so it can
   undo fixes.

## Design

### User rulings (2026-11-08)

1. **Mirror the manual loop**, not a new threshold ("please recall how we have run the full process manually").
2. **Spec review stays two passes** in the flow: pass 2's findings are folded without a third review.
3. **Phase 9 edits the PRD**; the flow proceeds to `RUN` after the edits.

### Calls made while drafting (not user rulings)

- **The API commits the edits, not the agent.** An `AGENT` job's checkout is detached and nothing it writes is pushed
  (`apps/runner/src/executor/checkout.ts`, the `AGENT` branch of `prepareCheckout`). The reviewer returns the edits in
  its verdict and koda applies them through the contents API, as it commits Flow's calls. No runner change: a `RUN`
  whose runner-local branch is behind origin checks out origin (`planBranch` -> `from-origin`), so the edit commit is
  what `RUN` builds on.
- **Edits are exact-text, applied in order, each on its own.** An edit names the text it replaces (the snapshot
  check). One whose text is not found, or not unique, is refused and reported; the others still apply. A refused edit
  never stops the flow.
- **Editable fields are a story's `description`, `acceptanceCriteria` and `contextFiles` only.** Story ids, order,
  dependencies, `outOfScope` and every other field are untouched; `analysis` reaches no prompt.
- **The commit lives on `FleetFlowCallsService`** (`applyPrdEdits`), next to `apply`: it is the flow's forge-write
  owner, and a new injected service would change the positional constructor of `FleetFlowAdvanceService` in five specs.
- **Second-round findings are accepted, not committed as calls.** After the re-plan the spec no longer changes what is
  built (`RUN` reads `prd.json`); the accepted findings are kept in the `flow.prd_edits` activity record.
- **A failed edit commit reuses the `calls_failed` stop reason** with the detail `PRD_REVIEW edits: <detail>`, so the
  stop-reason union, the web labels and the stop ticket stay as they are.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

Read only (verified):

- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts` — `FleetFlowCallsService.apply(flow, action, expectedHead)`:
  the pattern `applyPrdEdits` mirrors (mint token, `getBranchHead`, `getFile` at the head, `putFile` with `blobSha`,
  recovery through `isSingleFileCommit`, `RepoCheckException` -> `callsOutcomeForForgeError`).
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintInstallationToken(installationId, repoName)`,
  `getBranchHead(token, owner, name, branch): Promise<string>`, `getFile(token, owner, name, path, ref):
  Promise<ForgeFile | null>` (`ForgeFile { sha; size; content: Buffer }`), `putFile(token, owner, name, path,
  { branch, content, blobSha, message }): Promise<PutFileResult>`, `isSingleFileCommit(token, owner, name, base, head,
  path): Promise<boolean>`.
- `apps/api/src/fleet/flows/flow-calls.ts` — `sanitizeFlowText(value)`, `FLOW_CALLS_MAX_FINDINGS` (20),
  `callsOutcomeForForgeError(reason)`.
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `reaskLocked(flow, specSha, now)`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `record(flow, summary, activityAction, payload)`,
  `lockLive(flow)`, `writeStop(flow, reason, detail, now)`.

Changed (baseline -> target):

- `apps/api/src/fleet/flows/flow-verdict.ts`
  - Baseline: `export type FlowVerdict = { ok: true; findings: FlowFinding[] } | { ok: false };`
  - Target: `export type FlowVerdict = { ok: true; findings: FlowFinding[]; prdEdits: FlowPrdEdit[] } | { ok: false };`
    `parseFlowVerdict` reads an optional `prdEdits` key of the same JSON object through `parsePrdEdits`; absent ->
    `[]`; present and `parsePrdEdits` returns `null` -> `{ ok: false }`.
- `apps/api/src/fleet/flows/flow-steps.ts`
  - Baseline: `buildReviewTask(step: ReviewStep, specPath: string, feature: string): string`
  - Target: `buildReviewTask(step: ReviewStep, specPath: string, feature: string, options?: { prdEdits?: boolean }):
    string`. With `step === 'PRD_REVIEW'` and `options.prdEdits === true`, the suffix is
    `\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}\n\n${FLOW_PRD_EDITS_INSTRUCTION}`; otherwise unchanged.
- `apps/api/src/fleet/flows/flow-step-dispatch.ts`
  - Baseline: `BuildStepDispatchInput` has no edits flag; the review case calls
    `buildReviewTask(step, feature.specPath, feature.feature)`.
  - Target: `BuildStepDispatchInput` gains `prdEdits?: boolean`; the review case calls
    `buildReviewTask(step, feature.specPath, feature.feature, { prdEdits: input.prdEdits === true })`.
- `apps/api/src/fleet/flows/flow-step-decision.ts`
  - Baseline: `FlowStepInput` has no `specReviewCount` or `prdEditsJobId`; `FlowStepAction` has no `apply_prd_edits`.
  - Target: `FlowStepInput` gains `specReviewCount?: number` and `prdEditsJobId?: string | null`; `FlowStepAction`
    gains `{ kind: 'apply_prd_edits'; jobId: string; edits: FlowPrdEdit[]; accepted: FlowFinding[] }`, and
    `export type ApplyPrdEditsAction = Extract<FlowStepAction, { kind: 'apply_prd_edits' }>`.
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
  - Baseline: one method, `apply`.
  - Target: adds `applyPrdEdits(flow: FleetFlowRecord, action: ApplyPrdEditsAction, expectedHead: string):
    Promise<PrdEditsOutcome>` with
    `export type PrdEditsOutcome = { kind: 'committed'; sha: string; applied: number; refused: FlowPrdEditRefusal[] }
    | { kind: 'unchanged'; refused: FlowPrdEditRefusal[] } | { kind: 'stale'; head: string } | { kind: 'retry' }
    | { kind: 'failed'; detail: string }`.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` and `prisma-fleet-flow-step.repository.ts`
  - Baseline: `recordCalls`, `recordRulings`; no PRD-edits marker.
  - Target: adds `recordPrdEdits(flowId: string, featureId: string, jobId: string): Promise<void>` (an `updateMany`
    on `FleetFlowFeature` scoped by `id` and `flowId`, writing `prdEditsJobId`).
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — the feature record gains `prdEditsJobId?: string | null`.
- `apps/api/prisma/schema.prisma` — `model FleetFlowFeature` gains `prdEditsJobId String?`; migration
  `apps/api/prisma/migrations/20261202090000_fleet_flow_prd_edits/migration.sql` =
  `ALTER TABLE "FleetFlowFeature" ADD COLUMN "prdEditsJobId" TEXT;`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
  - Baseline: `decisionInput` sets no `specReviewCount`/`prdEditsJobId`; `advance` handles `apply_calls` and
    `apply_rulings`; `dispatchStep` builds the body with no edits flag.
  - Target: `decisionInput` sets `specReviewCount` (only when the latest job's step is `SPEC_REVIEW`) and
    `prdEditsJobId`; `decide` returns an `apply_prd_edits` pass; `advance` calls a new `advancePrdEdits`;
    `dispatchStep` passes `prdEdits: flow.entry === 'NAX'`.

### Approach

New pure module `apps/api/src/fleet/flows/flow-prd-edits.ts`:

```ts
export const FLOW_PRD_EDITS_MAX = 30;
export const FLOW_PRD_EDIT_TEXT_MAX = 2000;

export type FlowPrdEdit =
  | { story: string; op: 'replace_description'; old: string; new: string }
  | { story: string; op: 'replace_ac'; old: string; new: string }
  | { story: string; op: 'remove_ac'; old: string }
  | { story: string; op: 'add_ac'; new: string }
  | { story: string; op: 'add_context_file'; path: string }
  | { story: string; op: 'remove_context_file'; path: string };

export type FlowPrdEditRefusal = { index: number; story: string; op: string; reason: string };

export type PrdEditsResult =
  | { kind: 'ok'; text: string; applied: number; refused: FlowPrdEditRefusal[] }
  | { kind: 'unreadable' };

/** null when `value` is not an array or any entry is malformed. */
export function parsePrdEdits(value: unknown): FlowPrdEdit[] | null;
export function applyPrdEdits(prdText: string, edits: FlowPrdEdit[]): PrdEditsResult;
```

- **`parsePrdEdits`:** each entry is an object with string `story` and a known `op`; `replace_*` need non-empty string
  `old` and string `new`, `remove_ac` a non-empty `old`, `add_ac` a non-empty `new`, the context-file ops a non-empty
  `path`. Every string is passed through `sanitizeFlowText` and has NUL (`\u0000`) replaced with U+FFFD; `old`, `new`
  and `path` are cut to `FLOW_PRD_EDIT_TEXT_MAX` code units only for `new` (a cut `old` could no longer match, so an
  `old` longer than the cap makes the entry malformed).
- **`applyPrdEdits`:** `JSON.parse(prdText)`; not an object with a `userStories` array -> `unreadable`. Edits apply in
  input order to the evolving document; the edit at position `index` (0-based) beyond `FLOW_PRD_EDITS_MAX` is refused
  `over limit`. A story is found by `id === edit.story` (none -> `unknown story`). Per op:
  - `replace_description`: `old` must occur exactly once in the story's `description` (0 -> `text not found`, 2+ ->
    `text not unique`); that occurrence is replaced by `new`.
  - `replace_ac` / `remove_ac`: `old` must equal exactly one entry of `acceptanceCriteria` (0 -> `text not found`,
    2+ -> `text not unique`); it is replaced, or removed. Removing the last entry is refused `last criterion` (nax
    rejects a story with no acceptance criteria).
  - `add_ac`: `new` is appended; an entry equal to `new` already present -> `duplicate criterion`.
  - `add_context_file`: `path` must be relative, without a `..` segment, a leading `/` or a backslash (else
    `invalid path`), and absent from `contextFiles` (else `duplicate path`); it is appended (a missing `contextFiles`
    array is created).
  - `remove_context_file`: `path` must be in `contextFiles` (else `path not listed`); it is removed.
  - The result text is `JSON.stringify(document, null, 2) + '\n'`; every key the edits do not touch is kept.

`FLOW_PRD_EDITS_INSTRUCTION` (in `flow-steps.ts`, exact text):

```text
Fix every PRD defect you can yourself, as edits, instead of reporting it. Add a "prdEdits" array to the same JSON object as "findings".
Each edit is one of: {"story":"<id>","op":"replace_description","old":"<exact text in the description>","new":"<text>"}, {"story":"<id>","op":"replace_ac","old":"<exact criterion>","new":"<criterion>"}, {"story":"<id>","op":"remove_ac","old":"<exact criterion>"}, {"story":"<id>","op":"add_ac","new":"<criterion>"}, {"story":"<id>","op":"add_context_file","path":"<repo path>"}, {"story":"<id>","op":"remove_context_file","path":"<repo path>"}.
Edit only a story's description, acceptance criteria and context files. Never remove a criterion that carries a spec acceptance criterion. Do not report or edit "analysis": it reaches no prompt.
Report a finding only when the spec itself must change or only the user can decide. Do not edit any file: the flow commits your edits.
```

Decision rules (`decideFlowStep`, `SPEC_REVIEW` and `PRD_REVIEW` COMPLETED with a readable verdict; every rule not
listed is unchanged, in its current order):

1. `SPEC_REVIEW`, no findings -> `dispatch PLAN` (unchanged).
2. `SPEC_REVIEW`, `callsJobId === job.id` -> `dispatch SPEC_REVIEW` when `(specReviewCount ?? 0) < 2`, else
   `dispatch PLAN`. (Before: always `PLAN`.)
3. `PRD_REVIEW`, no findings: `canApplyCalls` true, `verdict.prdEdits.length > 0` and `prdEditsJobId !== job.id` ->
   `apply_prd_edits` with `accepted: []`; otherwise `dispatch RUN`.
4. `PRD_REVIEW` with findings, after the unchanged ambiguity, cap and `canApplyCalls` rules: let
   `replan = planCount < 2 || hasCurrentAnswers`. `replan` true -> the current calls path (`callsJobId === job.id` ->
   `dispatch PLAN`, else `apply_calls`), the edits are ignored. `replan` false -> `prdEditsJobId === job.id` ->
   `dispatch RUN`; otherwise `apply_prd_edits` with the verdict's `prdEdits` and `accepted` = the findings. (Before:
   `replan` false stopped `review_findings`.)

Advance (`FleetFlowAdvanceService`):

- `decisionInput`: `specReviewCount` = `steps.countJobsForStepSince(flow.id, 'SPEC_REVIEW', flow.approvedAt ?? now)`,
  read only when the latest job's step is `SPEC_REVIEW` (otherwise the key is omitted); `prdEditsJobId` =
  `flow.features[0]?.prdEditsJobId ?? null`.
- `decide`: `apply_prd_edits` takes the `apply_calls` PRD_REVIEW branch: it is not billed (`remaining '0.0000'`), the
  creator-access check applies, it needs the latest `PLAN` with `resultBranch` and `resultSha`, and it persists a
  different PLAN output branch with `setBranch` and the `flow.branch` record exactly as `apply_calls` does.
- `advancePrdEdits(flow, action, plan, now)`: `calls.applyPrdEdits(flow, action, plan.resultSha)`, outside any
  transaction. `retry` -> nothing; `failed` -> `writeStop(flow, 'calls_failed', 'PRD_REVIEW edits: <detail>', now)`;
  otherwise under `lockLive` (nothing when the flow is no longer live): `stale` -> `flowService.reaskLocked(current,
  head, now)`; `committed` / `unchanged` -> `steps.recordPrdEdits(current.id, featureId, action.jobId)` and one
  `record(current, 'flow PRD edits', 'flow.prd_edits', { jobId, sha: <sha or null>, applied: <n>, refused:
  <refusals>, accepted: <accepted finding summaries> })`.
- `dispatchStep`: `buildStepDispatch({ ..., prdEdits: flow.entry === 'NAX' })`.

`applyPrdEdits` (on `FleetFlowCallsService`): the path is `.nax/features/<feature>/prd.json` of the flow's single
feature; mint an installation token; read the branch head; read the file at that head (missing -> `failed`,
`prd.json missing on <branch>`). When the head equals `expectedHead`: `applyPrdEdits` on the file (`unreadable` ->
`failed`, `prd.json unreadable`); `applied === 0` -> `unchanged`; else `putFile` with message
`chore(<feature>): flow PRD edits from PRD_REVIEW job <jobId>` -> `committed` with the commit sha; 422 `refused` ->
`failed` `prd.json write refused`; 409 -> re-read: same blob sha -> `failed` `prd.json write refused`, else `retry`.
When the head differs: recover our own commit only when `isSingleFileCommit(expectedHead, head, path)` is true and the
file at the head equals `applyPrdEdits(<file at expectedHead>).text` -> `committed` with `sha: head`; otherwise
`stale`. A `RepoCheckException` maps through `callsOutcomeForForgeError` (`failed` with its reason, else `retry`).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `prdEdits` malformed in the verdict | `parseFlowVerdict` -> `{ ok: false }` -> stop `verdict_unreadable` (unchanged path). |
| An edit's text is not found or not unique, the story is unknown, or a path is invalid | That edit is refused with its reason; the others apply; the refusals are in the `flow.prd_edits` record. |
| More than `FLOW_PRD_EDITS_MAX` edits | The edits past the cap are refused `over limit`. |
| Every edit refused | `unchanged`: no commit, `prdEditsJobId` recorded, then `RUN`. |
| `prd.json` missing or not a PRD at the head | `failed` -> stop `calls_failed` `PRD_REVIEW edits: prd.json missing on <branch>` / `prd.json unreadable`. |
| Branch head moved since the PLAN | `stale` -> re-ask (as for calls), unless the move is our own edit commit (recovered as `committed`). |
| Write refused (422, or 409 with the same blob) | `failed` -> stop `calls_failed` `PRD_REVIEW edits: prd.json write refused`. |
| Forge transient error / 409 with a moved blob | `retry`: the next tick decides again. |
| Thread-entry flow | No edits instruction in the task; `prdEdits` ignored; findings stop as today. |

## Out of Scope

- Thread-entry flows: their review task, findings stop and PRD are unchanged.
- A supervisor or second agent verifying review findings before they are committed as calls.
- Committing the accepted second-round PRD findings to the spec as Flow's calls.
- Editing PRD fields other than a story's `description`, `acceptanceCriteria` and `contextFiles` (ids, order, `dependencies`, `outOfScope`, `analysis`, routing).
- A new stop reason for a failed PRD edit commit; it uses `calls_failed`.
- A third `SPEC_REVIEW` pass, or a configurable number of passes.
- Web and CLI display of `prdEditsJobId` or the `flow.prd_edits` record.
- Runner changes: the `RUN` checkout already prefers origin when the runner-local branch is behind.
- Changing the RULE, REVIEW or FIX steps.

## Stories

### US-001: PRD edit operations

No dependencies. Workdir: `apps/api`.

The pure `flow-prd-edits.ts` module: the edit types, `parsePrdEdits`, and `applyPrdEdits` with its refusals.

### US-002: PRD_REVIEW verdict and task carry edits

Depends on US-001. Workdir: `apps/api`.

`parseFlowVerdict` returns `prdEdits`; `FLOW_PRD_EDITS_INSTRUCTION` and the `prdEdits` option of `buildReviewTask`;
the `prdEdits` flag of `buildStepDispatch`.

### US-003: PRD-edits marker column and repository

No dependencies. Workdir: `apps/api`.

The `prdEditsJobId` column, migration, domain field and `recordPrdEdits`.

### US-004: Two-pass spec review and the PRD edits decision

Depends on US-002. Workdir: `apps/api`.

`decideFlowStep` rules 2-4 above, the new input fields and the `apply_prd_edits` action.

### US-005: Committing PRD edits to the flow branch

Depends on US-001, US-004. Workdir: `apps/api`.

`FleetFlowCallsService.applyPrdEdits` and its outcomes.

### US-006: Advance applies PRD edits and runs the second spec pass

Depends on US-003, US-004, US-005. Workdir: `apps/api`.

`decisionInput`, the `apply_prd_edits` pass in `decide`, `advancePrdEdits`, and the `prdEdits` flag at dispatch.

### US-007: Manual-loop reviews against the database

Depends on US-006. Workdir: `apps/api`.

An integration spec driving a nax-entry flow through two `SPEC_REVIEW` passes, `PLAN`, a `PRD_REVIEW` with edits, the
edit commit and the `RUN` dispatch, with the forge stubbed.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-calls.ts`
- `apps/api/src/fleet/flows/flow-rulings.ts`

**US-002**
- `apps/api/src/fleet/flows/flow-verdict.ts`
- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.ts`

**US-003**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/test/integration/fleet/fleet-flow-rulings-migration.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts`
- `apps/api/src/fleet/git-broker/github-app-client.ts`

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts`

**US-007**
- `apps/api/test/integration/fleet/fleet-flow-rulings.integration.spec.ts`
- `apps/api/test/helpers/fleet-fixtures.ts`

### Creates

**US-001**
- `apps/api/src/fleet/flows/flow-prd-edits.ts`
- `apps/api/src/fleet/flows/flow-prd-edits.spec.ts`

**US-003**
- `apps/api/prisma/migrations/20261202090000_fleet_flow_prd_edits/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-prd-edits-migration.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts`

**US-007**
- `apps/api/test/integration/fleet/fleet-flow-prd-edits.integration.spec.ts`

### Modifies

**US-002**
- `apps/api/src/fleet/flows/flow-verdict.spec.ts` — successful-parse assertions that compare the whole verdict with `toEqual({ ok: true, findings })` gain `prdEdits: []`; the findings themselves and every failure case are unchanged.
- `apps/api/src/fleet/flows/flow-steps.spec.ts` — add the `prdEdits` option cases; the existing three-argument `buildReviewTask` expectations are unchanged.
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts` — add the `prdEdits` flag cases; the existing bodies (no flag) are unchanged.

**US-003**
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — add the `recordPrdEdits` cases; existing assertions are unchanged.

**US-004**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — "US-004 AC-8 dispatches PLAN after already-recorded answered review" and "US-005 AC-6 dispatches PLAN when the SPEC_REVIEW calls are already recorded" set `specReviewCount: 2` so they still expect `dispatch PLAN` (with fewer than two passes the same input now dispatches `SPEC_REVIEW`); "US-004 AC-12 keeps second-round minor PRD stop" and "US-005 AC-9 stops findings in the second PRD_REVIEW round" now expect `{ kind: 'apply_prd_edits', jobId, edits: [], accepted: [<the finding>] }` instead of a `review_findings` stop, because a second-round finding is accepted; all other cases are unchanged.

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — add the `applyPrdEdits` cases; the existing `apply` cases are unchanged.

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — "AC-14: counts PLAN jobs since approval to stop second-round findings" now asserts that the second-round finding goes to `calls.applyPrdEdits` (stubbed `unchanged`) and is not a `review_findings` stop; "AC-11: retains the applied SPEC_REVIEW despite its old ref and dispatches PLAN" makes its `countJobsForStepSince` stub return 2 for `SPEC_REVIEW` so PLAN is still dispatched (with fewer than two passes the same flow now dispatches the second `SPEC_REVIEW`); the other cases are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — the exact-body dispatch assertions that call `buildStepDispatch({...})` for a nax-entry flow add `prdEdits: true` to the expected input; the body is otherwise unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — the `reviewBody` helper that calls `buildStepDispatch({...})` for a nax-entry flow adds `prdEdits: true`; its assertions are otherwise unchanged.

### Seams

- US-001 `parsePrdEdits` is called by US-002's `parseFlowVerdict` (seam AC in US-002).
- US-001 `applyPrdEdits` is called by US-005's `FleetFlowCallsService.applyPrdEdits` (seam AC in US-005).
- US-003 `recordPrdEdits` is called by US-006's `advancePrdEdits` (seam AC in US-006).
- US-005 `FleetFlowCallsService.applyPrdEdits` is called by US-006 through `FleetFlowAdvanceService.advance` (seam AC in US-006).
- US-002's `prdEdits` dispatch flag is set by US-006's `dispatchStep` (seam AC in US-006).

## Acceptance Criteria

### US-001: PRD edit operations

1. [unit] `parsePrdEdits([{ story: 'US-001', op: 'replace_ac', old: 'a', new: 'b' }])` returns that one edit.
2. [unit] `parsePrdEdits` returns `null` for an entry whose `op` is `rename_story`.
3. [unit] `parsePrdEdits` returns `null` for a `remove_ac` entry whose `old` is an empty string.
4. [unit] `parsePrdEdits` returns `null` when the value is an object rather than an array.
5. [unit] `parsePrdEdits` returns `null` for a `replace_ac` entry whose `old` is longer than `FLOW_PRD_EDIT_TEXT_MAX` code units, and cuts a `new` of that length to `FLOW_PRD_EDIT_TEXT_MAX` code units.
6. [unit] `applyPrdEdits` on a PRD whose `US-001` has acceptance criteria `['x', 'y']` with `replace_ac` `old: 'y'`, `new: 'z'` returns `kind: 'ok'`, `applied: 1`, and text whose parsed `userStories[0].acceptanceCriteria` is `['x', 'z']`.
7. [unit] `applyPrdEdits` with `replace_description` replaces the one occurrence of `old` in the story's `description` and leaves the rest of the description unchanged.
8. [unit] `applyPrdEdits` refuses a `replace_description` whose `old` occurs twice in the description with `{ index: 0, story: 'US-001', op: 'replace_description', reason: 'text not unique' }` and still applies the edit at index 1.
9. [unit] `applyPrdEdits` refuses an edit for story `US-404` with reason `unknown story`.
10. [unit] `applyPrdEdits` refuses a `remove_ac` of a story's only acceptance criterion with reason `last criterion`.
11. [unit] `applyPrdEdits` refuses `add_context_file` with path `../secrets` with reason `invalid path`, and appends `src/a.ts` to `contextFiles` when it is absent.
12. [unit] `applyPrdEdits` refuses `remove_context_file` of a path not in `contextFiles` with reason `path not listed`.
13. [unit] `applyPrdEdits` with 31 valid `add_ac` edits applies the first 30 and refuses the edit at index 30 with reason `over limit`.
14. [unit] `applyPrdEdits` returns `{ kind: 'unreadable' }` for text that is not JSON and for a JSON object with no `userStories` array.
15. [unit] `applyPrdEdits` keeps every untouched key (`analysis`, `branchName`, a story's `dependencies`) and returns text ending in a newline, formatted with two-space indentation.

### US-002: PRD_REVIEW verdict and task carry edits

1. [unit] `parseFlowVerdict('{"findings":[]}')` returns `{ ok: true, findings: [], prdEdits: [] }`.
2. [unit] `parseFlowVerdict` on `{"findings":[],"prdEdits":[{"story":"US-001","op":"add_ac","new":"n"}]}` returns `ok: true` with that one edit in `prdEdits`.
3. [unit] Seam: `parseFlowVerdict` obtains `prdEdits` from `parsePrdEdits` — with `parsePrdEdits` stubbed to return `null`, a verdict that has a `prdEdits` key parses as `{ ok: false }`.
4. [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: true })` ends with `FLOW_PRD_EDITS_INSTRUCTION`, preceded by `FLOW_VERDICT_INSTRUCTION`.
5. [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: true })` equals `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')`.
6. [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: false })` equals the three-argument call.
7. [unit] `FLOW_PRD_EDITS_INSTRUCTION` names all six ops (`replace_description`, `replace_ac`, `remove_ac`, `add_ac`, `add_context_file`, `remove_context_file`) and the sentence `Do not edit any file: the flow commits your edits.`
8. [unit] Seam: `buildStepDispatch` for `PRD_REVIEW` with `prdEdits: true` returns an `agent.task` equal to `buildReviewTask('PRD_REVIEW', <specPath>, <feature>, { prdEdits: true })`.
9. [unit] `buildStepDispatch` for `PRD_REVIEW` with no `prdEdits` returns the same `agent.task` as before (the three-argument `buildReviewTask`).

### US-003: PRD-edits marker column and repository

1. [integration] After the migrations, a `FleetFlowFeature` row created without `prdEditsJobId` reads it back as `null`.
2. [integration] `recordPrdEdits(flowId, featureId, 'job-1')` sets that feature's `prdEditsJobId` to `job-1` and leaves `callsJobId` and `rulingsJobId` unchanged.
3. [integration] `recordPrdEdits` with a `featureId` that belongs to a different flow changes no row.
4. [integration] The flow repository's feature record exposes the stored `prdEditsJobId`.

### US-004: Two-pass spec review and the PRD edits decision

1. [unit] A COMPLETED `SPEC_REVIEW` with one `minor` finding, `canApplyCalls: true`, `callsJobId` equal to its id and `specReviewCount: 1` returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
2. [unit] The same input with `specReviewCount: 2` returns `{ kind: 'dispatch', step: 'PLAN' }`.
3. [unit] The same input with `specReviewCount` absent returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
4. [unit] A COMPLETED `SPEC_REVIEW` with an empty verdict and `specReviewCount: 1` returns `{ kind: 'dispatch', step: 'PLAN' }`.
5. [unit] A second-pass `SPEC_REVIEW` (`specReviewCount: 2`) with one `minor` finding and no recorded calls returns `apply_calls` for that job.
6. [unit] A COMPLETED `PRD_REVIEW` with no findings, one edit, `canApplyCalls: true` and `planCount: 1` returns `{ kind: 'apply_prd_edits', jobId, edits: [<the edit>], accepted: [] }`.
7. [unit] The same input with `prdEditsJobId` equal to the job id returns `{ kind: 'dispatch', step: 'RUN' }`.
8. [unit] A COMPLETED `PRD_REVIEW` with no findings and one edit but `canApplyCalls: false` returns `{ kind: 'dispatch', step: 'RUN' }`.
9. [unit] A first-round `PRD_REVIEW` (`planCount: 1`) with one `minor` finding and one edit returns `apply_calls` with that finding (the edits are not applied).
10. [unit] A second-round `PRD_REVIEW` (`planCount: 2`) with one `minor` finding and one edit returns `{ kind: 'apply_prd_edits', jobId, edits: [<the edit>], accepted: [<the finding>] }`.
11. [unit] A second-round `PRD_REVIEW` with one `minor` finding and `prdEditsJobId` equal to the job id returns `{ kind: 'dispatch', step: 'RUN' }`.
12. [unit] A second-round `PRD_REVIEW` with one unanswered `ambiguous` finding returns `wait_answer` (unchanged).
13. [unit] A second-round `PRD_REVIEW` whose `ambiguous` finding is answered for this job (`questionsJobId` = job id, answers set) returns `apply_calls` (the answer re-plans).
14. [unit] A thread-entry (`canApplyCalls: false`) second-round `PRD_REVIEW` with one `minor` finding returns a `review_findings` stop (unchanged).

### US-005: Committing PRD edits to the flow branch

1. [unit] With the branch head equal to `expectedHead` and one applicable edit, `applyPrdEdits` calls `putFile` once for `.nax/features/<feature>/prd.json` on the flow branch with the head file's blob sha, the message `chore(<feature>): flow PRD edits from PRD_REVIEW job <jobId>` and content equal to `applyPrdEdits(<head file text>, edits).text`, and returns `{ kind: 'committed', sha: <commit sha>, applied: 1, refused: [] }`.
2. [unit] Seam: `FleetFlowCallsService.applyPrdEdits` computes the content through `applyPrdEdits` — with `applyPrdEdits` stubbed to return `{ kind: 'ok', text: 'T', applied: 1, refused: [] }`, the written content is `T`.
3. [unit] When every edit is refused it returns `{ kind: 'unchanged', refused: <the refusals> }` and never calls `putFile`.
4. [unit] When `prd.json` is missing at the head it returns `{ kind: 'failed', detail: 'prd.json missing on <branch>' }`.
5. [unit] When the file at the head is not a PRD it returns `{ kind: 'failed', detail: 'prd.json unreadable' }`.
6. [unit] When the head differs from `expectedHead` and is not our single-file commit, it returns `{ kind: 'stale', head }` and never calls `putFile`.
7. [unit] When the head differs, `isSingleFileCommit(expectedHead, head, <prd path>)` is true and the file at the head equals the edits applied to the file at `expectedHead`, it returns `committed` with `sha` equal to the head and never calls `putFile`.
8. [unit] A `putFile` result of kind `refused` returns `{ kind: 'failed', detail: 'prd.json write refused' }`.
9. [unit] A 409 conflict whose re-read shows the same blob sha returns `failed` `prd.json write refused`; one whose re-read shows a different blob sha returns `{ kind: 'retry' }`.
10. [unit] A `RepoCheckException` with reason `app_not_installed` returns `failed` with that reason, and one with reason `provider_error` returns `retry`.

### US-006: Advance applies PRD edits and runs the second spec pass

1. [unit] `advance` on a flow whose latest job is a COMPLETED `SPEC_REVIEW` calls `steps.countJobsForStepSince(flowId, 'SPEC_REVIEW', approvedAt)`.
2. [unit] `advance` on a flow whose latest job is a COMPLETED `PLAN` does not count `SPEC_REVIEW` jobs.
3. [unit] `advance` on a nax-entry flow whose latest job is a COMPLETED first-pass `SPEC_REVIEW` with recorded calls (`countJobsForStepSince` returns 1 for `SPEC_REVIEW`) dispatches a `SPEC_REVIEW` job whose `ref` is the flow's current `specSha`.
4. [unit] Seam: `advance` on a nax-entry flow whose latest job is a COMPLETED `PRD_REVIEW` with one edit and no findings calls `calls.applyPrdEdits(flow, { kind: 'apply_prd_edits', jobId, edits, accepted: [] }, <the PLAN's resultSha>)` once, and dispatches no job.
5. [unit] Seam: on a `committed` outcome `advance` calls `steps.recordPrdEdits(flowId, featureId, jobId)` and records one `flow.prd_edits` activity with payload `{ jobId, sha, applied, refused, accepted }`.
6. [unit] On an `unchanged` outcome `advance` calls `recordPrdEdits` and records `flow.prd_edits` with `sha: null`.
7. [unit] On a `stale` outcome `advance` calls `flowService.reaskLocked(<flow>, head, now)` and does not call `recordPrdEdits`.
8. [unit] On a `failed` outcome with detail `prd.json unreadable` `advance` stops the flow with reason `calls_failed` and detail `PRD_REVIEW edits: prd.json unreadable`.
9. [unit] On a `retry` outcome `advance` writes nothing and dispatches nothing.
10. [unit] A flow whose creator lost dispatch access stops `creator_lost_access` before `applyPrdEdits` is called.
11. [unit] `apply_prd_edits` runs with the cost cap exhausted (it is not billed).
12. [unit] When the PLAN pushed to a branch other than the flow's, `advance` persists the PLAN's `resultBranch` with `setBranch` before calling `applyPrdEdits`.
13. [unit] Seam: `advance` dispatching `PRD_REVIEW` for a nax-entry flow sends a body equal to `buildStepDispatch({ ..., prdEdits: true })`, and for a thread-entry flow a body whose task has no `prdEdits` instruction.
14. [unit] After the edits are recorded (`prdEditsJobId` = the `PRD_REVIEW` job id), the next `advance` dispatches `RUN` with `ref` equal to the PLAN's `resultBranch`.

### US-007: Manual-loop reviews against the database

1. [integration] A nax-entry flow whose first `SPEC_REVIEW` returns one `minor` finding commits the calls (stubbed `putFile`) and, on the next tick, has a second `SPEC_REVIEW` job linked to the flow with `ref` equal to the calls commit sha.
2. [integration] When that second `SPEC_REVIEW` returns one `minor` finding, the flow commits the calls and the following tick dispatches a `PLAN` job (no third `SPEC_REVIEW`).
3. [integration] After the PLAN completes, a `PRD_REVIEW` whose output carries one `replace_ac` edit and no findings leads to one `putFile` of `prd.json` whose content has that criterion replaced, a `FleetFlowFeature.prdEditsJobId` equal to the review job id, and a `flow.prd_edits` activity row.
4. [integration] The tick after the edit commit dispatches a `RUN` job linked to the flow.
5. [integration] A second-round `PRD_REVIEW` (two PLAN jobs since approval) with one `minor` finding and no edits records `flow.prd_edits` with that finding in `accepted`, dispatches `RUN`, and leaves the flow `RUNNING`, never `STOPPED review_findings`.
