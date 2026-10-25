# SPEC: Permissions P2e — Audit Entries for the Fleet Job, Thread and Approval Routes

## Summary

This feature makes the fleet's human- and agent-initiated writes in `apps/api` record an `AuditEntry` in the same transaction as the write, with the recorder and the rules `permissions-p2-audit-core` delivered (`AuditRecorder.record` inside an existing `txManager.run`, `AuditRecorder.audited` when there is none):
- **Jobs.** `FleetJobsService.dispatch`, `cancel` and `requeue`, and the ticket-job unlink in `FleetTicketsService.unlink`. `dispatch` gains an `auditKey` option so a thread's plan and run record under their own route key.
- **Agent pickup.** `GET /agents/:slug/pickup` records `agent.pickup` for the ticket it suggests (the one live write of `KodaDomainWriter`, handed over by audit-core).
- **Threads.** Every project and workspace thread write: create, cap update, stop, end-session, answer, archive, publish, discard, message send, plan and run. The thread repository owns every one of these transactions, so it records inside them; a pure helper `threadAuditKey` picks the workspace key (`thread.workspace.*`) for a workspace thread.
- **Approvals.** The three decide paths: budget, bash and assistant action. An approved assistant action's tool then runs under the assistant's action context, so the job it dispatches, requeues or cancels is recorded as `SYSTEM/assistant` on behalf of the requester, carrying the approval.

Each entry carries a short summary of ids, states and commands, never a thread title, message text, answer text, feature name or comment a user typed.

This is the fifth of eight features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, **audit-fleet-routes**, audit-fleet-ops, audit-integrations, web.

## Motivation

`permissions-p2-audit-core` (PR #329, deployed `3528f1c7` on 2026-10-25) records the core writes: on koda-wk a comment now leaves a `comment.create` entry. The fleet writes record none. The design's inventory (`2026-10-18-permission-action-inventory.tsv`) lists 58 fleet REST write routes, the assistant's fleet tools and about a dozen fleet system writers, more than one spec's eight stories can cover. They are split into two features:
- **audit-fleet-routes** (this feature): the routes a human or an agent calls to run work (jobs, threads, approvals), the assistant's fleet tools, and agent pickup.
- **audit-fleet-ops**: budgets, schedules, runners and enrollment, repos and repo config, ingest, knowledge, analytics, the runner sync and upload routes, and the fleet system writers.

**Rulings that bind this feature** (user, 2026-10-24):
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The coverage guard and the walker test belong to audit-integrations.** This feature does not add them.

The user skipped the design questions for this feature and for the split ("skip questions", 2026-10-25), so the split into eight features and every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The split.** audit-fleet becomes audit-fleet-routes and audit-fleet-ops, so P2 has eight features. One spec holds eight stories; the fleet surface needs about twelve.
- **Runner traffic is audit-fleet-ops'.** Heartbeats, log chunks, bundle uploads and sync reports are runner protocol, not a human's or agent's action, and they are audited only where they change state. That is the ops feature's to define.
- **Thread writes record in `PrismaChatThreadRepository`.** Its `create`, `updateCap`, `command`, `archive`, `publish`, `discard` and `sendMessage` each own the write's `txManager.run` (or, for `create`, a single insert). Recording in the services instead would need an outer `audited` around those calls, and that breaks two things. `sendMessage` re-runs its transaction when a send races a new job (`kind: 'retry'`), and inside an outer transaction the retry would re-read inside the same one. `ThreadsService.create` turns the insert's `repo_feature` unique violation into a 409, and a nested run that throws poisons the outer transaction (`PrismaTransactionManager.run`, SEC-16). The repository therefore injects `AuditRecorder`, the same way it already injects `FleetActivityService` for the activity rows it writes in the same transactions. This departs from `.nax/rules/api-data.md`'s layering (a repository owns Prisma access only), as the existing `FleetActivityService`, `PlacementService` and `RunnerNotifier` injections already do; extracting the thread transactions into a service is not this feature's.
- **The workspace key is chosen by `threadAuditKey(action, workspace)`.** A new pure function in `src/fleet/threads/thread-audit.ts`. The repository passes `scope.kind === 'workspace'` (for `create`, `input.kind === 'WORKSPACE'`). `create`, `message` and `archive` have workspace keys (`thread.workspace.create`, `thread.workspace.message.send`, `thread.workspace.archive`). `cap`, `stop`, `end-session` and `answer` use the same key in both scopes, the keys `WorkspaceThreadsService.assertThreadKey` checks. `publish`, `discard`, `plan` and `run` exist only for project threads.
- **`dispatch` records under `opts.auditKey`, defaulting to `fleet.job.dispatch`.** `ThreadsService.plan` passes `thread.plan` and `run` passes `thread.run`, the route keys of `POST …/threads/:id/plan` and `…/run`. The dispatch is the whole write of those routes, so they record one entry, under their own key, and no `fleet.job.dispatch` entry beside it. The type is `auditKey?: 'fleet.job.dispatch' | 'thread.plan' | 'thread.run'`.
- **A scheduled fire records `fleet.job.dispatch` for now.** `ScheduleTicker` calls `dispatch` with no `auditKey`, inside `runAsSystem('schedule', …, { onBehalfOf: owner })`, so the fire is recorded as `SYSTEM/schedule` on the owner's behalf. Whether it should use `system.schedule.dispatch`, and the ACs for it, are audit-fleet-ops' (see Out of Scope).
- **A follow-on write in its own transaction records its own entry.** Archiving a thread with a live job cancels the job afterwards (`ThreadsService.archive`, `WorkspaceThreadsService.archive`), and a budget decide that raises and resumes requeues each selected job afterwards (`ApprovalsService.decide`, plan D232). Each of those is a committed write in a separate transaction, so it records `fleet.job.cancel` or `fleet.job.requeue` next to the action's own entry. This differs from audit-core's "record only the action" rule, which covers writes inside one transaction.
- **Only committed writes are recorded.** A refused request (401, 403, 404, 409, 400) records nothing. So do the writes that find nothing to do:
  - a repeated cancel of a job whose cancel is already requested (`FleetJobsService.cancel` returns the job unchanged);
  - an archive of a thread that is already archived (`PrismaChatThreadRepository.archive` returns `null` before writing);
  - a message send whose `clientMessageId` was already stored (`deduplicated: true`);
  - a pickup that finds no verified unassigned ticket (`AgentsService.suggestTicket` returns `null`).
- **Closes that a decide request commits on the way to a 409 are not recorded here.** The bash path closes an ask whose job has ended (`resolvedBy: 'job_ended'`) or expired, and the assistant path expires an action past its `expiresAt`. Both commit and then refuse with 409. They are the same writes `ApprovalExpirySweeper` and `PendingActionExpirySweeper` make, so they belong with those sweepers in audit-fleet-ops (keys `system.approval.expire`, `system.assistant-action.expire`).
- **An approved assistant action records its decide, and its tool records its own writes.** `AssistantActionDecisions.approve` and `reject` record `fleet.approval.decide.assistant` inside `settle`'s transaction. The tool then runs outside it (`executeAction`, 2a-D8 step 8) inside `runWithActionContext({ actor: SYSTEM/assistant, onBehalfOf: USER <requester>, origin: 'thread', approval: approvalFor(action) })`. So a `koda_dispatch_job`, `koda_requeue_job` or `koda_cancel_job` the requester approved is recorded by US-001's `dispatch`, `requeue` or `cancel` with that context, including `approverType` `USER`, `approverId` the requester and `approvalRequestId` the action's id. `finalize` (the `EXECUTED`/`FAILED` status and its note) is bookkeeping of the decided action and is audit-integrations' (see Out of Scope).
- **Pickup wraps the agent event in `audited`.** `suggestTicket` already has `this.audit` (audit-core US-006). It wraps its `recordAgentAction(…, 'TICKET_SUGGESTED', …)` call in `audit.audited`. `KodaDomainWriter.writeAgentAction`'s own `txManager.run` joins it, so the agent event, its outbox row and the entry commit together. The resource is the suggested ticket.
- **`AuditRecorder` is a required constructor dependency, last.** None of `FleetJobsService`, `FleetTicketsService`, `PrismaChatThreadRepository`, `ApprovalsService` or `AssistantActionDecisions` has an `@Optional()` parameter, so audit-core's rule puts it last in each constructor.
- **`projectId` is the row's project.** A job's, a thread's (a workspace thread's home project) and a ticket's project. An approval's entry has the approval's `projectId`, `null` for a global budget policy's ask.

### The summary and resource contract

| Write | Key | `resourceType` | `resourceId` | `projectId` | `summary` |
|:--|:--|:--|:--|:--|:--|
| job dispatch (REST, tool, schedule) | `opts.auditKey ?? 'fleet.job.dispatch'` | `fleet-job` | job id | job's project | `<COMMAND> on repo <repoId>`, then `, thread <threadId>` when the job has a thread and `, schedule <scheduleId>` when it has a schedule (e.g. `RUN on repo r1`, `PLAN on repo r1, thread t1`) |
| thread plan / run (through dispatch) | `thread.plan` / `thread.run` | `fleet-job` | job id | job's project | as dispatch |
| job cancel, ended on the server | `fleet.job.cancel` | `fleet-job` | job id | job's project | `cancelled from <STATE>` |
| job cancel, sent to the runner | `fleet.job.cancel` | `fleet-job` | job id | job's project | `cancel requested in <STATE>` |
| job requeue | `fleet.job.requeue` | `fleet-job` | job id | job's project | `requeued from <STATE>` |
| ticket-job unlink | `fleet.ticket-job.unlink` | `ticket` | ticket id | project id | `job <jobId> unlinked` |
| agent pickup | `agent.pickup` | `ticket` | suggested ticket id | project id | `suggested <REF> to <agentSlug>` |
| thread create | `threadAuditKey('create', workspace)` | `thread` | thread id | thread's project | `created <KIND>` (`REPO`, `PROJECT` or `WORKSPACE`) |
| thread cap update | `thread.cap.update` | `thread` | thread id | thread's project | `fields: maxCostUsd` |
| thread stop / end-session / answer | `thread.stop` / `thread.end-session` / `thread.answer` | `thread` | thread id | thread's project | `stop requested` / `end requested` / `answered` |
| thread archive | `threadAuditKey('archive', workspace)` | `thread` | thread id | thread's project | `archived` |
| thread publish, new job | `thread.publish` | `thread` | thread id | thread's project | `publish job <jobId>` |
| thread publish, into the live session | `thread.publish` | `thread` | thread id | thread's project | `publish into session <jobId>` |
| thread discard | `thread.discard` | `thread` | thread id | thread's project | `discard job <jobId>` |
| thread message send, new session job | `threadAuditKey('message', workspace)` | `thread` | thread id | thread's project | `message <messageId>, job <jobId>` |
| thread message send, into the live session | `threadAuditKey('message', workspace)` | `thread` | thread id | thread's project | `message <messageId>` |
| budget decide | `fleet.approval.decide.budget` | `fleet-approval` | approval id | approval's project or `null` | `decision: <decision>` (`keep_paused`, `raise_budget_and_resume`) |
| bash decide | `fleet.approval.decide.bash` | `fleet-approval` | approval id | approval's project | `decision: <decision>` (`allow`, `allow_for_job`, `deny`) |
| assistant action decide | `fleet.approval.decide.assistant` | `fleet-approval` | approval id | approval's project | `decision: <decision>` (`approve`, `reject`) |

`<STATE>` is the job's state before the write: `QUEUED`, `ASSIGNED`, `RUNNING` or `UPLOADING` for a cancel, `CRASHED`, `FAILED` or `CANCELLED` for a requeue. `<REF>` is the ticket ref (`<project key>-<number>`). The table never lists a value from a request body: the names it prints are ids, refs, slugs, commands, states and decisions.

`threadAuditKey(action, workspace)`:

| `action` | `workspace` false | `workspace` true |
|:--|:--|:--|
| `create` | `thread.create` | `thread.workspace.create` |
| `message` | `thread.message.send` | `thread.workspace.message.send` |
| `archive` | `thread.archive` | `thread.workspace.archive` |
| `cap` | `thread.cap.update` | `thread.cap.update` |
| `stop` | `thread.stop` | `thread.stop` |
| `end-session` | `thread.end-session` | `thread.end-session` |
| `answer` | `thread.answer` | `thread.answer` |
| `publish` | `thread.publish` | `thread.publish` |
| `discard` | `thread.discard` | `thread.discard` |

The `workspace` true cells of `publish` and `discard` are defined for completeness and unused: those repository methods take a `projectId` and exclude `WORKSPACE` threads.

```typescript
// src/fleet/threads/thread-audit.ts
export type ThreadAuditAction = 'create' | 'message' | 'archive' | 'cap' | 'stop' | 'end-session' | 'answer' | 'publish' | 'discard';

/** The catalog key a thread write records under; a workspace thread's create, message and archive have their own keys. */
export function threadAuditKey(action: ThreadAuditAction, workspace: boolean): string;
```

### The writers

| Story | Service.method | Today | Change |
|:--|:--|:--|:--|
| US-001 | `FleetJobsService.dispatch` | `txManager.run`, `fleet-jobs.service.ts:93` | `record` inside, after `activity.record`; key `opts.auditKey ?? 'fleet.job.dispatch'` |
| US-001 | `FleetJobsService.cancel` | `txManager.run`, `:149` | `record` inside each of the three paths that write: the two early server-side `CANCELLED` returns (each records before its `return`) and the runner-command path; not on the already-requested return. Cancel reaches only `QUEUED`, `ASSIGNED`, `RUNNING` and `UPLOADING` (a terminal job is a 409) |
| US-001 | `FleetJobsService.requeue` | `txManager.run`, `:247` | `record` inside, after `transitions.apply`: its result is held in a local and returned after `record` (today the callback returns `this.transitions.apply(...)` directly). Requeue reaches only `CRASHED`, `FAILED` and `CANCELLED` |
| US-001 | `FleetTicketsService.unlink` | `txManager.run`, `fleet-tickets.service.ts:81` | `record` inside, after `events.record` |
| US-007 | `AgentsService.suggestTicket` | `recordAgentAction` → `KodaDomainWriter.writeAgentAction`'s `txManager.run` | wrap the `recordAgentAction` call in `audit.audited` |
| US-002 | `PrismaChatThreadRepository.create` | one insert, no transaction | wrap the insert in `audit.audited` |
| US-002 | `PrismaChatThreadRepository.updateCap` | `txManager.run`, `prisma-chat-thread.repository.ts:162` | `record` inside, after the update |
| US-002 | `PrismaChatThreadRepository.archive` | `txManager.run`, `:213` | `record` inside, after the update; not on the already-archived `null` return |
| US-003 | `PrismaChatThreadRepository.command` | `txManager.run`, `:180` | `record` inside, after `createCommand`; action from `type` (`THREAD_STOP_TURN` → `stop`, `THREAD_CLOSE` → `end-session`, `THREAD_ANSWER` → `answer`) |
| US-003 | `PrismaChatThreadRepository.publish`, `discard` | `txManager.run`, `:234`, `:290` | `record` inside, on each path that wrote a command or a job |
| US-004 | `PrismaChatThreadRepository.sendMessage` | `txManager.run` per attempt, `:330` | `record` inside, on the two paths that stored a message; not on the duplicate or the retry return |
| US-004 | `ThreadsService.plan`, `run` | `fleetJobs.dispatch(…, { threadId })` | pass `{ threadId, auditKey: 'thread.plan' }` / `'thread.run'` |
| US-005 | `ApprovalsService.decide` (budget) | `txManager.run`, `approvals.service.ts:105` | `record` inside, after `repo.resolve`, on both decisions |
| US-005 | `ApprovalsService.decideBash` | `txManager.run`, `:156` | `record` inside, on the `decided` path only |
| US-006 | `AssistantActionDecisions.approve`, `reject` | inside `settle`'s `tx.run`, `assistant-action-decisions.ts:82` | `record` after `approvals.resolve` and `actions.resolve` |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| a write route refuses (401, 403, 404, 409, 400) before writing | no `AuditEntry` row | US-001 to US-006 |
| `dispatch` finds an active job for the same repo and feature (`DuplicateActiveJobError`) | the transaction rolls back with its entry; 409; no entry | US-001 |
| `record` rejects inside `dispatch` | the transaction rolls back; no `FleetJob` row is created; the rejection propagates as an error status | US-001 |
| `cancel` of a job whose cancel is already requested | the job is returned unchanged; no entry | US-001 |
| pickup finds no ticket | `null`; no agent event; no entry | US-001 |
| archive of an already-archived thread | no write; no entry | US-002 |
| a thread create loses the `repo_feature` unique race | the insert and its entry roll back; 409 `threads.featureTaken`; no entry | US-002 |
| a thread command finds no live session | 409 `threads.noSession`; no entry | US-003 |
| a message send repeats a stored `clientMessageId` | `deduplicated: true`; no entry | US-004 |
| `record` rejects inside `sendMessage` | the transaction rolls back; no `ChatMessage` row; the rejection propagates | US-004 |
| a bash or assistant decide finds the ask expired or its job ended | the close commits with no entry from this feature; 409 | US-005, US-006 |
| an approved assistant tool fails (its write is refused) | the approval stays approved with its decide entry; the tool's write recorded nothing | US-006 |

### Integration

Verified at main `3528f1c7`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input)` and `AuditRecorder.audited(fn, entriesOf)`, `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. `record` throws for a key outside the catalog and outside a transaction.
- `mockAuditRecorder` — `src/common/test-helpers/global-stubs.module.ts` (`record` resolves `undefined`, `audited` runs its `fn`).
- `AuditLogModule` is `@Global()`, so every fleet module resolves `AuditRecorder` without importing it.
- `runWithActionContext`, `runAsSystem`, `currentContext` — `src/action-context/action-context.ts`.
- `AssistantToolExecutor.executeAction` (the assistant context with `approvalFor(action)`) — `src/fleet/assistant/assistant-tool.executor.ts:95`.
- `ScheduleTicker` fire (`runAsSystem('schedule', () => this.jobs.dispatch(…, { scheduleId }), { onBehalfOf: owner })`) — `src/fleet/schedules/schedule-ticker.ts:157`.
- `withTestActor(actor, fn)`, `fixtureDb(app)` — `test/helpers/action-context.ts`.
- `seedFleetHttpWorld`, `seedFleetHttpAgent`, `rosterFleetAgent`, `insertRunner` — `test/helpers/fleet-fixtures.ts`; `seedThreadJob`, `seedThreadJobFor` — `test/helpers/thread-fixtures.ts`.
- Route-test precedent: `test/integration/permissions/enforce-fleet-jobs.integration.spec.ts`, `test/integration/fleet/fleet-project-threads.integration.spec.ts`, `fleet-project-thread-send.integration.spec.ts`, `thread-publish.integration.spec.ts`, `thread-discard.integration.spec.ts`, `workspace-create.integration.spec.ts`, `workspace-turns.integration.spec.ts`, `permissions-project-threads.integration.spec.ts`, `fleet-approvals-api.integration.spec.ts`, `assistant-dispatch-job-tool.integration.spec.ts`, `assistant-requeue-job-tool.integration.spec.ts`, `assistant-cancel-job-tool.integration.spec.ts`, `assistant-actions-approve.integration.spec.ts`, `assistant-actor-approve.integration.spec.ts`, `permissions-workspace-threads.integration.spec.ts`.

Changed (baseline → target):
- `FleetJobsService.dispatch` — Baseline: `opts: { scheduleId?; ticketActor?; threadId? }`. Target: `opts: { scheduleId?; ticketActor?; threadId?; auditKey?: 'fleet.job.dispatch' | 'thread.plan' | 'thread.run' }`.
- The constructors of `FleetJobsService`, `FleetTicketsService`, `PrismaChatThreadRepository`, `ApprovalsService` and `AssistantActionDecisions` — Baseline: no `AuditRecorder`. Target: a required `AuditRecorder` as the last parameter.

## Out of Scope

- Budgets, schedules, runners and enrollment, repos and repo config (`config-edits`, `drift-checks`), ingest, knowledge, analytics, the runner routes (`/fleet/runner/sync`, `enroll`, logs, bundle upload, tool calls), the test hooks and every fleet system writer are out of scope (feature `permissions-p2-audit-fleet-ops`).
- Choosing the key a scheduled fire records under (`fleet.job.dispatch` today, possibly `system.schedule.dispatch`) and the ACs for scheduled dispatch are out of scope (feature `permissions-p2-audit-fleet-ops`); this feature leaves the ticker's `dispatch` call unchanged.
- Recording the close that a bash decide commits for an expired ask or an ended job, and the expiry an assistant decide commits for an expired action, is out of scope (feature `permissions-p2-audit-fleet-ops`, with `ApprovalExpirySweeper` and `PendingActionExpirySweeper`).
- Recording `BudgetsService.resume` when `ApprovalsService.decide` calls it inside the budget decide's transaction is out of scope; the decide's `fleet.approval.decide.budget` entry covers that transaction, and audit-fleet-ops records `fleet.budget.resume` only on the budget resume routes.
- Recording job placement (`PlacementService.placeJob` after dispatch and requeue) and runner-reported job transitions is out of scope (feature `permissions-p2-audit-fleet-ops`).
- Recording `AssistantActionDecisions.finalize` (the action's `EXECUTED`/`FAILED` status and its note) and the assistant tools that do not reach a service method this feature or audit-core audits are out of scope (feature `permissions-p2-audit-integrations`).
- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-integrations`).
- Changing `KodaDomainWriter`, `FleetActivityService`, `TicketEvent`, `AgentEvent`, `FleetJobEvent` or outbox payloads is out of scope; they keep their current shapes.
- Recording refused or failed attempts (403, 409, validation errors) is out of scope; only committed writes are recorded, and refusal records belong to P3's approval engine.
- Putting any request value (thread title, message text, answer text, feature name, approval comment, spec path, profile names) into an audit summary is out of scope; summaries carry only the ids, refs, slugs, commands, states and decisions in the contract table.
- A before/after diff of values in `AuditEntry` is out of scope.
- Changing any route's status codes, response bodies or `@Requires` keys is out of scope; `openapi.json` does not change.
- The web Audit log page is out of scope (feature `permissions-p2-web`).
- Throttling or de-duplicating pickup entries is out of scope: `GET /agents/:slug/pickup` is polled, and every call that suggests a ticket already writes an `AgentEvent`, so it records one `agent.pickup` entry per suggesting call.
- US-004 only: an AC that forces `sendMessage`'s lock-race `retry` return is out of scope; the retry path writes nothing and records nothing, and the attempt that stores the message records as any other send.
- US-002 only: auditing the `fleet.job.cancel` that `ThreadsService.archive` triggers is not this story's code; US-001's `cancel` records it, and US-002 only asserts it is there.

## Stories

1. **US-001: Job dispatch, cancel, requeue and ticket-job unlink are audited** — `Workdir: apps/api` — No dependencies. `FleetJobsService` records inside its three transactions and gains `opts.auditKey`; `FleetTicketsService.unlink` records inside its transaction.
2. **US-002: Thread create, cap update and archive are audited** — `Workdir: apps/api` — Depends on US-001. `threadAuditKey`, the `AuditRecorder` injection into `PrismaChatThreadRepository`, and its `create`, `updateCap` and `archive` in both scopes.
3. **US-003: Thread stop, end-session, answer, publish and discard are audited** — `Workdir: apps/api` — Depends on US-002. `PrismaChatThreadRepository.command`, `publish` and `discard`.
4. **US-004: Thread message send, plan and run are audited** — `Workdir: apps/api` — Depends on US-003. `PrismaChatThreadRepository.sendMessage` in both scopes, and `ThreadsService.plan` and `run` passing their `auditKey`.
5. **US-005: Budget and bash approval decisions are audited** — `Workdir: apps/api` — Depends on US-001. `ApprovalsService.decide` (budget) and `decideBash`.
6. **US-006: Assistant action decisions and the approved fleet tools are audited** — `Workdir: apps/api` — Depends on US-001. `AssistantActionDecisions.approve` and `reject`, and the dispatch, requeue and cancel an approved `koda_dispatch_job`, `koda_requeue_job` or `koda_cancel_job` makes.
7. **US-007: Agent pickup is audited** — `Workdir: apps/api` — No dependencies. `AgentsService.suggestTicket` wraps its agent event in `audited`.

Seven stories, one capability: every story wires the same recorder into a different set of fleet writers, and none is useful as a separate PR. US-002 to US-004 share `prisma-chat-thread.repository.ts`, so they run in order. US-002 depends on US-001 because a thread archive's job cancel is recorded by US-001's `cancel`, and US-004 needs US-001's `auditKey`. US-005 and US-006 depend on US-001 for the requeue, dispatch and cancel entries their ACs read. US-007 is independent of the job writers (a different service) and is its own story so US-001 stays within the AC cap.

### Context Files

**US-001**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/tickets/fleet-tickets.service.ts`
- `apps/api/src/fleet/jobs/job-state.ts`
- `apps/api/test/helpers/fleet-fixtures.ts`
- `apps/api/test/integration/permissions/enforce-fleet-jobs.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts`
- `apps/api/src/fleet/threads/workspace-threads.service.ts`
- `apps/api/test/integration/fleet/fleet-project-threads.integration.spec.ts`
- `apps/api/test/integration/fleet/workspace-create.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`
- `apps/api/src/fleet/threads/thread-audit.ts` — created by US-002
- `apps/api/test/helpers/thread-fixtures.ts`
- `apps/api/test/integration/fleet/thread-publish.integration.spec.ts`
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`
- `apps/api/src/fleet/threads/threads.service.ts`
- `apps/api/src/fleet/threads/thread-audit.ts` — created by US-002
- `apps/api/test/integration/fleet/permissions-project-threads.integration.spec.ts`
- `apps/api/test/integration/fleet/workspace-turns.integration.spec.ts`

**US-005**
- `apps/api/src/fleet/approvals/approvals.service.ts`
- `apps/api/src/fleet/approvals/bash-decision.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts`
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts`
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts`
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts`
- `apps/api/test/integration/fleet/assistant-requeue-job-tool.integration.spec.ts`
- `apps/api/test/integration/fleet/assistant-actions-approve.integration.spec.ts`

**US-007**
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/agents/agents.controller.ts`
- `apps/api/src/koda-domain-writer/koda-domain-writer.service.ts`
- `apps/api/test/integration/permissions/core-agent-routes.integration.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-fleet-jobs.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/threads/thread-audit.ts`
- `apps/api/src/fleet/threads/thread-audit.spec.ts`
- `apps/api/test/integration/audit/audit-fleet-threads-lifecycle.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-fleet-threads-commands.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-fleet-threads-send.integration.spec.ts`

**US-005**
- `apps/api/test/integration/audit/audit-fleet-approvals.integration.spec.ts`

**US-006**
- `apps/api/test/integration/audit/audit-fleet-assistant-actions.integration.spec.ts`

**US-007**
- `apps/api/test/integration/audit/audit-fleet-pickup.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — injects AuditRecorder as the last constructor parameter, records inside dispatch's, cancel's and requeue's transactions, and dispatch's opts gain auditKey (default fleet.job.dispatch); responses, placement and live events are unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — its direct new FleetJobsService(...) calls pass mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/fleet-jobs.config-requeue.spec.ts` — its direct new FleetJobsService(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-requeue.spec.ts` — its direct new FleetJobsService(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-handoff.spec.ts` — its direct new FleetJobsService(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/tickets/fleet-tickets.service.ts` — injects AuditRecorder as the last constructor parameter and records fleet.ticket-job.unlink inside unlink's transaction; the other methods are unchanged.
- `apps/api/src/fleet/tickets/fleet-tickets.service.spec.ts` — its direct new FleetTicketsService(...) calls pass mockAuditRecorder as the new last argument; the existing assertions are kept.

**US-002**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — injects AuditRecorder as the last constructor parameter, wraps create's insert in audited and records inside updateCap's and archive's transactions (not on archive's already-archived return); the returned records are unchanged.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — its direct new PrismaChatThreadRepository(...) calls pass mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/threads/prisma-chat-thread.discard.spec.ts` — its direct new PrismaChatThreadRepository(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/threads/thread-scope.spec.ts` — its direct new PrismaChatThreadRepository(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.

**US-003**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — records inside command's transaction after createCommand, and inside publish's and discard's transactions on each path that wrote a command or a job; refusals and responses are unchanged.

**US-004**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — records inside sendMessage's transaction on the two paths that stored a message (not on the duplicate or retry return); the retry loop and responses are unchanged.
- `apps/api/src/fleet/threads/threads.service.ts` — plan and run pass auditKey 'thread.plan' / 'thread.run' next to threadId in their fleetJobs.dispatch opts; nothing else changes.
- `apps/api/src/fleet/threads/threads.service.spec.ts` — the five assertions that plan and run call dispatch with exact opts { threadId: 't1' } (lines 116, 166, 212, 249 and 515; three of them use objectContaining on the dto but still pin the opts exactly) change to { threadId: 't1', auditKey: 'thread.plan' } for plan and { threadId: 't1', auditKey: 'thread.run' } for run; the other assertions are kept.

**US-005**
- `apps/api/src/fleet/approvals/approvals.service.ts` — injects AuditRecorder as the last constructor parameter and records inside the budget decide's transaction (both decisions) and inside decideBash's transaction on the decided path only; the requeue loop, live events and responses are unchanged.
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — its direct new ApprovalsService(...) calls pass mockAuditRecorder as the new last argument; the existing assertions are kept.

**US-006**
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — injects AuditRecorder as the last constructor parameter and records fleet.approval.decide.assistant inside settle's transaction in approve and reject; the expiry path, executeAction and finalize are unchanged.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.spec.ts` — its direct new AssistantActionDecisions(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.

**US-007**
- `apps/api/src/agents/agents.service.ts` — suggestTicket wraps its recordAgentAction(TICKET_SUGGESTED) call in this.audit.audited with an agent.pickup entry for the suggested ticket; the response and the authorization checks are unchanged.

### Seams

- US-002 to US-006 consume audit-core's `AuditRecorder.record` and `audited`. Their integration ACs call the named REST route through the booted `AppModule` and assert the stored `AuditEntry` row (key, resource, project, actor, origin, summary), so they prove the route reaches the recorder through the real wiring rather than a stub.
- US-001's `auditKey` option on `FleetJobsService.dispatch` is consumed by `ThreadsService.plan` and `run` in US-004. Its unit ACs assert the opts `plan` and `run` pass, and its integration ACs call `POST …/threads/:id/plan` and `…/run` and assert the stored entry's key.
- US-002's `threadAuditKey` is consumed by `PrismaChatThreadRepository` in US-002 to US-004. Its integration ACs call a workspace route (`POST /threads`, `POST /threads/:id/messages`, `POST /threads/:id/archive`) and assert the workspace key on the stored entry.
- US-006's tool ACs approve a pending action through `POST /projects/:slug/fleet/approvals/:id/decide`, which reaches `AssistantActionDecisions.decide` → `executeAction` → the tool → US-001's `dispatch`, `requeue` or `cancel`, and assert the entry's actor, `onBehalfOf` and approval fields.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database, create their fixtures with `seedFleetHttpWorld`, `fixtureDb(app)` and the thread and fleet fixtures, call the route over HTTP with a token for the acting principal, and read `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. Threads are disabled in the test config (`threadsEnabled: false`, `src/common/test-helpers/fleet-config.ts`), so every spec that calls a thread route or decides an assistant action sets `app.get(FLEET_CFG).threadsEnabled = true` after boot, as `thread-publish.integration.spec.ts` does, and restores it in `afterAll`. A thread runner is created directly with `fixtureDb(app).runner.create` with `protocolVersion: 4` (`THREAD_MIN_PROTOCOL_VERSION`), `capabilities: { ...FLEET_CAPS, threadWrite: true }`, `enabled: true` and a fresh `lastSeenAt`, as `permissions-project-threads.integration.spec.ts` does; `insertRunner` and `enrollRunner` set `protocolVersion: 1` and no `threadWrite`, so publish, discard and a live-session send refuse with `threads.runnerOutdated` on them. A live session is a thread whose `runnerId` is that runner plus a `RUNNING` THREAD job with a `SESSION` turn on it: `seedThreadJobFor` with that runner (its `ThreadFixtureRunner` needs only `runnerId` and an `apiKey` string), or `seedThreadJob` followed by `fixtureDb(app).runner.update` of the runner it enrolled to the values above. A thread with no active job, with `writtenPaths`, with `specPublished`, or with a `pendingQuestion` is created or updated directly with `fixtureDb(app).chatThread`. A `QUEUED` session job is the seeded job updated to `state: 'QUEUED'`, `runnerId: null`, `leaseEpoch: 0`. Plan needs a `REPO` thread with `specPublished: true`, `runnerId` the thread runner and no active job (`dispatch` takes `lockIdleThread`); run additionally needs a `PLAN` job of the thread in state `COMPLETED`. Each AC seeds its own thread, so a command one AC sends (an end-session's `THREAD_CLOSE`) never refuses another AC's. Assistant actions are proposed through the real tool call, as `assistant-actions-approve.integration.spec.ts` does. Every fixture id is created by the spec itself, never a fixed string, so entries from other specs cannot collide. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource (and key, where named) returns an empty array.

### US-001: Job dispatch, cancel, requeue and ticket-job unlink are audited

1. [integration] `POST /api/projects/:slug/fleet/jobs` with a `RUN` on the project's repo, as a user holding `fleet.job.dispatch`, returns 201 and leaves one entry for the new job's id with `key` `fleet.job.dispatch`, `resourceType` `fleet-job`, `projectId` the project's id, `actorType` `USER`, `actorId` the user's id, `origin` `rest` and `summary` `RUN on repo <repoId>`.
2. [integration] A second `POST /api/projects/:slug/fleet/jobs` for the same repo and feature while the first job is active returns 409, and the project's `fleet.job.dispatch` entries are still exactly one.
3. [integration] `POST /api/projects/:slug/fleet/jobs` as a member without `fleet.job.dispatch` returns 403 and leaves no `fleet.job.dispatch` entry with `projectId` the project's id.
4. [unit] `FleetJobsService.dispatch` with stub collaborators, a stub transaction manager whose `run` calls its callback, and a stub recorder calls the recorder's `record` once, inside the `run` callback and after the repository's `createJob`, with `key` `fleet.job.dispatch` and `resourceId` the created job's id when `opts.auditKey` is absent.
5. [unit] The same `dispatch` call with `opts.auditKey` `thread.plan` calls `record` with `key` `thread.plan` and does not call it with `fleet.job.dispatch`.
6. [integration] `POST /api/projects/:slug/fleet/jobs`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and leaves no `FleetJob` row for that repo and feature.
7. [integration] `POST /api/projects/:slug/fleet/jobs/:id/cancel` on a `QUEUED` job returns 200 and leaves one entry for the job with `key` `fleet.job.cancel` and `summary` `cancelled from QUEUED`.
8. [integration] `POST …/cancel` on a `RUNNING` job (a runner assigned, the assign acknowledged) leaves one entry for the job with `key` `fleet.job.cancel` and `summary` `cancel requested in RUNNING`.
9. [integration] Repeating `POST …/cancel` on that `RUNNING` job (its cancel already requested) returns 200 and leaves still exactly one `fleet.job.cancel` entry for the job.
10. [integration] `POST /api/projects/:slug/fleet/jobs/:id/requeue` on a `FAILED` job returns 200 and leaves one entry for the job with `key` `fleet.job.requeue` and `summary` `requeued from FAILED`.
11. [integration] `DELETE /api/projects/:slug/tickets/:ref/fleet-jobs/:jobId` for a job linked to the ticket leaves one entry for the ticket's id with `key` `fleet.ticket-job.unlink`, `resourceType` `ticket` and `summary` `job <jobId> unlinked`.
12. [integration] `DELETE /api/projects/:slug/tickets/:ref/fleet-jobs/:jobId` for a job not linked to the ticket returns 404 and leaves no `fleet.ticket-job.unlink` entry for the ticket.

### US-002: Thread create, cap update and archive are audited

1. [unit] `threadAuditKey(action, workspace)`, called for each of the nine actions with `workspace` false and true, returns the key in the Design's `threadAuditKey` table for every one of the 18 pairs (a table-driven test over that table).
2. [integration] `POST /api/projects/:slug/threads` for a `REPO` thread with title `secret-title` returns 201 and leaves one entry for the new thread's id with `key` `thread.create`, `resourceType` `thread`, `projectId` the project's id, `actorType` `USER` and `summary` `created REPO`.
3. [integration] The `thread.create` entry left by that `POST` has a `summary` that does not include `secret-title`.
4. [integration] A second `POST /api/projects/:slug/threads` for the same repo and feature returns 409 and the project's `thread.create` entries are still exactly one.
5. [integration] `POST /api/threads` (a workspace thread with a home project) returns 201 and leaves one entry for the new thread's id with `key` `thread.workspace.create`, `projectId` the home project's id and `summary` `created WORKSPACE`.
6. [integration] `POST /api/threads` as an agent that holds `thread.workspace.create` through a global role binding and `thread.create` in a home project with an anchor repo (the recipe of `permissions-workspace-threads.integration.spec.ts`: a custom global role with `WORKSPACE_AGENT_KEYS`) leaves an entry with `actorType` `AGENT` and `actorId` the agent's id.
7. [integration] `PATCH /api/projects/:slug/threads/:id` with `{ maxCostUsd: 5 }` leaves one entry for the thread with `key` `thread.cap.update` and `summary` `fields: maxCostUsd`.
8. [integration] `POST /api/projects/:slug/threads/:id/archive` leaves one entry for the thread with `key` `thread.archive` and `summary` `archived`.
9. [integration] Repeating `POST /api/projects/:slug/threads/:id/archive` on the archived thread leaves still exactly one `thread.archive` entry for the thread.
10. [integration] `POST /api/projects/:slug/threads/:id/archive` on a thread with a `QUEUED` session job leaves a `thread.archive` entry for the thread and a `fleet.job.cancel` entry for that job with `summary` `cancelled from QUEUED`.
11. [integration] `PATCH /api/threads/:id` with `{ maxCostUsd: 5 }` on the caller's workspace thread leaves one entry for the thread with `key` `thread.cap.update` and `projectId` the home project's id.
12. [integration] `POST /api/threads/:id/archive` on the caller's workspace thread leaves one entry for the thread with `key` `thread.workspace.archive`.
13. [integration] `POST /api/threads/:id/archive` on another user's workspace thread returns 404 and leaves no entry for that thread.

### US-003: Thread stop, end-session, answer, publish and discard are audited

1. [integration] `POST /api/projects/:slug/threads/:id/stop` on a thread whose session job is `RUNNING` on a runner leaves one entry for the thread with `key` `thread.stop` and `summary` `stop requested`.
2. [integration] `POST /api/projects/:slug/threads/:id/end-session` on a thread whose session job is `RUNNING` on a runner leaves one entry for the thread with `key` `thread.end-session` and `summary` `end requested`.
3. [integration] `POST /api/projects/:slug/threads/:id/answer` with the thread's pending question's `requestId` and text `secret-answer` leaves one entry for the thread with `key` `thread.answer` and `summary` `answered`.
4. [integration] The `thread.answer` entry left by that `POST` has a `summary` that does not include `secret-answer`.
5. [integration] `POST /api/projects/:slug/threads/:id/stop` on a thread with no live session returns 409 and leaves no `thread.stop` entry for the thread.
6. [integration] `POST /api/threads/:id/stop` on the caller's workspace thread with a `RUNNING` session leaves one entry for the thread with `key` `thread.stop` and `projectId` the home project's id.
7. [integration] `POST /api/threads/:id/answer` on the caller's workspace thread with a pending question leaves one entry for the thread with `key` `thread.answer`.
8. [integration] `POST /api/projects/:slug/threads/:id/publish` on a `REPO` thread with written paths, no active job and an online runner that reports `threadWrite` returns the route's success status and leaves one entry for the thread with `key` `thread.publish` and `summary` `publish job <jobId>`, where `<jobId>` is the `jobId` the response returns.
9. [integration] `POST …/publish` on a thread whose session job is `RUNNING` with no turn in flight, by the session's requester, leaves one entry for the thread with `key` `thread.publish` and `summary` `publish into session <session job id>`.
10. [integration] `POST …/publish` on a thread with no written paths and no active job returns 409 and leaves no `thread.publish` entry for the thread.
11. [integration] `POST /api/projects/:slug/threads/:id/discard` on a `REPO` thread with no active job and an online runner that reports `threadWrite` leaves one entry for the thread with `key` `thread.discard` and `summary` `discard job <jobId>`, where `<jobId>` is the `jobId` the response returns.

### US-004: Thread message send, plan and run are audited

1. [integration] `POST /api/projects/:slug/threads/:id/messages` with text `secret-text` on a thread with no live session returns the route's success status and leaves one entry for the thread with `key` `thread.message.send`, `resourceType` `thread` and `summary` `message <messageId>, job <jobId>`, the `message.id` and `jobId` the response returns.
2. [integration] The `thread.message.send` entry left by that `POST` has a `summary` that does not include `secret-text`.
3. [integration] Repeating that `POST` with the same `clientMessageId` returns `deduplicated: true` and leaves still exactly one `thread.message.send` entry for the thread.
4. [integration] `POST …/messages` on a thread whose session job is `RUNNING` with no turn in flight, by the session's requester, leaves an entry for the thread with `key` `thread.message.send` and `summary` `message <messageId>`.
5. [integration] `POST …/messages` on an archived thread returns 409 and leaves no `thread.message.send` entry for the thread.
6. [integration] `POST …/messages`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and leaves no `ChatMessage` row with that `clientMessageId`.
7. [integration] `POST /api/threads/:id/messages` on the caller's workspace thread leaves one entry for the thread with `key` `thread.workspace.message.send` and `projectId` the home project's id.
8. [integration] `POST /api/projects/:slug/threads/:id/plan` on a published `REPO` thread with a runner returns 201 and leaves one entry for the dispatched job's id with `key` `thread.plan`, `resourceType` `fleet-job` and `summary` `PLAN on repo <repoId>, thread <threadId>`.
9. [integration] That `POST …/plan` leaves no `fleet.job.dispatch` entry for the dispatched job's id.
10. [integration] `POST /api/projects/:slug/threads/:id/run` on that thread after its `PLAN` job is `COMPLETED` leaves one entry for the dispatched job's id with `key` `thread.run` and `summary` `RUN on repo <repoId>, thread <threadId>`.
11. [unit] `ThreadsService.plan` with a stub `FleetJobsService` and a stub thread repository returning a published `REPO` thread with a runner calls `dispatch` with the opts `{ threadId: <thread id>, auditKey: 'thread.plan' }`.
12. [unit] `ThreadsService.run` with the same stubs and a `COMPLETED` plan calls `dispatch` with the opts `{ threadId: <thread id>, auditKey: 'thread.run' }`.

### US-005: Budget and bash approval decisions are audited

1. [integration] `POST /api/fleet/approvals/:id/decide` with `{ decision: 'keep_paused' }` on a pending budget approval, as a holder of `fleet.approval.decide.budget`, returns 200 and leaves one entry for the approval's id with `key` `fleet.approval.decide.budget`, `resourceType` `fleet-approval`, `actorType` `USER`, `actorId` the decider's id and `summary` `decision: keep_paused`.
2. [integration] That entry's `projectId` is the approval's `projectId`, and `null` when the approval's policy is global.
3. [integration] `POST /api/fleet/approvals/:id/decide` with `{ decision: 'raise_budget_and_resume', amountUsd, requeueJobIds: [<candidate job id>] }` leaves one entry for the approval with `summary` `decision: raise_budget_and_resume`.
4. [integration] That raise-and-resume decide also leaves one entry for the requeued job's id with `key` `fleet.job.requeue`.
5. [integration] `POST /api/fleet/approvals/:id/decide` on an approval that is no longer pending returns 409 and adds no `fleet.approval.decide.budget` entry for it.
6. [integration] `POST /api/projects/:slug/fleet/approvals/:id/decide` with `{ decision: 'deny' }` on a pending bash approval of a `RUNNING` job whose lease epoch matches, as a holder of `fleet.approval.decide.bash`, leaves one entry for the approval with `key` `fleet.approval.decide.bash` and `summary` `decision: deny`.
7. [integration] `POST /api/projects/:slug/fleet/approvals/:id/decide` on a pending bash approval as a member without `fleet.approval.decide.bash` returns 403 and leaves no entry for the approval.
8. [integration] `POST /api/projects/:slug/fleet/approvals/:id/decide` on a pending bash approval whose job is no longer `RUNNING` returns 409 and leaves no `fleet.approval.decide.bash` entry for the approval.
9. [integration] `POST /api/projects/:slug/fleet/approvals/:id/decide` on a pending bash approval whose `expiresAt` has passed returns 409 and leaves no `fleet.approval.decide.bash` entry for the approval.
10. [unit] `ApprovalsService.decide` on a budget approval, with a stub transaction manager whose `run` calls its callback and a stub recorder, calls the recorder's `record` once, inside the `run` callback and after the approval repository's `resolve`, with `key` `fleet.approval.decide.budget`.
11. [integration] Repeating `POST /api/projects/:slug/fleet/approvals/:id/decide` on a bash approval that was already decided returns 409 and leaves still exactly one `fleet.approval.decide.bash` entry for the approval.

### US-006: Assistant action decisions and the approved fleet tools are audited

1. [integration] `POST /api/projects/:slug/fleet/approvals/:id/decide` with `{ decision: 'approve' }` on a pending `assistant_action` approval, by the action's requester, leaves one entry for the approval's id with `key` `fleet.approval.decide.assistant`, `resourceType` `fleet-approval`, `actorType` `USER`, `actorId` the requester's id and `summary` `decision: approve`.
2. [integration] The same `POST` with `{ decision: 'reject' }` leaves one entry for the approval with `summary` `decision: reject`.
3. [integration] That `POST` by a project member who is not the action's requester but holds `fleet.approval.decide.bash` (the seeded `developer` role, so the route guard passes and the refusal is the handler's `threads.notCreator`) returns 403 and leaves no entry for the approval.
4. [integration] That `POST` on an action whose `expiresAt` has passed returns 409 and leaves no `fleet.approval.decide.assistant` entry for the approval.
5. [integration] Approving a pending `koda_dispatch_job` action through that route leaves one entry for the dispatched job's id with `key` `fleet.job.dispatch`, `actorType` `SYSTEM`, `actorId` `assistant`, `onBehalfOfType` `USER`, `onBehalfOfId` the requester's id and `origin` `thread`.
6. [integration] That `fleet.job.dispatch` entry has `satisfiedBy` `human`, `approverType` `USER`, `approverId` the requester's id and `approvalRequestId` the pending action's id.
7. [integration] Approving a pending `koda_requeue_job` action for a `FAILED` job leaves one entry for that job with `key` `fleet.job.requeue`, `actorType` `SYSTEM` and `actorId` `assistant`.
8. [integration] Approving a pending `koda_cancel_job` action for a `QUEUED` job leaves one entry for that job with `key` `fleet.job.cancel`, `actorType` `SYSTEM` and `actorId` `assistant`.
9. [integration] Approving a pending `koda_dispatch_job` action whose repo and feature already have an active job returns 200 with the approval approved, leaves its `fleet.approval.decide.assistant` entry, and leaves no `fleet.job.dispatch` entry with `actorId` `assistant` in the project.
10. [unit] `AssistantActionDecisions.decide` with `{ decision: 'approve' }`, a stub transaction manager whose `run` calls its callback, a stub recorder and a stub executor, calls the recorder's `record` with `key` `fleet.approval.decide.assistant` inside the `run` callback, and before the executor's `executeAction`.
11. [integration] Approving a pending `koda_dispatch_job` action through `POST /api/projects/:slug/fleet/approvals/:id/decide` and then repeating that same approving `POST` returns 409 on the repeat, and the approval still has exactly one `fleet.approval.decide.assistant` entry and the project exactly one `fleet.job.dispatch` entry with `actorId` `assistant`.

### US-007: Agent pickup is audited

1. [integration] `GET /api/agents/:slug/pickup?project=<slug>` as the agent, with one `VERIFIED` unassigned ticket in the project, leaves one entry for that ticket's id with `key` `agent.pickup`, `resourceType` `ticket`, `projectId` the project's id, `actorType` `AGENT`, `actorId` the agent's id and `summary` `suggested <ref> to <agent slug>`.
2. [integration] `GET /api/agents/:slug/pickup?project=<slug>` as the agent when the project has no `VERIFIED` unassigned ticket leaves no `agent.pickup` entry with `projectId` the project's id.
3. [integration] Two `GET /api/agents/:slug/pickup?project=<slug>` calls as the agent that both suggest the same ticket leave two `agent.pickup` entries for that ticket.
