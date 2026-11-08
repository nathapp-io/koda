# SPEC: Flow questions, answers and resume (fleet flow F4b)

Closes: #407

## Summary

A nax-entry flow whose review finds an `ambiguous` finding no longer stops. It moves to `WAITING_ANSWER`, stores
that review's questions on the feature, and posts them together as one comment on the flow's ticket with one
notification to the approver and the human creator. A human answers every question in one call,
`POST /projects/:slug/flows/:flowId/answers`, naming the review job the questions came from. The flow then returns
to `RUNNING`, and the next tick appends the answers to the spec under `## Flow's calls` together with the review's
`answered` and `minor` calls (the F4a calls commit), and continues as F4a does: a spec review to `PLAN`, a PRD review
to a re-run of `PLAN`. The PRD review also stops re-reviewing the spec: its task now asks `/spec-review` for phase 9
(PRD fidelity) only.

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
`--phase 9` selector (nathapp-io/nax-spec-kit-skills#56, PR #57, release 0.4.17), and koda sends it.

## Design

### User rulings (2026-11-07)

1. **Answers through an API, humans only.** `POST /projects/:slug/flows/:flowId/answers`; an agent principal is
   refused. The questions are one ticket comment plus a notification; the web form is F6.
2. **F4b scope:** `WAITING_ANSWER`, batched questions, answers and resume, plus #407 (PRD review is phase 9 only).
3. **Approved split and calls:** questions are deterministic text (no billed supervisor job); answers must cover
   every question in one call; answers go into `## Flow's calls`, and the flow continues with no new approval;
   thread-entry flows still stop `review_ambiguous`; a new permission key `fleet.flow.answer`, granted to existing
   `developer` roles by a migration (as #402 did for the F1 keys).

### Calls made while drafting (not user rulings)

- **Question ids are positions.** A question's id is the 1-based position of its finding in the verdict's
  `findings` list (`"2"`, `"5"`), never the reviewer's own `id`: positions are unique and short, and a reviewer id
  can repeat or be blank.
- **Answers name their review job.** The body is `{ jobId, answers }`; `jobId` must equal the feature's
  `questionsJobId`, else 409 `fleet.flows.answersStale`. Position ids repeat across reviews, so without the job id a
  late or approval-deferred post could answer a later wait's questions.
- **Rule order changes one F4a outcome on purpose.** A nax-entry verdict with more than 20 findings that include an
  `ambiguous` one stopped `review_ambiguous` in F4a and stops `review_findings` now: the size stop comes before any
  wait, so a human is never asked questions the flow then cannot apply. A thread-entry flow with an `ambiguous`
  finding still stops `review_ambiguous` first, whatever the count (F4a order).
- **Answers are bound to the review job.** A new wait (a later review) replaces the questions and clears older
  answers. The stored answers apply only while the latest review job is `questionsJobId`.
- **An answered `PRD_REVIEW` re-plans even on the second round.** The F4a "second `PRD_REVIEW` round stops" rule
  applies only to a verdict with no `ambiguous` finding; each extra round needs a human's answers.
- **No timeout.** A flow waits until a human answers or stops it (`POST .../stop` already accepts
  `WAITING_ANSWER`). No job runs and no cost accrues while it waits.
- **The human check runs before the approval gate**, as the thread pre-approval routes do, so an agent never opens an
  approval request it could not execute; the route command repeats it as a backstop.
- **The phase-9 selector is sent unconditionally.** koda does not probe the runner's installed spec-review skill;
  a runner whose skill predates 0.4.17 runs its full review, as today.

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `buildReviewTask` (`apps/api/src/fleet/flows/flow-steps.ts`).
  Baseline: `PRD_REVIEW` prompt `/spec-review --spec <specPath> --prd .nax/features/<feature>/prd.json`.
  Target: the same prompt followed by ` --phase 9`; `SPEC_REVIEW` unchanged.
- `FlowFinding` (`apps/api/src/fleet/flows/flow-verdict.ts`).
  Target: adds optional `answer?: string`. `parseFlowVerdict` never sets it; only the decision does.
- `buildFlowCalls` (`apps/api/src/fleet/flows/flow-calls.ts`).
  Baseline: only `answered` and `minor` findings produce bullets.
  Target: an `ambiguous` finding with a non-blank `answer` also produces a bullet,
  `- **<id>** (answer): <question> Answer: <answer>`, with `<id>` named as for the other bullets (reviewer id, else
  position) and question and answer each collapsed to one line and cut at `FLOW_CALL_TEXT_MAX`. An `ambiguous`
  finding without an answer still produces none.
- `FlowStepInput`, `FlowStepAction` and `decideFlowStep` (`apps/api/src/fleet/flows/flow-step-decision.ts`).
  Target: the input adds `questionsJobId: string | null` and `answers: FlowAnswer[] | null`; the action union adds
  `{ kind: 'wait_answer'; step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; questions: FlowQuestion[] }`, exported
  as `WaitAnswerAction`. The rule order is in Approach.
- `FleetFlowFeatureRecord` (`apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`).
  Target: adds optional `questionsJobId?: string | null`, `questions?: FlowQuestion[] | null`,
  `answers?: FlowAnswer[] | null`, `answeredById?: string | null`, `answeredAt?: Date | null`.
- `IFleetFlowRepository` and `PrismaFleetFlowRepository` (`apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts`).
  Target: adds `recordAnswers(flowId: string, featureId: string, input: { answers: FlowAnswer[]; userId: string; at: Date }): Promise<FleetFlowRecord>`
  (sets the feature's `answers`, `answeredById`, `answeredAt` and `state: 'RUNNING'`, and the flow's
  `state: 'RUNNING'`; returns the flow with its features). The row mapper returns `questions` and `answers` as
  arrays, `null` when the column is null.
- `IFleetFlowStepRepository` and `PrismaFleetFlowStepRepository`.
  Target: adds `setWaiting(flowId: string, featureId: string, input: { jobId: string; questions: FlowQuestion[] }): Promise<void>`
  (sets the feature's `questionsJobId`, `questions`, `state: 'WAITING_ANSWER'`, clears `answers` (with
  `Prisma.DbNull`: a nullable `Json` column is not cleared by a plain `null`), `answeredById` and `answeredAt`, and sets the flow's `state: 'WAITING_ANSWER'`).
- `FleetFlowAdvanceService` (`apps/api/src/fleet/flows/fleet-flow-advance.service.ts`).
  Target: `decisionInput` fills `questionsJobId` and `answers` from `flow.features[0]`; `writeDecision` handles
  `wait_answer`: `setWaiting`, an audit entry `system.flow.advance` (summary `flow waiting answer <STEP>`), activity
  `flow.waiting` `{ step, jobId, count }`, and one outbox event `fleet_flow_questions` (event id
  `<flowId>:questions:<jobId>`). No constructor change.
- `FleetFlowsService` (`apps/api/src/fleet/flows/fleet-flows.service.ts`).
  Target: adds `answer(projectId: string, flowId: string, input: FlowAnswersInput, actor: { type: 'USER'; id: string }, now?: Date): Promise<FleetFlowRecord>`.
- `FleetFlowFeatureDto` (`apps/api/src/fleet/flows/dto/fleet-flow.dto.ts`).
  Target: adds `questionsJobId: string | null`, `questions: { id: string; question: string }[] | null`,
  `answers: { id: string; answer: string }[] | null` and `answeredAt: string | null` (ISO).
- `ProjectFlowsController` (`apps/api/src/fleet/flows/project-flows.controller.ts`) and `FlowRouteCommands`
  (`apps/api/src/fleet/flows/flow-route.commands.ts`): the new route and its route command (see Approach).
- `FleetFlowStopTicketSubscriber` (`apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts`).
  Target: `onModuleInit` registers the stop handler first, then a `fleet_flow_questions` handler that runs the same
  lock, slug and lazy ticket create as the stop handler and then comments `formatQuestionsComment(...)`. The stop
  handler's behaviour is unchanged.
- `FleetFlowStoppedSubscriber` (`apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.ts`).
  Target: `onModuleInit` registers the stop handler first, then a `fleet_flow_questions` handler that delivers
  `flowQuestionsDraft` to the approver and to the creator when the creator is a user other than the approver.
- `fleet-notification-events.ts` (`apps/api/src/notifications/fleet/`): adds `FLEET_FLOW_QUESTIONS`
  (`'fleet_flow_questions'`), `FleetFlowQuestionsPayload` and `parseFlowQuestionsPayload`.
- `fleet-notification-drafts.ts`: adds `flowQuestionsDraft(payload, slug, userId)`, using `truncate`, `TITLE_MAX`
  and `BODY_MAX` from `apps/api/src/notifications/notification.types.ts`.
- `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS` (`apps/api/src/permissions/catalog.ts`): `fleet.flow.answer` (`'project'`).
- `SYSTEM_ROLES` `developer` (`apps/api/src/permissions/system-roles.ts`): adds `fleet.flow.answer`.
- Prisma: `FleetFlowFeature` adds `questionsJobId String?`, `questions Json?`, `answers Json?`,
  `answeredById String?`, `answeredAt DateTime?`.

**Read-only symbols**

- `FleetFlowsService.stop`, `reaskLocked`, `get`; `canTransitionFlow` (`WAITING_ANSWER` -> `RUNNING`, `PENDING`,
  `STOPPED` is already allowed).
- `FleetFlowCallsService.apply(flow, action, expectedHead)` and its `stale`/`retry`/`failed` outcomes (F4a):
  unchanged; it receives findings that may now carry answers.
- `IFleetFlowRepository.lockById`, `FleetReposService.lockById`, `ThreadsService.lockForFlowTransition`.
- `ApprovalRouteGate.run`, `routeCommand`, `parseRouteInput`, `ApprovalPending`, `@ApprovalGated()`, `@Requires`,
  `@Principal()`, and `assertHuman` in `thread-preapproval.controller.ts` (the pattern for a human check before the
  gate).
- `OutboxService.record`, `FanOutPublisher.register`, `NotificationWriter.deliver`,
  `FleetNotificationReader.projectSlug`, `FleetJobTicketEffects.commentOnFlowTicket` (deduplicates an identical
  body).
- `AuditRecorder.record`, `FleetActivityService.record`.

**New symbols**

- `apps/api/src/fleet/flows/flow-calls.ts`: `FlowQuestion { id: string; question: string }`,
  `FlowAnswer { id: string; answer: string }` (both `type` aliases, so they are assignable to Prisma's `InputJsonValue`), `FLOW_ANSWER_MAX` (1000, equal to `FLOW_CALL_TEXT_MAX`, so an accepted answer is never cut in the calls block), `flowQuestions(findings: FlowFinding[]): FlowQuestion[]`,
  `formatQuestionsComment(input: { step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; questions: FlowQuestion[]; answerPath: string }): string`.
- `apps/api/src/fleet/flows/flow-answers.ts`: `FlowAnswersInput { jobId: string; answers: FlowAnswer[] }`,
  `parseFlowAnswers(body: unknown): FlowAnswersInput`.
- `FLOW_ANSWER_VARIANT = 'rest:fleet-flow.answer'` (`flow-route.commands.ts`).

### Approach

`decideFlowStep` for a `COMPLETED` review job whose verdict parsed, in this order (the first rule that matches wins):

1. No findings: `SPEC_REVIEW` continues to `PLAN`, `PRD_REVIEW` to `RUN` (unchanged).
2. Any `ambiguous` finding and `canApplyCalls` false (thread entry): stop `review_ambiguous`, detail
   `formatQuestions` (unchanged, whatever the count).
3. More than `FLOW_CALLS_MAX_FINDINGS` findings: stop `review_findings` (for a nax entry with an `ambiguous`
   finding this replaces F4a's `review_ambiguous`).
4. `canApplyCalls` false: stop `review_findings` (unchanged).
5. Any `ambiguous` finding, unless `questionsJobId` equals the job's id and `answers` is not null: `wait_answer`
   with the job's step and id and `flowQuestions(findings)`.
6. `PRD_REVIEW`, `planCount` 2 or more, and no `ambiguous` finding: stop `review_findings`.
7. `callsJobId` equals the job's id: dispatch `PLAN` (unchanged).
8. Otherwise: `apply_calls` with the job's step and id and the findings, each `ambiguous` finding carrying the
   `answer` whose `id` equals its question id.

`flowQuestions(findings)`: one entry per `ambiguous` finding, in verdict order; `id` = its 1-based position in
`findings` as a string; `question` = the finding's question collapsed to one line and cut at `FLOW_CALL_TEXT_MAX`.

`formatQuestionsComment` (the ticket comment), for example:

```text
Flow needs answers (SPEC_REVIEW job cmw6hlv1x003q08quzn0wgbfw):
2. Should clamp accept NaN bounds?
5. Is -0 a valid upper bound?
Answer every question with POST /api/projects/sandbox/flows/cmw6h7jki001t08quwgb8dsiy/answers and the body {"jobId":"cmw6hlv1x003q08quzn0wgbfw","answers":[{"id":"2","answer":"..."}]}.
```

The questions event payload:
`{ flowId, projectId, feature, step, jobId, questions: FlowQuestion[], approverId: string | null, creatorType: 'USER' | 'AGENT', creatorId }`.
The notification: category `FLEET_NEEDS_YOU`, kind `flow_questions`, title `Flow needs answers: <feature>`, body the
questions as `<id>. <question>` joined with a space and cut to `BODY_MAX`, link `/<slug>/flows/<flowId>`, params
`{ flowId, feature, step, count }`, source `fleet_flow` / `<flowId>:<jobId>` (a second wait on the same flow is a
new notification).

`parseFlowAnswers(body)` checks `body` and `jobId`, then `answers`, then each entry in array order (shape, `id`,
`answer`, duplicate), and throws `ValidationAppException` with key `fleet.flows.answersInput` and the named
`reason` on the first failure. An array is not an object for these checks:

- `body` not an object: `body`; `jobId` not a non-blank string: `jobId`.
- `answers` not an array of 1 to `FLOW_CALLS_MAX_FINDINGS` entries: `answers`.
- an entry not an object: `answers[<n>]`.
- `id` not a string, blank after trimming, or longer than `FLOW_CALL_ID_MAX`: `answers[<n>].id`.
- `answer` not a string, blank after trimming, or longer than `FLOW_ANSWER_MAX`: `answers[<n>].answer`.
- an `id` equal to an earlier entry's: `answers[<n>].id duplicate`.

Ids and answers are kept as sent (no trimming); ids match question ids exactly.

`FleetFlowsService.answer(projectId, flowId, input, actor, now)`, one transaction:

1. `get(projectId, flowId)` (404 `fleet.flows.notFound`); lock the parent (thread or repo), then `lockById` the flow.
2. State not `WAITING_ANSWER`, or the feature's `questions` null: 409 `fleet.flows.notWaiting`.
3. `input.jobId` not equal to the feature's `questionsJobId`: 409 `fleet.flows.answersStale`.
4. The answer ids must equal the question ids as sets: an id with no question throws `fleet.flows.answersInput`
   reason `unknown question <id>`; a question with no answer throws reason `missing answer <id>`.
5. `recordAnswers` with the answers in question order; audit `fleet.flow.answer` (resource `flow`, summary
   `flow answered`); activity `flow.answered` `{ flowId, jobId, count }` with the human actor.

The route: `POST /projects/:slug/flows/:flowId/answers`, `@Requires('fleet.flow.answer')`, `@ApprovalGated()`,
`@HttpCode(200)`. The handler refuses a non-user principal with 403 `fleet.flows.answerHumanOnly` before anything
else, fences the flow with `get`, then calls `routeGate.run` with key `fleet.flow.answer`, variant
`FLOW_ANSWER_VARIANT` and input `{ projectId, flowId, body }`. The route command's `parse` returns
`{ projectId, flowId, body: FlowAnswersInput }` (via `parseRouteInput` and `parseFlowAnswers`; re-parsing that
persisted value yields the same value, as the create commands do), its `run` refuses a non-user principal again
(backstop) and calls `FleetFlowsService.answer`. A pending
gate returns 202 (`ApprovalPending`); success returns `FleetFlowDto`.

After the answers the flow is `RUNNING`; the next tick decides rule 8 (`apply_calls`); the F4a calls path commits the
block and records `callsJobId`; the tick after that dispatches `PLAN`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Nax-entry review with an `ambiguous` finding and at most 20 findings | `WAITING_ANSWER`, questions stored, one questions event |
| Thread-entry review with an `ambiguous` finding, any number of findings | stop `review_ambiguous` (unchanged) |
| Nax-entry review with more than 20 findings, any class | stop `review_findings` |
| Answers posted while the flow is not `WAITING_ANSWER` | 409 `fleet.flows.notWaiting` |
| Answers naming a job other than `questionsJobId` | 409 `fleet.flows.answersStale` |
| Answers body malformed | 400 `fleet.flows.answersInput` with the reason of Approach |
| An answer id with no matching question | 400 `fleet.flows.answersInput`, reason `unknown question <id>` |
| A question with no answer | 400 `fleet.flows.answersInput`, reason `missing answer <id>` |
| Answers posted by an agent principal | 403 `fleet.flows.answerHumanOnly`, no approval request opened |
| Caller lacks `fleet.flow.answer` | 403 (permission guard) |
| A policy asks before answering | 202 approval request; approving it records the answers |
| Flow not in the project | 404 `fleet.flows.notFound` |
| Human stop while waiting | `STOPPED` `human_stop` (existing stop path) |
| Branch head moved while the flow waited | the calls step returns `stale` and re-asks (F4a path); `callsJobId` is not recorded |
| Questions event for a flow that is gone | ticket handler returns; notification handler sends nothing when the project is gone |
| Malformed `fleet_flow_questions` payload | both handlers log a warning and skip |
| Creator and approver both unavailable for the ticket | no ticket; logged; notification still delivered |

## Out of Scope

- The web answer form, the flow page and rendering of the `flow_questions` notification kind (fleet flow F6); clients fall back to the English `title` and `body`.
- Answering through the CLI or an MCP tool; only a human user's call to the route records answers.
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
- Regenerating the CLI client: `apps/cli/src/generated` is not committed, so only `openapi.json` is regenerated.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Phase-9 PRD review task

No dependencies. Workdir: `apps/api`.

`buildReviewTask` sends `--phase 9` for `PRD_REVIEW` (#407).

### US-002: Questions and answer bullets

No dependencies. Workdir: `apps/api`.

`FlowQuestion`, `FlowAnswer`, `FLOW_ANSWER_MAX`, `flowQuestions` and `formatQuestionsComment` in `flow-calls.ts`;
`buildFlowCalls` renders answered `ambiguous` findings; `FlowFinding.answer`.

### US-003: Parsing answers

Depends on US-002. Workdir: `apps/api`.

`FlowAnswersInput` and `parseFlowAnswers` in `flow-answers.ts`.

### US-004: The decision waits for answers

Depends on US-002. Workdir: `apps/api`.

`decideFlowStep` gains the `questionsJobId` and `answers` inputs, the `wait_answer` action and the rule order in
Approach; an answered verdict becomes `apply_calls` with answers on its `ambiguous` findings.

### US-005: Question and answer columns

Depends on US-002. Workdir: `apps/api`.

The migration, the record fields, `IFleetFlowStepRepository.setWaiting`, `IFleetFlowRepository.recordAnswers`, the
row mapper, and the four new `FleetFlowFeatureDto` fields.

### US-006: Advance writes the wait

Depends on US-004, US-005. Workdir: `apps/api`.

`decisionInput` fills the two inputs; `writeDecision` handles `wait_answer` with `setWaiting`, audit, activity and
the `fleet_flow_questions` outbox event; the event constant, payload type and parser.

### US-007: Questions notification

Depends on US-006. Workdir: `apps/api`.

`flowQuestionsDraft` and the `fleet_flow_questions` handler in `FleetFlowStoppedSubscriber`.

### US-008: Questions ticket comment

Depends on US-006. Workdir: `apps/api`.

The `fleet_flow_questions` handler in `FleetFlowStopTicketSubscriber`: the same lazy ticket, then the questions
comment.

### US-009: The answer permission key

No dependencies. Workdir: `apps/api`.

`fleet.flow.answer` in the catalog (project scope, pending surface until US-011), the `developer` system role, the
role matrix, and a migration appending it to existing `developer` roles.

### US-010: Recording answers

Depends on US-003, US-005. Workdir: `apps/api`.

`FleetFlowsService.answer`.

### US-011: The answers route

Depends on US-009, US-010. Workdir: `apps/api`.

`POST /projects/:slug/flows/:flowId/answers`, its route command, the i18n messages, the approval contract and
endpoint e2e entries, and `openapi.json`.

### US-012: Answered flows against the database

Depends on US-006, US-007, US-008, US-011. Workdir: `apps/api`.

An integration spec driving a nax-entry flow from an ambiguous review through the wait, the questions comment and
notification, the answers and the calls commit to a dispatched `PLAN`.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/flow-steps.ts` — `buildReviewTask`.
- `apps/api/src/fleet/flows/flow-steps.spec.ts` — the existing task assertions.

**US-002**
- `apps/api/src/fleet/flows/flow-calls.ts` — `buildFlowCalls`, `FLOW_CALL_*` limits and `oneLine`, extended here.
- `apps/api/src/fleet/flows/flow-verdict.ts` — `FlowFinding`, gains `answer`.
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — existing calls-block tests.
- `apps/api/src/fleet/flows/flow-verdict.spec.ts` — existing verdict tests.

**US-003**
- `apps/api/src/fleet/flows/flow-input.ts` — validation style and `ValidationAppException` reasons.
- `apps/api/src/fleet/flows/flow-calls.ts` — `FlowAnswer`, `FLOW_ANSWER_MAX`, `FLOW_CALL_ID_MAX`, `FLOW_CALLS_MAX_FINDINGS` (created by US-002).

**US-004**
- `apps/api/src/fleet/flows/flow-step-decision.ts` — the decision being extended.
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — its `input()` fixture and classified-review helpers.
- `apps/api/src/fleet/flows/flow-calls.ts` — `flowQuestions` and the types (created by US-002).

**US-005**
- `apps/api/prisma/schema.prisma` — `FleetFlowFeature`.
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — the row mapper and repository.
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — `recordCalls` and `markStep` patterns.
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.ts` — `FleetFlowFeatureDto.from`.
- `apps/api/test/integration/fleet-flow-repository.integration.spec.ts` — repository round-trip tests, extended here.

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decisionInput`, `writeDecision`.
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — the advance harness used for F4a's calls path.
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — `FLEET_FLOW_STOPPED` and its parser pattern.
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — existing parser tests.

**US-007**
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.ts` — the subscriber being extended.
- `apps/api/src/notifications/fleet/fleet-notification-drafts.ts` — `flowStoppedDraft`.
- `apps/api/src/notifications/notification.types.ts` — `truncate`, `TITLE_MAX`, `BODY_MAX`.
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.spec.ts` — existing fixture.

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts` — the subscriber being extended.
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.spec.ts` — existing fixture.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `commentOnFlowTicket`.

**US-009**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS`.
- `apps/api/src/permissions/system-roles.ts` — the `developer` role.
- `apps/api/prisma/migrations/20261126090000_developer_flow_keys/migration.sql` — the append-and-skip-denied pattern.
- `apps/api/test/integration/permissions/developer-flow-keys-migration.integration.spec.ts` — the migration test pattern.

**US-010**
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `stop` (lock order, audit, activity) and `get`.
- `apps/api/src/fleet/flows/fleet-flow-read-stop.spec.ts` — the service fixture for `stop`.
- `apps/api/src/fleet/flows/flow-answers.ts` — `FlowAnswersInput` (created by US-003).

**US-011**
- `apps/api/src/fleet/flows/project-flows.controller.ts` — the `stop` route pattern.
- `apps/api/src/fleet/flows/flow-route.commands.ts` — `routeCommand` registrations and `assertHuman`.
- `apps/api/src/fleet/flows/thread-preapproval.controller.ts` — a human check before `routeGate.run`.
- `apps/api/test/integration/fleet-flow-read-stop.integration.spec.ts` — the route integration pattern for flows.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the flow route cases and the `refusal` helper.

**US-012**
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts` — the F4a fixture (seeded review, ticker, mocked GitHub client, outbox publish).
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — the tick entry point.
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — `answer` (from US-010).

### Creates

**US-002**
- `apps/api/src/fleet/flows/flow-questions.spec.ts` — `flowQuestions` and `formatQuestionsComment` tests.

**US-003**
- `apps/api/src/fleet/flows/flow-answers.ts` — `FlowAnswersInput`, `parseFlowAnswers`.
- `apps/api/src/fleet/flows/flow-answers.spec.ts` — its tests.

**US-005**
- `apps/api/prisma/migrations/20261130090000_fleet_flow_answers/migration.sql` — the five `FleetFlowFeature` columns.

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-advance-answers.spec.ts` — the wait and answered-advance tests, with a local copy of the `build()` harness from `fleet-flow-advance-calls.spec.ts` (it is file-local; never import a spec file).

**US-009**
- `apps/api/prisma/migrations/20261130100000_developer_flow_answer_key/migration.sql` — appends `fleet.flow.answer` to `developer` roles.
- `apps/api/test/integration/permissions/developer-flow-answer-key-migration.integration.spec.ts` — the migration's tests.

**US-010**
- `apps/api/src/fleet/flows/fleet-flow-answer.spec.ts` — `FleetFlowsService.answer` tests, with a local copy of the `setup()` fixture from `fleet-flow-read-stop.spec.ts`.

**US-011**
- `apps/api/test/integration/fleet-flow-answers-route.integration.spec.ts` — the route's integration tests.

**US-012**
- `apps/api/test/integration/fleet/fleet-flow-answers.integration.spec.ts` — the end-to-end database spec.

### Modifies

**US-001**
- `apps/api/src/fleet/flows/flow-steps.spec.ts` — the PRD_REVIEW task assertion (line ~17) expects the phase 9 selector after the prd path, before the verdict instruction; the SPEC_REVIEW assertion is unchanged.

**US-002**
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — add the answered-ambiguous bullet tests next to the existing calls-block tests; existing assertions are unchanged.
- `apps/api/src/fleet/flows/flow-verdict.spec.ts` — add the test that a verdict's own answer field is dropped; existing assertions are unchanged.

**US-004**
- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — the `input()` fixture (line ~10) gains `questionsJobId: null, answers: null`; "US-005 AC-2 ambiguous findings precede applicable calls" (line ~161) now expects a `wait_answer` action for a nax-entry (`canApplyCalls: true`) verdict with a minor and an ambiguous finding; thread-entry ambiguous cases keep `review_ambiguous`.
- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts` — `seedReview` (line ~95) hard-codes a nax entry, and two cases seed an ambiguous review that now waits instead of stopping: "AC-3–AC-9: ambiguous review stops" (line ~155) and "AC-4: failure after persisting the stop event rolls back both writes" (line ~199). Give `seedReview` an entry option; for these two cases, after `FleetFlowsService.create` set the row's `entry` to `THREAD` with `db.fleetFlow.update` (leave `threadId` null: `canApplyCalls` reads only `entry`, and `lockParent` falls back to the repo lock), so they still stop `review_ambiguous`, keeping every stop, ticket, comment, notification and rollback assertion.

**US-005**
- `apps/api/prisma/schema.prisma` — `FleetFlowFeature` gains `questionsJobId String?`, `questions Json?`, `answers Json?`, `answeredById String?`, `answeredAt DateTime?`.
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — `FleetFlowFeatureRecord` gains the five optional fields; `IFleetFlowRepository` gains `recordAnswers`.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` — `IFleetFlowStepRepository` gains `setWaiting`.
- `apps/api/test/integration/fleet-flow-repository.integration.spec.ts` — add the `setWaiting`, `recordAnswers` and mapper round-trip tests; existing assertions are unchanged.
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.spec.ts` — its exact `toEqual` of the mapped flow (line ~47) gains `questionsJobId: null, questions: null, answers: null, answeredAt: null` on each feature.
- `openapi.json` — regenerated by `bun run api:export-spec` for the four new `FleetFlowFeatureDto` fields.

**US-006**
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — add the `parseFlowQuestionsPayload` tests; existing assertions are unchanged.

**US-007**
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.spec.ts` — add the questions-handler tests; its stop tests read the handler at `register.mock.calls[0][1]` (line ~27), which stays the stop handler because it registers first.

**US-008**
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.spec.ts` — add the questions-handler tests; its registration test (line ~50) still holds because the stop handler is still registered once for `fleet_flow_stopped`.

**US-009**
- `apps/api/src/permissions/catalog.ts` — add `'fleet.flow.answer': 'project'` to `NEW_KEY_SCOPES` and add it to `PENDING_SURFACE_KEYS`.
- `apps/api/src/permissions/catalog.spec.ts` — its own copy of the new-key list (around line 113) gains `'fleet.flow.answer': 'project'`; its derived length assertions follow from that list.
- `apps/api/src/permissions/role-matrix.spec.ts` — the per-row cell count (line ~224) becomes 245 instead of 244.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `expectedPending` (line ~7) gains `fleet.flow.answer`, so "defines exactly the pending surface keys" (line ~63) holds.
- `apps/api/src/permissions/system-roles.ts` — add `fleet.flow.answer` to the `developer` role after `fleet.thread.preapprove`.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated: `fleet.flow.answer` granted in project scope to exactly the roles that hold `fleet.flow.stop`.

**US-010**
- `apps/api/src/i18n/en/fleet.json` — add `fleet.flows.notWaiting` (409), `fleet.flows.answersStale` (409) and `fleet.flows.answersInput` (-2, with `{reason}`).
- `apps/api/src/i18n/zh/fleet.json` — add the same three keys in Chinese.

**US-011**
- `apps/api/src/fleet/flows/project-flows.controller.ts` — add the answers route.
- `apps/api/src/fleet/flows/flow-route.commands.ts` — register the `fleet.flow.answer` route command and export `FLOW_ANSWER_VARIANT`.
- `apps/api/src/fleet/flows/flow-route.commands.spec.ts` — add the answer command's parse round-trip and agent-refusal tests next to the create command's (line ~31); its registry stub keys commands by variant, so existing tests are unchanged.
- `apps/api/src/permissions/catalog.ts` — remove `fleet.flow.answer` from `PENDING_SURFACE_KEYS` now that a route declares it (verified by the permission contract tests).
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `expectedPending` (line ~7) loses `fleet.flow.answer` again.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add the post operation for /api/projects/{slug}/flows/{flowId}/answers to `gatedOperations`; the expected length (line ~289) and the two titles naming 145 (lines ~197 and ~287) become 146.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the answers route next to the read/stop flow cases: a 200 on a waiting flow, a 409 `fleet.flows.notWaiting` on a `PENDING` flow and a 400 `fleet.flows.answersInput` on an empty body, with exact status codes through the `refusal` helper.
- `apps/api/src/i18n/en/fleet.json` — add `fleet.flows.answerHumanOnly` (40003).
- `apps/api/src/i18n/zh/fleet.json` — add `fleet.flows.answerHumanOnly` in Chinese.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new route.

**US-012**

None. US-012 only creates its integration spec.

### Seams

- `flowQuestions` (US-002) is called by `decideFlowStep` (US-004): US-004's `wait_answer` AC asserts the action's `questions` equal `flowQuestions(findings)` for the same verdict.
- `wait_answer` (US-004) is written by `FleetFlowAdvanceService` (US-006): US-006 triggers `advance` on a flow whose latest review has an ambiguous finding and asserts `setWaiting` and the outbox event; US-012 drives the same path from `FleetFlowTicker.tick`.
- `FLEET_FLOW_QUESTIONS` (US-006) is consumed by both subscribers (US-007, US-008): each registers on it in `onModuleInit` and is exercised through the registered handler.
- `formatQuestionsComment` (US-002) is called by the ticket handler (US-008): US-008 asserts `commentOnFlowTicket` receives exactly its output.
- `flowQuestionsDraft` (US-007) is delivered by the questions handler (US-007): its handler AC asserts `NotificationWriter.deliver` receives the drafts.
- `parseFlowAnswers` (US-003) is called by the route command (US-011): US-011 posts an invalid body and asserts its 400 reason.
- `FleetFlowsService.answer` (US-010) is called by the route command (US-011): US-011 posts the route and asserts `answer` was called with the parsed input and the user actor.
- `recordAnswers` and `setWaiting` (US-005) are used by US-010 and US-006.

## Acceptance Criteria

### US-001: Phase-9 PRD review task

1. [unit] `buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a')` starts with `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json --phase 9`, followed by a blank line and `FLOW_VERDICT_INSTRUCTION`.
2. [unit] `buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')` starts with `/spec-review .nax/features/a/spec.md` followed by a blank line, with no `--phase` (a guard that already passes before this story).

### US-002: Questions and answer bullets

1. [unit] `flowQuestions` on findings `[minor, ambiguous("Q1"), answered, ambiguous("Q2")]` returns `[{ id: "2", question: "Q1" }, { id: "4", question: "Q2" }]`.
2. [unit] `flowQuestions` gives a lone ambiguous finding whose own `id` is `"api-shape"` the question id `"1"`.
3. [unit] `flowQuestions` collapses a question containing a newline and repeated spaces to one line.
4. [unit] `flowQuestions` cuts a 1,500-character question to exactly `FLOW_CALL_TEXT_MAX` (1,000) characters.
5. [unit] `flowQuestions` returns an empty array when no finding is `ambiguous`.
6. [unit] `formatQuestionsComment({ step: 'SPEC_REVIEW', jobId: 'j1', questions: [{ id: '2', question: 'Q1' }, { id: '5', question: 'Q2' }], answerPath: '/api/projects/sandbox/flows/f1/answers' })` returns exactly the four lines `Flow needs answers (SPEC_REVIEW job j1):`, `2. Q1`, `5. Q2` and `Answer every question with POST /api/projects/sandbox/flows/f1/answers and the body {"jobId":"j1","answers":[{"id":"2","answer":"..."}]}.` joined by newlines; the example body always uses the first question's id.
7. [unit] `buildFlowCalls` with an `ambiguous` finding at position 1 carrying `question: "Q1"` and `answer: "Use USD"` appends the bullet `- **1** (answer): Q1 Answer: Use USD`.
8. [unit] `buildFlowCalls` names an answered `ambiguous` finding with id `"api-shape"` as `**api-shape**`.
9. [unit] `buildFlowCalls` appends no bullet for an `ambiguous` finding without an `answer`, while a `minor` finding in the same input keeps its bullet.
10. [unit] `buildFlowCalls` cuts an answer of 1,500 characters to `FLOW_CALL_TEXT_MAX` characters in its bullet.
11. [unit] `parseFlowVerdict` on a verdict whose `ambiguous` finding includes an `"answer"` field returns that finding without an `answer` property (a guard that already passes before this story).

### US-003: Parsing answers

1. [unit] `parseFlowAnswers({ jobId: 'j1', answers: [{ id: '2', answer: 'A1' }] })` returns `{ jobId: 'j1', answers: [{ id: '2', answer: 'A1' }] }`.
2. [unit] `parseFlowAnswers('x')` and `parseFlowAnswers([])` throw `ValidationAppException` with key `fleet.flows.answersInput` and reason `body`.
3. [unit] `parseFlowAnswers` with a missing or blank `jobId` throws reason `jobId`.
4. [unit] `parseFlowAnswers` with a missing `answers`, an empty array or 21 entries throws reason `answers`.
5. [unit] `parseFlowAnswers` with `answers: ['x']` or `answers: [[]]` throws reason `answers[0]`.
6. [unit] `parseFlowAnswers` throws reason `answers[0].id` for a numeric id, a blank id and an id of 65 characters.
7. [unit] `parseFlowAnswers` throws reason `answers[0].answer` for a numeric answer, a blank answer and an answer of 1,001 characters.
8. [unit] `parseFlowAnswers` throws reason `answers[1].id duplicate` when two entries share id `"2"`, and for `[{ id: '1', answer: 'a' }, { id: '1', answer: 'b' }, { id: 5 }]` (entries are checked in array order).
9. [unit] `parseFlowAnswers` keeps an answer with surrounding spaces exactly as sent.

### US-004: The decision waits for answers

1. [unit] `decideFlowStep` for a nax-entry (`canApplyCalls: true`) `COMPLETED` `SPEC_REVIEW` job `j1` with findings `[minor, ambiguous]` and `questionsJobId: null` returns `{ kind: 'wait_answer', step: 'SPEC_REVIEW', jobId: 'j1', questions: flowQuestions(findings) }`.
2. [unit] The same input as a `PRD_REVIEW` returns `wait_answer` with `step: 'PRD_REVIEW'`.
3. [unit] A nax-entry `PRD_REVIEW` with an `ambiguous` finding, `planCount: 2` and no answers returns `wait_answer`.
4. [unit] A nax-entry review with `questionsJobId` naming a different job and `answers` set returns `wait_answer` for the current job.
5. [unit] A nax-entry review whose id equals `questionsJobId` but with `answers: null` returns `wait_answer`.
6. [unit] A nax-entry `SPEC_REVIEW` job `j1` with findings `[minor, ambiguous("Q1")]`, `questionsJobId: 'j1'` and `answers: [{ id: '2', answer: 'A1' }]` returns `apply_calls` whose second finding carries `answer: 'A1'` and whose first finding has no `answer`.
7. [unit] A nax-entry `PRD_REVIEW` with an `ambiguous` finding, `planCount: 2`, `questionsJobId` equal to its id and answers set returns `apply_calls`.
8. [unit] An answered review whose id equals `callsJobId` returns `{ kind: 'dispatch', step: 'PLAN' }`.
9. [unit] A thread-entry (`canApplyCalls: false`) review with one `ambiguous` finding returns a `review_ambiguous` stop whose detail is `formatQuestions` of the ambiguous findings.
10. [unit] A thread-entry review with 21 findings, one of them `ambiguous`, returns a `review_ambiguous` stop.
11. [unit] A nax-entry review with 21 findings, one of them `ambiguous`, returns a `review_findings` stop.
12. [unit] A nax-entry `PRD_REVIEW` with only `minor` findings and `planCount: 2` returns a `review_findings` stop.

### US-005: Question and answer columns

1. [integration] A `FleetFlowFeature` row created without the new fields reads back `questionsJobId`, `questions`, `answers`, `answeredById` and `answeredAt` as null.
2. [integration] `setWaiting(flowId, featureId, { jobId: 'j1', questions: [{ id: '2', question: 'Q1' }] })` on a `RUNNING` flow reads back flow `state` `WAITING_ANSWER`, feature `state` `WAITING_ANSWER`, `questionsJobId` `j1` and `questions` `[{ id: '2', question: 'Q1' }]`.
3. [integration] `setWaiting` on a feature with `answers`, `answeredById` and `answeredAt` set clears all three to null.
4. [integration] `recordAnswers(flowId, featureId, { answers: [{ id: '2', answer: 'A1' }], userId: 'u1', at })` returns a record with flow `state` `RUNNING`, feature `state` `RUNNING`, `answers` `[{ id: '2', answer: 'A1' }]`, `answeredById` `u1` and `answeredAt` equal to `at`.
5. [integration] `findById` of a waiting flow returns its feature's `questions` as an array of `{ id, question }` objects.
6. [unit] `FleetFlowFeatureDto.from` maps a feature's `questionsJobId`, `questions` and `answers` unchanged and `answeredAt` to its ISO string.
7. [unit] `FleetFlowFeatureDto.from` of a feature without the new fields returns `questionsJobId: null`, `questions: null`, `answers: null` and `answeredAt: null`.

### US-006: Advance writes the wait

1. [unit] `parseFlowQuestionsPayload` returns the payload for a valid `{ flowId, projectId, feature, step, jobId, questions, approverId, creatorType, creatorId }`.
2. [unit] `parseFlowQuestionsPayload` returns null when `questions` is empty or a question lacks a string `id` or `question`.
3. [unit] `parseFlowQuestionsPayload` returns null when `step` is neither `SPEC_REVIEW` nor `PRD_REVIEW`.
4. [unit] `advance` on a `RUNNING` nax-entry flow whose latest job is a `COMPLETED` `SPEC_REVIEW` `j1` with an ambiguous finding calls `setWaiting(flowId, featureId, { jobId: 'j1', questions })` with `flowQuestions` of the verdict.
5. [unit] That pass calls `OutboxService.record` once with type `fleet_flow_questions`, the payload of Approach and metadata `{ projectId, eventId: '<flowId>:questions:j1' }`.
6. [unit] That pass records audit key `system.flow.advance` with summary `flow waiting answer SPEC_REVIEW` and activity `flow.waiting` with payload `{ step: 'SPEC_REVIEW', jobId: 'j1', count: 1 }`.
7. [unit] That pass dispatches no job and never calls `FleetFlowCallsService.apply`.
8. [unit] `advance` on a `WAITING_ANSWER` flow writes and dispatches nothing.
9. [unit] `advance` on a `RUNNING` flow whose feature has `questionsJobId: 'j1'` and `answers: [{ id: '2', answer: 'A1' }]` calls `FleetFlowCallsService.apply` with findings whose ambiguous entry carries `answer: 'A1'`.
10. [unit] When that `apply` returns `stale` with head `h2`, `advance` calls `reaskLocked` with `h2` and never calls `recordCalls`.

### US-007: Questions notification

1. [unit] `FleetFlowStoppedSubscriber.onModuleInit` registers handlers for `fleet_flow_stopped` and then `fleet_flow_questions`.
2. [unit] `flowQuestionsDraft(payload, 'sandbox', 'u1')` has category `FLEET_NEEDS_YOU`, kind `flow_questions`, title `Flow needs answers: <feature>` and link `/sandbox/flows/<flowId>`.
3. [unit] `flowQuestionsDraft` has params `{ flowId, feature, step, count }` and source `fleet_flow` / `<flowId>:<jobId>`.
4. [unit] `flowQuestionsDraft` body is the questions as `<id>. <question>` joined with a space, cut to `BODY_MAX`.
5. [unit] The questions handler passes `NotificationWriter.deliver` one draft for the approver and one for a user creator who is not the approver.
6. [unit] The questions handler delivers one draft when the creator is the approver, and only the approver's when the creator is an agent.
7. [unit] The questions handler delivers nothing when the project slug is gone.
8. [unit] The questions handler logs a warning and delivers nothing for a malformed payload.

### US-008: Questions ticket comment

1. [unit] `FleetFlowStopTicketSubscriber.onModuleInit` registers handlers for `fleet_flow_stopped` and then `fleet_flow_questions`.
2. [unit] The questions handler on a flow with no ticket creates a `TASK` ticket titled `Fleet flow: <feature>` as the creator and links it with `setTicket`.
3. [unit] The questions handler calls `commentOnFlowTicket(ticketId, projectId, body)` with `body` equal to `formatQuestionsComment({ step, jobId, questions, answerPath: '/api/projects/<slug>/flows/<flowId>/answers' })`.
4. [unit] The questions handler on a flow that already has a ticket comments on it and creates none.
5. [unit] The questions handler runs inside `runAsSystem('flow', ..., { onBehalfOf: { type: creatorType, id: creatorId } })`.
6. [unit] The questions handler writes nothing when the flow is gone or the project slug is null.
7. [unit] The questions handler uses the approver as ticket author when the creator is unavailable, and creates no ticket when both are unavailable.
8. [unit] The questions handler logs a warning and writes nothing for a malformed payload.

### US-009: The answer permission key

1. [unit] The catalog entry for `fleet.flow.answer` has scope `project` and risk `medium`.
2. [unit] The `developer` system role's permissions include `fleet.flow.answer`.
3. [unit] The role matrix grants `fleet.flow.answer` in project scope to exactly the roles that hold `fleet.flow.stop`.
4. [integration] Applying the `developer_flow_answer_key` migration to a `developer` role without the key appends `fleet.flow.answer`.
5. [integration] Applying the migration to a `developer` role holding `!fleet.flow.answer` leaves its permissions unchanged.
6. [integration] Applying the migration twice leaves exactly one `fleet.flow.answer` entry.
7. [integration] The migration leaves a non-`developer` role unchanged.

### US-010: Recording answers

1. [unit] `FleetFlowsService.answer` on a `WAITING_ANSWER` flow with `questionsJobId` `j1`, questions `2` and `4`, and input `{ jobId: 'j1', answers }` covering both calls `recordAnswers` with the answers in question order (`2` then `4`), the user id and `now`.
2. [unit] `answer` returns the record `recordAnswers` returned.
3. [unit] `answer` locks the parent (repo for a nax-entry flow) before `lockById` of the flow.
4. [unit] `answer` records audit key `fleet.flow.answer` with resource `flow` and summary `flow answered`.
5. [unit] `answer` records activity `flow.answered` with actor `USER` and payload `{ flowId, jobId: 'j1', count: 2 }`.
6. [unit] `answer` on a `RUNNING` flow throws a 409 `ConflictAppException` with key `fleet.flows.notWaiting` and never calls `recordAnswers`.
7. [unit] `answer` on a `WAITING_ANSWER` flow whose feature `questions` is null throws 409 `fleet.flows.notWaiting`.
8. [unit] `answer` with input `jobId` `j0` while `questionsJobId` is `j1` throws 409 `fleet.flows.answersStale` and never calls `recordAnswers`.
9. [unit] `answer` with an answer id `9` that matches no question throws `fleet.flows.answersInput` with reason `unknown question 9`.
10. [unit] `answer` without an answer for question `4` throws `fleet.flows.answersInput` with reason `missing answer 4`.
11. [unit] `answer` for a flow in another project throws 404 `fleet.flows.notFound`.

### US-011: The answers route

1. [integration] `POST /api/projects/:slug/flows/:flowId/answers` by a user holding `fleet.flow.answer` on a `WAITING_ANSWER` flow returns 200 with the `FleetFlowDto` in state `RUNNING` and the feature's `answers`.
2. [integration] The POST by an agent principal holding `fleet.flow.answer` returns 403 `fleet.flows.answerHumanOnly` and leaves the flow `WAITING_ANSWER`.
3. [integration] The same agent POST under an approval policy that asks for `fleet.flow.answer` returns 403 and opens no approval request.
4. [integration] The POST by a user without `fleet.flow.answer` returns 403.
5. [integration] The POST on a `PENDING` flow returns 409 with the English message for `fleet.flows.notWaiting`.
6. [integration] The POST with a `jobId` other than the feature's `questionsJobId` returns 409 with the English message for `fleet.flows.answersStale`.
7. [integration] The POST with body `{}` returns 400 with the English message for `fleet.flows.answersInput` naming reason `jobId`.
8. [integration] The POST for a flow id in another project returns 404 `fleet.flows.notFound`.
9. [integration] Under a policy that asks, a user's POST returns 202 with an approval request and leaves the flow `WAITING_ANSWER`.
10. [integration] Approving that request through `POST /api/approvals/:id/decisions` with `approve` leaves the flow `RUNNING` with the posted answers stored.
11. [unit] The OpenAPI document lists `post /api/projects/{slug}/flows/{flowId}/answers` with a 202 response, among the 146 gated operations.
12. [unit] The registered `rest:fleet-flow.answer` command's `parse` of `{ projectId, flowId, body }` returns `{ projectId, flowId, body: parseFlowAnswers(body) }`, and parsing its JSON round-trip returns an equal value.
13. [unit] Running the registered `rest:fleet-flow.answer` command with an agent principal throws 403 `fleet.flows.answerHumanOnly` and never calls `FleetFlowsService.answer`.

### US-012: Answered flows against the database

1. [integration] A nax-entry `RUNNING` flow whose `COMPLETED` `SPEC_REVIEW` job has findings `[minor, ambiguous]` (the ambiguous finding seeded with no `id`, so its bullet is named by position) is `WAITING_ANSWER` after one `FleetFlowTicker.tick`, with feature `questions` `[{ id: '2', question: <the question> }]` and `questionsJobId` the review job's id.
2. [integration] After that tick exactly one `OutboxEvent` of type `fleet_flow_questions` with event id `<flowId>:questions:<jobId>` exists, and a second tick adds none.
3. [integration] Publishing that outbox row creates the flow's ticket with one comment equal to `formatQuestionsComment` for the flow, and one `flow_questions` notification for the approver.
4. [integration] Publishing the same outbox row a second time adds no second comment and no second notification.
5. [integration] `FleetFlowsService.answer` with `{ jobId: <the review job>, answers: [{ id: '2', answer: 'Use USD' }] }` moves the flow to `RUNNING` with the answer stored.
6. [integration] The next tick calls the mocked `GitHubAppClient.putFile` once with spec content containing `### SPEC_REVIEW job <jobId>`, the minor finding's bullet and `- **2** (answer): <the question> Answer: Use USD`.
7. [integration] The tick after that dispatches exactly one `PLAN` job linked to the flow.
8. [integration] `FleetFlowsService.stop` on a `WAITING_ANSWER` flow moves it to `STOPPED` with reason `human_stop`.
