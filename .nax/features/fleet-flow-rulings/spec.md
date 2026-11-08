<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Flow PR-phase rulings (fleet flow, after F4b)

## Summary

A flow's PR phase no longer stops when the RUN publishes a draft. After `REVIEW`, a new `RULE` step (an `AGENT` job on
the reviewer model, read-only) rules the RUN's open workflow items the way the nax-finish skill does, with evidence,
and koda records each ruling through Arc A's ruling store as the system `flow` actor on behalf of the flow's creator.
The single `FIX` that follows carries those rulings (`--rulings`), fixes the findings, and readies the PR. That is the
one automatic round. When `FIX` leaves the PR held (a red gate, items it could not close), a nax-entry flow asks the
human instead of stopping: one ticket comment and notification (the F4b question path), and the human's answer is
the guidance for one more `RULE` + `FIX` round. Every further round needs a new answer. CI holds still stop.

## Motivation

Live flows 7-9 (fleet design doc §9.174-§9.176) reach `FIX`, but a draft PR whose open items need rulings stops the
flow `pr_not_ready`, and the human has to rule each item through `POST .../fleet/jobs/:id/rulings` and dispatch
`FIX` by hand. The flow design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, Steps, step 2.5) says the
finish is "Arc A's rulings by agent, then the ready step"; Arc A (#390) already lets an agent rule an item and a
`FIX` apply the rulings.

## Design

### User rulings (2026-11-08)

1. **The agent rules and settles.** The flow's reviewer agent writes the rulings; there is no per-item human ask.
2. **Rule before the single FIX.** Order is `RUN` -> `REVIEW` -> `RULE` -> `FIX`. Arc A validates rulings against the
   RUN's stored open items and `FIX` picks pending rulings up at dispatch, so one `FIX` both applies the rulings and
   readies the PR.
3. **Ruling rules follow the nax-finish skill** (cross-checked): findings and code-gap stories get no ruling (`FIX`
   fixes them); advisor/ruling items are verified (`verified:`), confirmed only for a code change `nax bot fix` can
   push (`confirm:`, never for a PRD or AC edit) or overridden (`override:`); `defer` is not a ruling;
   cannot-verify items are `verified:` or `waive:` with the reason; out-of-scope stories are `waive:` citing the spec
   or PRD; a gate is `fixed <sha>` only after a green re-run on the head; a CI item is never ruled. Every ruling's
   first line is its keyword and the rest carries the evidence.
4. **One automatic round; any extra round asks the human.** If the PR is still held after the `FIX`, the flow waits
   for a human answer (nax entry), which starts exactly one more `RULE` + `FIX` round with the answer as guidance.
   The human can stop instead (the existing stop route).
5. **A red gate is the agent's to fix**: `FIX` tries the code fix; the guided `RULE` after it re-runs the gate and
   rules `fixed <sha>` when it is green.

### Calls made while drafting (not user rulings)

- **Ruling actor.** A flow ruling is stored with `actorType: 'SYSTEM'`, `actorId: 'flow'` (the column is a string, no
  migration) and the flow's `approvalRequestId`; it runs under `runAsSystem('flow', ..., { onBehalfOf: creator })`,
  as the flow's stop tickets do. The Finish ticket is created with the creator's principal; the ruling comment is a
  system-authored `RULING` comment. `snapshotForFix` sends it to nax as `by: koda:system:flow`.
- **No new permission or approval.** The in-process ruling path skips the route gate: the flow's approval covers it.
  It still runs every eligibility check of `ruleTarget` and the item-index check of `assertItemIndex`.
- **Refused rulings are skipped, not fatal.** A ruling for an item that is not in the RULE task (a finding, a CI
  item, an unknown id), or one that `ruleTarget` refuses (invalid text, already applied) or whose item index is
  missing, is not recorded. The flow lists the refused ones in one `commentOnRulingResult` comment on the RUN's
  tickets (the Finish ticket; nothing is posted when no ticket exists, i.e. every ruling was refused) and in the
  `flow.rulings` activity record, and continues to `FIX`. If the PR stays held, the human is asked anyway.
- **Recording is idempotent.** `createForFlow` returns the existing ruling, with no new comment, audit or insert, when
  the item's latest ruling is `pending`, `SYSTEM`-authored and has the same text, so a tick that crashed after some
  rulings re-runs safely.
- **Questions take precedence over rulings in one verdict.** A RULE verdict with both is a wait: its rulings are
  not recorded, and the guided RULE after the answer rules again with the answers in hand.
- **The item-index check runs per ruling** (`assertItemIndex`, at most `FLOW_RULINGS_MAX` per RULE job); caching it
  is left out.
- **The ruling contract.** `FleetPrRulingDto.actorType`'s enum gains `SYSTEM` and `openapi.json` is regenerated
  (`bun run api:export-spec`) in the same story, as F4b did for its route; the web and CLI types are out of scope.
- **When RULE runs.** Automatically only when the RUN's outcome is `draft` and at least one open item of kind
  `advisor`, `ruling`, `cannot-verify`, `story` or `reason` has no applied ruling; otherwise `REVIEW` goes straight to
  `FIX`. A guided `RULE` (after a human answer) always runs. The task lists every open item that is not `finding` or
  `ci` and has no applied ruling (gates included, so a guided round can rule `fixed <sha>`).
- **RULE ref** is the RUN's `resultBranch` (the PR's head branch), so a guided round sees `FIX`'s push.
- **Questions from RULE** use the F4b path: positional ids, at most `FLOW_CALLS_MAX_FINDINGS` (20); more is a stop.
  An answered `RULE` question, like an answered `FIX` hold, dispatches a new guided `RULE`; answers are never turned
  into rulings directly, so every ruling keeps the agent's evidence.
- **Decision inputs load lazily.** `run` and `appliedItemIds` are read only when the latest job is `REVIEW` or
  `RULE`, so earlier steps add no reads.
- **CI holds stop.** A `FIX` whose `readyHeld` starts with `CI ` stops `pr_not_ready` (nobody can rule a CI item).
  Thread-entry flows keep F4b's behaviour: no waits, a held `FIX` stops `pr_not_ready` and `RULE` questions stop
  `review_ambiguous`.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `FlowStep` (`apps/api/src/fleet/flows/flow-steps.ts:3`). Baseline:
  `'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX'`. Target: adds `'RULE'`.
- `FlowStepInput` (`apps/api/src/fleet/flows/flow-step-decision.ts:23`). Target: adds OPTIONAL
  `run?: { outcome: string | null; openItems: FlowOpenItem[] } | null` (the feature's latest `RUN` job's
  `workflow`), `appliedItemIds?: string[]` (items of that RUN whose latest ruling is `applied`) and
  `rulingsJobId?: string | null` (the `RULE` job whose rulings were recorded); absent reads as `null` / `[]`, so
  `decisionInput` compiles before US-011 fills them.
- `FlowStepAction` (same file :53). Target: the `dispatch` variant gains optional
  `rule?: { answeredJobId: string | null }`; a new variant
  `{ kind: 'apply_rulings'; jobId: string; rulings: FlowRuling[] }`; `wait_answer.step` widens to
  `'SPEC_REVIEW' | 'PRD_REVIEW' | 'RULE' | 'FIX'`.
- `decideFlowStep` (same file :76). Target: the PR-phase rules in Approach.
- `buildStepDispatch` (`apps/api/src/fleet/flows/flow-step-dispatch.ts:30`) and `BuildStepDispatchInput` (:14).
  Target: input gains optional `rule?: { ref: string; prNumber: number; items: FlowOpenItem[]; guidance:
  FlowRuleGuidance | null }`; a `RULE` case returns `{ command: 'AGENT', feature, ref: rule.ref, bashMode: 'raw',
  agent: { name: reviewAgent, task: buildRuleTask(...), model: flow.reviewerRole } }` plus the common fields.
- `FleetPrRuling.actorType` (`apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts:15`). Baseline: `'USER' | 'AGENT'`.
  Target: `'USER' | 'AGENT' | 'SYSTEM'`. `FleetPrRulingDto.actorType` (`apps/api/src/fleet/rulings/dto/fleet-pr-ruling.dto.ts:14`)
  enum: `['USER', 'AGENT', 'SYSTEM']`.
- `FleetPrRulingsService` constructor (`apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts:25`). Target: gains
  `ActorPrincipalLoader` as its last parameter.
- `FleetFlowAdvanceService` constructor (`apps/api/src/fleet/flows/fleet-flow-advance.service.ts:48`). Target:
  gains `FleetPrRulingsService` as its last parameter; `FlowsModule` imports `FleetRulingsModule` (no cycle: it is
  already reached through `FleetJobsModule`).
- `pendingForFix` (`apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts:98`). Target: a `SYSTEM` row's
  `actorName` is its `actorId`, with no user or agent lookup.
- `snapshotForFix` (`apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts:33`). Baseline `by` is
  `koda:agent:<name>` or `koda:user:<name>`. Target: a `SYSTEM` ruling is `koda:system:<actorId>`.
- `FleetPrRulingsService` (same file). Target: adds `createForFlow(input: FlowRulingInput): Promise<FlowRulingOutcome>`
  and `appliedItemIds(runJobId: string): Promise<string[]>`.
- `FleetJobTicketEffects` (`apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`). Target: adds
  `createSystemRulingComment(ticketId: string, body: string): Promise<{ id: string }>` over the repository's existing
  `createSystemComment(ticketId, body, CommentType.RULING)`.
- `FleetFlowFeature` (`apps/api/prisma/schema.prisma:1274` area) and `FleetFlowFeatureRecord`
  (`apps/api/src/fleet/flows/domain/fleet-flow.domain.ts:15`). Target: adds `rulingsJobId String?` /
  `rulingsJobId?: string | null`, mapped by the flow repositories like `callsJobId`.
- `IFleetFlowStepRepository` (`apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`). Target: adds
  `recordRulings(flowId: string, featureId: string, jobId: string): Promise<void>`, an
  `updateMany({ where: { id: featureId, flowId } })`.
- `FleetFlowAdvanceService` (`apps/api/src/fleet/flows/fleet-flow-advance.service.ts`). Target: `decisionInput`
  (:395 area) fills `run`, `appliedItemIds`, `rulingsJobId`; `decide` (:243) passes `apply_rulings` out of the decide
  transaction like `apply_calls`; a new `advanceRulings`; `RULE` dispatch reads the RUN, the guidance and the held
  reason; `writeDecision`'s `wait_answer` branch (:472) works unchanged for the new steps.
- `FleetFlowQuestionsPayload` and `parseFlowQuestionsPayload`
  (`apps/api/src/notifications/fleet/fleet-notification-events.ts:33`, :104). Target: `step` accepts `RULE` and `FIX`.
- `formatQuestionsComment` (`apps/api/src/fleet/flows/flow-calls.ts:79`). Target: `step` accepts `RULE` and `FIX`.

**Read-only symbols (unchanged)**

- `FleetPrRulingsService.ruleTarget(projectId, jobId, dto)`, `assertItemIndex(target)`, `latestRunForPr`; repository
  `lockTarget(slug, jobId)`, `replacePending`, `insert`, `latestRuling(jobId, itemId)`.
- `parseRulingText(text)` (`apps/api/src/fleet/rulings/ruling-keyword.ts:4`).
- `FleetJobTicketEffects.ensureFinishTicket(job, principal)` (:48).
- `ActorPrincipalLoader` (`apps/api/src/auth/principal/actor-principal.loader.ts`), `runAsSystem`
  (`apps/api/src/action-context/action-context.ts`).
- `FleetJobWorkflow` / `FleetJobWorkflowItem` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:130-148`): the
  RUN's `workflow.outcome` and `openItems` `{ id, kind, issue, severity, file, line, suggestion }`.
- `FleetFlowsService.answer` (`apps/api/src/fleet/flows/fleet-flows.service.ts:101`): step-agnostic, unchanged.
- `IFleetFlowStepRepository.latestJobForStep(flowId, step)`, `projectSlug(projectId)`, `setWaiting`.
- `FLOW_CALLS_MAX_FINDINGS`, `flowQuestions`, `AGENT_TASK_MAX_LENGTH` (16,384).

### Approach

New pure module `apps/api/src/fleet/flows/flow-rulings.ts`:

```ts
export type FlowOpenItem = { id: string; kind: string; issue: string; severity?: string | null;
  file?: string | null; line?: number | null; suggestion?: string | null };
export type FlowRuling = { item: string; ruling: string };
export type FlowRuleQuestion = { item: string; question: string };
export type FlowRuleGuidance = { held: string | null; questions: FlowQuestion[]; answers: FlowAnswer[] };
export const FLOW_RULE_KINDS = ['advisor', 'ruling', 'cannot-verify', 'story', 'reason'] as const;
export const FLOW_RULINGS_MAX = 100;
export const FLOW_RULING_INSTRUCTION: string;            // the rules below plus the verdict shape
export function ruleTaskItems(items: FlowOpenItem[], appliedItemIds: string[]): FlowOpenItem[];
export function needsAutomaticRule(items: FlowOpenItem[], appliedItemIds: string[]): boolean;
export function buildRuleTask(input: { prNumber: number; items: FlowOpenItem[]; guidance: FlowRuleGuidance | null }): string;
export function parseRuleVerdict(output: string | null):
  | { ok: true; rulings: FlowRuling[]; questions: FlowRuleQuestion[] } | { ok: false };
```

- `ruleTaskItems` keeps items whose kind is neither `finding` nor `ci` and whose id is not in `appliedItemIds`, in
  input order. `needsAutomaticRule` is true when any kept item's kind is in `FLOW_RULE_KINDS`.
- `FLOW_RULING_INSTRUCTION` states, one line each: rule only the listed items; never rule a finding; advisor or
  ruling items: `verified: <evidence>` when the premise holds and nothing remains to change, `confirm: <evidence>`
  only for a code change `nax bot fix` can push and never for a PRD or acceptance-criteria edit, `override: <reason>`
  when the premise is wrong; `defer` is not a ruling; cannot-verify items: `verified: <evidence>` after running what
  it names, else `waive: <why it cannot be checked>`; story items: `waive: <reason citing the spec or PRD line>`
  when out of scope or accepted, no ruling for a code gap; reason items: `verified: <evidence>` or
  `waive: <reason>`; gate items: re-run `nax gates run --gate <name> --json`, `fixed <head sha>` only when it is
  green at the head, no ruling when red; ask a question only when the answer changes what gets built and the spec,
  PRD and code do not settle it; end with one JSON object on its own line, no text after it:
  `{"rulings":[{"item":"<id>","ruling":"<keyword line and evidence>"}],"questions":[{"item":"<id>","question":"<question>"}]}`.
- `buildRuleTask` returns: `Rule the open workflow items of PR #<n>.`, a blank line, then (guided only) a
  `Guidance from the user:` block with the held reason line `Still held: <held>` when present and one
  `Q<id>: <question> A: <answer>` line per answer, a blank line, then one line per item
  `- <id> (<kind>[, <severity>])[ <file>[:<line>]]: <issue>[ Suggestion: <suggestion>]`, then a blank line and
  `FLOW_RULING_INSTRUCTION`. Every interpolated item, question and answer text is collapsed to one line first, so
  an `issue` with newlines cannot forge item lines. Only item lines are cut when the task would exceed
  `AGENT_TASK_MAX_LENGTH`: whole item lines are dropped from the end and a final `(N more items not shown)` line is
  added, so the guidance and the instruction are always complete.
- `parseRuleVerdict` reads the last line that starts with `{"rulings"` and parses it as JSON, tolerating a single
  trailing code-fence line after it as `parseFlowVerdict` does. `rulings` and `questions` must be arrays (either may
  be empty); each ruling needs non-blank string `item` and `ruling`, each question non-blank `item` and `question`;
  anything else, other trailing text after the object, or no such line is `{ ok: false }`. More than `FLOW_RULINGS_MAX` rulings is `{ ok: false }`.

`FleetPrRulingsService.createForFlow`:

```ts
export type FlowRulingInput = { projectId: string; projectSlug: string; runJobId: string; itemId: string; text: string;
  creator: { type: 'USER' | 'AGENT'; id: string }; approvalRequestId: string | null; flowId: string };
export type FlowRulingOutcome = { kind: 'recorded'; rulingId: string } | { kind: 'refused'; reason: string };
```

First, when `latestRuling(runJobId, itemId)` is `pending`, `actorType: 'SYSTEM'` and has the same trimmed text, it
returns `{ kind: 'recorded', rulingId: <that id> }` with no writes. Otherwise, outside any transaction it runs
`ruleTarget` then `assertItemIndex`; a thrown app exception becomes
`{ kind: 'refused', reason: <its message key> }`. Then, under `runAsSystem('flow', fn, { onBehalfOf: creator })`, in
one transaction: `lockTarget(projectSlug, runJobId)`, `ruleTarget` again (refusal -> `refused`), load the creator's
principal with `ActorPrincipalLoader` (unavailable -> `refused`, reason `creator unavailable`), `ensureFinishTicket`,
`createSystemRulingComment(ticketId, '<item> (<kind>): <text> (flow <flowId>)')`, `replacePending`, `insert` with
`actorType: 'SYSTEM'`, `actorId: 'flow'`, `approvalRequestId` from the input, and one audit record
`system.flow.advance` with summary `flow ruled <item>: <disposition>`.

`decideFlowStep` PR-phase rules (single-feature flows; all earlier rules unchanged):

1. `REVIEW` COMPLETED, `featurePrNumber` null -> `wait` (unchanged).
2. `REVIEW` COMPLETED: `run?.outcome === 'draft'` and `needsAutomaticRule(run.openItems, appliedItemIds)` ->
   `dispatch RULE` with `rule: { answeredJobId: null }`; otherwise `dispatch FIX` (unchanged shape).
3. `RULE` COMPLETED, verdict unreadable -> stop `verdict_unreadable`, detail `RULE job <id>: no rulings JSON in the
   agent output`.
4. `RULE` with questions: `canApplyCalls` false -> stop `review_ambiguous` (detail lists the questions); more than
   `FLOW_CALLS_MAX_FINDINGS` -> stop `review_ambiguous`; `questionsJobId === job.id && answers !== null` ->
   `dispatch RULE` with `rule: { answeredJobId: job.id }`; otherwise `wait_answer` step `RULE` with positional
   questions whose text is `<item>: <question>`.
5. `RULE` with no questions: `rulingsJobId === job.id` -> `dispatch FIX` with the feature PR (`wait` while
   `featurePrNumber` is null); otherwise `apply_rulings` with the job id and the verdict's rulings (possibly empty).
   A verdict with both rulings and questions follows rule 4 (its rulings are not recorded).
6. `FIX` COMPLETED and ready (`markedReady` true, or false with no `readyHeld`) -> `complete` (unchanged).
7. `FIX` held, `readyHeld` starting with `CI ` -> stop `pr_not_ready` with `readyHeld` (unchanged detail).
8. `FIX` held, `canApplyCalls` false, or `fixReady` null -> stop `pr_not_ready` (unchanged).
9. `FIX` held (nax entry): `questionsJobId === job.id && answers !== null` -> `dispatch RULE` with
   `rule: { answeredJobId: job.id }`; otherwise `wait_answer` step `FIX`, one question id `1`:
   `PR still held after FIX <id>: <readyHeld>. Answer with guidance for one more ruling and FIX round, or stop the flow.`

Advance (`FleetFlowAdvanceService`):

- `decisionInput` (only when the latest job's step is `REVIEW` or `RULE`): `run` from `latestJobForStep(flowId, 'RUN')`'s `workflow` (null when no RUN or no workflow),
  `appliedItemIds` from `FleetPrRulingsService.appliedItemIds(run.id)` (empty without a RUN), `rulingsJobId` from
  the feature.
- `apply_rulings` leaves the decide transaction like `apply_calls` (creator-access check first, no cost-cap check:
  rulings are not billed). `advanceRulings` calls `createForFlow` once per ruling, in verdict order, outside any
  transaction, skipping (as refused, reason `not in task`) any ruling whose item is not in
  `ruleTaskItems(run.openItems, appliedItemIds)`; then in one transaction under `lockLive` (nothing is written when
  the flow is no longer live): `recordRulings(flowId, featureId, ruleJobId)`, one `flow.rulings` activity record
  with payload `{ jobId, recorded: <item ids>, refused: [{ item, reason }] }`, and, when any were refused,
  `commentOnRulingResult(runId, 'Flow rulings refused (RULE job <id>): <item> (<reason>)[; ...]')`.
- `RULE` dispatch: `ref` = the RUN's `resultBranch`, `prNumber` = the feature PR, items =
  `ruleTaskItems(run.openItems, appliedItemIds)`, guidance = when `answeredJobId` is set, the feature's stored
  `questions` and `answers` plus `held` = that job's `fixReady.readyHeld` when it is a `FIX` (else null).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| RULE output has no rulings JSON | stop `verdict_unreadable` |
| RULE job FAILED / CANCELLED / CRASHED / ESCALATED | stop `step_failed` (existing rule) |
| A ruling for an item not in the RULE task | refused `not in task`, never recorded |
| A ruling refused by `ruleTarget` or the item-index check | skipped, listed in one Finish ticket comment, flow continues |
| Every ruling refused (no Finish ticket yet) | no comment; the refused list is in the `flow.rulings` activity |
| Tick crashes after recording some rulings | the next tick re-runs; already-recorded identical rulings are returned, not duplicated |
| RULE verdict with rulings and questions | wait for answers; rulings not recorded |
| Creator unavailable when recording | ruling refused (`creator unavailable`) |
| More than 20 RULE questions | stop `review_ambiguous` |
| FIX held by CI | stop `pr_not_ready` |
| FIX held, nax entry | `WAITING_ANSWER`, questions comment + notification |
| FIX held, thread entry | stop `pr_not_ready` |
| RUN has no `resultBranch` at RULE dispatch | stop `dispatch_refused`, detail `RULE: RUN has no result branch` |

## Out of Scope

- A flow-side code fix that does not go through `FIX` (`nax bot fix`); RULE never pushes.
- Ruling `ci` items; a CI hold stops the flow.
- Turning human answers directly into rulings; answers are guidance for a new RULE job.
- Waits for thread-entry flows; they keep F4b's stop behaviour.
- Multi-feature flows; `decideFlowStep` still skips them (F5).
- A web form for answering or showing rulings (F6); the flow DTO is unchanged.
- A notification when a flow completes.
- Refreshing a RUN's stored `openItems` after a FIX; rulings stay bound to the RUN snapshot (Arc A).
- `SYSTEM` in the web (`apps/web/lib/fleet-types.ts`) and generated CLI ruling types; the API DTO and `openapi.json` are updated.
- Caching the item-index forge read across the rulings of one RULE job.
- A new permission key or approval for the RULE step or the flow's rulings.
- Cancelling a running job when the flow stops.

## Stories

### US-001: Rule task

No dependencies. Workdir: `apps/api`.

The pure task half of `flow-rulings.ts`: `FlowOpenItem`, `FlowRuleGuidance`, `FLOW_RULE_KINDS`, `ruleTaskItems`,
`needsAutomaticRule`, `FLOW_RULING_INSTRUCTION`, `buildRuleTask`.

### US-002: Rule verdict parser

No dependencies. Workdir: `apps/api`.

`parseRuleVerdict`, `FlowRuling`, `FlowRuleQuestion`, `FLOW_RULINGS_MAX` in `flow-rulings.ts`.

### US-003: RULE step and dispatch body

Depends on US-001. Workdir: `apps/api`.

`FlowStep` gains `RULE` together with the `RULE` case of the exhaustive `buildStepDispatch` switch, so the type
check stays green.

### US-004: System ruling actor

No dependencies. Workdir: `apps/api`.

`actorType` `SYSTEM` in the ruling domain and DTO (with the regenerated `openapi.json`), `pendingForFix` naming,
`snapshotForFix` `by`, and `createSystemRulingComment` on the ticket effects.

### US-005: Recording a flow ruling

Depends on US-004. Workdir: `apps/api`.

`FleetPrRulingsService.createForFlow` (with `ActorPrincipalLoader` injected) and `appliedItemIds`.

### US-006: Rulings column and repository

No dependencies. Workdir: `apps/api`.

Migration adding `FleetFlowFeature.rulingsJobId`, the record field and mappers, and `recordRulings`.

### US-007: Decision after REVIEW and RULE

Depends on US-001, US-002, US-003. Workdir: `apps/api`.

Optional `FlowStepInput` fields, the `apply_rulings` action and `rule` dispatch option, the widened `wait_answer`
step, and rules 1-5.

### US-008: Decision after FIX

Depends on US-007. Workdir: `apps/api`.

Rules 6-9.

### US-009: Questions payload and comment for RULE and FIX

No dependencies. Workdir: `apps/api`.

Widen `FleetFlowQuestionsPayload.step`, `parseFlowQuestionsPayload` and `formatQuestionsComment` to `RULE` and `FIX`.

### US-010: Advance records rulings

Depends on US-005, US-006, US-007. Workdir: `apps/api`.

`FleetPrRulingsService` injected into `FleetFlowAdvanceService`, `FlowsModule` importing `FleetRulingsModule`, the
`apply_rulings` pass out of `decide` and `advanceRulings`.

### US-011: Advance dispatches RULE and waits after FIX

Depends on US-003, US-008, US-010. Workdir: `apps/api`.

`decisionInput`'s lazy `run`, `appliedItemIds` and `rulingsJobId`; the `RULE` dispatch inputs (ref, items,
guidance, held reason); the `FIX` wait.

### US-012: PR-phase rulings against the database

Depends on US-009, US-011. Workdir: `apps/api`.

An integration spec driving a nax-entry flow from a draft RUN through RULE, recorded rulings, FIX dispatch with the
rulings snapshot, a held FIX, the wait, the answers and the guided RULE.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-steps.ts` — `FLOW_VERDICT_INSTRUCTION` and `buildReviewTask` as the task-building precedent.
- `apps/api/src/fleet/common/agent-jobs.ts` — `AGENT_TASK_MAX_LENGTH`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobWorkflowItem`.
- `apps/api/src/fleet/flows/flow-calls.ts` — `FlowQuestion`, `FlowAnswer`, the one-line collapsing helper.

**US-002**
- `apps/api/src/fleet/flows/flow-verdict.ts` — `parseFlowVerdict`, the last-marker and trailing-fence precedent.
- `apps/api/src/fleet/flows/flow-rulings.ts` — created by US-001, extended here.

**US-003**
- `apps/api/src/fleet/flows/flow-steps.ts` — `FlowStep`.
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` — `buildStepDispatch`.
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts` — existing dispatch body tests.
- `apps/api/src/fleet/flows/flow-rulings.ts` — `buildRuleTask` (created by US-001).

**US-004**
- `apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts` — `FleetPrRuling`, `PendingFixRuling`.
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts` — `pendingForFix`.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `snapshotForFix`.
- `apps/api/src/fleet/rulings/dto/fleet-pr-ruling.dto.ts` — `FleetPrRulingDto`.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `createRulingComment`, `commentOnFinish`.

**US-005**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `create`, `ruleTarget`, `assertItemIndex`.
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts` — `runAsSystem('flow', ..., { onBehalfOf })` and `ActorPrincipalLoader` usage.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.spec.ts` — existing service test harness.
- `apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts` — repository interface (`latestRuling`, `list`).

**US-006**
- `apps/api/prisma/schema.prisma` — `FleetFlowFeature` (line ~1264).
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — `recordCalls` precedent.
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — feature row mapping.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` — repository interface.

**US-007**
- `apps/api/src/fleet/flows/flow-step-decision.ts` — the decision being extended.
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — `input()` fixture and job helpers.
- `apps/api/src/fleet/flows/flow-rulings.ts` — created by US-001 and US-002.
- `apps/api/src/fleet/flows/flow-calls.ts` — `flowQuestions`, `formatQuestions`, `FLOW_CALLS_MAX_FINDINGS`.

**US-008**
- `apps/api/src/fleet/flows/flow-step-decision.ts` — the FIX branch.
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — existing FIX cases.

**US-009**
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — questions payload and parser.
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — parser tests.
- `apps/api/src/fleet/flows/flow-calls.ts` — `formatQuestionsComment`.
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — existing comment tests.

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decide`, `advanceCalls`, `lockLive`, `writeDecision`.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — the advance harness used for calls.
- `apps/api/src/fleet/flows/flows.module.ts` — module imports.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `commentOnRulingResult`.

**US-011**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decisionInput`, `dispatchStep`, `writeDecision`'s `wait_answer` branch.
- `apps/api/src/fleet/flows/fleet-flow-advance-answers.spec.ts` — the advance harness used for waits and answers.
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` — the `rule` input (added by US-003).

**US-012**
- `apps/api/test/integration/fleet/fleet-flow-answers.integration.spec.ts` — seeding a nax-entry flow and answering.
- `apps/api/test/integration/fleet/fleet-pr-rulings-ingest.integration.spec.ts` — seeding a draft RUN with `workflow.openItems`.
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — driving `advance` ticks.

### Creates

**US-001**
- `apps/api/src/fleet/flows/flow-rulings.ts`
- `apps/api/src/fleet/flows/flow-rulings.spec.ts`

**US-004**
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.spec.ts`

**US-006**
- `apps/api/prisma/migrations/20261201090000_fleet_flow_rulings/migration.sql`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance-rulings.spec.ts`

**US-012**
- `apps/api/test/integration/fleet/fleet-flow-rulings.integration.spec.ts`

### Modifies

**US-003**
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts` — add the `RULE` body tests; existing step bodies and their assertions are unchanged.

**US-004**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.snapshot.spec.ts` — add the `koda:system:flow` case next to the user and agent `by` cases; existing assertions are unchanged.
- `openapi.json` — regenerated with `bun run api:export-spec`: the `FleetPrRulingDto.actorType` enum gains `SYSTEM`; nothing else changes.

**US-005**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.spec.ts` — the positional `new FleetPrRulingsService(...)` call (line ~23) gains an `ActorPrincipalLoader` stub as its last argument; existing assertions are unchanged.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.snapshot.spec.ts` — the positional constructor call (line ~16) gains the `ActorPrincipalLoader` stub; existing assertions are unchanged.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.preflight.spec.ts` — the positional constructor call (line ~23) gains the `ActorPrincipalLoader` stub; existing assertions are unchanged.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.results.spec.ts` — the positional constructor call (line ~13) gains the `ActorPrincipalLoader` stub; existing assertions are unchanged.
- `apps/api/src/fleet/tickets/finish-ticket.spec.ts` — the positional `new FleetPrRulingsService(...)` call (line ~48) gains the `ActorPrincipalLoader` stub; existing assertions are unchanged.

**US-006**
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — add the `rulingsJobId` / `recordRulings` cases; existing assertions are unchanged.

**US-007**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — add the REVIEW and RULE cases; the `input()` fixture (line ~10) is unchanged because the new fields are optional; existing assertions are unchanged.

**US-008**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — add the nax-entry FIX hold cases; the existing FIX cases (lines ~124-150) keep `canApplyCalls: false` and their assertions are unchanged.

**US-009**
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — add the `RULE` and `FIX` accepted-step cases; the existing malformed-step case (line ~97) is unchanged.
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — add the `FIX` questions-comment case; existing assertions are unchanged.

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — the positional `new FleetFlowAdvanceService(...)` call (line ~187) gains a `FleetPrRulingsService` stub as its last argument; existing assertions are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — the positional constructor call (line ~108) gains the `FleetPrRulingsService` stub; existing assertions are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — the positional constructor call (line ~121) gains the `FleetPrRulingsService` stub; existing assertions are unchanged.
- `apps/api/src/fleet/flows/fleet-flow-advance-answers.spec.ts` — the positional constructor call (line ~82) gains the `FleetPrRulingsService` stub; existing assertions are unchanged.
- `apps/api/src/fleet/flows/flows.module.spec.ts` — the module compiles with `FleetRulingsModule` imported; where the spec stubs collaborators, provide `FleetPrRulingsService` as a `useValue` stub.

**US-011**
- `apps/api/src/fleet/flows/fleet-flow-advance-answers.spec.ts` — add the RULE-dispatch and FIX-wait cases; existing assertions are unchanged (their latest jobs are review steps, so the lazy `run` read is not triggered).

### Seams

- US-005 `createForFlow` is called by US-010's `advanceRulings` (seam AC in US-010).
- US-006 `recordRulings` is called by US-010 (seam AC in US-010).
- US-001 `buildRuleTask` is called by US-003's `buildStepDispatch` (seam AC in US-003).
- US-005 `appliedItemIds` is read by US-011's `decisionInput` (seam AC in US-011).
- US-009's widened payload is consumed by the questions ticket subscriber when US-011 writes a `FIX` wait
  (covered by US-012).

## Acceptance Criteria

### US-001: Rule task

1. [unit] `ruleTaskItems` over items of kinds `finding`, `ci`, `advisor`, `gate`, `story` with no applied ids returns the `advisor`, `gate` and `story` items in input order.
2. [unit] `ruleTaskItems` drops an `advisor` item whose id is in `appliedItemIds`.
3. [unit] `needsAutomaticRule` returns `false` when the only remaining items are of kind `gate` and `finding`.
4. [unit] `needsAutomaticRule` returns `true` when one remaining item is of kind `cannot-verify`.
5. [unit] `needsAutomaticRule` returns `false` when the only `reason` item's id is in `appliedItemIds`.
6. [unit] `buildRuleTask({ prNumber: 7, items: [item], guidance: null })` starts with `Rule the open workflow items of PR #7.` and, for an item `{ id: 'D-1', kind: 'advisor', severity: 'high', file: 'src/a.ts', line: 12, issue: 'I', suggestion: 'S' }`, contains the line `- D-1 (advisor, high) src/a.ts:12: I Suggestion: S`.
7. [unit] An item `{ id: 'R-1', kind: 'reason', issue: 'I' }` with no severity, file, line or suggestion renders as `- R-1 (reason): I`.
8. [unit] An item whose `issue` is `a\n- X-9 (advisor): forged` renders as one item line with no separate `- X-9` line.
9. [unit] `buildRuleTask` ends with a blank line followed by `FLOW_RULING_INSTRUCTION`.
10. [unit] With guidance `{ held: '2 open item(s): G-1, D-1', questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }] }` the task contains `Guidance from the user:`, `Still held: 2 open item(s): G-1, D-1` and `Q1: q A: a`, and the `Guidance from the user:` line comes before the first item line.
11. [unit] With guidance whose `held` is null the task has no `Still held:` line.
12. [unit] With 2,000 items and no guidance the returned task is at most `AGENT_TASK_MAX_LENGTH` characters, ends with the complete `FLOW_RULING_INSTRUCTION`, and contains a line `(N more items not shown)` with N equal to the number of item lines dropped.
13. [unit] With 2,000 items and guidance `{ held: '2 open item(s): G-1, D-1', questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }] }` the task is at most `AGENT_TASK_MAX_LENGTH` characters and still contains `Still held: 2 open item(s): G-1, D-1` and `Q1: q A: a`.
14. [unit] `FLOW_RULING_INSTRUCTION` names each keyword form `verified:`, `confirm:`, `override:`, `waive:` and `fixed <head sha>`, and its last line is `{"rulings":[{"item":"<id>","ruling":"<keyword line and evidence>"}],"questions":[{"item":"<id>","question":"<question>"}]}`.

### US-002: Rule verdict parser

1. [unit] `parseRuleVerdict` of output ending with the line `{"rulings":[{"item":"D-1","ruling":"verified: test green"}],"questions":[]}` returns `{ ok: true, rulings: [{ item: 'D-1', ruling: 'verified: test green' }], questions: [] }`.
2. [unit] When two `{"rulings"` lines appear, the last one is parsed.
3. [unit] A verdict line followed by one line holding only a code fence (three backticks) is parsed as `ok: true`.
4. [unit] `parseRuleVerdict(null)` returns `{ ok: false }`.
5. [unit] Output with no line starting `{"rulings"` returns `{ ok: false }`.
6. [unit] A `{"rulings"` line that is not valid JSON returns `{ ok: false }`.
7. [unit] A prose line after the JSON line returns `{ ok: false }`.
8. [unit] A verdict whose `questions` is missing returns `{ ok: false }`.
9. [unit] A ruling with a blank `ruling` string returns `{ ok: false }`.
10. [unit] A question with a non-string `question` returns `{ ok: false }`.
11. [unit] A verdict with 101 rulings returns `{ ok: false }`.
12. [unit] A verdict with exactly `FLOW_RULINGS_MAX` (100) rulings returns `ok: true`.
13. [unit] `{"rulings":[],"questions":[{"item":"S-2","question":"Which?"}]}` returns `ok: true` with one question and no rulings.

### US-003: RULE step and dispatch body

1. [unit] `buildStepDispatch` with `step: 'RULE'` and `rule: { ref: 'feat/x', prNumber: 7, items, guidance: null }` returns `command: 'AGENT'`, the feature, `ref: 'feat/x'`, `bashMode: 'raw'`, the flow's `repoId`, `maxCostUsd` from the remaining cap and `agent: { name: reviewAgent, model: flow.reviewerRole }`.
2. [unit] The returned `agent.task` equals `buildRuleTask({ prNumber: 7, items, guidance: null })` for the same input.
3. [unit] A flow with `pinnedRunnerId` set carries it on the `RULE` body.
4. [unit] `buildStepDispatch` with `step: 'RULE'` and no `rule` input throws an error with message `RULE requires the RUN branch and PR`.

### US-004: System ruling actor

1. [unit] `PrismaFleetPrRulingRepository.pendingForFix` maps a pending row with `actorType: 'SYSTEM'`, `actorId: 'flow'` to `actorName: 'flow'`, with the stubbed agent and user lookups not asked for that id.
2. [unit] `snapshotForFix` sends a pending `SYSTEM` ruling with `by: 'koda:system:flow'`.
3. [unit] `snapshotForFix` still sends a `USER` ruling as `koda:user:<name>` and an `AGENT` ruling as `koda:agent:<slug>`.
4. [unit] The Swagger metadata of `FleetPrRulingDto.actorType` lists the enum `['USER', 'AGENT', 'SYSTEM']`.
5. [unit] `FleetJobTicketEffects.createSystemRulingComment('t1', 'body')` calls the repository's `createSystemComment` with `('t1', 'body', CommentType.RULING)` and returns its `{ id }`.

### US-005: Recording a flow ruling

1. [unit] `createForFlow` with an eligible advisor item and text `verified: test green` calls `repo.insert` once with `actorType: 'SYSTEM'`, `actorId: 'flow'`, `itemId`, `itemKind: 'advisor'`, `disposition: 'verified'`, `state: 'pending'` and the input's `approvalRequestId`, and returns `{ kind: 'recorded', rulingId }` with the inserted id.
2. [unit] It calls `ruleTarget` and `assertItemIndex` before opening the transaction, and `ruleTarget` again after `lockTarget(projectSlug, runJobId)` inside it.
3. [unit] When the pre-transaction `ruleTarget` throws `fleet.rulings.notRulable`, it returns `{ kind: 'refused', reason: 'fleet.rulings.notRulable' }` and never calls `lockTarget` or `insert`.
4. [unit] When `assertItemIndex` throws `fleet.rulings.noItemIndex`, it returns `{ kind: 'refused', reason: 'fleet.rulings.noItemIndex' }` and never inserts.
5. [unit] When the in-transaction `ruleTarget` throws `fleet.rulings.settled`, it returns `refused` with that reason and never inserts.
6. [unit] When `ActorPrincipalLoader.load` throws `ActorUnavailableError` for the creator, it returns `{ kind: 'refused', reason: 'creator unavailable' }` and never inserts.
7. [unit] It calls `ensureFinishTicket({ id: runJobId }, creatorPrincipal)` with the principal loaded for the input's `creator`.
8. [unit] It calls `createSystemRulingComment(ticketId, 'D-1 (advisor): verified: test green (flow f1)')` and stores the returned id as the ruling's `commentId`.
9. [unit] It calls `replacePending(runJobId, itemId)` before `insert`.
10. [unit] It records one audit entry with key `system.flow.advance`, resource `fleet_job` / `runJobId`, and summary `flow ruled D-1: verified`.
11. [unit] The action context seen by `audit.record` has actor `SYSTEM` / `flow` with `onBehalfOf` equal to the input's creator.
12. [unit] When `latestRuling(runJobId, itemId)` is `pending`, `actorType: 'SYSTEM'`, with the same trimmed text, it returns `{ kind: 'recorded', rulingId: <that id> }` and calls neither `insert`, `createSystemRulingComment` nor `audit.record`.
13. [unit] `appliedItemIds('r1')` returns the ids of RUN `r1`'s items whose latest ruling state is `applied`.
14. [unit] `appliedItemIds('r1')` omits an item whose latest ruling state is `pending`, `skipped` or `replaced`.

### US-006: Rulings column and repository

1. [integration] After the migration, a `FleetFlowFeature` row accepts `rulingsJobId` null and a string, and an existing row reads `rulingsJobId` null.
2. [integration] `recordRulings(flowId, featureId, 'j1')` sets that feature's `rulingsJobId` to `j1` and leaves `callsJobId`, `questionsJobId`, `questions` and `answers` unchanged.
3. [integration] `FleetFlowRepository.findById` returns the feature with `rulingsJobId: 'j1'` after `recordRulings`.
4. [integration] `recordRulings` with a feature id that belongs to another flow changes no row.

### US-007: Decision after REVIEW and RULE

1. [unit] `decideFlowStep` for a COMPLETED `REVIEW`, a feature PR, `run: { outcome: 'draft', openItems: [advisorItem] }` and no applied ids returns `{ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: null } }`.
2. [unit] For a COMPLETED `REVIEW` with `run.outcome: 'ready'` and the same items it returns `dispatch FIX` with the feature PR number.
3. [unit] For a COMPLETED `REVIEW` with a `draft` RUN whose only items are of kind `finding` and `gate` it returns `dispatch FIX`.
4. [unit] For a COMPLETED `REVIEW` with no `run` field it returns `dispatch FIX`.
5. [unit] For a COMPLETED `RULE` whose `agentOutput` has no rulings JSON it returns `{ kind: 'stop', reason: 'verdict_unreadable', detail: 'RULE job <id>: no rulings JSON in the agent output' }`.
6. [unit] For a COMPLETED `RULE` with rulings and no questions and no `rulingsJobId` it returns `{ kind: 'apply_rulings', jobId: <id>, rulings }` with the verdict's rulings.
7. [unit] For a COMPLETED `RULE` with an empty rulings list and no questions it returns `apply_rulings` with `rulings: []`.
8. [unit] For a COMPLETED `RULE` whose id equals `rulingsJobId` it returns `{ kind: 'dispatch', step: 'FIX', pr: { number: <feature PR> } }`.
9. [unit] For a COMPLETED `RULE` whose id equals `rulingsJobId` and a null `featurePrNumber` it returns `wait`.
10. [unit] For a COMPLETED `RULE` with one question, no rulings and `canApplyCalls: true` it returns `{ kind: 'wait_answer', step: 'RULE', jobId: <id>, questions: [{ id: '1', question: 'S-2: Which?' }] }`.
11. [unit] For a COMPLETED `RULE` with one ruling and one question and `canApplyCalls: true` it returns `wait_answer` (not `apply_rulings`).
12. [unit] For a COMPLETED `RULE` with one question, no rulings and `canApplyCalls: false` it returns a stop with reason `review_ambiguous`.
13. [unit] For a `RULE` with 21 questions and `canApplyCalls: true` it returns a stop with reason `review_ambiguous`.
14. [unit] For a `RULE` with questions where `questionsJobId` equals its id and `answers` is non-null it returns `{ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: <id> } }`.

### US-008: Decision after FIX

1. [unit] A COMPLETED `FIX` with `fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' }`, `canApplyCalls: true` and no stored answers returns `{ kind: 'wait_answer', step: 'FIX', jobId: <id>, questions: [{ id: '1', question: 'PR still held after FIX <id>: 1 open item(s): G-1. Answer with guidance for one more ruling and FIX round, or stop the flow.' }] }`.
2. [unit] The same `FIX` with `questionsJobId` equal to its id and non-null `answers` returns `{ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: <id> } }`.
3. [unit] A held `FIX` whose `questionsJobId` names an older job returns `wait_answer`.
4. [unit] A held `FIX` with `readyHeld: 'CI failure: test'` and `canApplyCalls: true` returns `{ kind: 'stop', reason: 'pr_not_ready', detail: 'CI failure: test' }`.
5. [unit] A held `FIX` with `readyHeld: 'CI no-checks: no CI check reported within 20m 0s'` and `canApplyCalls: true` returns a `pr_not_ready` stop.
6. [unit] A held `FIX` with `canApplyCalls: false` returns a `pr_not_ready` stop with the `readyHeld` detail.
7. [unit] A `FIX` with `fixReady: null` and `canApplyCalls: true` returns `{ kind: 'stop', reason: 'pr_not_ready', detail: 'FIX ended without a ready result' }`.
8. [unit] A `FIX` with `markedReady: true` and `canApplyCalls: true` returns `complete`.
9. [unit] A `FIX` with `markedReady: false`, no `readyHeld` and `canApplyCalls: true` returns `complete`.

### US-009: Questions payload and comment for RULE and FIX

1. [unit] `parseFlowQuestionsPayload` accepts a payload with `step: 'RULE'` and returns it with `step: 'RULE'`.
2. [unit] It accepts a payload with `step: 'FIX'` and returns it with `step: 'FIX'`.
3. [unit] It returns `null` for `step: 'PLAN'`.
4. [unit] `formatQuestionsComment({ step: 'FIX', jobId: 'j9', questions: [{ id: '1', question: 'q' }], answerPath })` starts with `Flow needs answers (FIX job j9):` and contains the line `1. q`.

### US-010: Advance records rulings

1. [unit] A tick whose decision is `apply_rulings` with rulings for `D-1` and `S-1` (both in the RULE task) calls `FleetPrRulingsService.createForFlow` twice, `D-1` first, each with the RUN job id, the ruling's item and text, the flow's creator, `approvalRequestId`, flow id and project slug.
2. [unit] After the rulings are recorded it calls `recordRulings(flowId, featureId, ruleJobId)` once.
3. [unit] A ruling for item `F-1` of kind `finding` is never passed to `createForFlow` and is listed as refused with reason `not in task`.
4. [unit] When one of two rulings returns `{ kind: 'refused', reason: 'fleet.rulings.notRulable' }` it still records the other, calls `recordRulings`, and calls `commentOnRulingResult(runId, body)` once with a body containing `Flow rulings refused (RULE job <id>): C-1 (fleet.rulings.notRulable)`.
5. [unit] When no ruling is refused it never calls `commentOnRulingResult`.
6. [unit] It records one `flow.rulings` activity whose payload is `{ jobId: <RULE id>, recorded: ['D-1'], refused: [{ item: 'C-1', reason: 'fleet.rulings.notRulable' }] }` when `D-1` is recorded and `C-1` is refused with `fleet.rulings.notRulable`.
7. [unit] When the flow is no longer live at the record transaction (`lockLive` returns null) it calls neither `recordRulings` nor the activity recorder.
8. [unit] With `spentUsd` equal to `costCapUsd`, an `apply_rulings` decision still calls `createForFlow` (no `cost_cap` stop).
9. [unit] When the creator has lost dispatch access, an `apply_rulings` decision stops the flow `creator_lost_access` and never calls `createForFlow`.
10. [unit] `createForFlow` is never called while the decide transaction is open (the stubbed transaction manager records no active `run` when the stub is invoked).

### US-011: Advance dispatches RULE and waits after FIX

1. [unit] With a COMPLETED `REVIEW` as the latest job, `decisionInput` passes `run` from the latest RUN's `workflow`, `appliedItemIds` from `FleetPrRulingsService.appliedItemIds(runId)` and `rulingsJobId` from the feature to `decideFlowStep`.
2. [unit] With a COMPLETED `PLAN` as the latest job, `decisionInput` never calls `appliedItemIds` or `latestJobForStep(flowId, 'RUN')`.
3. [unit] A tick deciding `dispatch RULE` with `answeredJobId: null` dispatches an `AGENT` body whose `ref` is the latest RUN's `resultBranch` and whose task lists the RUN's open items except `finding`, `ci` and applied ones.
4. [unit] A tick deciding `dispatch RULE` with `answeredJobId` naming a held `FIX` dispatches a task containing `Still held: <that FIX's readyHeld>` and the stored answers as `Q<id>: <question> A: <answer>` lines.
5. [unit] A tick deciding `dispatch RULE` with `answeredJobId` naming a `RULE` job dispatches a task with the stored answers and no `Still held:` line.
6. [unit] A `dispatch RULE` when the latest RUN has no `resultBranch` stops the flow `dispatch_refused` with detail `RULE: RUN has no result branch`.
7. [unit] A `wait_answer` decision with step `FIX` calls `setWaiting` with the FIX job id and records a `fleet_flow_questions` outbox event with `step: 'FIX'`.

### US-012: PR-phase rulings against the database

1. [integration] A nax-entry flow whose RUN is a draft with open items `D-1` (advisor) and `F-1` (finding), after a COMPLETED REVIEW, dispatches a `RULE` `AGENT` job on the next `advance` tick.
2. [integration] With that RULE job COMPLETED and output ending `{"rulings":[{"item":"D-1","ruling":"verified: test green"}],"questions":[]}`, the next tick stores one `FleetPrRuling` for `D-1` with `actorType` `SYSTEM`, `actorId` `flow` and state `pending`, and sets the feature's `rulingsJobId` to the RULE job id (the item-index forge read stubbed to find the marker).
3. [integration] The RUN's Finish ticket carries a `RULING` comment `D-1 (advisor): verified: test green (flow <flowId>)` with no author user or agent.
4. [integration] The following tick dispatches a `FIX` job whose `prRulings` snapshot (PR head read stubbed) contains the `D-1` ruling with `by: 'koda:system:flow'`.
5. [integration] With that FIX COMPLETED and `fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' }`, the next tick moves the flow and feature to `WAITING_ANSWER` with `questionsJobId` equal to the FIX id, and the questions ticket comment starts `Flow needs answers (FIX job <id>):`.
6. [integration] After `FleetFlowsService.answer` with that job id and answer `re-run the gate after the fix`, the next tick dispatches a `RULE` job whose `agentInput.task` contains `Still held: 1 open item(s): G-1` and `A: re-run the gate after the fix`.
7. [integration] A held FIX with `readyHeld: 'CI failure: test'` stops the flow `pr_not_ready` instead of waiting.
