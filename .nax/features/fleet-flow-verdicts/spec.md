<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Classified review verdicts, flow calls and stop notices (fleet flow F4a)

## Summary

A flow's two review steps (`SPEC_REVIEW`, `PRD_REVIEW`) now sort each finding into `answered`, `minor` or
`ambiguous` instead of stopping on any finding. When every finding is `answered` or `minor`, koda appends them to
the spec on the flow branch as a "Flow's calls" section (one commit made by the api through the GitHub App), moves
the flow's `specSha` to that commit, and continues: a spec review continues to `PLAN`; a PRD review re-runs `PLAN`
once so the PRD picks the calls up. An `ambiguous` finding still stops the flow, with the questions in its detail,
until F4b adds waiting for answers. Every stop the engine makes now also posts a comment on the flow's ticket
(created at the first stop) and notifies the flow's approver and its human creator.

## Motivation

The F3 live check (§9.171 of the fleet design doc, 2026-11-07) ran three single-feature flows on the sandbox. Under
F3's strict stop, `/spec-review` found something on almost every pass: two of three spec reviews and the one PRD
review stopped the flow, all on hygiene or coverage findings the reviewer itself called minor. A real flow
therefore almost never reaches `RUN`. The design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, Review
verdicts and escalation, Stops) asks for exactly this split: settle answered and minor findings as recorded calls,
escalate only genuine ambiguity, and tell the user when a flow stops. F3 left stops silent (`stopReason` and
`stopDetail` only).

## Design

### User rulings (2026-11-07)

1. **Calls are appended by the api.** The verdict carries each finding's `fix`. The api commits them to the spec as
   a "Flow's calls" section through a new GitHub contents write (the App's installation token already has
   `contents: write`). No runner change; the spec body above the section is never rewritten.
2. **Questions are answered through an API (F4b).** F4a only stops on `ambiguous` findings and lists the questions.
3. **Split.** F4a = classified verdicts, the calls commit, and a ticket comment plus notification on every engine
   stop. F4b = `WAITING_ANSWER`, batched questions, answers and resume. Agent rulings on the PR's open items are a
   feature after F4b.
4. **Both reviews are classified.** `PRD_REVIEW` `answered`/`minor` findings are appended to the spec as calls, then
   the flow re-runs `PLAN` once. A second round of `PRD_REVIEW` findings stops the flow.

### Calls made while drafting (not user rulings)

- **The flow's own spec commit never re-asks.** The calls commit moves `flow.specSha` to the new commit sha in the
  same transaction that records the calls, so the existing spec-sha check before `PLAN` sees its own commit as the
  approved spec. A later push by anyone else still re-asks.
- **Thread-entry flows cannot take calls.** A thread's branch is local to its runner (thread publish never pushes),
  so the api cannot commit to it. A thread-entry review with `answered`/`minor` findings stops as `review_findings`,
  as in F3.
- **At most 20 findings per review are applied** (`FLOW_CALLS_MAX_FINDINGS`); a verdict with more stops as
  `review_findings`. Each finding's summary and fix are collapsed to one line and cut at 1,000 characters
  (`FLOW_CALL_TEXT_MAX`) in the calls block.
- **Idempotent commit.** Each review's block has the heading `### <STEP> job <jobId>`. If the spec at the branch
  head already contains that heading (a crash after the commit, before the record), no second commit is made and
  the branch head is recorded instead.
- **The calls step is not billed** and runs no cap guard; it does run the creator-access guard (it writes to the
  repository on the creator's behalf).
- **Write conflicts.** A `409` from the contents write re-reads the file: if its blob sha is unchanged, the write was
  refused for another reason (a branch rule) and the flow stops as `calls_failed`; if it moved, this pass ends and
  the next tick retries against the new file.
- **Stop notices come from the outbox.** The engine's stop transaction records one outbox event
  `fleet_flow_stopped` (event id `<flowId>:stopped`). Two handlers consume it: a notifications handler (in-app and
  email per preference, category `FLEET_NEEDS_YOU`) and a fleet handler that creates the flow's ticket on first use
  and posts the stop comment. A human stop (`FleetFlowsService.stop`) and an approval rejection enqueue nothing: a
  human did them.
- **Ticket author.** The flow's ticket is created as the flow's creator, loaded through `ActorPrincipalLoader.load`;
  when the creator is unavailable (deleted, disabled or paused), as the approver; when both are unavailable, no
  ticket is created and the handler logs and returns (the notification still goes out).

### Integration

The baseline below exists only to locate the code. It is never the interface to implement; the target is.

**Changed symbols**

- `FlowFinding` and `parseFlowVerdict` (`apps/api/src/fleet/flows/flow-verdict.ts`).
  Baseline: `FlowFinding { id?: string; summary: string }`; any object with a string `summary` is accepted.
  Target: `FlowFinding { id?: string; class: FlowFindingClass; summary: string; fix?: string; question?: string }`
  with `FlowFindingClass = 'answered' | 'minor' | 'ambiguous'`. A finding whose `class` is missing or not one of the
  three, an `answered`/`minor` finding without a non-blank string `fix`, or an `ambiguous` finding without a
  non-blank string `question` makes the whole verdict unreadable (`{ ok: false }`).
- `formatFindings` (same file).
  Baseline: entries `<n>. [<id>] <summary>`.
  Target: entries `<n>. [<id>] (<class>) <summary>`; the 2,000-character cap is unchanged.
- `FLOW_VERDICT_INSTRUCTION` (`apps/api/src/fleet/flows/flow-steps.ts`).
  Target: asks for `{"findings":[{"id":"<short id>","class":"answered|minor|ambiguous","summary":"<one sentence>","fix":"<the change, for answered and minor>","question":"<the question, for ambiguous>"}]}`
  and defines the classes (see Approach). It still ends with the line `{"findings":[]}`.
- `FlowStepInput`, `FlowStepAction`, `FlowStopReason` and `decideFlowStep`
  (`apps/api/src/fleet/flows/flow-step-decision.ts`).
  Target: the input adds `callsJobId: string | null` (the feature's last applied review job), `planCount: number`
  (the flow's `PLAN` jobs) and `canApplyCalls: boolean` (true for nax-entry flows); the action union adds
  `{ kind: 'apply_calls'; step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; findings: FlowFinding[] }`; stop
  reasons add `review_ambiguous` and `calls_failed`.
- `FleetFlowAdvanceService` (`apps/api/src/fleet/flows/fleet-flow-advance.service.ts`).
  Target: handles `apply_calls` (creator guard, `FleetFlowCallsService.apply` outside a transaction, record under the
  locks); `decide` keeps a `SPEC_REVIEW` latest job whose id is the feature's `callsJobId` even though its `ref` is
  no longer `specSha`; `readSpecHead` also reads the forge head when the latest job is a terminal `PRD_REVIEW`;
  `decisionInput` fills the three new inputs; `writeDecision` records the `fleet_flow_stopped` outbox event with
  every stop it writes.
- `FleetFlowFeatureRecord` and `FleetFlowRecord` (`apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`).
  Target: the feature adds optional `callsJobId?: string | null`; the flow adds optional `ticketId?: string | null`.
- `IFleetFlowStepRepository` (`apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`) and
  `PrismaFleetFlowStepRepository`.
  Target: adds `countJobsForStep(flowId: string, step: FlowStep): Promise<number>`,
  `recordCalls(flowId: string, featureId: string, jobId: string, specSha: string): Promise<void>` (sets the
  feature's `callsJobId` and the flow's `specSha`) and `setTicket(flowId: string, ticketId: string): Promise<boolean>`
  (sets `ticketId` only where it is null; true when it set it).
- `GitHubAppClient` (`apps/api/src/fleet/git-broker/github-app-client.ts`).
  Target: adds `putFile(token, owner, name, path, input: { branch: string; content: Buffer; blobSha: string; message: string }): Promise<PutFileResult>`
  with `PutFileResult = { kind: 'committed'; commitSha: string } | { kind: 'conflict' }`.
- `FleetJobTicketEffects` (`apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`).
  Target: adds `commentOnFlowTicket(ticketId: string, projectId: string, body: string): Promise<void>` (skip when the
  ticket already has a comment with that body; else a system comment plus an `AuditRecorder` entry `comment.create`,
  as `commentOnFinish` does).
- `fleet-notification-events.ts` (`apps/api/src/notifications/fleet/`): adds `FLEET_FLOW_STOPPED`
  (`'fleet_flow_stopped'`), `FleetFlowStoppedPayload` and `parseFlowStoppedPayload`.
- `NotificationSourceType` (`apps/api/src/notifications/notification.types.ts`): adds `'fleet_flow'`.
- `NEW_KEY_SCOPES` (`apps/api/src/permissions/catalog.ts`): appends `system.flow.ticket` (`'any'`) after
  `system.flow.advance`.
- `FlowsModule` (`apps/api/src/fleet/flows/flows.module.ts`): provides `FleetFlowCallsService` and
  `FleetFlowStopTicketSubscriber`; imports what they need (`OutboxModule`, the module exporting
  `FleetJobTicketEffects` and `TicketsService`, the module exporting `ActorPrincipalLoader`).
- `NotificationsModule` (`apps/api/src/notifications/notifications.module.ts`): provides
  `FleetFlowStoppedSubscriber`.
- Prisma: `FleetFlowFeature.callsJobId String?`; `FleetFlow.ticketId String?` with a relation to `Ticket`
  (`onDelete: SetNull`) and the back-relation on `Ticket`.

**Read-only symbols**

- `GitHubAppClient.mintInstallationToken(installationId, repoName)` (contents write), `getFile(token, owner, name,
  path, ref): Promise<ForgeFile | null>` (`{ sha, size, content: Buffer }`), `getBranchHead(token, owner, name,
  branch)`; forge failures throw `RepoCheckException` with a `reason` (`app_not_installed`,
  `app_permissions_insufficient`, `repo_not_found`, `provider_unreachable`, `provider_error`, ...).
- `FleetReposService.findReviewRepo(id)` (id, projectId, owner, name, `githubInstallationId`).
- `ActorPrincipalLoader.load({ type: 'USER' | 'AGENT', id })` throws `ActorUnavailableError` for a missing, disabled
  or paused actor (`apps/api/src/auth/principal/actor-principal.loader.ts`).
- `TicketsService.create(projectSlug, { type, title, description? }, principal)`.
- `OutboxService.record({ type, payload, metadata: { projectId, eventId } })` inside the caller's transaction;
  `FanOutPublisher.register(type, handler)` runs every handler registered for a type.
- `NotificationWriter.deliver(drafts)`, `FleetNotificationReader.projectSlug(projectId)`, and the
  `FleetJobOutcomeSubscriber` pattern (`apps/api/src/notifications/fleet/fleet-job-outcome.subscriber.ts`).
- `bookkeeping('fleet.flow-bookkeeping', fn)`, `AuditRecorder.record`, `FleetActivityService.record`,
  `IFleetFlowRepository.lockById`, `mayDispatch`, `PermissionService.effectiveKeys` (as F3 uses them).

**New symbols**

- `apps/api/src/fleet/flows/flow-calls.ts` (pure): `FLOW_CALLS_HEADING` (`## Flow's calls`),
  `FLOW_CALLS_MAX_FINDINGS` (20), `FLOW_CALL_TEXT_MAX` (1000), `formatQuestions(findings)`,
  `buildFlowCalls(specText: string, input: { step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; findings: FlowFinding[] }): { text: string; alreadyApplied: boolean }`.
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`: `FleetFlowCallsService.apply(flow: FleetFlowRecord, action: ApplyCallsAction): Promise<CallsOutcome>`
  with `CallsOutcome = { kind: 'committed'; specSha: string } | { kind: 'retry' } | { kind: 'failed'; detail: string }`.
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts`: `FleetFlowStopTicketSubscriber`
  (`@SystemWriter('system.flow.ticket')`, registers on `fleet_flow_stopped`).
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.ts`: `FleetFlowStoppedSubscriber`
  (`@SystemWriter('system.notification.fleet')`); a draft builder `flowStoppedDraft(payload, slug, userId)` in
  `fleet-notification-drafts.ts`.

### Approach

The verdict instruction appended to both review tasks:

```text
When you are done, end your reply with exactly one JSON object on its own line, with no text after it:
{"findings":[{"id":"<short id>","class":"answered|minor|ambiguous","summary":"<one sentence>","fix":"<the change, for answered and minor>","question":"<the question, for ambiguous>"}]}
Classes: "answered" = the spec, the brainstorm or the code already settles it; "minor" = a small call you can make
and record; "ambiguous" = only the user can settle it, because the answer changes what gets built.
Use {"findings":[]} when you found nothing that should change before the next step.
{"findings":[]}
```

`decideFlowStep` for a `COMPLETED` review job whose verdict parsed, in this order (the first rule that matches wins):

1. No findings: `SPEC_REVIEW` continues to `PLAN`, `PRD_REVIEW` to `RUN` (unchanged from F3).
2. Any `ambiguous` finding: stop `review_ambiguous`, detail `formatQuestions` of the ambiguous findings.
3. More than `FLOW_CALLS_MAX_FINDINGS` findings: stop `review_findings`, detail `formatFindings`.
4. `canApplyCalls` false (thread entry): stop `review_findings`, detail `formatFindings`.
5. `PRD_REVIEW` with `planCount` 2 or more: stop `review_findings`, detail `formatFindings` (the second round).
6. `callsJobId` equals the job's id (calls already recorded): dispatch `PLAN`.
7. Otherwise: `apply_calls` with the job's step, id and findings.

`advance` for `apply_calls`: the creator-access guard (stop `creator_lost_access`), then
`FleetFlowCallsService.apply` with no transaction open, then:

- `committed`: one transaction locks parent and flow (`lockLive`); if still live, `recordCalls(flowId, featureId,
  jobId, specSha)`, an audit entry `system.flow.advance` (summary `flow calls <STEP>`) and activity `flow.calls`
  `{ step, jobId, specSha, count }`. The next tick dispatches `PLAN`.
- `retry`: nothing is written.
- `failed`: stop `calls_failed`, detail `<STEP>: <detail>`.

`FleetFlowCallsService.apply(flow, action)`:

1. `findReviewRepo(flow.repoId)`; missing or no installation: `failed` `repo not connected`.
2. `mintInstallationToken`, then `getFile(spec path, flow.branch)`; null: `failed` `spec missing on <branch>`.
3. `buildFlowCalls(file text, action)`; `alreadyApplied`: `committed` with `getBranchHead(flow.branch)`.
4. `putFile` with the file's blob sha and message `docs(<feature>): flow calls from <STEP> job <jobId>`;
   `committed`: `committed` with its commit sha; `conflict`: `getFile` again, same blob sha: `failed`
   `spec write refused`, different: `retry`.
5. A `RepoCheckException` with reason `app_not_installed`, `app_permissions_insufficient` or `repo_not_found`:
   `failed` with the reason; any other reason: `retry`. Any other error propagates.

The calls block (appended after a blank line; the `## Flow's calls` heading only when the spec has none):

```markdown
## Flow's calls

### SPEC_REVIEW job cmw66x5ix002f08p2kcxvye58

- **ac-untagged** (minor): All 7 ACs carry no mechanism tag. Call: append [unit] to each AC.
- **2** (answered): The -0 bound is untested. Call: add an AC for clamp(-5, -0, 0).
```

A finding without an id is named by its 1-based position in the verdict. Only `answered` and `minor` findings
appear.

The stop event payload:
`{ flowId, projectId, feature, stopReason, detail (first 500 characters), approverId: string | null, creatorType: 'USER' | 'AGENT', creatorId }`.
The notifications handler sends one draft to the approver and one to the creator when the creator is a user other
than the approver: category `FLEET_NEEDS_YOU`, kind `flow_stopped`, title `Flow stopped: <feature>`, body the
detail, link `/<slug>/flows/<flowId>`, params `{ flowId, feature, stopReason }`, source `fleet_flow` / `flowId`.
The fleet handler, in one transaction: lock the flow (gone: return); when `ticketId` is null, create a `TASK`
ticket titled `Fleet flow: <feature>` with description `Flow <flowId> on <branch>` and `setTicket` (under
`fleet.flow-bookkeeping`); then `commentOnFlowTicket(ticketId, projectId, "Flow stopped (<stopReason>): <detail>")`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Finding with no or unknown `class` | verdict unreadable: stop `verdict_unreadable` (F3 path) |
| `answered`/`minor` finding with a missing or blank `fix` | verdict unreadable |
| `ambiguous` finding with a missing or blank `question` | verdict unreadable |
| Any `ambiguous` finding | stop `review_ambiguous`, questions in the detail |
| More than 20 findings | stop `review_findings` |
| Thread-entry flow with `answered`/`minor` findings | stop `review_findings` |
| Second `PRD_REVIEW` round with findings | stop `review_findings` |
| Creator lost access before the calls step | stop `creator_lost_access` |
| Repo missing or not connected at the calls step | stop `calls_failed`, `<STEP>: repo not connected` |
| Spec file missing on the flow branch | stop `calls_failed`, `<STEP>: spec missing on <branch>` |
| Contents write `409`, blob sha unchanged on re-read | stop `calls_failed`, `<STEP>: spec write refused` |
| Contents write `409`, blob sha moved | nothing written; next tick retries |
| Forge reason `app_not_installed`, `app_permissions_insufficient`, `repo_not_found` | stop `calls_failed` with the reason |
| Forge reason `provider_unreachable`, `provider_error` or another | nothing written; next tick retries |
| Calls block already on the branch (crash after commit) | no second commit; branch head recorded as `specSha` |
| Flow left `APPROVED`/`RUNNING` between the commit and the record | record writes nothing |
| Stop event for a flow that is gone | ticket handler returns; notification handler sends nothing when the project is gone |
| Creator and approver both unavailable for the ticket | no ticket; logged; notification still delivered |
| Malformed `fleet_flow_stopped` payload | both handlers log a warning and skip |

## Out of Scope

- `WAITING_ANSWER`, posting the batched questions on the ticket, the answers API and resuming after answers (fleet flow F4b); in F4a an `ambiguous` finding stops the flow.
- Agent rulings on the PR's open items after `FIX`: the PR phase is unchanged from F3 (`pr_not_ready` stops).
- Applying calls for thread-entry flows: their branch exists only on the runner, so the api cannot commit to it.
- Rewriting the spec body: calls are only appended under `## Flow's calls`; no finding edits an existing line.
- More than one re-plan per flow: a second `PRD_REVIEW` with findings stops the flow.
- Classifying `REVIEW` (PR review) findings; `REVIEW` and `FIX` jobs are dispatched exactly as in F3.
- Notifications or ticket comments for a flow's completion, for a human stop and for an approval rejection.
- De-duplicating a flow-stop notification against the `fleet_job_outcome` notification the failed job itself sends.
- Closing or transitioning the flow's ticket; it stays in its created state.
- Web rendering of the `flow_stopped` notification kind and every flow page (fleet flow F6); clients fall back to the English `title` and `body`.
- GitLab repositories: flows are GitHub-only, and `putFile` exists only on the GitHub client.
- Signing the calls commit or setting its author: GitHub records it as the App.
- Regenerating the CLI client; `openapi.json` does not change.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Classified verdicts

Workdir: `apps/api`. No dependencies. `FlowFinding` gains `class`, `fix` and `question`; `parseFlowVerdict` rejects
a finding without a valid class or its class's text; `formatFindings` shows the class; `FLOW_VERDICT_INSTRUCTION`
asks for the classified shape.

### US-002: The calls block

Workdir: `apps/api`. Depends on US-001. Pure module `flow-calls.ts`: the constants, `formatQuestions` and
`buildFlowCalls`.

### US-003: Calls and ticket columns

Workdir: `apps/api`. No dependencies. One migration adds `FleetFlowFeature.callsJobId` and `FleetFlow.ticketId`
(relation to `Ticket`, `onDelete: SetNull`). The domain records gain both optional fields; the step repository
gains `countJobsForStep`, `recordCalls` and `setTicket`.

### US-004: GitHub contents write

Workdir: `apps/api`. No dependencies. `GitHubAppClient.putFile` creates a commit that replaces one file on a branch.

### US-005: Step decision for classified verdicts

Workdir: `apps/api`. Depends on US-001. `decideFlowStep` applies the seven verdict rules in the Approach, with the
new inputs, action and stop reasons.

### US-006: The calls service

Workdir: `apps/api`. Depends on US-002, US-003, US-004. `FleetFlowCallsService.apply` reads the spec, builds the
block and commits it, returning `committed`, `retry` or `failed`.

### US-007: Advance applies calls

Workdir: `apps/api`. Depends on US-005, US-006. `FleetFlowAdvanceService` handles `apply_calls`, records the calls
and the new `specSha`, keeps the applied `SPEC_REVIEW` as the latest job, reads the forge head after a terminal
`PRD_REVIEW`, and fills the new decision inputs.

### US-008: The flow-stopped event

Workdir: `apps/api`. Depends on US-007. `FLEET_FLOW_STOPPED`, its payload and parser; `writeDecision` records the
event with every stop the engine writes.

### US-009: Stop notifications

Workdir: `apps/api`. Depends on US-008. `FleetFlowStoppedSubscriber` delivers the stop to the approver and the human
creator; `flowStoppedDraft`; the `fleet_flow` source type.

### US-010: The flow ticket

Workdir: `apps/api`. Depends on US-003, US-008. `FleetFlowStopTicketSubscriber` (`@SystemWriter('system.flow.ticket')`,
new key) creates the flow's ticket on first use and posts the stop comment through
`FleetJobTicketEffects.commentOnFlowTicket`.

### US-011: Classified flows against the database

Workdir: `apps/api`. Depends on US-007, US-009, US-010. Integration tests that run `FleetFlowTicker.tick` over real
flows and jobs with a stubbed GitHub client, and the stop handlers over a real outbox row.

### Context Files

**US-001**

- `apps/api/src/fleet/flows/flow-verdict.ts` — the parser this story extends
- `apps/api/src/fleet/flows/flow-steps.ts` — `FLOW_VERDICT_INSTRUCTION`

**US-002**

- `apps/api/src/fleet/flows/flow-verdict.ts` — `FlowFinding`, `formatFindings`

**US-003**

- `apps/api/prisma/schema.prisma` — `FleetFlow`, `FleetFlowFeature` and `Ticket` models
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — `FleetFlowFeatureRecord`, `FleetFlowRecord`
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` — `IFleetFlowStepRepository`
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — the repository this story extends
- `apps/api/test/integration/fleet/fleet-flow-steps-migration.integration.spec.ts` — migration test pattern

**US-004**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — `getFile`, `getBranchHead`, error mapping
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — the HTTP stub pattern

**US-005**

- `apps/api/src/fleet/flows/flow-step-decision.ts` — `decideFlowStep`
- `apps/api/src/fleet/flows/flow-calls.ts` — created by US-002; `FLOW_CALLS_MAX_FINDINGS`, `formatQuestions`

**US-006**

- `apps/api/src/fleet/flows/flow-calls.ts` — created by US-002
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `putFile` created by US-004
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `findReviewRepo`
- `apps/api/src/fleet/git-broker/repo-check.exception.ts` — `RepoCheckException` reasons

**US-007**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `decide`, `readSpecHead`, `decisionInput`, `writeDecision`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts` — created by US-006
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts` — `recordCalls`, `countJobsForStep` added by US-003

**US-008**

- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — event constants and parsers
- `apps/api/src/fleet/jobs/job-outcome.recorder.ts` — outbox enqueue pattern
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `writeDecision`
- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts` — created by US-007; its fixture gains the same `OutboxService` stub as the advance service spec

**US-009**

- `apps/api/src/notifications/fleet/fleet-job-outcome.subscriber.ts` — subscriber pattern
- `apps/api/src/notifications/fleet/fleet-notification-drafts.ts` — draft builders
- `apps/api/src/notifications/notification.types.ts` — `NotificationSourceType`
- `apps/api/src/notifications/notifications.module.ts` — subscriber registration

**US-010**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — fleet-side outbox subscriber with `@SystemWriter`
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `ensureFinishTicket`, `commentOnFinish`
- `apps/api/src/auth/principal/actor-principal.loader.ts` — `ActorPrincipalLoader.load`
- `apps/api/src/fleet/flows/flows.module.ts` — module wiring
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`

**US-011**

- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — flow tick fixture pattern
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — `tick`

### Creates

**US-002**

- `apps/api/src/fleet/flows/flow-calls.ts`
- `apps/api/src/fleet/flows/flow-calls.spec.ts`

**US-003**

- `apps/api/prisma/migrations/20261129090000_fleet_flow_verdicts/migration.sql`
- `apps/api/test/integration/fleet/fleet-flow-verdicts-migration.integration.spec.ts`

**US-006**

- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts`

**US-007**

- `apps/api/src/fleet/flows/fleet-flow-advance-calls.spec.ts`

**US-009**

- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.ts`
- `apps/api/src/notifications/fleet/fleet-flow-stopped.subscriber.spec.ts`

**US-010**

- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.ts`
- `apps/api/src/fleet/flows/fleet-flow-stop-ticket.subscriber.spec.ts`

**US-011**

- `apps/api/test/integration/fleet/fleet-flow-verdicts.integration.spec.ts`

### Modifies

**US-001**

- `apps/api/src/fleet/flows/flow-verdict.spec.ts` — its findings fixtures have no `class`, which now makes a verdict unreadable; give each fixture finding a `class` (and the `fix` or `question` that class needs) and expect `formatFindings` entries with the `(<class>)` part; the cases for missing JSON, trailing text and non-array findings keep their expectations.
- `apps/api/src/fleet/flows/flow-steps.spec.ts` — the instruction assertions pin F3's two-field example; they now expect the classified example with `class`, `fix` and `question`, and still expect the final `{"findings":[]}` line.

**US-003**

- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — if it pins the full set of columns a feature or flow row returns, add `callsJobId` and `ticketId` as null; nothing else changes.

**US-005**

- `apps/api/src/fleet/flows/flow-step-decision.spec.ts` — the F3 "any finding stops `review_findings`" cases used class-less findings; they now give a class and assert the F4a rule that applies (`apply_calls` for `minor` on a nax-entry flow, `review_findings` where `canApplyCalls` is false), and every input fixture gains `callsJobId: null`, `planCount: 0` and `canApplyCalls: true`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — agent-output fixtures with class-less findings would now stop as `verdict_unreadable`; give them a class so each test keeps the stop or step it asserts, and expect `review_findings` only where the flow is thread-entry or the rule order still produces it.
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — the strict-stop review case's agent output gains `class` on its finding; where it asserted `review_findings` for a nax-entry flow with a `minor` finding it now uses an `ambiguous` finding and asserts `review_ambiguous`.

**US-007**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — the constructor and module fixtures gain a `FleetFlowCallsService` stub; the step repository stub gains `countJobsForStep` (returning 0) and `recordCalls`; no existing expectation changes.
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — the same constructor stub additions; no existing expectation changes.
- `apps/api/src/fleet/flows/flows.module.spec.ts` — the compiled module now also provides `FleetFlowCallsService`; add it to the expected providers and stub `GitHubAppClient` and `FleetReposService` if not already stubbed.

**US-008**

- `apps/api/src/fleet/flows/fleet-flow-advance.service.spec.ts` — the advance service now takes `OutboxService`; add a stub whose `record` is a spy, and the stop tests may additionally assert the spy; no existing expectation changes.
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — the same `OutboxService` stub; no existing expectation changes.
- `apps/api/src/fleet/flows/flows.module.spec.ts` — stub `OutboxService` for the advance service's new dependency.

**US-009**

- `apps/api/src/notifications/notifications.module.spec.ts` — if it lists the registered fleet subscribers, add `FleetFlowStoppedSubscriber`; nothing else changes.

**US-010**

- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES` table ends at `system.flow.advance`; append `system.flow.ticket: 'any'` after it so the table still equals the catalog's, in the same order.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role's map gains `"system.flow.ticket": ["non-role-key","non-role-key"]` right after `system.flow.advance`, the same value that key has; no other entry changes.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer list gains `[FleetFlowStopTicketSubscriber, 'system.flow.ticket']` and its `toHaveLength(41)` becomes `toHaveLength(42)`.
- `apps/api/src/fleet/flows/flows.module.spec.ts` — the compiled module now also provides `FleetFlowStopTicketSubscriber`; stub its new imports' providers (`FanOutPublisher`, `FleetJobTicketEffects`, `TicketsService`, `ActorPrincipalLoader`) and expect it among the providers.

### Seams

- US-004 → US-006: `FleetFlowCallsService.apply` calls `GitHubAppClient.putFile` with the spec path, the flow branch, the file's blob sha and the built text (US-006 pins the call).
- US-002 → US-006: `apply` commits exactly the text `buildFlowCalls` returns.
- US-006 → US-007: `FleetFlowFeature`'s calls are applied by `advance` calling `FleetFlowCallsService.apply` for an `apply_calls` decision (US-007 seam AC, entered at `advance`).
- US-008 → US-009, US-010: both subscribers register a handler for `fleet_flow_stopped` on `FanOutPublisher` in `onModuleInit` (each story's seam AC, entered through the registered handler).
- US-007 → US-011: `FleetFlowTicker.tick` reaches the calls commit and then dispatches `PLAN` (US-011 proves it against the database).

## Acceptance Criteria

### US-001: Classified verdicts

- [unit] `parseFlowVerdict('ok\n{"findings":[{"id":"F1","class":"minor","summary":"s","fix":"f"}]}')` returns `ok` true with the finding `{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }`.
- [unit] `parseFlowVerdict` of a verdict with one `ambiguous` finding carrying `question: 'q'` returns `ok` true with that finding's `class` `ambiguous` and `question` `q`.
- [unit] `parseFlowVerdict` of a verdict with one `answered` finding carrying `fix: 'f'` returns `ok` true with `class` `answered`.
- [unit] `parseFlowVerdict` of a verdict whose only finding has no `class` returns `{ ok: false }`.
- [unit] `parseFlowVerdict` of a verdict whose only finding has `class: 'major'` returns `{ ok: false }`.
- [unit] `parseFlowVerdict` of a verdict with a `minor` finding and no `fix` returns `{ ok: false }`.
- [unit] `parseFlowVerdict` of a verdict with an `answered` finding whose `fix` is `'   '` returns `{ ok: false }`.
- [unit] `parseFlowVerdict` of a verdict with an `ambiguous` finding and no `question` returns `{ ok: false }`.
- [unit] `parseFlowVerdict('{"findings":[]}')` still returns `{ ok: true, findings: [] }`.
- [unit] `formatFindings([{ id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' }])` returns `1 finding: 1. [F1] (minor) Missing AC`.
- [unit] `FLOW_VERDICT_INSTRUCTION` includes the text `"class":"answered|minor|ambiguous"`.
- [unit] `FLOW_VERDICT_INSTRUCTION` still includes the line `{"findings":[]}` as its last line.

### US-002: The calls block

- [unit] `buildFlowCalls('# Spec\n', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [{ id: 'a', class: 'minor', summary: 'S', fix: 'F' }] })` returns `alreadyApplied` false and a `text` that starts with `# Spec\n` and ends with the lines `## Flow's calls`, a blank line, `### SPEC_REVIEW job j1`, a blank line and `- **a** (minor): S Call: F`.
- [unit] `buildFlowCalls` of a spec that already contains the line `## Flow's calls` adds only the `### <STEP> job <jobId>` block after it, so `## Flow's calls` appears once in the returned `text`.
- [unit] `buildFlowCalls` of a spec that already contains the line `### PRD_REVIEW job j2`, called with `step: 'PRD_REVIEW'` and `jobId: 'j2'`, returns `alreadyApplied` true and the spec text unchanged.
- [unit] `buildFlowCalls` with a finding that has no `id` names it by its 1-based position in the findings list (`- **2** (answered): ...` for the second finding).
- [unit] `buildFlowCalls` with a finding of class `ambiguous` among `minor` ones leaves the ambiguous finding out of the block.
- [unit] `buildFlowCalls` with a `summary` containing a newline writes the summary on one line, the newline replaced by a space.
- [unit] `buildFlowCalls` with a 3,000-character `fix` writes at most `FLOW_CALL_TEXT_MAX` (1000) characters of it.
- [unit] `formatQuestions([{ id: 'q1', class: 'ambiguous', summary: 's', question: 'Which DB?' }])` returns `1 question: 1. [q1] Which DB?`.
- [unit] `formatQuestions` of questions whose joined text exceeds 2,000 characters returns at most 2,000 characters ending in `…`.
- [unit] `FLOW_CALLS_MAX_FINDINGS` equals 20 and `FLOW_CALLS_HEADING` equals `## Flow's calls`.

### US-003: Calls and ticket columns

- [integration] After the migration, a `FleetFlowFeature` row inserted without `callsJobId` reads back with `callsJobId` null.
- [integration] After the migration, a `FleetFlow` row inserted without `ticketId` reads back with `ticketId` null.
- [integration] Deleting the `Ticket` a flow's `ticketId` points at leaves the flow row in place with `ticketId` null.
- [integration] `countJobsForStep(flowId, 'PLAN')` returns 2 for a flow with two `PLAN` jobs and one `SPEC_REVIEW` job.
- [integration] `countJobsForStep(flowId, 'PLAN')` returns 0 for a flow with no jobs.
- [integration] `recordCalls(flowId, featureId, 'j1', 'abc123')` sets the feature's `callsJobId` to `j1` and the flow's `specSha` to `abc123`.
- [integration] `setTicket(flowId, ticketId)` on a flow with no ticket sets `ticketId` and returns true.
- [integration] `setTicket(flowId, otherTicketId)` on a flow that already has a ticket leaves `ticketId` unchanged and returns false.
- [integration] `findById` of a flow returns its `ticketId` and each feature's `callsJobId`.

### US-004: GitHub contents write

- [unit] `putFile(token, 'o', 'r', '.nax/features/a/spec.md', { branch: 'feat/a', content, blobSha: 'b1', message: 'm' })` sends one `PUT` to `/repos/o/r/contents/.nax/features/a/spec.md` whose JSON body has `message` `m`, `branch` `feat/a`, `sha` `b1` and `content` equal to the base64 of `content`.
- [unit] `putFile` returns `{ kind: 'committed', commitSha }` with the response's `commit.sha` when GitHub answers `200`.
- [unit] `putFile` returns `{ kind: 'committed', commitSha }` when GitHub answers `201`.
- [unit] `putFile` returns `{ kind: 'conflict' }` when GitHub answers `409`.
- [unit] `putFile` throws `RepoCheckException` with reason `repo_not_found` when GitHub answers `404`.
- [unit] `putFile` throws `RepoCheckException` with reason `app_permissions_insufficient` when GitHub answers `403`.
- [unit] `putFile` throws `RepoCheckException` with reason `provider_error` when GitHub answers `422` or `500`.
- [unit] `putFile` throws `RepoCheckException` with reason `provider_error` when a `200` response has no string `commit.sha`.
- [unit] `putFile` with a path segment containing a space sends the segment URL-encoded.

### US-005: Step decision for classified verdicts

- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` whose verdict has one `ambiguous` finding returns `stop` `review_ambiguous` with the detail `formatQuestions` returns for it.
- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` with one `minor` and one `ambiguous` finding returns `stop` `review_ambiguous` (rule 2 wins over rule 7).
- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` with 21 `minor` findings returns `stop` `review_findings`.
- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` with one `minor` finding and `canApplyCalls` false returns `stop` `review_findings` with the `formatFindings` detail.
- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` (job `j1`) with one `minor` finding, `canApplyCalls` true and `callsJobId` null returns `apply_calls` with step `SPEC_REVIEW`, job id `j1` and that finding.
- [unit] `decideFlowStep` for the same job with `callsJobId` `j1` returns `dispatch` `PLAN`.
- [unit] `decideFlowStep` for a `COMPLETED` `PRD_REVIEW` (job `j2`) with one `answered` finding, `planCount` 1 and `callsJobId` null returns `apply_calls` with step `PRD_REVIEW` and job id `j2`.
- [unit] `decideFlowStep` for that `PRD_REVIEW` with `callsJobId` `j2` and `planCount` 1 returns `dispatch` `PLAN`.
- [unit] `decideFlowStep` for a `COMPLETED` `PRD_REVIEW` with one `minor` finding and `planCount` 2 returns `stop` `review_findings`.
- [unit] `decideFlowStep` for a `COMPLETED` `PRD_REVIEW` with no findings and `planCount` 2 returns `dispatch` `RUN`.
- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` with no findings still returns `dispatch` `PLAN`.
- [unit] `decideFlowStep` for a `COMPLETED` `SPEC_REVIEW` whose output has a class-less finding returns `stop` `verdict_unreadable`.

### US-006: The calls service

- [unit] `apply` for a nax-entry flow mints an installation token for the repo, reads the spec at `flow.branch`, and calls `putFile` with the spec path, `flow.branch`, the read file's blob sha, the text `buildFlowCalls` returns for the file and the action, and the message `docs(<feature>): flow calls from <STEP> job <jobId>`.
- [unit] `apply` returns `{ kind: 'committed', specSha }` with the commit sha `putFile` returned.
- [unit] `apply` when the spec already contains the action's block heading calls no `putFile` and returns `committed` with the sha `getBranchHead(flow.branch)` returns.
- [unit] `apply` when `findReviewRepo` returns null returns `{ kind: 'failed', detail: 'repo not connected' }`.
- [unit] `apply` when the repo's `githubInstallationId` is null returns `failed` with detail `repo not connected`.
- [unit] `apply` when `getFile` returns null returns `failed` with detail `spec missing on <branch>`.
- [unit] `apply` when `putFile` returns `conflict` and a second `getFile` returns the same blob sha returns `failed` with detail `spec write refused`.
- [unit] `apply` when `putFile` returns `conflict` and a second `getFile` returns a different blob sha returns `{ kind: 'retry' }`.
- [unit] `apply` when the token mint throws `RepoCheckException('app_not_installed')` returns `failed` with detail `app_not_installed`.
- [unit] `apply` when `putFile` throws `RepoCheckException('app_permissions_insufficient')` returns `failed` with detail `app_permissions_insufficient`.
- [unit] `apply` when `getFile` throws `RepoCheckException('repo_not_found')` returns `failed` with detail `repo_not_found`.
- [unit] `apply` when `putFile` throws `RepoCheckException('provider_unreachable')` returns `{ kind: 'retry' }`.
- [unit] `apply` when `putFile` throws a plain `Error` rethrows it.

### US-007: Advance applies calls

- [unit] `advance` for a `RUNNING` nax-entry flow whose latest job is a `COMPLETED` `SPEC_REVIEW` with one `minor` finding calls `FleetFlowCallsService.apply` once with the flow and an `apply_calls` action for that job, and dispatches no job.
- [unit] After `apply` returns `committed` with sha `s2`, `advance` calls `recordCalls(flowId, featureId, jobId, 's2')` and records activity `flow.calls` with `{ step: 'SPEC_REVIEW', jobId, specSha: 's2', count: 1 }`.
- [unit] After `apply` returns `committed`, `advance` records an `AuditRecorder` entry with key `system.flow.advance` and summary `flow calls SPEC_REVIEW`.
- [unit] When `apply` returns `retry`, `advance` writes nothing: no `recordCalls`, no stop, no activity.
- [unit] When `apply` returns `failed` with detail `spec write refused`, `advance` stops the flow as `calls_failed` with detail `SPEC_REVIEW: spec write refused`.
- [unit] When the creator no longer holds `fleet.job.dispatch`, `advance` stops the flow as `creator_lost_access` and calls no `apply`.
- [unit] When the flow left `RUNNING` between the decision and the record, `advance` calls no `recordCalls` after a `committed` outcome.
- [unit] For a flow whose feature's `callsJobId` is the latest `SPEC_REVIEW` job's id and whose `specSha` is that job's calls commit (not the job's `ref`), `advance` dispatches `PLAN` instead of a new `SPEC_REVIEW`.
- [unit] For a `RUNNING` nax-entry flow whose latest job is a `COMPLETED` `PRD_REVIEW` with calls already recorded (`callsJobId` = its id), `advance` reads the forge head of `flow.branch` and, when it equals `specSha`, dispatches `PLAN`.
- [unit] `advance` passes `planCount` from `countJobsForStep(flowId, 'PLAN')` to the decision, so a `PRD_REVIEW` with a `minor` finding on a flow with two `PLAN` jobs stops as `review_findings`.
- [unit] `advance` for a thread-entry flow whose latest `SPEC_REVIEW` has one `minor` finding stops it as `review_findings` and calls no `apply`.

### US-008: The flow-stopped event

- [unit] `parseFlowStoppedPayload` of a payload with every field returns it unchanged.
- [unit] `parseFlowStoppedPayload` of a payload without `flowId` returns null.
- [unit] `parseFlowStoppedPayload` of a payload whose `creatorType` is `RUNNER` returns null.
- [unit] When `advance` stops a flow as `step_failed`, it calls `OutboxService.record` once with type `fleet_flow_stopped`, metadata `{ projectId, eventId: '<flowId>:stopped' }`, and a payload with the flow id, project id, feature, `stopReason` `step_failed`, approver id, creator type and creator id.
- [unit] The event's `detail` is the stop detail cut to its first 500 characters.
- [unit] When `advance` dispatches a step or completes a flow, it records no `fleet_flow_stopped` event.
- [unit] When the stop is written inside `writeStop` after a dispatch refusal (`budget_paused`), the event is recorded in the same transaction as the stop, with `stopReason` `budget_paused`.

### US-009: Stop notifications

- [unit] `FleetFlowStoppedSubscriber.onModuleInit` registers its handler on `FanOutPublisher` for `fleet_flow_stopped`.
- [unit] The handler for a payload with approver `u1` and USER creator `u2` calls `NotificationWriter.deliver` with two drafts, for `u1` and `u2`.
- [unit] The handler for a payload whose USER creator is also the approver delivers one draft.
- [unit] The handler for a payload with an AGENT creator and approver `u1` delivers one draft, for `u1`.
- [unit] The handler for a payload with no approver and an AGENT creator delivers nothing.
- [unit] `flowStoppedDraft(payload, 'sandbox', 'u1')` returns category `FLEET_NEEDS_YOU`, kind `flow_stopped`, title `Flow stopped: <feature>`, body the payload's detail, link `/sandbox/flows/<flowId>`, source type `fleet_flow` and source id the flow id.
- [unit] `flowStoppedDraft` params are `{ flowId, feature, stopReason }`.
- [unit] The handler delivers nothing when `FleetNotificationReader.projectSlug` returns null.
- [unit] The handler skips a malformed payload without calling `deliver`.

### US-010: The flow ticket

- [unit] `FleetFlowStopTicketSubscriber.onModuleInit` registers its handler on `FanOutPublisher` for `fleet_flow_stopped`.
- [unit] The handler for a flow with no ticket loads the creator through `ActorPrincipalLoader.load`, calls `TicketsService.create` with the project slug, type `TASK`, title `Fleet flow: <feature>` and description `Flow <flowId> on <branch>`, and calls `setTicket(flowId, ticketId)`.
- [unit] The handler then calls `FleetJobTicketEffects.commentOnFlowTicket(ticketId, projectId, 'Flow stopped (<stopReason>): <detail>')`.
- [unit] The handler for a flow that already has a ticket creates no ticket and comments on the existing one.
- [unit] When loading the creator throws `ActorUnavailableError`, the handler creates the ticket as the approver.
- [unit] When loading both the creator and the approver throws `ActorUnavailableError`, the handler creates no ticket and posts no comment.
- [unit] The handler for a flow that no longer exists creates no ticket and posts no comment.
- [unit] The handler skips a malformed payload without creating a ticket.
- [unit] `commentOnFlowTicket` on a ticket that already has a comment with the same body creates no comment.
- [unit] `commentOnFlowTicket` on a ticket without that comment creates one system comment and records an audit entry with key `comment.create` and the given project id.
- [unit] `NEW_KEY_SCOPES` maps `system.flow.ticket` to `'any'`, and `FleetFlowStopTicketSubscriber` is declared with `@SystemWriter('system.flow.ticket')`.

### US-011: Classified flows against the database

- [integration] A tick over a `RUNNING` nax-entry flow whose latest job is a `COMPLETED` `SPEC_REVIEW` with one `minor` finding, with a stubbed `GitHubAppClient` whose `putFile` returns commit `c2`, sets the feature's `callsJobId` to that job's id and the flow's `specSha` to `c2`.
- [integration] A second tick over that flow, with the stubbed forge head `c2`, inserts a `PLAN` job with `flowId` the flow's id and `flowStep` `PLAN`.
- [integration] A tick over a flow whose latest `SPEC_REVIEW` has an `ambiguous` finding leaves the flow `STOPPED` with `stopReason` `review_ambiguous` and one outbox row of type `fleet_flow_stopped` with event id `<flowId>:stopped`.
- [integration] Publishing that outbox row through `FanOutPublisher` creates one ticket titled `Fleet flow: <feature>`, sets the flow's `ticketId` to it, and adds one comment starting with `Flow stopped (review_ambiguous):`.
- [integration] Publishing the same outbox row a second time creates no second ticket and no second comment.
- [integration] Publishing that outbox row creates one `flow_stopped` notification for the approver with source type `fleet_flow` and source id the flow id.
- [integration] A tick over a `RUNNING` flow whose latest job is a `COMPLETED` `PRD_REVIEW` with one `minor` finding and two `PLAN` jobs leaves it `STOPPED` with `stopReason` `review_findings`.
