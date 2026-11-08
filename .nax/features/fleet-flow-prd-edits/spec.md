# SPEC: Flow reviews follow the manual loop (two spec passes, phase 9 edits the PRD)

## Summary

A nax-entry flow's review steps now run the way the spec, plan and phase-9 loop is run by hand. `SPEC_REVIEW` runs at
most two passes: pass 1's findings are committed as Flow's calls and a second `SPEC_REVIEW` reads them; pass 2's
findings are committed as calls and the flow goes to `PLAN` without a third review. `PRD_REVIEW` (spec-review
phase 9) now fixes the PRD itself: its verdict carries `prdEdits` (exact-text replacements on a story's description,
acceptance criteria and context files), koda applies them to `prd.json` on the flow branch in one contents-API commit,
and the flow goes to `RUN`. A first-round finding the PRD cannot absorb (the spec itself must change) re-plans; an
answered question re-plans as well. After a re-plan, the next `PRD_REVIEW`'s edits are applied and its remaining
findings are accepted instead of stopping the flow. Ambiguous findings still wait for the human, and more than 20
findings in one verdict still stop it. Thread-entry flows are unchanged.

## Motivation

Live flows 10 and 11 (2026-11-08) stopped `review_findings` at the second `PRD_REVIEW` round on minor findings whose
verdicts read "ready": an `analysis` miscount (a field rendered into no prompt), a planner-added context file, and
"exactly four tests" against six PRD ACs. Flows 8 and 9 passed only because their second round came back empty, and
flow 6 (fleet design doc §9.173) stopped at the same rule. The rule "any finding in the second PRD round stops the
flow" has no counterpart in the manual process the flow automates:

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
- **The verdict has an 8 KB budget.** The runner keeps the last `AGENT_RESULT_LIMITS.maxOutputBytes` (8,192) bytes of
  an agent's output (`packages/fleet-protocol/src/agent-jobs.ts`), and `parseFlowVerdict` finds the verdict by its
  `{"findings"` prefix. So the edits instruction asks for `findings` as the first key and the whole JSON line under
  6,000 bytes of UTF-8, and the caps are `FLOW_PRD_EDITS_MAX` = 12 edits of at most `FLOW_PRD_EDIT_TEXT_MAX` = 400
  code units of new text (a longer `new` is refused `text too long`, never cut). A verdict that still overflows is `verdict_unreadable` (accepted; the instruction tells the
  reviewer to keep the most important edits and report the rest as one minor finding).
- **Edits are exact-text, applied in order, each on its own.** An edit names the text it replaces (the snapshot
  check). One whose text is not found, or not unique, is refused and reported; the others still apply. A refused edit
  never stops the flow.
- **Editable fields are a story's `description`, `acceptanceCriteria` and `contextFiles` only.** Story ids, order,
  dependencies, `outOfScope` and every other field are untouched; `analysis` reaches no prompt.
- **The commit lives on `FleetFlowCallsService`** (`applyPrdEdits`), next to `apply`: it is the flow's forge-write
  owner, and a new injected service would change the positional constructor of `FleetFlowAdvanceService` in five specs.
- **Second-round findings are accepted, not committed as calls.** After the re-plan the spec no longer changes what is
  built (`RUN` reads `prd.json`); the accepted findings' summaries are kept in the `flow.prd_edits` activity record.
- **The findings cap still stops.** More than `FLOW_CALLS_MAX_FINDINGS` (20) findings in one verdict stops
  `review_findings` in every round, as today.
- **A failed edit commit reuses the `calls_failed` stop reason** with the detail `PRD_REVIEW edits: <detail>`, so the
  stop-reason union, the web labels and the stop ticket stay as they are.
- **`parseFlowVerdict` is step-agnostic.** A malformed `prdEdits` key makes any verdict unreadable, including a
  `SPEC_REVIEW` one; only the `PRD_REVIEW` task asks for edits, so the case is not expected.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

Read only (verified):

- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts` — `FleetFlowCallsService.apply(flow, action, expectedHead)`:
  the pattern `applyPrdEdits` mirrors (feature and repo guards, mint token, `getBranchHead`, `getFile` at the head,
  `putFile` with `blobSha`, recovery through `isSingleFileCommit`, `RepoCheckException` -> `callsOutcomeForForgeError`).
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintInstallationToken(installationId, repoName)`,
  `getBranchHead(token, owner, name, branch): Promise<string>`, `getFile(token, owner, name, path, ref):
  Promise<ForgeFile | null>` (`ForgeFile { sha; size; content: Buffer }`), `putFile(token, owner, name, path,
  { branch, content, blobSha, message }): Promise<PutFileResult>` (`{ kind: 'committed'; commitSha } | { kind:
  'conflict' } | { kind: 'refused' }`), `isSingleFileCommit(token, owner, name, base, head, path): Promise<boolean>`.
- `apps/api/src/fleet/flows/flow-calls.ts` — `sanitizeFlowText(value)`, `truncateFlowText(value, max)` (surrogate-safe
  cut that also replaces lone surrogates), `FLOW_CALL_TEXT_MAX` (1000), `FLOW_CALLS_MAX_FINDINGS` (20),
  `callsOutcomeForForgeError(reason)`.
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `reaskLocked(flow, specSha, now)`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `record(flow, summary, activityAction, payload)`,
  `lockLive(flow)`, `writeStop(flow, reason, detail, now)`.
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — `FleetFlowTicker.tick(now)`, the entry point the integration specs
  drive.

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
  - Baseline: `DispatchPass<A extends DispatchAction | ApplyCallsAction | ApplyRulingsAction>`; `decide` returns a pass
    for `dispatch`, `apply_calls` and `apply_rulings` only (the kind check before `writeDecision`); `advance` handles
    `apply_calls` and `apply_rulings`; `decisionInput` sets no `specReviewCount`/`prdEditsJobId`; `dispatchStep`
    builds the body with no edits flag.
  - Target: `DispatchPass` also admits `ApplyPrdEditsAction`, and the kind check lets `apply_prd_edits` through to a
    pass (otherwise it would reach `writeDecision` and the flow would never move); `advance` calls a new
    `advancePrdEdits`; `decisionInput` sets `specReviewCount` (only when the latest job's step is `SPEC_REVIEW`) and
    `prdEditsJobId`; `dispatchStep` passes `prdEdits: flow.entry === 'NAX'`.

### Approach

New pure module `apps/api/src/fleet/flows/flow-prd-edits.ts`:

```ts
export const FLOW_PRD_EDITS_MAX = 12;
export const FLOW_PRD_EDIT_TEXT_MAX = 400;

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
/** Apply the edits, in order, to the text of a prd.json. */
export function applyPrdEditsToText(prdText: string, edits: FlowPrdEdit[]): PrdEditsResult;
```

- **`parsePrdEdits`:** each entry is an object with a non-empty string `story` and a known `op`.
  `replace_description` needs a non-empty `old` and a string `new` (empty deletes the text); `replace_ac` a non-empty
  `old` and a non-empty `new`; `remove_ac` a non-empty `old`; `add_ac` a non-empty `new`; the context-file ops a
  non-empty `path`. Every string is passed through `sanitizeFlowText` and has NUL (`\u0000`) replaced with U+FFFD.
  Nothing is cut: `new` keeps its full length (the length rule is in `applyPrdEditsToText`), and an `old` longer
  than `FLOW_PRD_EDIT_TEXT_MAX * 4` code units makes the entry malformed.
- **`applyPrdEditsToText`:** `JSON.parse(prdText)`; not an object with a `userStories` array -> `unreadable`. Edits
  apply in input order to the evolving document. The edit at 0-based `index >= FLOW_PRD_EDITS_MAX` is refused
  `over limit`. A `replace_description`, `replace_ac` or `add_ac` whose `new` is longer than `FLOW_PRD_EDIT_TEXT_MAX`
  code units is refused `text too long`. A story is found by `id === edit.story` (none -> `unknown story`). Per op:
  - `replace_description`: a story whose `description` is not a string is refused `story malformed`; `old` must occur
    exactly once in it (0 -> `text not found`, 2+ -> `text not unique`); `new === old` -> `no change`; that
    occurrence is replaced by `new`.
  - `replace_ac` / `remove_ac`: a story whose `acceptanceCriteria` is not an array is refused `story malformed`; `old`
    must equal exactly one entry (0 -> `text not found`, 2+ -> `text not unique`); `replace_ac` with `new === old` ->
    `no change`; `replace_ac` whose `new` equals another entry -> `duplicate criterion`; the entry is replaced, or
    removed. Removing the last entry is refused `last criterion` (nax rejects a
    story with no acceptance criteria).
  - `add_ac`: a non-array `acceptanceCriteria` -> `story malformed`; an entry equal to `new` already present ->
    `duplicate criterion`; else `new` is appended.
  - `add_context_file`: `path` must be relative, without a `..` segment, a leading `/` or a backslash (else
    `invalid path`); a `contextFiles` that is present and not an array -> `story malformed`; a path already listed ->
    `duplicate path`; else it is appended (a missing `contextFiles` array is created).
  - `remove_context_file`: `path` must be in `contextFiles` (else `path not listed`); it is removed.
  - `applied` counts the edits that changed the document. The result text is `JSON.stringify(document, null, 2) +
    '\n'`; every key the edits do not touch is kept.

`FLOW_PRD_EDITS_INSTRUCTION` (in `flow-steps.ts`, exact text):

```text
Fix every PRD defect you can yourself, as edits, instead of reporting it. Add a "prdEdits" array to the same JSON object, after "findings": the object must still start with {"findings".
Each edit is one of: {"story":"<id>","op":"replace_description","old":"<exact text in the description>","new":"<text>"}, {"story":"<id>","op":"replace_ac","old":"<exact criterion>","new":"<criterion>"}, {"story":"<id>","op":"remove_ac","old":"<exact criterion>"}, {"story":"<id>","op":"add_ac","new":"<criterion>"}, {"story":"<id>","op":"add_context_file","path":"<repo path>"}, {"story":"<id>","op":"remove_context_file","path":"<repo path>"}.
Edit only a story's description, acceptance criteria and context files. Never remove a criterion that carries a spec acceptance criterion. Do not report or edit "analysis": it reaches no prompt.
Keep the whole JSON line under 6000 bytes of UTF-8 and at most 12 edits; when more are needed, keep the most important edits and report the rest as one minor finding.
Report a finding only when the spec itself must change or only the user can decide. Do not edit any file: the flow commits your edits.
```

Decision rules (`decideFlowStep`, `SPEC_REVIEW` and `PRD_REVIEW` COMPLETED with a readable verdict; every rule not
listed is unchanged, in its current order, including the ambiguity, findings-cap and `canApplyCalls` rules):

1. `SPEC_REVIEW`, no findings -> `dispatch PLAN` (unchanged).
2. `SPEC_REVIEW`, `callsJobId === job.id` -> `dispatch SPEC_REVIEW` when `specReviewCount !== undefined &&
   specReviewCount < 2`, else `dispatch PLAN`. (Before: always `PLAN`.) An absent count keeps today's behaviour, so
   the rule changes nothing until the advance service supplies the count (US-009).
3. `PRD_REVIEW`, no findings: `canApplyCalls` true, `verdict.prdEdits.length > 0` and `prdEditsJobId !== job.id` ->
   `apply_prd_edits` with `accepted: []`; otherwise `dispatch RUN`. (Before: always `RUN`.)
4. `PRD_REVIEW` with findings, after the unchanged ambiguity, cap and `canApplyCalls` rules: let
   `replan = planCount < 2 || hasCurrentAnswers`. `replan` true -> the current calls path (`callsJobId === job.id` ->
   `dispatch PLAN`, else `apply_calls`), the edits are ignored. `replan` false -> `prdEditsJobId === job.id` ->
   `dispatch RUN`; otherwise `apply_prd_edits` with the verdict's `prdEdits` and `accepted` = the findings. (Before:
   `replan` false stopped `review_findings`.) Rule 4's `apply_prd_edits` outcome ships with the advance pass that
   handles it (US-010); until then `decide` would hand the action to `writeDecision`, which has no handler for it.

Advance (`FleetFlowAdvanceService`):

- `decisionInput`: `specReviewCount` = `steps.countJobsForStepSince(flow.id, 'SPEC_REVIEW', flow.approvedAt ?? now)`,
  read only when the latest job's step is `SPEC_REVIEW` (otherwise the key is omitted); `prdEditsJobId` =
  `flow.features[0]?.prdEditsJobId ?? null`.
- `decide`: `apply_prd_edits` takes the `apply_calls` `PRD_REVIEW` branch (the condition becomes
  `action.kind === 'apply_prd_edits' || (action.kind === 'apply_calls' && action.step === 'PRD_REVIEW')`, since the
  new action has no `step`): it is not billed (`remaining '0.0000'`),
  the creator-access check applies, it needs the latest `PLAN` with `resultBranch` and `resultSha`, and it persists a
  different PLAN output branch with `setBranch` and the `flow.branch` record exactly as `apply_calls` does.
- `advancePrdEdits(flow, action, plan, now)`: `calls.applyPrdEdits(flow, action, plan.resultSha)`, outside any
  transaction. `retry` -> nothing; `failed` -> `writeStop(flow, 'calls_failed', 'PRD_REVIEW edits: <detail>', now)`;
  otherwise under `lockLive` (nothing when the flow is no longer live): `stale` -> `flowService.reaskLocked(current,
  head, now)`; `committed` / `unchanged` -> `steps.recordPrdEdits(current.id, featureId, action.jobId)` and one
  `record(current, 'flow PRD edits', 'flow.prd_edits', { jobId, sha, applied, refused, accepted })` where `sha` is
  the commit sha or `null`, `applied` is the count (0 for `unchanged`), `refused` is the refusal list, and `accepted`
  is the array of `truncateFlowText(summary, FLOW_CALL_TEXT_MAX)` of the accepted findings (an unsanitised lone
  surrogate would fail the JSON write after the forge commit, on every tick).
- `dispatchStep`: `buildStepDispatch({ ..., prdEdits: flow.entry === 'NAX' })`.

`applyPrdEdits` (on `FleetFlowCallsService`): `action.edits` empty -> `{ kind: 'unchanged', refused: [] }` with no
forge call. Otherwise, mirroring `apply`: no feature -> `failed` `feature missing`; repo missing or not installed ->
`failed` `repo not connected`. The path is `.nax/features/<feature>/prd.json` of the flow's single feature; mint an
installation token; read the branch head; read the file at that head (missing -> `failed`,
`prd.json missing on <branch>`). When the head equals `expectedHead`: `applyPrdEditsToText` on the file
(`unreadable` -> `failed`, `prd.json unreadable`); `applied === 0` -> `unchanged`; else `putFile` with message
`chore(<feature>): flow PRD edits from PRD_REVIEW job <jobId>` -> `committed` with the commit sha; `refused` ->
`failed` `prd.json write refused`; `conflict` -> re-read: same blob sha -> `failed` `prd.json write refused`, else
`retry`. When the head differs: recover our own commit only when `isSingleFileCommit(expectedHead, head, path)` is
true and the file at the head equals `applyPrdEditsToText(<file at expectedHead>).text` -> `committed` with
`sha: head`; otherwise `stale`. A `RepoCheckException` maps through `callsOutcomeForForgeError` (`failed` with its
reason, else `retry`).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `prdEdits` malformed in the verdict | `parseFlowVerdict` -> `{ ok: false }` -> stop `verdict_unreadable` (unchanged path). |
| Verdict longer than the 8 KB output tail | Its `{"findings"` prefix is cut -> `verdict_unreadable` (accepted). |
| An edit's text is not found or not unique, the story is unknown or malformed, a path is invalid, `new` is too long or a duplicate, or the edit changes nothing | That edit is refused with its reason; the others apply; the refusals are in the `flow.prd_edits` record. |
| More than `FLOW_PRD_EDITS_MAX` edits | The edits past the cap are refused `over limit`. |
| No edits, or every edit refused | `unchanged`: no commit, `prdEditsJobId` recorded, then `RUN`. |
| Feature or repo missing | `failed` -> stop `calls_failed` `PRD_REVIEW edits: feature missing` / `repo not connected`. |
| `prd.json` missing or not a PRD at the head | `failed` -> stop `calls_failed` `PRD_REVIEW edits: prd.json missing on <branch>` / `prd.json unreadable`. |
| Branch head moved since the PLAN | `stale` -> re-ask (as for calls), unless the move is our own edit commit (recovered as `committed`). |
| Write refused (`refused`, or `conflict` with the same blob) | `failed` -> stop `calls_failed` `PRD_REVIEW edits: prd.json write refused`. |
| Forge transient error / `conflict` with a moved blob | `retry`: the next tick decides again. |
| More than 20 findings in one verdict | stop `review_findings` (unchanged, every round). |
| Flow stopped or re-asked between the commit and the record | `lockLive` finds it no longer live: nothing is recorded (as for calls). |
| Thread-entry flow | No edits instruction in the task; `prdEdits` ignored; findings stop as today. |

## Out of Scope

- Thread-entry flows: their review task, findings stop and PRD are unchanged.
- A supervisor or second agent verifying review findings before they are committed as calls.
- Committing the accepted second-round PRD findings to the spec as Flow's calls.
- Editing PRD fields other than a story's `description`, `acceptanceCriteria` and `contextFiles` (ids, order, `dependencies`, `outOfScope`, `analysis`, routing).
- A new stop reason for a failed PRD edit commit; it uses `calls_failed`.
- A third `SPEC_REVIEW` pass, or a configurable number of passes.
- Raising the agent output limit (`AGENT_RESULT_LIMITS.maxOutputBytes`); a verdict over it stays `verdict_unreadable`.
- Lifting the 20-findings cap for second-round PRD findings.
- Web and CLI display of `prdEditsJobId` or the `flow.prd_edits` record.
- Runner changes: the `RUN` checkout already prefers origin when the runner-local branch is behind.
- Changing the RULE, REVIEW or FIX steps.

## Stories

### US-001: PRD edit parsing

No dependencies. Workdir: `apps/api`.

The edit types, the caps and `parsePrdEdits` in the new `flow-prd-edits.ts`.

### US-002: Applying description and criterion edits

Depends on US-001. Workdir: `apps/api`.

`applyPrdEditsToText` in `flow-prd-edits.ts`: the document read, story lookup, and the `replace_description`,
`replace_ac`, `remove_ac` and `add_ac` ops with their refusals.

### US-003: Applying context-file edits, the caps and the output text

Depends on US-002. Workdir: `apps/api`.

The `add_context_file` and `remove_context_file` ops, `over limit`, `text too long`, the `unreadable` result and the
serialised output text of `applyPrdEditsToText`.

### US-004: PRD_REVIEW verdict and task carry edits

Depends on US-001. Workdir: `apps/api`.

`parseFlowVerdict` returns `prdEdits`; `FLOW_PRD_EDITS_INSTRUCTION` and the `prdEdits` option of `buildReviewTask`;
the `prdEdits` flag of `buildStepDispatch`.

### US-005: PRD-edits marker column and repository

No dependencies. Workdir: `apps/api`.

The `prdEditsJobId` column, migration, domain field and `recordPrdEdits`.

### US-006: Two-pass spec review rule and the no-findings PRD edits rule

Depends on US-004. Workdir: `apps/api`.

`decideFlowStep` rules 2 and 3, the new `FlowStepInput` fields, and the `apply_prd_edits` action type.

### US-007: Committing PRD edits on the flow branch

Depends on US-003, US-006. Workdir: `apps/api`.

`FleetFlowCallsService.applyPrdEdits`: the guards, the write at the expected head and the `unchanged` outcomes.

### US-008: PRD edit commit recovery and write failures

Depends on US-007. Workdir: `apps/api`.

`applyPrdEdits` when the head moved (recovery or `stale`), refused and conflicting writes, and forge errors.

### US-009: Advance runs the second spec pass and flags PRD_REVIEW dispatches

Depends on US-005, US-006. Workdir: `apps/api`.

`decisionInput`'s `specReviewCount` and `prdEditsJobId`, the second `SPEC_REVIEW` dispatch, and `prdEdits` at
dispatch.

### US-010: Advance applies PRD edits and accepts second-round findings

Depends on US-005, US-008, US-009. Workdir: `apps/api`.

Decision rule 4's `apply_prd_edits` outcome, the `apply_prd_edits` pass in `decide` (`DispatchPass` and the kind
check), `advancePrdEdits`, and `RUN` after the edits are recorded.

### US-011: Manual-loop reviews against the database

Depends on US-010. Workdir: `apps/api`.

An integration spec driving `FleetFlowTicker.tick` for a nax-entry flow through two `SPEC_REVIEW` passes, `PLAN`, a
`PRD_REVIEW` with edits, the edit commit and the `RUN` dispatch, with the forge stubbed.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-calls.ts`
- `apps/api/src/fleet/flows/flow-rulings.ts`

**US-002**
- `apps/api/src/fleet/flows/flow-calls.ts`
- `apps/api/src/fleet/flows/flow-prd-edits.ts` — created by US-001, extended here with `applyPrdEditsToText`

**US-003**
- `apps/api/src/fleet/flows/flow-calls.ts`
- `apps/api/src/fleet/flows/flow-prd-edits.ts` — created by US-001, extended here (context-file ops, caps, output text)

**US-004**
- `apps/api/src/fleet/flows/flow-verdict.ts`
- `apps/api/src/fleet/flows/flow-steps.ts`
- `apps/api/src/fleet/flows/flow-step-dispatch.ts`

**US-005**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/test/integration/fleet/fleet-flow-rulings-migration.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-flow-answers-migration.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts`

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts`
- `apps/api/src/fleet/git-broker/github-app-client.ts`

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts`
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-flow-answers.integration.spec.ts`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`
- `apps/api/src/fleet/flows/flow-step-decision.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts`
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts`
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts` — created by US-009, extended here with the `apply_prd_edits` pass cases

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts`
- `apps/api/test/helpers/fleet-fixtures.ts`

### Creates

**US-001**
- `apps/api/src/fleet/flows/flow-prd-edits.ts`
- `apps/api/src/fleet/flows/flow-prd-edits.spec.ts`

**US-002**
- `apps/api/src/fleet/flows/flow-prd-edits-apply.spec.ts`

**US-003**
- `apps/api/src/fleet/flows/flow-prd-edits-files.spec.ts`

**US-005**
- `apps/api/prisma/migrations/20261202090000_fleet_flow_prd_edits/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-prd-edits-migration.integration.spec.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance-prd-edits.spec.ts`

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-prd-edits.integration.spec.ts`

### Modifies

**US-004**
- `apps/api/src/fleet/flows/flow-verdict.spec.ts` — successful-parse assertions that compare the whole verdict with `toEqual({ ok: true, findings })` gain `prdEdits: []`; the findings themselves and every failure case are unchanged.
- `apps/api/src/fleet/flows/flow-steps.spec.ts` — add the `prdEdits` option cases; the existing three-argument `buildReviewTask` expectations are unchanged.
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts` — add the `prdEdits` flag cases; the existing bodies (no flag) are unchanged.

**US-005**
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — add the `recordPrdEdits` cases; existing assertions are unchanged.
- `apps/api/test/integration/fleet/fleet-flow-rulings-migration.integration.spec.ts` — the generated client now selects `prdEditsJobId`, which only the new migration adds; apply `20261202090000_fleet_flow_prd_edits` after the rulings migration and before the first client read; the assertions still cover only what the rulings migration writes.
- `apps/api/test/integration/fleet/fleet-flow-answers-migration.integration.spec.ts` — it already applies the later rulings migration so the client read works; also apply `20261202090000_fleet_flow_prd_edits` before that read, for the same reason; the assertions are unchanged.

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — add the rule 2 and rule 3 cases; existing cases are unchanged (they pass no `specReviewCount`, which keeps `dispatch PLAN`, and no PRD_REVIEW verdict in them carries edits).

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — add the `applyPrdEdits` guard, write and `unchanged` cases; the existing `apply` cases are unchanged.

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — add the `applyPrdEdits` recovery, stale, refused, conflict and forge-error cases; existing cases are unchanged.

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — "AC-11: retains the applied SPEC_REVIEW despite its old ref and dispatches PLAN" makes its `countJobsForStepSince` stub return 2 for `SPEC_REVIEW` so PLAN is still dispatched (with one pass counted the same flow now dispatches the second `SPEC_REVIEW`); the other cases are unchanged here.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — in "dispatches the exact %s body using durable PLAN/feature data", the `PRD_REVIEW` case of a nax-entry flow adds `prdEdits: true` to the expected `buildStepDispatch` input (the `RUN` and `FIX` bodies ignore the flag and are unchanged); new advance cases go in the new advance PRD-edits spec file this story creates, not here.
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts` — "AC-1/AC-2: commits SPEC_REVIEW calls, then dispatches a linked PLAN on the second tick" now expects the second tick to dispatch a second `SPEC_REVIEW` job with `ref` equal to the calls commit (`c2`) and no `PLAN` job, because the first pass's calls lead to pass 2; the calls-commit assertions of the first tick are unchanged.
- `apps/api/test/integration/fleet/fleet-flow-answers.integration.spec.ts` — the answered `SPEC_REVIEW` case (AC-1..7) now expects the tick after the calls commit to dispatch a second `SPEC_REVIEW` job (ref `c2`) instead of a `PLAN`, because the answered first pass leads to pass 2; the questions, answers and calls-commit assertions are unchanged.

**US-010**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — "US-004 AC-12 keeps second-round minor PRD stop" and "US-005 AC-9 stops findings in the second PRD_REVIEW round" now expect `{ kind: 'apply_prd_edits', jobId, edits: [], accepted: [<the finding>] }` instead of a `review_findings` stop, because a second-round finding is accepted; all other cases are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — "AC-14: counts PLAN jobs since approval to stop second-round findings" now asserts that the second-round finding goes to `calls.applyPrdEdits` (stubbed `unchanged`) and is not a `review_findings` stop; the `build()` harness gains `calls.applyPrdEdits` and `steps.recordPrdEdits` stubs; the other cases are unchanged.
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts` — "AC-10: PRD_REVIEW minor findings stop after two PLAN jobs since approval" seeds `resultBranch: BRANCH` on its two PLAN jobs (the `apply_prd_edits` pass needs the PLAN branch) and now expects the flow to stay `RUNNING`, `prdEditsJobId` to equal the review job id and one `flow.prd_edits` activity with the finding's summary in `accepted` (the verdict has no edits, so no forge call is made), instead of a `review_findings` stop.

### Seams

- US-001 `parsePrdEdits` is called by US-004's `parseFlowVerdict` (seam AC in US-004).
- US-002 `applyPrdEditsToText` is called by US-007's `FleetFlowCallsService.applyPrdEdits` (seam AC in US-007).
- US-005 `recordPrdEdits` is called by US-010's `advancePrdEdits` (seam AC in US-010).
- US-007 `FleetFlowCallsService.applyPrdEdits` is called by US-010 through `FleetFlowAdvanceService.advance` (seam AC in US-010).
- US-004's `prdEdits` dispatch flag is set by US-009's `dispatchStep` (seam AC in US-009).

## Acceptance Criteria

### US-001: PRD edit parsing

1. [unit] `parsePrdEdits([{ story: 'US-001', op: 'replace_ac', old: 'a', new: 'b' }])` returns that one edit.
2. [unit] `parsePrdEdits` returns `null` for an entry whose `op` is `rename_story`.
3. [unit] `parsePrdEdits` returns `null` for a `remove_ac` entry whose `old` is an empty string.
4. [unit] `parsePrdEdits` returns `null` for a `replace_ac` entry whose `new` is an empty string.
5. [unit] `parsePrdEdits` accepts a `replace_description` entry whose `new` is an empty string.
6. [unit] `parsePrdEdits` returns `null` when the value is an object rather than an array.
7. [unit] `parsePrdEdits` returns `null` for an entry whose `story` is not a string.
8. [unit] `parsePrdEdits` keeps an `add_ac` `new` of 500 code units at its full length.
9. [unit] `parsePrdEdits` returns `null` for a `replace_ac` entry whose `old` is longer than `FLOW_PRD_EDIT_TEXT_MAX * 4` code units.
10. [unit] `parsePrdEdits` replaces a NUL character in a `new` value with U+FFFD.
11. [unit] `FLOW_PRD_EDITS_MAX` is 12.
12. [unit] `FLOW_PRD_EDIT_TEXT_MAX` is 400.

### US-002: Applying description and criterion edits

1. [unit] `applyPrdEditsToText` on a PRD whose `US-001` has acceptance criteria `['x', 'y']`, with `replace_ac` `old: 'y'`, `new: 'z'`, returns text whose parsed `userStories[0].acceptanceCriteria` is `['x', 'z']`.
2. [unit] That same call returns `applied: 1`.
3. [unit] `applyPrdEditsToText` with `replace_description` replaces the one occurrence of `old` in the story's `description`, keeping the text around it.
4. [unit] `applyPrdEditsToText` refuses a `replace_description` whose `old` occurs twice with `{ index: 0, story: 'US-001', op: 'replace_description', reason: 'text not unique' }`.
5. [unit] `applyPrdEditsToText` refuses a `replace_ac` whose `old` matches no criterion with reason `text not found`.
6. [unit] `applyPrdEditsToText` refuses an edit for story `US-404` with reason `unknown story`.
7. [unit] `applyPrdEditsToText` refuses a `replace_ac` on a story whose `acceptanceCriteria` is a string with reason `story malformed`.
8. [unit] `applyPrdEditsToText` refuses a `replace_ac` whose `new` equals its `old` with reason `no change`.
9. [unit] `applyPrdEditsToText` refuses a `replace_ac` whose `new` equals another of the story's criteria with reason `duplicate criterion`.
10. [unit] `applyPrdEditsToText` with `remove_ac` `old: 'x'` on criteria `['x', 'y']` returns criteria `['y']`.
11. [unit] `applyPrdEditsToText` refuses a `remove_ac` of a story's only acceptance criterion with reason `last criterion`.
12. [unit] `applyPrdEditsToText` with `add_ac` `new: 'w'` on criteria `['x']` returns criteria `['x', 'w']`.
13. [unit] `applyPrdEditsToText` refuses an `add_ac` whose `new` is already one of the story's criteria with reason `duplicate criterion`.
14. [unit] With a refused edit at index 0 and a valid edit at index 1, `applyPrdEditsToText` applies the edit at index 1.

### US-003: Applying context-file edits, the caps and the output text

1. [unit] `applyPrdEditsToText` appends `src/a.ts` to a story's `contextFiles` when it is absent.
2. [unit] `applyPrdEditsToText` refuses `add_context_file` with path `../secrets` with reason `invalid path`.
3. [unit] `applyPrdEditsToText` refuses `add_context_file` of a path already in `contextFiles` with reason `duplicate path`.
4. [unit] `applyPrdEditsToText` with `remove_context_file` of a listed path returns a `contextFiles` without that path.
5. [unit] `applyPrdEditsToText` refuses `remove_context_file` of a path not in `contextFiles` with reason `path not listed`.
6. [unit] `applyPrdEditsToText` with 13 valid `add_ac` edits refuses the edit at index 12 with reason `over limit`.
7. [unit] `applyPrdEditsToText` refuses an `add_ac` whose `new` is 401 code units with reason `text too long`.
8. [unit] `applyPrdEditsToText` returns `{ kind: 'unreadable' }` for text that is not JSON.
9. [unit] `applyPrdEditsToText` returns `{ kind: 'unreadable' }` for a JSON object with no `userStories` array.
10. [unit] `applyPrdEditsToText` keeps every key the edits do not touch (`analysis`, `branchName`, a story's `dependencies`).
11. [unit] `applyPrdEditsToText` returns text equal to `JSON.stringify(<edited document>, null, 2) + '\n'`.

### US-004: PRD_REVIEW verdict and task carry edits

1. [unit] `parseFlowVerdict('{"findings":[]}')` returns `{ ok: true, findings: [], prdEdits: [] }`.
2. [unit] `parseFlowVerdict` on `{"findings":[],"prdEdits":[{"story":"US-001","op":"add_ac","new":"n"}]}` returns `ok: true` with that one edit in `prdEdits`.
3. [unit] Seam: `parseFlowVerdict` obtains `prdEdits` from `parsePrdEdits` — with `parsePrdEdits` stubbed to return `null`, a verdict that has a `prdEdits` key parses as `{ ok: false }`.
4. [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: true })` ends with `FLOW_VERDICT_INSTRUCTION` followed by a blank line and `FLOW_PRD_EDITS_INSTRUCTION`.
5. [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: true })` equals `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')`.
6. [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: false })` equals the three-argument call.
7. [unit] `FLOW_PRD_EDITS_INSTRUCTION` names each of the six ops `replace_description`, `replace_ac`, `remove_ac`, `add_ac`, `add_context_file` and `remove_context_file`.
8. [unit] `FLOW_PRD_EDITS_INSTRUCTION` includes the sentence `Do not edit any file: the flow commits your edits.`
9. [unit] `FLOW_PRD_EDITS_INSTRUCTION` includes the text `the object must still start with {"findings".`
10. [unit] Seam: `buildStepDispatch` for `PRD_REVIEW` with `prdEdits: true` returns an `agent.task` equal to `buildReviewTask('PRD_REVIEW', <specPath>, <feature>, { prdEdits: true })`.
11. [unit] `buildStepDispatch` for `PRD_REVIEW` with no `prdEdits` returns the `agent.task` of the three-argument `buildReviewTask`.

### US-005: PRD-edits marker column and repository

1. [integration] After the migrations, a `FleetFlowFeature` row created without `prdEditsJobId` reads it back as `null`.
2. [integration] `recordPrdEdits(flowId, featureId, 'job-1')` sets that feature's `prdEditsJobId` to `job-1`.
3. [integration] `recordPrdEdits` leaves the feature's `callsJobId` unchanged.
4. [integration] `recordPrdEdits` leaves the feature's `rulingsJobId` unchanged.
5. [integration] `recordPrdEdits` with a `featureId` that belongs to a different flow changes no row.
6. [integration] The flow repository's feature record (`findById`) exposes the stored `prdEditsJobId`.

### US-006: Two-pass spec review rule and the no-findings PRD edits rule

1. [unit] A COMPLETED `SPEC_REVIEW` with one `minor` finding, `canApplyCalls: true`, `callsJobId` equal to its id and `specReviewCount: 1` returns `{ kind: 'dispatch', step: 'SPEC_REVIEW' }`.
2. [unit] The same input with `specReviewCount: 2` returns `{ kind: 'dispatch', step: 'PLAN' }`.
3. [unit] The same input with `specReviewCount` absent returns `{ kind: 'dispatch', step: 'PLAN' }`.
4. [unit] A COMPLETED `SPEC_REVIEW` with an empty verdict and `specReviewCount: 1` returns `{ kind: 'dispatch', step: 'PLAN' }`.
5. [unit] A second-pass `SPEC_REVIEW` (`specReviewCount: 2`) with one `minor` finding and no recorded calls returns `apply_calls` for that job.
6. [unit] A COMPLETED `PRD_REVIEW` with no findings, one edit, `canApplyCalls: true` and `planCount: 1` returns `{ kind: 'apply_prd_edits', jobId, edits: [<the edit>], accepted: [] }`.
7. [unit] The same input with `prdEditsJobId` equal to the job id returns `{ kind: 'dispatch', step: 'RUN' }`.
8. [unit] A COMPLETED `PRD_REVIEW` with no findings and one edit but `canApplyCalls: false` returns `{ kind: 'dispatch', step: 'RUN' }`.
9. [unit] A first-round `PRD_REVIEW` (`planCount: 1`) with one `minor` finding and one edit returns `apply_calls` with that finding.

### US-007: Committing PRD edits on the flow branch

1. [unit] With the branch head equal to `expectedHead` and one applicable edit, `applyPrdEdits` calls `putFile` once for `.nax/features/<feature>/prd.json` on the flow branch with the head file's blob sha.
2. [unit] That `putFile` call carries the message `chore(<feature>): flow PRD edits from PRD_REVIEW job <jobId>`.
3. [unit] That call returns `{ kind: 'committed', sha: <putFile commitSha>, applied: 1, refused: [] }`.
4. [unit] Seam: `FleetFlowCallsService.applyPrdEdits` computes the written content with `applyPrdEditsToText` — with `applyPrdEditsToText` stubbed to return `{ kind: 'ok', text: 'T', applied: 1, refused: [] }`, `putFile` receives content `T`.
5. [unit] With `action.edits` empty it returns `{ kind: 'unchanged', refused: [] }` without minting a token.
6. [unit] When every edit is refused it returns `{ kind: 'unchanged', refused: <the refusals> }`.
7. [unit] When every edit is refused it never calls `putFile`.
8. [unit] When `prd.json` is missing at the head it returns `{ kind: 'failed', detail: 'prd.json missing on <branch>' }`.
9. [unit] When the file at the head is not a PRD it returns `{ kind: 'failed', detail: 'prd.json unreadable' }`.
10. [unit] When the repo has no GitHub installation it returns `{ kind: 'failed', detail: 'repo not connected' }`.
11. [unit] When the flow has no feature it returns `{ kind: 'failed', detail: 'feature missing' }`.

### US-008: PRD edit commit recovery and write failures

1. [unit] When the head differs from `expectedHead` and is not our single-file commit, `applyPrdEdits` returns `{ kind: 'stale', head }`.
2. [unit] In that stale case it never calls `putFile`.
3. [unit] When the head differs, `isSingleFileCommit(expectedHead, head, <prd path>)` is true and the file at the head equals the edits applied to the file at `expectedHead`, it returns `committed` with `sha` equal to the head.
4. [unit] In that recovered case it never calls `putFile`.
5. [unit] When `isSingleFileCommit` is true but the file at the head differs from the expected edited text, it returns `{ kind: 'stale', head }`.
6. [unit] A `putFile` result of kind `refused` returns `{ kind: 'failed', detail: 'prd.json write refused' }`.
7. [unit] A `conflict` whose re-read shows the same blob sha returns `{ kind: 'failed', detail: 'prd.json write refused' }`.
8. [unit] A `conflict` whose re-read shows a different blob sha returns `{ kind: 'retry' }`.
9. [unit] A `RepoCheckException` with reason `app_not_installed` returns `{ kind: 'failed', detail: 'app_not_installed' }`.
10. [unit] A `RepoCheckException` with reason `provider_error` returns `{ kind: 'retry' }`.

### US-009: Advance runs the second spec pass and flags PRD_REVIEW dispatches

1. [unit] `advance` on a flow whose latest job is a COMPLETED `SPEC_REVIEW` calls `steps.countJobsForStepSince(flowId, 'SPEC_REVIEW', approvedAt)`.
2. [unit] `advance` on a flow whose latest job is a COMPLETED `PLAN` never calls `countJobsForStepSince` with `'SPEC_REVIEW'`.
3. [unit] `advance` on a nax-entry flow whose latest job is a COMPLETED first-pass `SPEC_REVIEW` with recorded calls (`countJobsForStepSince` returns 1 for `SPEC_REVIEW`) dispatches a `SPEC_REVIEW` job.
4. [unit] That dispatched `SPEC_REVIEW` job's `ref` equals the flow's current `specSha` (the calls commit).
5. [unit] With `countJobsForStepSince` returning 2 for `SPEC_REVIEW`, the same flow dispatches `PLAN`.
6. [unit] `advance` on a flow whose latest job is a COMPLETED `PRD_REVIEW` with one edit and `prdEditsJobId` equal to that job's id dispatches `RUN`.
7. [unit] Seam: `advance` dispatching `PRD_REVIEW` for a nax-entry flow sends a body equal to `buildStepDispatch({ ..., prdEdits: true })`.
8. [unit] `advance` dispatching `PRD_REVIEW` for a thread-entry flow sends a task that does not include `FLOW_PRD_EDITS_INSTRUCTION`.

### US-010: Advance applies PRD edits and accepts second-round findings

1. [unit] `decideFlowStep` on a second-round `PRD_REVIEW` (`planCount: 2`, `canApplyCalls: true`) with one `minor` finding and one edit returns `{ kind: 'apply_prd_edits', jobId, edits: [<the edit>], accepted: [<the finding>] }`.
2. [unit] `decideFlowStep` on that review with `prdEditsJobId` equal to the job id returns `{ kind: 'dispatch', step: 'RUN' }`.
3. [unit] `decideFlowStep` on a second-round `PRD_REVIEW` with 21 `minor` findings returns a `review_findings` stop.
4. [unit] Seam: `advance` on a nax-entry flow whose latest job is a COMPLETED `PRD_REVIEW` with one edit and no findings calls `calls.applyPrdEdits(flow, { kind: 'apply_prd_edits', jobId, edits, accepted: [] }, <the PLAN's resultSha>)` once.
5. [unit] That `advance` dispatches no job.
6. [unit] Seam: on a `committed` outcome `advance` calls `steps.recordPrdEdits(flowId, featureId, jobId)`.
7. [unit] On a `committed` outcome `advance` records one `flow.prd_edits` activity with payload `{ jobId, sha: <commit sha>, applied: 1, refused: [], accepted: [] }`.
8. [unit] On an `unchanged` outcome `advance` records `flow.prd_edits` with `sha: null` and `applied: 0`.
9. [unit] On a second-round `PRD_REVIEW` whose `minor` finding's summary contains a lone surrogate, the `flow.prd_edits` payload's `accepted` holds that summary with U+FFFD in its place.
10. [unit] On a `stale` outcome `advance` calls `flowService.reaskLocked(<flow>, head, now)` and not `recordPrdEdits`.
11. [unit] On a `failed` outcome with detail `prd.json unreadable` `advance` stops the flow with reason `calls_failed` and detail `PRD_REVIEW edits: prd.json unreadable`.
12. [unit] When the flow is stopped between `applyPrdEdits` and the record, `advance` does not call `recordPrdEdits`.
13. [unit] A flow whose creator lost dispatch access stops `creator_lost_access` without calling `applyPrdEdits`.
14. [unit] When the PLAN pushed to a branch other than the flow's, `advance` calls `steps.setBranch(flowId, <PLAN resultBranch>)` before `applyPrdEdits`.
15. [unit] After the edits are recorded (`prdEditsJobId` = the `PRD_REVIEW` job id), the next `advance` dispatches `RUN` with `ref` equal to the PLAN's `resultBranch`.

### US-011: Manual-loop reviews against the database

1. [integration] After `FleetFlowTicker.tick` on a nax-entry flow whose first `SPEC_REVIEW` returned one `minor` finding, `putFile` has been called once for the spec.
2. [integration] The next `tick` creates a second `SPEC_REVIEW` job linked to the flow with `ref` equal to the calls commit sha.
3. [integration] When that second `SPEC_REVIEW` returned one `minor` finding, the `tick` after its calls commit creates a `PLAN` job.
4. [integration] No third `SPEC_REVIEW` job exists after that `tick`.
5. [integration] After the PLAN completes, a `tick` over a `PRD_REVIEW` whose output carries one `replace_ac` edit and no findings makes one `putFile` of `prd.json` whose content has that criterion replaced.
6. [integration] After that `tick`, `FleetFlowFeature.prdEditsJobId` equals the review job id.
7. [integration] After that `tick`, one `flow.prd_edits` activity row exists for the flow.
8. [integration] The `tick` after the edit commit creates a `RUN` job linked to the flow.
