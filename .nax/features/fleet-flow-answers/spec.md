<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Flow questions, answers and resume (fleet flow F4b)

Closes: #407

## Summary

A nax-entry flow whose review finds an `ambiguous` finding no longer stops. It moves to `WAITING_ANSWER`, stores
that review's questions on the feature, and posts them together as one comment on the flow's ticket with one
notification to the approver and the human creator. A human answers every question in one call,
`POST /projects/:slug/flows/:flowId/answers`. The flow then returns to `RUNNING`, and the next tick appends the
answers to the spec under `## Flow's calls` together with the review's `answered` and `minor` calls (the F4a calls
commit), and continues as F4a does: a spec review to `PLAN`, a PRD review to a re-run of `PLAN`. The PRD review
also stops re-reviewing the spec: its task now asks `/spec-review` for phase 9 (PRD fidelity) only.

## Motivation

F4a (§9.172 of the fleet design doc, 2026-11-07) classifies findings and applies `answered`/`minor` ones, but an
`ambiguous` finding still stops the flow (`review_ambiguous`), and a human has to start a new flow after editing the
spec by hand. The design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, Review verdicts and escalation)
asks for one batch of questions per step, answered by the user, applied like `answered` findings, with no new
approval.

The same live check showed that `PRD_REVIEW` re-runs the whole spec review (#407): it sends
`/spec-review --spec <spec> --prd <prd>`, and the skill always runs phases 1-6 before phase 9. All eight findings of
flow 5's two PRD reviews came from phases 1, 4, 5 and 7, none from phase 9, while the spec review minutes earlier was
clean. A re-plan cannot fix a spec opinion, so the second round stopped the flow. The spec-review skill gains a
`--phase 9` selector (nathapp-io/nax-spec-kit-skills#56), and koda sends it.

## Design

### User rulings (2026-11-07)

1. **Answers through an API, humans only.** `POST /projects/:slug/flows/:flowId/answers`; an agent principal is
   refused. The questions are one ticket comment plus a notification; the web form is F6.
2. **F4b scope:** `WAITING_ANSWER`, batched questions, answers and resume, plus #407 (PRD review is phase 9 only).
3. **The split above is approved:** questions are deterministic text (no billed supervisor job); answers must cover
   every question in one call; answers go into `## Flow's calls`, and the flow continues with no new approval;
   thread-entry flows still stop `review_ambiguous`; a new permission key `fleet.flow.answer`, granted to existing
   `developer` roles by a migration (as #402 did for the F1 keys).

### Calls made while drafting (not user rulings)

- **Question ids are positions.** A question's id is the 1-based position of its finding in the verdict's
  `findings` list (`"2"`, `"5"`), never the reviewer's own `id`: positions are unique and short, and a reviewer id
  can repeat or be blank. The comment shows the reviewer id next to the question.
- **Rule order.** A verdict with more than 20 findings stops `review_findings` before any wait, so a human is never
  asked questions the flow then cannot apply. A thread-entry flow with an `ambiguous` finding stops
  `review_ambiguous` exactly as in F4a.
- **Answers are bound to the review job.** The feature stores `questionsJobId`; answers apply only while the
  latest review job is that job. A new wait (a later review) replaces the questions and clears older answers.
- **An answered `PRD_REVIEW` re-plans even on the second round.** The F4a "second `PRD_REVIEW` round stops" rule
  applies only to a verdict with no `ambiguous` finding; each extra round needs a human's answers, so it is bounded
  by the human.
- **No timeout.** A flow waits for answers until a human answers or stops it (`POST .../stop` already accepts
  `WAITING_ANSWER`). No job runs and no cost accrues while it waits.
- **The phase-9 selector is sent unconditionally.** koda does not probe the runner's installed spec-review skill;
  a runner whose skill predates #56 runs its full review, as today.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `buildReviewTask` (`apps/api/src/fleet/flows/flow-steps.ts`).
  Baseline: `PRD_REVIEW` prompt `/spec-review --spec <specPath> --prd .nax/features/<feature>/prd.json`.
  Target: `/spec-review --spec <specPath> --prd .nax/features/<feature>/prd.json --phase 9`; `SPEC_REVIEW` unchanged.
- `FlowFinding` (`apps/api/src/fleet/flows/flow-verdict.ts`).
  Target: adds optional `answer?: string`. `parseFlowVerdict` never sets it (a reviewer cannot answer its own
  question); only the decision does.
- `buildFlowCalls` (`apps/api/src/fleet/flows/flow-calls.ts`).
  Baseline: only `answered` and `minor` findings produce bullets.
  Target: an `ambiguous` finding with a non-blank `answer` also produces a bullet,
  `- **<id>** (answer): <question> Answer: <answer>`, with `<id>` named as for the other bullets (reviewer id, else
  position) and question and answer each collapsed to one line and cut at `FLOW_CALL_TEXT_MAX`. An `ambiguous`
  finding without an answer still produces none.
- `FlowStepInput`, `FlowStepAction` and `decideFlowStep` (`apps/api/src/fleet/flows/flow-step-decision.ts`).
  Target: the input adds `questionsJobId: string | null` and `answers: FlowAnswer[] | null` (the feature's stored
  answers); the action union adds `{ kind: 'wait_answer'; step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; questions: FlowQuestion[] }`,
  exported as `WaitAnswerAction`. The rule order is in Approach.
- `FleetFlowFeatureRecord` (`apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`).
  Target: adds optional `questionsJobId?: string | null`, `questions?: FlowQuestion[] | null`,
  `answers?: FlowAnswer[] | null`, `answeredById?: string | null`, `answeredAt?: Date | null`.
- `IFleetFlowRepository` and `PrismaFleetFlowRepository` (`apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts`).
  Target: adds `recordAnswers(flowId: string, featureId: string, input: { answers: FlowAnswer[]; userId: string; at: Date }): Promise<FleetFlowRecord>`
  (sets the feature's `answers`, `answeredById`, `answeredAt` and `state: 'RUNNING'`, and the flow's
  `state: 'RUNNING'`; returns the flow with its features). The row mapper reads `questions` and `answers` as arrays
  (`null` when the column is null).
- `IFleetFlowStepRepository` and `PrismaFleetFlowStepRepository`.
  Target: adds `setWaiting(flowId: string, featureId: string, input: { jobId: string; questions: FlowQuestion[] }): Promise<void>`
  (sets the feature's `questionsJobId`, `questions`, `state: 'WAITING_ANSWER'`, clears `answers`, `answeredById`
  and `answeredAt`, and sets the flow's `state: 'WAITING_ANSWER'`).
- `FleetFlowAdvanceService` (`apps/api/src/fleet/flows/fleet-flow-advance.service.ts`).
  Target: `decisionInput` fills `questionsJobId` and `answers` from `flow.features[0]`; `writeDecision` handles
  `wait_answer`: `setWaiting`, an audit entry `system.flow.advance` (summary `flow waiting answer <STEP>`), activity
  `flow.waiting` `{ step, jobId, count }`, and one outbox event `fleet_flow_questions` (event id
  `<flowId>:questions:<jobId>`).
- `FleetFlowsService` (`apps/api/src/fleet/flows/fleet-flows.service.ts`).
  Target: adds `answer(projectId: string, flowId: string, answers: FlowAnswer[], actor: { type: 'USER'; id: string }, now?: Date): Promise<FleetFlowRecord>`.
- `FleetFlowFeatureDto` (`apps/api/src/fleet/flows/dto/fleet-flow.dto.ts`).
  Target: adds `questions: { id: string; question: string }[] | null`, `answers: { id: string; answer: string }[] | null`
  and `answeredAt: string | null` (ISO).
- `ProjectFlowsController` (`apps/api/src/fleet/flows/project-flows.controller.ts`) and `FlowRouteCommands`
  (`apps/api/src/fleet/flows/flow-route.commands.ts`).
  Target: the new route and its route command (see Approach).
- `FleetFlowStopTicketSubscriber` (`apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts`).
  Target: also registers a `fleet_flow_questions` handler, which runs the same lock, slug and lazy ticket create as
  the stop handler and then comments `formatQuestionsComment(...)`. The stop handler's behaviour is unchanged.
- `FleetFlowStoppedSubscriber` (`apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.ts`).
  Target: also registers a `fleet_flow_questions` handler that delivers `flowQuestionsDraft` to the approver and to
  the creator when the creator is a user other than the approver.
- `fleet-notification-events.ts` (`apps/api/src/notifications/fleet/`): adds `FLEET_FLOW_QUESTIONS`
  (`'fleet_flow_questions'`), `FleetFlowQuestionsPayload` and `parseFlowQuestionsPayload`.
- `fleet-notification-drafts.ts`: adds `flowQuestionsDraft(payload, slug, userId)`.
- `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS` (`apps/api/src/permissions/catalog.ts`): `fleet.flow.answer` (`'project'`).
- `SYSTEM_ROLES` `developer` (`apps/api/src/permissions/system-roles.ts`): adds `fleet.flow.answer`.
- Prisma: `FleetFlowFeature` adds `questionsJobId String?`, `questions Json?`, `answers Json?`,
  `answeredById String?`, `answeredAt DateTime?`.

**Read-only symbols**

- `FleetFlowsService.stop`, `reaskLocked`, `get`; `canTransitionFlow` (`WAITING_ANSWER` -> `RUNNING`, `PENDING`,
  `STOPPED` is already allowed); `isLiveFlowState`.
- `FleetFlowCallsService.apply(flow, action, expectedHead)` and its `stale`/`retry`/`failed` outcomes (F4a):
  unchanged; it receives findings that now may carry answers.
- `IFleetFlowRepository.lockById`, `FleetReposService.lockById`, `ThreadsService.lockForFlowTransition` (the parent
  then flow lock order).
- `ApprovalRouteGate.run`, `routeCommand`, `parseRouteInput`, `ApprovalPending`, `@ApprovalGated()`, `@Requires`.
- `OutboxService.record`, `FanOutPublisher.register`, `NotificationWriter.deliver`,
  `FleetNotificationReader.projectSlug`, `FleetJobTicketEffects.commentOnFlowTicket` (deduplicates an identical
  body).
- `AuditRecorder.record`, `FleetActivityService.record`.

**New symbols**

- `apps/api/src/fleet/flows/flow-calls.ts`: `FlowQuestion { id: string; question: string }`,
  `FlowAnswer { id: string; answer: string }`, `FLOW_ANSWER_MAX` (2000), `flowQuestions(findings: FlowFinding[]): FlowQuestion[]`,
  `formatQuestionsComment(input: { step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; questions: FlowQuestion[]; answerPath: string }): string`.
- `apps/api/src/fleet/flows/flow-answers.ts`: `parseFlowAnswers(body: unknown): FlowAnswer[]`.
- `FLOW_ANSWER_VARIANT = 'rest:fleet-flow.answer'` (`flow-route.commands.ts`).

### Approach

`decideFlowStep` for a `COMPLETED` review job whose verdict parsed, in this order (the first rule that matches wins):

1. No findings: `SPEC_REVIEW` continues to `PLAN`, `PRD_REVIEW` to `RUN` (unchanged).
2. Any `ambiguous` finding and `canApplyCalls` false (thread entry): stop `review_ambiguous`, detail
   `formatQuestions` (unchanged).
3. More than `FLOW_CALLS_MAX_FINDINGS` findings: stop `review_findings`.
4. `canApplyCalls` false: stop `review_findings` (unchanged).
5. Any `ambiguous` finding, unless `questionsJobId` equals the job's id and `answers` is not null: `wait_answer`
   with the job's step and id and `flowQuestions(findings)`.
6. `PRD_REVIEW`, `planCount` 2 or more, and no `ambiguous` finding: stop `review_findings`.
7. `callsJobId` equals the job's id: dispatch `PLAN` (unchanged).
8. Otherwise: `apply_calls` with the job's step and id and the findings, each `ambiguous` finding carrying the
   `answer` whose `id` equals its question id.

`flowQuestions(findings)`: one entry per `ambiguous` finding, in verdict order; `id` = its 1-based position in
`findings` as a string; `question` = the finding's question collapsed to one line and cut at `FLOW_CALL_TEXT_MAX`.

`formatQuestionsComment` (the ticket comment):

```text
Flow needs answers (SPEC_REVIEW job cmw6hlv1x003q08quzn0wgbfw):
2. Should clamp accept NaN bounds?
5. Is -0 a valid upper bound?
Answer every question with POST /api/projects/sandbox/flows/cmw6h7jki001t08quwgb8dsiy/answers and the body {"answers":[{"id":"2","answer":"..."}]}.
```

The questions event payload:
`{ flowId, projectId, feature, step, jobId, questions: FlowQuestion[], approverId: string | null, creatorType: 'USER' | 'AGENT', creatorId }`.
The notification: category `FLEET_NEEDS_YOU`, kind `flow_questions`, title `Flow needs answers: <feature>`, body the
questions as `<id>. <question>` joined with a space and cut to `BODY_MAX`, link `/<slug>/flows/<flowId>`, params
`{ flowId, feature, step, count }`, source `fleet_flow` / `<flowId>:<jobId>` (a second wait on the same flow is a
new notification).

`parseFlowAnswers(body)`: `body` is an object with an `answers` array of 1 to `FLOW_CALLS_MAX_FINDINGS` entries;
each entry has a non-blank string `id` of at most `FLOW_CALL_ID_MAX` characters and a non-blank string `answer` of
at most `FLOW_ANSWER_MAX` characters; ids are unique. Any violation throws `ValidationAppException` with key
`fleet.flows.answersInput` and a `reason` naming the property (`answers`, `answers[<n>].id`,
`answers[<n>].answer`, `answers[<n>].id duplicate`).

`FleetFlowsService.answer(projectId, flowId, answers, actor, now)`, one transaction:

1. `get(projectId, flowId)` (404 `fleet.flows.notFound`); lock the parent (thread or repo), then `lockById` the flow.
2. State not `WAITING_ANSWER`: 409 `fleet.flows.notWaiting`.
3. The answer ids must equal the feature's question ids as sets: an id with no question throws
   `fleet.flows.answersInput` reason `unknown question <id>`; a question with no answer throws reason
   `missing answer <id>`.
4. `recordAnswers` with the answers in question order; audit `fleet.flow.answer` (resource `flow`, summary
   `flow answered`); activity `flow.answered` `{ flowId, jobId: questionsJobId, count }` with the human actor.

The route: `POST /projects/:slug/flows/:flowId/answers`, `@Requires('fleet.flow.answer')`, `@ApprovalGated()`,
`@HttpCode(200)`; it fences the flow with `get`, then `routeGate.run` with key `fleet.flow.answer`, variant
`FLOW_ANSWER_VARIANT` and input `{ projectId, flowId, body }`. The route command parses `body` with
`parseFlowAnswers`, refuses a non-user principal with 403 `fleet.flows.answerHumanOnly`, and calls
`FleetFlowsService.answer`. A pending gate returns 202 (`ApprovalPending`); success returns `FleetFlowDto`.

After the answers the flow is `RUNNING`; the next tick decides rule 8 (`apply_calls`), and the F4a calls path
commits the block, records `callsJobId`, and the tick after that dispatches `PLAN`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Nax-entry review with an `ambiguous` finding and at most 20 findings | `WAITING_ANSWER`, questions stored, one questions event |
| Thread-entry review with an `ambiguous` finding | stop `review_ambiguous` (unchanged) |
| Review with more than 20 findings, any class | stop `review_findings` |
| Answers posted while the flow is not `WAITING_ANSWER` | 409 `fleet.flows.notWaiting` |
| Answers body malformed (not an object, no array, empty, blank or long id or answer, duplicate id) | 400 `fleet.flows.answersInput` naming the property |
| An answer id with no matching question | 400 `fleet.flows.answersInput`, reason `unknown question <id>` |
| A question with no answer | 400 `fleet.flows.answersInput`, reason `missing answer <id>` |
| Answers posted by an agent principal | 403 `fleet.flows.answerHumanOnly` |
| Caller lacks `fleet.flow.answer` | 403 (permission guard) |
| A policy asks before answering | 202 approval request; the answers apply when it is approved |
| Flow not in the project | 404 `fleet.flows.notFound` |
| Human stop while waiting | `STOPPED` `human_stop` (existing stop path) |
| Branch head moved while the flow waited | the calls step returns `stale` and re-asks (F4a path); the stored answers are not reused |
| Questions event for a flow that is gone | ticket handler returns; notification handler sends nothing when the project is gone |
| Malformed `fleet_flow_questions` payload | both handlers log a warning and skip |
| Creator and approver both unavailable for the ticket | no ticket; logged; notification still delivered |

## Out of Scope

- The web answer form, the flow page and rendering of the `flow_questions` notification kind (fleet flow F6); clients fall back to the English `title` and `body`.
- Answering through the CLI or an MCP tool; the route is reachable with a user token only.
- A billed supervisor job that rewrites the questions; the comment text is built by koda.
- Partial answers: one call must answer every question of the waiting review.
- Editing or withdrawing answers after they are recorded.
- A timeout or reminder for a flow left in `WAITING_ANSWER`.
- Questions and answers for thread-entry flows: their branch exists only on the runner, so the api cannot commit the answers.
- Reusing stored answers after a re-ask: a re-approved flow re-runs its spec review and asks again.
- Agent rulings on the PR's open items after `FIX` (a feature after F4b); `pr_not_ready` still stops.
- Multi-feature flows (fleet flow F5); the decision still skips any flow with more than one feature.
- Probing whether the runner's spec-review skill supports `--phase 9`; a runner on an older skill runs its full review.
- The spec-review skill change itself (nathapp-io/nax-spec-kit-skills#56), which ships in that repository.
- Closing or transitioning the flow's ticket after answers; it stays in its created state.
- Regenerating the CLI client; only `openapi.json` is regenerated.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Questions, answer bullets and the phase-9 PRD task

No dependencies. Workdir: `apps/api`.

Pure helpers: `FlowQuestion`, `FlowAnswer`, `FLOW_ANSWER_MAX`, `flowQuestions` and `formatQuestionsComment` in
`flow-calls.ts`; `buildFlowCalls` renders answered `ambiguous` findings; `FlowFinding.answer`; the `PRD_REVIEW`
task gains `--phase 9`.

### US-002: The decision waits for answers

Depends on US-001. Workdir: `apps/api`.

`decideFlowStep` gains the `questionsJobId` and `answers` inputs, the `wait_answer` action and the rule order in
Approach; an answered verdict becomes `apply_calls` with answers on its `ambiguous` findings.

### US-003: Question and answer columns

Depends on US-001. Workdir: `apps/api`.

The migration, the record fields, `IFleetFlowStepRepository.setWaiting`, `IFleetFlowRepository.recordAnswers`, the
row mapper, and the three new `FleetFlowFeatureDto` fields.

### US-004: Advance writes the wait

Depends on US-002, US-003. Workdir: `apps/api`.

`decisionInput` fills the two inputs; `writeDecision` handles `wait_answer` with `setWaiting`, audit, activity and
the `fleet_flow_questions` outbox event; the event constant, payload type and parser.

### US-005: Questions notification

Depends on US-004. Workdir: `apps/api`.

`flowQuestionsDraft` and the `fleet_flow_questions` handler in `FleetFlowStoppedSubscriber`.

### US-006: Questions ticket comment

Depends on US-004. Workdir: `apps/api`.

The `fleet_flow_questions` handler in `FleetFlowStopTicketSubscriber`: the same lazy ticket, then the questions
comment.

### US-007: The answer permission key

No dependencies. Workdir: `apps/api`.

`fleet.flow.answer` in the catalog (project scope, pending surface), the `developer` system role, the role matrix,
and a migration appending it to existing `developer` roles.

### US-008: Recording answers

Depends on US-001, US-003. Workdir: `apps/api`.

`parseFlowAnswers` and `FleetFlowsService.answer`.

### US-009: The answers route

Depends on US-007, US-008. Workdir: `apps/api`.

`POST /projects/:slug/flows/:flowId/answers`, its route command, the i18n messages, the approval contract and
endpoint e2e entries, and `openapi.json`.

### US-010: Answered flows against the database

Depends on US-004, US-005, US-006, US-009. Workdir: `apps/api`.

An integration spec driving a nax-entry flow from an ambiguous review through the wait, the questions comment and
notification, the answers and the calls commit to a dispatched `PLAN`.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-calls.ts` — `buildFlowCalls`, `FLOW_CALL_*` limits and `oneLine`, extended here.
- `apps/api/src/fleet/flows/flow-verdict.ts` — `FlowFinding`, gains `answer`.
- `apps/api/src/fleet/flows/flow-steps.ts` — `buildReviewTask`.
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — existing calls-block tests to extend.

**US-002**
- `apps/api/src/fleet/flows/flow-step-decision.ts` — the decision being extended.
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — its `input()` fixture and classified-review helpers.
- `apps/api/src/fleet/flows/flow-calls.ts` — `flowQuestions` and the types, from US-001.

**US-003**
- `apps/api/prisma/schema.prisma` — `FleetFlowFeature`.
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — the row mapper and repository.
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — `recordCalls` and `markStep` patterns.
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.ts` — `FleetFlowFeatureDto.from`.
- `apps/api/test/integration/fleet-flow-repository.integration.spec.ts` — repository round-trip pattern.

**US-004**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decisionInput`, `writeDecision`.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — the advance fixture used for F4a's calls path.
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — `FLEET_FLOW_STOPPED` and its parser pattern.

**US-005**
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.ts` — the handler being extended.
- `apps/api/src/notifications/fleet/fleet-notification-drafts.ts` — `flowStoppedDraft`, `truncate`, `TITLE_MAX`, `BODY_MAX`.
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.spec.ts` — existing fixture.

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts` — the handler being extended.
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.spec.ts` — existing fixture.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `commentOnFlowTicket`.

**US-007**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS`.
- `apps/api/src/permissions/system-roles.ts` — the `developer` role.
- `apps/api/prisma/migrations/20261126090000_developer_flow_keys/migration.sql` — the append-and-skip-denied pattern.
- `apps/api/test/integration/permissions/developer-flow-keys-migration.integration.spec.ts` — the migration test pattern.

**US-008**
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `stop` (lock order, audit, activity) and `get`.
- `apps/api/src/fleet/flows/flow-input.ts` — validation style and `ValidationAppException` reasons.
- `apps/api/src/fleet/flows/fleet-flow-read-stop.spec.ts` — the service fixture for `stop`.

**US-009**
- `apps/api/src/fleet/flows/project-flows.controller.ts` — the `stop` route pattern.
- `apps/api/src/fleet/flows/flow-route.commands.ts` — `routeCommand` registrations and `assertHuman`.
- `apps/api/src/fleet/flows/thread-preapproval.controller.ts` — a human-only gated route.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — `gatedOperations`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the flow route cases near the read/stop tests.

**US-010**
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts` — the F4a fixture (seeded review, ticker, mocked GitHub client, outbox publish).
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — the tick entry point.
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `answer`, from US-008.

### Creates

**US-001**
- `apps/api/src/fleet/flows/flow-questions.spec.ts` — `flowQuestions` and `formatQuestionsComment` tests.

**US-003**
- `apps/api/prisma/migrations/20261130090000_fleet_flow_answers/migration.sql` — the five `FleetFlowFeature` columns.

**US-007**
- `apps/api/prisma/migrations/20261130100000_developer_flow_answer_key/migration.sql` — appends `fleet.flow.answer` to `developer` roles.
- `apps/api/test/integration/permissions/developer-flow-answer-key-migration.integration.spec.ts` — the migration's tests.

**US-008**
- `apps/api/src/fleet/flows/flow-answers.ts` — `parseFlowAnswers`.
- `apps/api/src/fleet/flows/flow-answers.spec.ts` — its tests.
- `apps/api/src/fleet/flows/fleet-flow-answer.spec.ts` — `FleetFlowsService.answer` tests.

**US-010**
- `apps/api/test/integration/fleet/fleet-flow-answers.integration.spec.ts` — the end-to-end database spec.

### Modifies

**US-001**
- `apps/api/src/fleet/flows/flow-steps.spec.ts` — the `PRD_REVIEW` task assertion (line ~17) expects the PRD prompt to end with the phase 9 selector (dash-dash phase 9) after the prd path, before the verdict instruction; the `SPEC_REVIEW` assertion is unchanged.

**US-002**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — the `input()` fixture (line ~10) gains `questionsJobId: null, answers: null`; "US-005 AC-2 ambiguous findings precede applicable calls" (line ~161) now expects `{ kind: 'wait_answer' }` for a nax-entry (`canApplyCalls: true`) verdict with a minor and an ambiguous finding; thread-entry ambiguous cases keep `review_ambiguous`.
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts` — the "AC-3–AC-9: ambiguous review stops" case (line ~155) seeds a nax-entry flow that now waits; switch that case's seeded flow to thread entry (still `STOPPED review_ambiguous`), keeping every stop, ticket, comment and notification assertion.

**US-003**
- `apps/api/prisma/schema.prisma` — `FleetFlowFeature` gains `questionsJobId String?`, `questions Json?`, `answers Json?`, `answeredById String?`, `answeredAt DateTime?`.
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — `FleetFlowFeatureRecord` gains the five optional fields; `IFleetFlowRepository` gains `recordAnswers`.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` — `IFleetFlowStepRepository` gains `setWaiting`.
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.spec.ts` — its exact `toEqual` of the mapped flow (line ~47) gains `questions: null, answers: null, answeredAt: null` on each feature.
- `openapi.json` — regenerated by `bun run api:export-spec` for the three new `FleetFlowFeatureDto` fields.

**US-004**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — fixtures that build `FleetFlowStepInput`-shaped expectations or a step-repository stub with every method listed gain `setWaiting` and the two new inputs (`questionsJobId: null`, `answers: null`).

**US-005**
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.spec.ts` — a "registers" assertion that counts the subscriber's `register` calls expects two (stop and questions).

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.spec.ts` — a "registers" assertion that counts the subscriber's `register` calls expects two (stop and questions); `getHandlers(FLEET_FLOW_STOPPED)` still has length 1.

**US-007**
- `apps/api/src/permissions/catalog.ts` — add `'fleet.flow.answer': 'project'` to `NEW_KEY_SCOPES` and add it to `PENDING_SURFACE_KEYS`.
- `apps/api/src/permissions/catalog.spec.ts` — its own copy of the new-key list (around line 113) gains `'fleet.flow.answer': 'project'`, and the full-key-list length assertions grow by one.
- `apps/api/src/permissions/system-roles.ts` — add `fleet.flow.answer` to the `developer` role after `fleet.thread.preapprove`.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated: `fleet.flow.answer` granted in project scope to exactly the roles that hold `fleet.flow.stop`.

**US-009**
- `apps/api/src/fleet/flows/project-flows.controller.ts` — add the answers route.
- `apps/api/src/fleet/flows/flow-route.commands.ts` — register the `fleet.flow.answer` route command and export `FLOW_ANSWER_VARIANT`.
- `apps/api/src/permissions/catalog.ts` — remove `fleet.flow.answer` from `PENDING_SURFACE_KEYS` now that a route declares it.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add the post operation for /api/projects/{slug}/flows/{flowId}/answers to `gatedOperations` and raise the expected length (line ~289) from 145 to 146.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the answers route next to the read/stop flow cases: a 409 `fleet.flows.notWaiting` on a `PENDING` flow and a 400 `fleet.flows.answersInput` on an empty body, with exact status codes.
- `apps/api/src/i18n/en/fleet.json` — add `fleet.flows.notWaiting` (409), `fleet.flows.answersInput` (-2, with `{reason}`) and `fleet.flows.answerHumanOnly` (40003).
- `apps/api/src/i18n/zh/fleet.json` — add the same three keys in Chinese.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new route.

**US-010**

None. US-010 only creates its integration spec.

### Seams

- `flowQuestions` (US-001) is called by `decideFlowStep` (US-002): US-002's `wait_answer` AC asserts the action's `questions` equal `flowQuestions(findings)` for the same verdict.
- `wait_answer` (US-002) is written by `FleetFlowAdvanceService` (US-004): US-004 triggers `advance` (the ticker's entry point) on a flow whose latest review has an ambiguous finding and asserts `setWaiting` and the outbox event.
- `FLEET_FLOW_QUESTIONS` (US-004) is consumed by both subscribers (US-005, US-006): each registers on it in `onModuleInit` and is exercised through the registered handler.
- `formatQuestionsComment` (US-001) is called by the ticket handler (US-006): US-006 asserts `commentOnFlowTicket` receives exactly its output.
- `FleetFlowsService.answer` (US-008) is called by the route command (US-009): US-009 posts the route and asserts `answer` was called with the parsed answers and the user actor.
- `recordAnswers` and `setWaiting` (US-003) are used by US-008 and US-004.

## Acceptance Criteria

### US-001: Questions, answer bullets and the phase-9 PRD task

1. [unit] `flowQuestions` on findings `[minor, ambiguous("Q1"), answered, ambiguous("Q2")]` returns `[{ id: "2", question: "Q1" }, { id: "4", question: "Q2" }]`.
2. [unit] `flowQuestions` uses the position even when the ambiguous finding carries its own `id` `"api-shape"`: the question id is `"1"` for a lone ambiguous finding.
3. [unit] `flowQuestions` collapses a question containing a newline and repeated spaces to one line.
4. [unit] `flowQuestions` cuts a 1,500-character question to exactly `FLOW_CALL_TEXT_MAX` (1,000) characters.
5. [unit] `flowQuestions` returns an empty array when no finding is `ambiguous`.
6. [unit] `formatQuestionsComment({ step: 'SPEC_REVIEW', jobId: 'j1', questions: [{ id: '2', question: 'Q1' }, { id: '5', question: 'Q2' }], answerPath: '/api/projects/sandbox/flows/f1/answers' })` returns the three-part text of Approach: the line `Flow needs answers (SPEC_REVIEW job j1):`, the lines `2. Q1` and `5. Q2`, then the line naming `POST /api/projects/sandbox/flows/f1/answers` and the body `{"answers":[{"id":"2","answer":"..."}]}`.
7. [unit] `buildFlowCalls` with an `ambiguous` finding at position 1 carrying `question: "Q1"` and `answer: "Use USD"` appends the bullet `- **1** (answer): Q1 Answer: Use USD`.
8. [unit] `buildFlowCalls` names an answered `ambiguous` finding with id `"api-shape"` as `**api-shape**`.
9. [unit] `buildFlowCalls` with an `ambiguous` finding that has no `answer` appends no bullet for it, while a `minor` finding in the same input still gets its bullet.
10. [unit] `buildFlowCalls` cuts an answer of 1,500 characters to `FLOW_CALL_TEXT_MAX` characters in its bullet.
11. [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a')` starts with `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json --phase 9` followed by a blank line and `FLOW_VERDICT_INSTRUCTION`.
12. [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')` starts with `/spec-review .nax/features/a/spec.md` and does not carry `--phase`.
13. [unit] `parseFlowVerdict` on a verdict whose `ambiguous` finding includes an `"answer"` field returns that finding without an `answer` property.

### US-002: The decision waits for answers

1. [unit] `decideFlowStep` for a nax-entry (`canApplyCalls: true`) `COMPLETED` `SPEC_REVIEW` job `j1` with findings `[minor, ambiguous]` and `questionsJobId: null` returns `{ kind: 'wait_answer', step: 'SPEC_REVIEW', jobId: 'j1', questions: flowQuestions(findings) }`.
2. [unit] The same input as a `PRD_REVIEW` returns `wait_answer` with `step: 'PRD_REVIEW'`.
3. [unit] A nax-entry `PRD_REVIEW` with an `ambiguous` finding and `planCount: 2` returns `wait_answer`, not a `review_findings` stop.
4. [unit] A nax-entry review with `questionsJobId` equal to a different job id and `answers` set still returns `wait_answer` for the current job.
5. [unit] A nax-entry review whose id equals `questionsJobId` but with `answers: null` returns `wait_answer`.
6. [unit] A nax-entry `SPEC_REVIEW` job `j1` with findings `[minor, ambiguous("Q1")]`, `questionsJobId: 'j1'` and `answers: [{ id: '2', answer: 'A1' }]` returns `apply_calls` whose second finding carries `answer: 'A1'` and whose first finding has no `answer`.
7. [unit] An answered review whose id equals `callsJobId` returns `{ kind: 'dispatch', step: 'PLAN' }`.
8. [unit] A thread-entry (`canApplyCalls: false`) review with an `ambiguous` finding returns `{ kind: 'stop', reason: 'review_ambiguous' }` with `formatQuestions` of the ambiguous findings as detail.
9. [unit] A nax-entry review with 21 findings, one of them `ambiguous`, returns `{ kind: 'stop', reason: 'review_findings' }`.
10. [unit] A nax-entry `PRD_REVIEW` with only `minor` findings and `planCount: 2` still returns a `review_findings` stop.
11. [unit] A nax-entry review with no `ambiguous` finding and `callsJobId: null` still returns `apply_calls` without any `answer` on its findings.

### US-003: Question and answer columns

1. [integration] After the migration, a `FleetFlowFeature` row created without the new fields reads back `questionsJobId`, `questions`, `answers`, `answeredById` and `answeredAt` as null.
2. [integration] `setWaiting(flowId, featureId, { jobId: 'j1', questions: [{ id: '2', question: 'Q1' }] })` on a `RUNNING` flow reads back the flow `state` `WAITING_ANSWER`, the feature `state` `WAITING_ANSWER`, `questionsJobId` `j1` and `questions` `[{ id: '2', question: 'Q1' }]`.
3. [integration] `setWaiting` on a feature that already has `answers`, `answeredById` and `answeredAt` clears all three to null.
4. [integration] `recordAnswers(flowId, featureId, { answers: [{ id: '2', answer: 'A1' }], userId: 'u1', at })` returns a `FleetFlowRecord` whose `state` is `RUNNING` and whose feature has `state` `RUNNING`, `answers` `[{ id: '2', answer: 'A1' }]`, `answeredById` `u1` and `answeredAt` `at`.
5. [integration] `findById` of a waiting flow returns its feature's `questions` as an array of `{ id, question }` objects.
6. [unit] `FleetFlowFeatureDto.from` of a feature with `questions`, `answers` and `answeredAt` maps them to `questions`, `answers` and the ISO string `answeredAt`.
7. [unit] `FleetFlowFeatureDto.from` of a feature without the new fields returns `questions: null`, `answers: null` and `answeredAt: null`.

### US-004: Advance writes the wait

1. [unit] `parseFlowQuestionsPayload` returns the payload for a valid `{ flowId, projectId, feature, step, jobId, questions, approverId, creatorType, creatorId }`.
2. [unit] `parseFlowQuestionsPayload` returns null when `questions` is empty, when a question lacks a string `id` or `question`, or when `step` is not `SPEC_REVIEW` or `PRD_REVIEW`.
3. [unit] `advance` on a `RUNNING` nax-entry flow whose latest job is a `COMPLETED` `SPEC_REVIEW` `j1` with an ambiguous finding calls `setWaiting(flowId, featureId, { jobId: 'j1', questions })` with `flowQuestions` of the verdict.
4. [unit] In the same pass `OutboxService.record` is called once with type `fleet_flow_questions`, the payload of Approach (`step: 'SPEC_REVIEW'`, `jobId: 'j1'`, the questions, the flow's approver and creator) and metadata `{ projectId, eventId: '<flowId>:questions:j1' }`.
5. [unit] In the same pass `AuditRecorder.record` is called with key `system.flow.advance` and summary `flow waiting answer SPEC_REVIEW`, and `FleetActivityService.record` with action `flow.waiting` and payload `{ step: 'SPEC_REVIEW', jobId: 'j1', count: 1 }`.
6. [unit] The wait pass dispatches no job and calls `FleetFlowCallsService.apply` zero times.
7. [unit] `advance` on a flow in `WAITING_ANSWER` writes nothing and dispatches nothing.
8. [unit] `decisionInput` for a flow whose feature has `questionsJobId: 'j1'` and `answers: [{ id: '2', answer: 'A1' }]` passes both to `decideFlowStep`, observed by `advance` returning to the calls path: `FleetFlowCallsService.apply` is called with findings whose ambiguous entry carries `answer: 'A1'`.
9. [unit] A flow whose feature has no `questionsJobId` passes `questionsJobId: null` and `answers: null`.

### US-005: Questions notification

1. [unit] `FleetFlowStoppedSubscriber.onModuleInit` registers a handler for `fleet_flow_questions` as well as `fleet_flow_stopped`.
2. [unit] `flowQuestionsDraft(payload, 'sandbox', 'u1')` has category `FLEET_NEEDS_YOU`, kind `flow_questions`, title `Flow needs answers: <feature>`, link `/sandbox/flows/<flowId>`, params `{ flowId, feature, step, count }` and source `fleet_flow` / `<flowId>:<jobId>`.
3. [unit] `flowQuestionsDraft` body is the questions as `<id>. <question>` joined with a space, cut to `BODY_MAX`.
4. [unit] The questions handler delivers one draft to the approver and one to a user creator who is not the approver.
5. [unit] The questions handler delivers one draft when the creator is the approver, and only the approver's draft when the creator is an agent.
6. [unit] The questions handler delivers nothing when the project slug is gone.
7. [unit] The questions handler logs a warning and delivers nothing for a malformed payload.

### US-006: Questions ticket comment

1. [unit] `FleetFlowStopTicketSubscriber.onModuleInit` registers a handler for `fleet_flow_questions` as well as `fleet_flow_stopped`.
2. [unit] The questions handler on a flow with no ticket creates a `TASK` ticket titled `Fleet flow: <feature>` as the creator and links it with `setTicket`.
3. [unit] The questions handler calls `commentOnFlowTicket(ticketId, projectId, body)` with `body` equal to `formatQuestionsComment({ step, jobId, questions, answerPath: '/api/projects/<slug>/flows/<flowId>/answers' })`.
4. [unit] The questions handler on a flow that already has a ticket comments on that ticket and creates none.
5. [unit] The questions handler runs inside `runAsSystem('flow', ..., { onBehalfOf: { type: creatorType, id: creatorId } })`.
6. [unit] The questions handler returns without writing when the flow is gone or the project slug is null.
7. [unit] The questions handler falls back to the approver as ticket author when the creator is unavailable, and creates no ticket when both are unavailable.
8. [unit] The questions handler logs a warning and writes nothing for a malformed payload.

### US-007: The answer permission key

1. [unit] The catalog entry for `fleet.flow.answer` has scope `project` and risk `medium`.
2. [unit] `PENDING_SURFACE_KEYS` contains `fleet.flow.answer` after this story.
3. [unit] The `developer` system role's permissions include `fleet.flow.answer`.
4. [unit] The role matrix grants `fleet.flow.answer` in project scope to exactly the roles that hold `fleet.flow.stop`.
5. [integration] Applying the `developer_flow_answer_key` migration to a `developer` role without the key appends `fleet.flow.answer` to its permissions.
6. [integration] Applying the migration to a `developer` role holding `!fleet.flow.answer` leaves its permissions unchanged.
7. [integration] Applying the migration twice leaves exactly one `fleet.flow.answer` entry.
8. [integration] The migration leaves a non-`developer` role unchanged.

### US-008: Recording answers

1. [unit] `parseFlowAnswers({ answers: [{ id: '2', answer: 'A1' }] })` returns `[{ id: '2', answer: 'A1' }]`.
2. [unit] `parseFlowAnswers` throws `ValidationAppException` with key `fleet.flows.answersInput` and reason `answers` for a non-object body, a missing `answers`, an empty array and an array of 21 entries.
3. [unit] `parseFlowAnswers` throws reason `answers[0].id` for a blank id and for an id of 65 characters.
4. [unit] `parseFlowAnswers` throws reason `answers[0].answer` for a blank answer and for an answer of 2,001 characters.
5. [unit] `parseFlowAnswers` throws reason `answers[1].id duplicate` when two entries share id `"2"`.
6. [unit] `FleetFlowsService.answer` on a `WAITING_ANSWER` flow with questions `2` and `4` and answers for both calls `recordAnswers` with the answers in question order (`2` then `4`), the user id and `now`, and returns its record.
7. [unit] `answer` locks the parent (repo for a nax-entry flow) before `lockById` of the flow.
8. [unit] `answer` records audit key `fleet.flow.answer` (resource `flow`, summary `flow answered`) and activity `flow.answered` with actor `USER` and payload `{ flowId, jobId: questionsJobId, count: 2 }`.
9. [unit] `answer` on a `RUNNING` flow throws a 409 `ConflictAppException` with key `fleet.flows.notWaiting` and calls `recordAnswers` zero times.
10. [unit] `answer` with an answer id `9` that matches no question throws `fleet.flows.answersInput` with reason `unknown question 9`.
11. [unit] `answer` missing the answer for question `4` throws `fleet.flows.answersInput` with reason `missing answer 4`.
12. [unit] `answer` for a flow in another project throws 404 `fleet.flows.notFound`.

### US-009: The answers route

1. [integration] `POST /api/projects/:slug/flows/:flowId/answers` by a user holding `fleet.flow.answer` on a `WAITING_ANSWER` flow returns 200 with the `FleetFlowDto` in state `RUNNING` and the feature's `answers`.
2. [integration] The route command calls `FleetFlowsService.answer` with the project id, the flow id, the parsed answers and the actor `{ type: 'USER', id }`.
3. [integration] The same POST by an agent principal holding `fleet.flow.answer` returns 403 with key `fleet.flows.answerHumanOnly` and leaves the flow `WAITING_ANSWER`.
4. [integration] The POST by a user without `fleet.flow.answer` returns 403.
5. [integration] The POST on a `PENDING` flow returns 409 `fleet.flows.notWaiting`.
6. [integration] The POST with body `{}` returns 400 `fleet.flows.answersInput`.
7. [integration] The POST for a flow id in another project returns 404 `fleet.flows.notFound`.
8. [integration] With an approval policy that asks for `fleet.flow.answer`, the POST returns 202 with an approval request and leaves the flow `WAITING_ANSWER`.
9. [unit] The OpenAPI document lists `post /api/projects/{slug}/flows/{flowId}/answers` with a 202 response, among the 146 gated operations.
10. [unit] The English and Chinese API i18n files both define `fleet.flows.notWaiting`, `fleet.flows.answersInput` and `fleet.flows.answerHumanOnly`.

### US-010: Answered flows against the database

1. [integration] A nax-entry `RUNNING` flow whose `COMPLETED` `SPEC_REVIEW` job has findings `[minor, ambiguous]` is `WAITING_ANSWER` after one `FleetFlowTicker.tick`, with the feature's `questions` `[{ id: '2', question: <the question> }]` and `questionsJobId` the review job's id.
2. [integration] After that tick exactly one `OutboxEvent` of type `fleet_flow_questions` with event id `<flowId>:questions:<jobId>` exists, and a second tick adds none.
3. [integration] Publishing that outbox row creates the flow's ticket, one comment equal to `formatQuestionsComment` for the flow, and one `flow_questions` notification for the approver.
4. [integration] `FleetFlowsService.answer` with `[{ id: '2', answer: 'Use USD' }]` moves the flow to `RUNNING` and stores the answer.
5. [integration] The next tick calls the mocked `GitHubAppClient.putFile` once with spec content containing `### SPEC_REVIEW job <jobId>`, the minor finding's bullet and the bullet `- **2** (answer): <the question> Answer: Use USD`.
6. [integration] The tick after that dispatches exactly one `PLAN` job linked to the flow.
7. [integration] `FleetFlowsService.stop` on a `WAITING_ANSWER` flow moves it to `STOPPED` with reason `human_stop`.
