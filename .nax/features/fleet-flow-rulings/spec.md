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
- **Refused rulings are skipped, not fatal.** A ruling that `ruleTarget` refuses (unknown item, CI item, invalid text,
  already applied) or whose item index is missing is not recorded; the flow lists the refused ones in one Finish
  ticket comment and continues to `FIX`. If the PR stays held, the human is asked anyway.
- **When RULE runs.** Automatically only when the RUN's outcome is `draft` and at least one open item of kind
  `advisor`, `ruling`, `cannot-verify`, `story` or `reason` has no applied ruling; otherwise `REVIEW` goes straight to
  `FIX`. A guided `RULE` (after a human answer) always runs. The task lists every open item that is not `finding` or
  `ci` and has no applied ruling (gates included, so a guided round can rule `fixed <sha>`).
- **RULE ref** is the RUN's `resultBranch` (the PR's head branch), so a guided round sees `FIX`'s push.
- **Questions from RULE** use the F4b path: positional ids, at most `FLOW_CALLS_MAX_FINDINGS` (20); more is a stop.
  An answered `RULE` question, like an answered `FIX` hold, dispatches a new guided `RULE`; answers are never turned
  into rulings directly, so every ruling keeps the agent's evidence.
- **CI holds stop.** A `FIX` whose `readyHeld` starts with `CI ` stops `pr_not_ready` (nobody can rule a CI item).
  Thread-entry flows keep F4b's behaviour: no waits, a held `FIX` stops `pr_not_ready` and `RULE` questions stop
  `review_ambiguous`.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `FlowStep` (`apps/api/src/fleet/flows/flow-steps.ts:3`). Baseline:
  `'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX'`. Target: adds `'RULE'`.
- `FlowStepInput` (`apps/api/src/fleet/flows/flow-step-decision.ts:23`). Target: adds
  `run: { outcome: string | null; openItems: FlowOpenItem[] } | null` (the feature's latest `RUN` job's
  `workflow`), `appliedItemIds: string[]` (items of that RUN whose latest ruling is `applied`) and
  `rulingsJobId: string | null` (the `RULE` job whose rulings were recorded).
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
  Target: `'USER' | 'AGENT' | 'SYSTEM'`.
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
  `recordRulings(flowId: string, featureId: string, jobId: string): Promise<void>`.
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
- `buildRuleTask` returns: `Rule the open workflow items of PR #<n>.`, a blank line, one line per item
  `- <id> (<kind>[, <severity>])[ <file>[:<line>]]: <issue>[ Suggestion: <suggestion>]`, then (guided only) a
  `Guidance from the user:` block with the held reason line `Still held: <held>` when present and one
  `Q<id>: <question> A: <answer>` line per answer, then a blank line and `FLOW_RULING_INSTRUCTION`. The item and
  guidance block is cut (whole lines dropped from the end, then a final `(N more items not shown)` line) so the task
  stays within `AGENT_TASK_MAX_LENGTH` with the instruction always complete.
- `parseRuleVerdict` reads the last line that starts with `{"rulings"` and parses it as JSON. `rulings` and
  `questions` must be arrays (either may be empty); each ruling needs non-blank string `item` and `ruling`, each
  question non-blank `item` and `question`; anything else, trailing text after the object, or no such line is
  `{ ok: false }`. More than `FLOW_RULINGS_MAX` rulings is `{ ok: false }`.

`FleetPrRulingsService.createForFlow`:

```ts
export type FlowRulingInput = { projectId: string; projectSlug: string; runJobId: string; itemId: string; text: string;
  creator: { type: 'USER' | 'AGENT'; id: string }; approvalRequestId: string | null; flowId: string };
export type FlowRulingOutcome = { kind: 'recorded'; rulingId: string } | { kind: 'refused'; reason: string };
```

Outside any transaction it runs `ruleTarget` then `assertItemIndex`; a thrown app exception becomes
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
5. `RULE` with no questions: `rulingsJobId === job.id` -> `dispatch FIX` with the feature PR; otherwise
   `apply_rulings` with the job id and the verdict's rulings (possibly empty).
6. `FIX` COMPLETED and ready (`markedReady` true, or false with no `readyHeld`) -> `complete` (unchanged).
7. `FIX` held, `readyHeld` starting with `CI ` -> stop `pr_not_ready` with `readyHeld` (unchanged detail).
8. `FIX` held, `canApplyCalls` false, or `fixReady` null -> stop `pr_not_ready` (unchanged).
9. `FIX` held (nax entry): `questionsJobId === job.id && answers !== null` -> `dispatch RULE` with
   `rule: { answeredJobId: job.id }`; otherwise `wait_answer` step `FIX`, one question id `1`:
   `PR still held after FIX <id>: <readyHeld>. Answer with guidance for one more ruling and FIX round, or stop the flow.`

Advance (`FleetFlowAdvanceService`):

- `decisionInput`: `run` from `latestJobForStep(flowId, 'RUN')`'s `workflow` (null when no RUN or no workflow),
  `appliedItemIds` from `FleetPrRulingsService.appliedItemIds(run.id)` (empty without a RUN), `rulingsJobId` from
  the feature.
- `apply_rulings` leaves the decide transaction like `apply_calls` (creator-access check first, no cost-cap check:
  rulings are not billed). `advanceRulings` calls `createForFlow` once per ruling, in verdict order, outside any
  transaction; then in one transaction (flow still live): `recordRulings(flowId, featureId, ruleJobId)`, one
  `flow.rulings` activity record `{ jobId, recorded, refused }`, and, when any were refused, one system comment on the
  Finish ticket of the RUN listing `Flow rulings refused (RULE job <id>): <item> (<reason>)` per refused ruling.
- `RULE` dispatch: `ref` = the RUN's `resultBranch`, `prNumber` = the feature PR, items =
  `ruleTaskItems(run.openItems, appliedItemIds)`, guidance = when `answeredJobId` is set, the feature's stored
  `questions` and `answers` plus `held` = that job's `fixReady.readyHeld` when it is a `FIX` (else null).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| RULE output has no rulings JSON | stop `verdict_unreadable` |
| RULE job FAILED / CANCELLED / CRASHED / ESCALATED | stop `step_failed` (existing rule) |
| A ruling refused by `ruleTarget` or the item-index check | skipped, listed in one Finish ticket comment, flow continues |
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
- A new permission key or approval for the RULE step or the flow's rulings.
- Cancelling a running job when the flow stops.

## Stories

### US-001: Rule task and RULE step

No dependencies. Workdir: `apps/api`.

`FlowStep` gains `RULE`; the pure task half of `flow-rulings.ts`: `FlowOpenItem`, `FLOW_RULE_KINDS`,
`ruleTaskItems`, `needsAutomaticRule`, `FLOW_RULING_INSTRUCTION`, `buildRuleTask`.

### US-002: Rule verdict parser

No dependencies. Workdir: `apps/api`.

`parseRuleVerdict`, `FlowRuling`, `FlowRuleQuestion`, `FLOW_RULINGS_MAX` in `flow-rulings.ts`.

### US-003: System ruling actor

No dependencies. Workdir: `apps/api`.

`actorType` `SYSTEM` in the ruling domain, `pendingForFix` naming, `snapshotForFix` `by`, and
`createSystemRulingComment` on the ticket effects.

### US-004: Recording a flow ruling

Depends on US-003. Workdir: `apps/api`.

`FleetPrRulingsService.createForFlow` and `appliedItemIds`.

### US-005: Rulings column and repository

No dependencies. Workdir: `apps/api`.

Migration adding `FleetFlowFeature.rulingsJobId`, the record field and mappers, and `recordRulings`.

### US-006: Decision after REVIEW and RULE

Depends on US-001, US-002. Workdir: `apps/api`.

`FlowStepInput` and `FlowStepAction` changes and rules 1-5.

### US-007: Decision after FIX

Depends on US-006. Workdir: `apps/api`.

Rules 6-9.

### US-008: RULE dispatch body

Depends on US-001. Workdir: `apps/api`.

The `RULE` case of `buildStepDispatch`.

### US-009: Questions payload and comment for RULE and FIX

No dependencies. Workdir: `apps/api`.

Widen `FleetFlowQuestionsPayload.step`, `parseFlowQuestionsPayload` and `formatQuestionsComment` to `RULE` and `FIX`.

### US-010: Advance records rulings and dispatches RULE

Depends on US-004, US-005, US-006, US-007, US-008. Workdir: `apps/api`.

`decisionInput` fields, `apply_rulings` handling (`advanceRulings`), and `RULE` dispatch inputs.

### US-011: PR-phase rulings against the database

Depends on US-009, US-010. Workdir: `apps/api`.

An integration spec driving a nax-entry flow from a draft RUN through RULE, recorded rulings, FIX dispatch with the
rulings snapshot, a held FIX, the wait, the answers and the guided RULE.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-steps.ts` — `FlowStep`, `FLOW_VERDICT_INSTRUCTION` and `buildReviewTask` as the task-building precedent.
- `apps/api/src/fleet/common/agent-jobs.ts` — `AGENT_TASK_MAX_LENGTH`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobWorkflowItem`.
- `apps/api/src/fleet/flows/flow-calls.ts` — `FlowQuestion`, `FlowAnswer`.

**US-002**
- `apps/api/src/fleet/flows/flow-verdict.ts` — `parseFlowVerdict`, the last-marker parsing precedent.
- `apps/api/src/fleet/flows/flow-rulings.ts` — created by US-001, extended here.

**US-003**
- `apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts` — `FleetPrRuling`, `PendingFixRuling`.
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts` — `pendingForFix`, `toDomain`.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `snapshotForFix`.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `createRulingComment`, `commentOnFinish`.

**US-004**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `create`, `ruleTarget`, `assertItemIndex`.
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts` — `runAsSystem('flow', ..., { onBehalfOf })` and `ActorPrincipalLoader` usage.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.spec.ts` — existing service test harness.
- `apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts` — repository interface.

**US-005**
- `apps/api/prisma/schema.prisma` — `FleetFlowFeature`.
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — `recordCalls` precedent.
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — feature row mapping.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` — repository interface.

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.ts` — the decision being extended.
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — `input()` fixture and job helpers.
- `apps/api/src/fleet/flows/flow-rulings.ts` — created by US-001 and US-002.
- `apps/api/src/fleet/flows/flow-calls.ts` — `flowQuestions`, `formatQuestions`, `FLOW_CALLS_MAX_FINDINGS`.

**US-007**
- `apps/api/src/fleet/flows/flow-step-decision.ts` — the FIX branch.
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — existing FIX cases.

**US-008**
- `apps/api/src/fleet/flows/flow-step-dispatch.ts` — `buildStepDispatch`.
- `apps/api/src/fleet/flows/flow-step-dispatch.spec.ts` — existing dispatch body tests.
- `apps/api/src/fleet/flows/flow-rulings.ts` — `buildRuleTask` (created by US-001).

**US-009**
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — questions payload and parser.
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — parser tests.
- `apps/api/src/fleet/flows/flow-calls.ts` — `formatQuestionsComment`.
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — existing comment tests.

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decide`, `decisionInput`, `advanceCalls`, `dispatchStep`, `writeDecision`.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — the advance harness used for calls.
- `apps/api/src/fleet/flows/flows.module.ts` — provider wiring; `FleetPrRulingsService` must be injectable here.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `createForFlow`, `appliedItemIds` (extended by US-004).

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-answers.integration.spec.ts` — seeding a nax-entry flow and answering.
- `apps/api/test/integration/fleet/fleet-pr-rulings-ingest.integration.spec.ts` — seeding a draft RUN with `workflow.openItems`.
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — driving `advance` ticks.

### Creates

**US-001**
- `apps/api/src/fleet/flows/flow-rulings.ts`
- `apps/api/src/fleet/flows/flow-rulings.spec.ts`

**US-005**
- `apps/api/prisma/migrations/20261201090000_fleet_flow_rulings/migration.sql`

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-advance-rulings.spec.ts`

**US-011**
- `apps/api/test/integration/fleet/fleet-flow-rulings.integration.spec.ts`

### Modifies

**US-003**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.snapshot.spec.ts` — add the `koda:system:flow` snapshot case next to the user and agent `by` cases; existing assertions are unchanged.

**US-006**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — the `input()` fixture (line ~10) gains `run: null, appliedItemIds: [], rulingsJobId: null`; existing assertions are unchanged (REVIEW with `run: null` still dispatches FIX).

**US-009**
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — any case asserting that a step other than `SPEC_REVIEW`/`PRD_REVIEW` is malformed now uses an unknown step such as `PLAN`; `RULE` and `FIX` are accepted.

**US-010**
- `apps/api/src/fleet/flows/flows.module.spec.ts` — the module compiles with `FleetPrRulingsService` (or its module) available to `FleetFlowAdvanceService`; provide it as a `useValue` stub where the spec stubs collaborators.

### Seams

- US-004 `createForFlow` is called by US-010's `advanceRulings` (seam AC in US-010).
- US-005 `recordRulings` is called by US-010 (seam AC in US-010).
- US-001 `buildRuleTask` is called by US-008's `buildStepDispatch` (seam AC in US-008).
- US-009's widened payload is consumed by the questions ticket subscriber when US-010 writes a `RULE`/`FIX` wait
  (covered by US-011).

## Acceptance Criteria

### US-001: Rule task and RULE step

1. [unit] `ruleTaskItems` over items of kinds `finding`, `ci`, `advisor`, `gate`, `story` with no applied ids returns the `advisor`, `gate` and `story` items in input order.
2. [unit] `ruleTaskItems` drops an `advisor` item whose id is in `appliedItemIds`.
3. [unit] `needsAutomaticRule` returns `false` when the only remaining items are of kind `gate` and `finding`.
4. [unit] `needsAutomaticRule` returns `true` when one remaining item is of kind `cannot-verify`.
5. [unit] `needsAutomaticRule` returns `false` when the only `reason` item's id is in `appliedItemIds`.
6. [unit] `buildRuleTask({ prNumber: 7, items: [advisorItem], guidance: null })` starts with `Rule the open workflow items of PR #7.` and contains the line `- D-1 (advisor, high) src/a.ts:12: <issue> Suggestion: <suggestion>` for an item with those fields.
7. [unit] An item with no severity, file, line or suggestion renders as `- R-1 (reason): <issue>`.
8. [unit] `buildRuleTask` ends with a blank line followed by `FLOW_RULING_INSTRUCTION`.
9. [unit] With guidance `{ held: '2 open item(s): G-1, D-1', questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }] }` the task contains `Guidance from the user:`, `Still held: 2 open item(s): G-1, D-1` and `Q1: q A: a`.
10. [unit] With guidance whose `held` is null the task has no `Still held:` line.
11. [unit] With 2,000 items the returned task is at most `AGENT_TASK_MAX_LENGTH` characters, ends with the complete `FLOW_RULING_INSTRUCTION`, and contains a line `(N more items not shown)` with N equal to the number of item lines dropped.
12. [unit] `FLOW_RULING_INSTRUCTION` names each keyword form `verified:`, `confirm:`, `override:`, `waive:` and `fixed <head sha>`, and ends with the exact JSON shape line `{"rulings":[{"item":"<id>","ruling":"<keyword line and evidence>"}],"questions":[{"item":"<id>","question":"<question>"}]}`.
13. [unit] A value typed `FlowStep` accepts `'RULE'` (a function taking `FlowStep` returns it unchanged when called with `'RULE'`).

### US-002: Rule verdict parser

1. [unit] `parseRuleVerdict` of output ending with the line `{"rulings":[{"item":"D-1","ruling":"verified: test green"}],"questions":[]}` returns `{ ok: true, rulings: [{ item: 'D-1', ruling: 'verified: test green' }], questions: [] }`.
2. [unit] When two `{"rulings"` lines appear, the last one is parsed.
3. [unit] `parseRuleVerdict(null)` returns `{ ok: false }`.
4. [unit] Output with no line starting `{"rulings"` returns `{ ok: false }`.
5. [unit] A `{"rulings"` line that is not valid JSON returns `{ ok: false }`.
6. [unit] Text on a line after the JSON line returns `{ ok: false }`.
7. [unit] A verdict whose `questions` is missing returns `{ ok: false }`.
8. [unit] A ruling with a blank `ruling` string returns `{ ok: false }`.
9. [unit] A question with a non-string `question` returns `{ ok: false }`.
10. [unit] A verdict with 101 rulings returns `{ ok: false }` and one with exactly `FLOW_RULINGS_MAX` (100) returns `ok: true`.
11. [unit] `{"rulings":[],"questions":[{"item":"S-2","question":"Which?"}]}` returns `ok: true` with one question and no rulings.

### US-003: System ruling actor

1. [unit] `pendingForFix` maps a pending row with `actorType: 'SYSTEM'`, `actorId: 'flow'` to `actorName: 'flow'` without querying users or agents for it.
2. [unit] `snapshotForFix` sends a pending `SYSTEM` ruling with `by: 'koda:system:flow'`.
3. [unit] `snapshotForFix` still sends a `USER` ruling as `koda:user:<name>` and an `AGENT` ruling as `koda:agent:<slug>` (guard for the existing mapping).
4. [unit] `toDomain` of a stored row with `actorType: 'SYSTEM'` returns `actorType: 'SYSTEM'`.
5. [unit] `FleetJobTicketEffects.createSystemRulingComment('t1', 'body')` calls the repository's `createSystemComment` with `('t1', 'body', CommentType.RULING)` and returns its `{ id }`.

### US-004: Recording a flow ruling

1. [unit] `createForFlow` with an eligible advisor item calls `repo.insert` once with `actorType: 'SYSTEM'`, `actorId: 'flow'`, `itemId`, `itemKind: 'advisor'`, `disposition: 'verified'` for text `verified: test green`, `state: 'pending'` and the input's `approvalRequestId`, and returns `{ kind: 'recorded', rulingId }` with the inserted id.
2. [unit] It calls `ruleTarget` and `assertItemIndex` before opening the transaction, and `ruleTarget` again after `lockTarget(projectSlug, runJobId)` inside it.
3. [unit] When the pre-transaction `ruleTarget` throws `fleet.rulings.notRulable` (a `ci` item), it returns `{ kind: 'refused', reason: 'fleet.rulings.notRulable' }` and never calls `lockTarget` or `insert`.
4. [unit] When `assertItemIndex` throws `fleet.rulings.noItemIndex`, it returns `{ kind: 'refused', reason: 'fleet.rulings.noItemIndex' }` and never inserts.
5. [unit] When the in-transaction `ruleTarget` throws `fleet.rulings.settled`, it returns `refused` with that reason and never inserts.
6. [unit] When `ActorPrincipalLoader` throws `ActorUnavailableError` for the creator, it returns `{ kind: 'refused', reason: 'creator unavailable' }` and never inserts.
7. [unit] It calls `ensureFinishTicket({ id: runJobId }, creatorPrincipal)` with the principal loaded for the input's `creator`.
8. [unit] It calls `createSystemRulingComment(ticketId, 'D-1 (advisor): verified: test green (flow f1)')` and stores the returned id as the ruling's `commentId`.
9. [unit] It calls `replacePending(runJobId, itemId)` before `insert`.
10. [unit] It records one audit entry with key `system.flow.advance`, resource `fleet_job` / `runJobId`, and summary `flow ruled D-1: verified`.
11. [unit] The audit and insert run inside a `runAsSystem('flow', ...)` context whose `onBehalfOf` is the input's creator (the action context seen by `audit.record` has actor `SYSTEM` / `flow`).
12. [unit] `appliedItemIds('r1')` returns the ids of RUN `r1`'s items whose latest ruling state is `applied`.
13. [unit] `appliedItemIds('r1')` omits an item whose latest ruling state is `pending`, `skipped` or `replaced`.

### US-005: Rulings column and repository

1. [integration] After the migration, a `FleetFlowFeature` row accepts `rulingsJobId` null and a string, and an existing row reads `rulingsJobId` null.
2. [integration] `recordRulings(flowId, featureId, 'j1')` sets that feature's `rulingsJobId` to `j1` and leaves `callsJobId`, `questionsJobId`, `questions` and `answers` unchanged.
3. [integration] `FleetFlowRepository.findById` returns the feature with `rulingsJobId: 'j1'` after `recordRulings`.
4. [integration] `recordRulings` for a feature id that belongs to another flow changes no row.

### US-006: Decision after REVIEW and RULE

1. [unit] `decideFlowStep` for a COMPLETED `REVIEW`, a feature PR, `run: { outcome: 'draft', openItems: [advisorItem] }` and no applied ids returns `{ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: null } }`.
2. [unit] For a COMPLETED `REVIEW` with `run.outcome: 'ready'` and the same items it returns `dispatch FIX` with the feature PR number.
3. [unit] For a COMPLETED `REVIEW` with a `draft` RUN whose only items are of kind `finding` and `gate` it returns `dispatch FIX`.
4. [unit] For a COMPLETED `REVIEW` with `run: null` it returns `dispatch FIX` (guard for flows whose RUN carries no workflow).
5. [unit] For a COMPLETED `RULE` whose `agentOutput` has no rulings JSON it returns `{ kind: 'stop', reason: 'verdict_unreadable', detail: 'RULE job <id>: no rulings JSON in the agent output' }`.
6. [unit] For a COMPLETED `RULE` with rulings and no questions, `rulingsJobId` null, it returns `{ kind: 'apply_rulings', jobId: <id>, rulings }` with the verdict's rulings.
7. [unit] For a COMPLETED `RULE` with an empty rulings list and no questions it returns `apply_rulings` with `rulings: []`.
8. [unit] For a COMPLETED `RULE` whose id equals `rulingsJobId` it returns `{ kind: 'dispatch', step: 'FIX', pr: { number: <feature PR> } }`.
9. [unit] For a COMPLETED `RULE` with one question and `canApplyCalls: true` it returns `{ kind: 'wait_answer', step: 'RULE', jobId: <id>, questions: [{ id: '1', question: 'S-2: Which?' }] }`.
10. [unit] For the same `RULE` with `canApplyCalls: false` it returns a stop with reason `review_ambiguous`.
11. [unit] For a `RULE` with 21 questions and `canApplyCalls: true` it returns a stop with reason `review_ambiguous`.
12. [unit] For a `RULE` with questions where `questionsJobId` equals its id and `answers` is non-null it returns `{ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: <id> } }`.
13. [unit] For a FAILED `RULE` job it returns a stop with reason `step_failed` (guard for the existing failed-job rule).

### US-007: Decision after FIX

1. [unit] A COMPLETED `FIX` with `fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' }`, `canApplyCalls: true`, no stored answers, returns `{ kind: 'wait_answer', step: 'FIX', jobId: <id>, questions: [{ id: '1', question: 'PR still held after FIX <id>: 1 open item(s): G-1. Answer with guidance for one more ruling and FIX round, or stop the flow.' }] }`.
2. [unit] The same `FIX` with `questionsJobId` equal to its id and non-null `answers` returns `{ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: <id> } }`.
3. [unit] A held `FIX` whose `questionsJobId` names an older job returns `wait_answer` (answers to an older wait never start a round).
4. [unit] A held `FIX` with `readyHeld: 'CI failure: test'` and `canApplyCalls: true` returns `{ kind: 'stop', reason: 'pr_not_ready', detail: 'CI failure: test' }`.
5. [unit] A held `FIX` with `readyHeld: 'CI no-checks: no CI check reported within 20m 0s'` returns a `pr_not_ready` stop.
6. [unit] A held `FIX` with `canApplyCalls: false` returns a `pr_not_ready` stop with the `readyHeld` detail.
7. [unit] A `FIX` with `fixReady: null` and `canApplyCalls: true` returns `{ kind: 'stop', reason: 'pr_not_ready', detail: 'FIX ended without a ready result' }`.
8. [unit] A `FIX` with `markedReady: true` returns `complete`, and one with `markedReady: false` and no `readyHeld` returns `complete` (guards for #411).

### US-008: RULE dispatch body

1. [unit] `buildStepDispatch` with `step: 'RULE'` and `rule: { ref: 'feat/x', prNumber: 7, items, guidance: null }` returns `command: 'AGENT'`, `feature`, `ref: 'feat/x'`, `bashMode: 'raw'`, `repoId`, `maxCostUsd` from the remaining cap and `agent: { name: reviewAgent, model: flow.reviewerRole, task }`.
2. [unit] The returned `agent.task` equals `buildRuleTask({ prNumber: 7, items, guidance: null })` for the same input (spy or direct comparison).
3. [unit] A flow with `pinnedRunnerId` set carries it on the `RULE` body.
4. [unit] `buildStepDispatch` with `step: 'RULE'` and no `rule` input throws `RULE requires the RUN branch and PR`.

### US-009: Questions payload and comment for RULE and FIX

1. [unit] `parseFlowQuestionsPayload` accepts a payload with `step: 'RULE'` and returns it with `step: 'RULE'`.
2. [unit] It accepts `step: 'FIX'`.
3. [unit] It returns `null` for `step: 'PLAN'`.
4. [unit] `formatQuestionsComment({ step: 'FIX', jobId: 'j9', questions: [{ id: '1', question: 'q' }], answerPath })` starts with `Flow needs answers (FIX job j9):` and contains `1. q`.

### US-010: Advance records rulings and dispatches RULE

1. [unit] A tick whose decision is `apply_rulings` with two rulings calls `FleetPrRulingsService.createForFlow` twice, in verdict order, with the RUN job id, each ruling's item and text, the flow's creator, `approvalRequestId` and project slug.
2. [unit] After the rulings are recorded it calls `recordRulings(flowId, featureId, ruleJobId)` once.
3. [unit] When one ruling returns `{ kind: 'refused', reason: 'fleet.rulings.notRulable' }` it still records the other and calls `recordRulings`, and posts one system comment on the RUN's Finish ticket containing `Flow rulings refused (RULE job <id>): C-1 (fleet.rulings.notRulable)`.
4. [unit] When no ruling is refused it posts no refused comment.
5. [unit] `apply_rulings` is not stopped by a spent cost cap (no `cost_cap` stop when `spentUsd` equals `costCapUsd`), but a creator without dispatch access stops `creator_lost_access`.
6. [unit] `createForFlow` is never called inside the decide transaction (the transaction manager's `run` is not active when the stub is called).
7. [unit] A tick deciding `dispatch RULE` with `answeredJobId: null` dispatches an `AGENT` body whose `ref` is the latest RUN's `resultBranch` and whose task lists the RUN's open items minus `finding`/`ci` and applied ones.
8. [unit] A tick deciding `dispatch RULE` with `answeredJobId` naming a held `FIX` dispatches a task containing `Still held: <that FIX's readyHeld>` and the stored answers as `Q<id>: <question> A: <answer>` lines.
9. [unit] A tick deciding `dispatch RULE` with `answeredJobId` naming a `RULE` job dispatches a task with the answers and no `Still held:` line.
10. [unit] A `dispatch RULE` when the latest RUN has no `resultBranch` stops the flow `dispatch_refused` with detail `RULE: RUN has no result branch`.
11. [unit] `decisionInput` passes `run` from the latest RUN's `workflow`, `appliedItemIds` from `FleetPrRulingsService.appliedItemIds(runId)` and `rulingsJobId` from the feature to `decideFlowStep` (spy on the decision input).
12. [unit] A `wait_answer` decision with step `FIX` calls `setWaiting` with the FIX job id and records a `fleet_flow_questions` outbox event with `step: 'FIX'`.

### US-011: PR-phase rulings against the database

1. [integration] A nax-entry flow whose RUN is a draft with open items `D-1` (advisor) and `F-1` (finding), after a COMPLETED REVIEW, dispatches a `RULE` `AGENT` job on the next `advance` tick.
2. [integration] With that RULE job COMPLETED and output ending `{"rulings":[{"item":"D-1","ruling":"verified: test green"}],"questions":[]}`, the next tick stores one `FleetPrRuling` for `D-1` with `actorType` `SYSTEM`, `actorId` `flow`, state `pending`, and the feature's `rulingsJobId` equals the RULE job id (with the item-index forge read stubbed to find the marker).
3. [integration] The Finish ticket for the RUN exists and carries a `RULING` comment `D-1 (advisor): verified: test green (flow <flowId>)` with no author user or agent.
4. [integration] The following tick dispatches a `FIX` job whose `prRulings` snapshot (with the PR head read stubbed) contains the `D-1` ruling with `by: 'koda:system:flow'`.
5. [integration] With that FIX COMPLETED and `fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' }`, the next tick moves the flow and feature to `WAITING_ANSWER` with `questionsJobId` equal to the FIX id, and the questions ticket comment starts `Flow needs answers (FIX job <id>):`.
6. [integration] After `FleetFlowsService.answer` with that job id and answer `re-run the gate after the fix`, the next tick dispatches a `RULE` job whose `agentInput.task` contains `Still held: 1 open item(s): G-1` and `A: re-run the gate after the fix`.
7. [integration] A held FIX with `readyHeld: 'CI failure: test'` stops the flow `pr_not_ready` instead of waiting.
