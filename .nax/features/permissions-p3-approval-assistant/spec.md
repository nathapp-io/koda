# SPEC: Permissions P3c — Assistant Writes on the Approval Engine

Closes: #301

## Summary

This feature moves the assistant's nine write tools (the thread tools and the same tools over MCP) off `PendingAction` and onto the approval engine of `permissions-p3-approval-core`.
- **One command per write tool.** Each write tool registers an `ApprovalCommand` under its catalog key (`comment.create`, `ticket.create`, `ticket.update`, `ticket.link.add`, `memory.create`, `memory.decision.record`, `fleet.job.dispatch`, `fleet.job.cancel`, `fleet.job.requeue`). The command's frozen input is the project, the thread and job it came from, and the tool's parsed arguments.
- **Every write call goes through `ApprovalGate.gate`.** The policy resolver, not `approvalModeFor`, decides whether a write runs at once or waits. A thread write is the assistant acting on behalf of the thread's requester (subject `ASSISTANT`, default `human`). An MCP write is the calling agent's own (subject `AGENT`, catalog default `none` for these keys). A policy can now make any of them `none`, `self`, `agent` or `human`.
- **A thread's waiting write is an `ApprovalRequest` plus a thread link.** The new table `AssistantActionRequest` holds what only the thread needs: the thread, job and tool call, the tool name, the preview, and the outcome-note and delivery marks. The request carries status, approver and result.
- **Outcome notes come from request events.** A subscriber on `approval_request_changed` writes the thread's system note when a linked request is executed, failed, rejected, expired or cancelled. The next message hands the notes to the agent, as before.
- **The thread card decides through `POST /approvals/:id/decisions`.** The thread detail's `pendingActions` lists linked pending requests, with the request id in `id` and `approvalId`.
- **`PendingAction` is dropped**, with its propose service, decide handler, expiry sweeper and repository, the `assistant_action` fleet approval type, and `approvalModeFor`.

This is the third of six features implementing phase P3 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). The order (ruled 2026-10-26): approval-core, approval-api, **approval-assistant**, approval-fleet, approval-gate, web.

## Motivation

`permissions-p3-approval-core` (PR #338) built the engine and `permissions-p3-approval-api` (PR #339, `313dfb60`) put it behind REST, MCP and the CLI, but no production code opens a request yet. The assistant still runs its own approval model:
- `approvalModeFor` (`src/fleet/assistant/actions/approval-policy.ts`) is a code default: a user's thread write waits for the user, everything else runs at once. Nothing reads a policy, so koda #301 ("configurable approval policy per tool") is still open.
- `PendingAction` duplicates what `ApprovalRequest` now models (actor, on-behalf-of, mode, approver, status, result, expiry), and opens a second record, an `assistant_action` `FleetApproval`, so the fleet inbox can show it.
- A waiting write can only be `human` and only in a thread. An MCP write can only be `none`. The `self` and `agent` modes exist in the model but nothing serves them.

The design (§4) replaces `PendingAction` and `FleetApproval` with one request model and makes the assistant's tool executors registry entries, so REST (feature 5), MCP and threads share one mechanism.

**Rulings that bind this feature** (user, 2026-10-26): P3 is six features in the order above. This one is "`PendingAction` → `ApprovalRequest`, `approvalModeFor` reads the engine, drop `PendingAction`, closes #301". The deferred-run mechanism is the command registry: a per-key executor with validated input; the assistant tool executors become registry entries. Design decision 2 (no data migration) applies: pending actions are not copied. Decision 8: the thread's on-behalf-of user may approve the assistant's write.

**#301 is closed by ruling.** Its checklist is met by the three P3 features together: the policy store (approval-core); the agent decide path `koda_decide_approval` (the issue's `koda_decide_action`) and policy CRUD over REST and the CLI (approval-api); `self` confirmation through the actor's own decide (approval-core eligibility); and the assistant reading the store instead of code defaults (this feature). The web policy editor item is delivered by `permissions-p3-web`, which the user ruled part of the same P3 plan.

This spec is one capability: the assistant's writes moved onto the engine. It has twelve stories because each path (waiting thread writes, direct thread writes, reads and deciding, decided outcomes, MCP) is sized to the 15-assertion gate, and the removal is split across two stories by the 40-entry `### Modifies` limit.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The command input is domain-shaped plus provenance.** `{ projectId, threadId, jobId, args }`, where `args` is the tool's parsed input. It carries no preview and no tool name, so the REST gate of feature 5 can open the same command with `threadId: null, jobId: null`. `threadId` stays in the input because `koda_add_memory` and `koda_record_decision` record it as provenance.
- **The thread link is its own table, not columns on `ApprovalRequest`.** `AssistantActionRequest` (one row per thread request, keyed by `requestId`) holds the thread, job, tool call, tool name, preview and the note and delivery marks. These are thread bookkeeping, not approval state, and the engine stays free of thread knowledge. An MCP request gets no link row.
- **The mode is resolved before any lock.** The executor asks `ApprovalPolicyResolver.resolve` (newly exported by `ApprovalEngineModule`) for the call's mode first. A `none` write calls the gate with no transaction and no lock, so the tool runs exactly as the direct path ran it before: its writes are its own, a batch tool's partial writes stand, and no thread lock is held while a fleet tool takes a job lock (the ingest fold and job effects lock job, then thread). A waiting write takes the thread lock, checks the cap, opens the request through the gate and writes the link in one transaction that runs no tool. The one exception is a policy that changes between the executor's resolution and the gate's: a write resolved as waiting that the gate runs at once runs its tool inside that transaction.
- **The cap is checked before the gate's duplicate lookup.** With 10 linked requests pending, a retry of a pending write with a new `toolCallId` is refused rather than answered with the existing request id. The agent is told not to retry a pending write. The gate's duplicate key includes the input's `jobId`, so the same write asked in a new turn opens a second request, bounded by the cap.
- **An approved command's failure fails the request, rolls back, and keeps no tool text.** `ApprovalExecutionService` runs the command inside its settle transaction, and this transaction manager rolls back the outer transaction when any nested `run()` throws, even if the throw is caught (`PrismaTransactionManager`, SEC-16). So the command rethrows every tool error: `NotFoundAppException`, `ToolActionError` and anything else. The engine settles the request `failed` with `result: { error: 'execution-failed', name }`, and none of the tool's writes persist. On the approved path a batch is all-or-nothing, and the agent's note says `not_found` or `error: <tool> failed`; the tool's own failure sentence (2b1-D2, for example `KODA-1 cannot move from CLOSED to IN_PROGRESS`) is not carried. On the direct path the tool's text still reaches the agent.
- **An agent-created thread's write now waits.** The gate treats every assistant call as subject `ASSISTANT`, whose default is `human`, whether the requester is a user or an agent. Before this feature an agent's thread write ran at once. The agent (the on-behalf-of principal) may approve it with `koda_decide_approval`, and an admin can set an `ASSISTANT` policy of `none`.
- **Who may decide a thread write widens from "the requester only" to the engine's eligibility.** The requester still may (decision 8). A principal holding `approval.decide` and the action's key may too (approval-core `decideEligibility`), for example a Project Admin. One holding `approval.decide` without the action's key may not (`approverMustHoldAction` defaults to true).
- **Outcome notes are written by an outbox subscriber.** `approval_request_changed` is recorded in the transaction that changed the status, and the relay retries a failed handler. So the note is written once, after the change commits, however the request was settled (decided, executed, swept, cancelled). The note can appear one relay interval after the decision. The subscriber declares `@SystemWriter('system.thread.ingest')`, the key of the other system writer of thread transcript rows (`ThreadIngestHook`), and runs in the relay's own `runAsSystem('outbox')` context (an allowlisted unaudited surface); it does not open `runAsSystemWriter`.
- **A direct write records no extra row.** A `none` write runs inside the gate. Its audit entry, written by the domain service with the gate's `approval` block, is the record. The agent's answer loses the `action <id>` suffix, and `koda_get_action` reads requests only.
- **The pending answer drops "user".** It becomes `pending <requestId>: awaiting approval; do not retry`, because the approver may be an agent.

### The command (US-002)

`AssistantToolCommands` (provider of `AssistantModule`) injects `AssistantToolRegistry` and `ApprovalCommandRegistry` and, in `onModuleInit`, registers one `ApprovalCommand` per registered write tool through `assistantToolCommand(tool, deps)`. It is listed after the tool group providers, so their `onModuleInit` registrations have run first.

```ts
export interface AssistantCommandInput {
  projectId: string;
  threadId: string | null;
  jobId: string | null;
  args: unknown;          // the tool's own parsed input
}

export interface AssistantCommandResult {
  text: string;           // masked, capped at RESULT_CAP_BYTES
}

export function assistantToolCommand(tool: AssistantTool, deps: AssistantCommandDeps): ApprovalCommand<AssistantCommandInput, AssistantCommandResult> {
  return {
    key: tool.key,
    parse: (input) => parseCommandInput(input, tool),          // shape checked, args: tool.parse(args)
    execute: (input) => runToolCommand(tool, input, deps),     // principal, membership, ToolContext, tool.execute
    toResult: (result) => result,
  };
}
```

`execute` runs inside the engine's action context (the gate's on the direct path, the request's on the approved path):
1. The principal is the context's `onBehalfOf` when the actor is `SYSTEM/assistant`, otherwise the actor (`USER` or `AGENT`). A user is loaded with `findUserActor` and built with `userPrincipal`, an agent with the new `findAgentActor` and `agentPrincipal` (both exported unchanged from `assistant-tool.executor.ts`). A missing principal, a disabled user, a `PAUSED` agent, or a principal `ProjectAccessService.resolveMembership` refuses in `projectId` throws `AssistantCommandRefusedError`.
2. The project slug is read with the new `AssistantToolCallRepository.findProjectSlug(projectId)`; a null answer throws `NotFoundAppException({}, 'projects')`.
3. `tool.execute` runs with a `ToolContext` built from the input: `projectId`, the slug, the principal, `threadId`, `jobId`, `now: new Date()`, a fresh fence token for `data`, and `can` checking the principal's key in `projectId` through `PermissionService.can`.
4. The tool's text answers `{ text: capText(maskSecrets(text), RESULT_CAP_BYTES) }`. Every error is rethrown.

On the approved path the engine re-checks the principal's key before `execute` (`stillHoldsKey`). On the direct path the executor's own `can()` check before the preview is that check; the command does not repeat it.

### The thread link (US-001)

```prisma
model AssistantActionRequest {
  requestId          String    @id
  threadId           String?
  jobId              String?
  toolCallId         String?
  tool               String
  preview            String    @db.Text
  noteMessageId      String?
  notedAt            DateTime?
  deliveredAt        DateTime?
  deliveredMessageId String?
  createdAt          DateTime  @default(now())

  request ApprovalRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  thread  ChatThread?     @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@index([threadId])
  @@index([threadId, deliveredAt])
  @@index([deliveredMessageId])
}
```

Migration `20261105090000_assistant_action_request`. `ApprovalRequest` gains `assistantAction AssistantActionRequest?` and `ChatThread` gains `assistantActionRequests AssistantActionRequest[]`.

`src/fleet/assistant/requests/assistant-action-request.domain.ts` holds `ASSISTANT_ACTION_REQUEST_REPOSITORY`, the record types and `MAX_PENDING_ACTIONS = 10` (from US-001 on, the import every reader uses). `PrismaAssistantActionRequestRepository` (same directory):
- `insert(link)`: one row; answers it.
- `findByRequest(requestId)`: the row or null.
- `lockThread(threadId)`: `SELECT ... FOR UPDATE` on the `ChatThread` row; false when it is gone (the same query as `PrismaPendingActionRepository.lockThread`).
- `lockByRequest(requestId)`: `SELECT ... FOR UPDATE` on the link row; null when gone.
- `insertSystemNote(threadId, content)`: one `system` message with the next `seq` from `allocateThreadSeq`; answers its id (the same write as `PrismaPendingActionRepository.insertSystemNote`).
- `markNoted(requestId, noteMessageId, at)`.
- `countPendingInThread(threadId)`: rows of the thread whose request status is `pending`.
- `findScopedInThread(requestId, projectId, threadId)`: the row with its request when the row's thread is `threadId` and the request's project is `projectId`, else null.
- `findOwnRequest(requestId, projectId, actor)`: the `ApprovalRequest` whose id and project match and whose `actorType`/`actorId` are the actor's, with its link when one exists, else null.

### Waiting thread writes (US-005)

`AssistantToolExecutor.writeTool`, for an origin of kind `thread`, after the permission check and the preview (both unchanged):
1. `mode = (await resolver.resolve({ key: tool.key, projectId, subject: { type: 'ASSISTANT', id: 'assistant' } })).mode`.
2. **Any mode but `none`:** in one transaction: `lockThread(threadId)` (false answers `not_found`); `countPendingInThread(threadId) >= MAX_PENDING_ACTIONS` answers `refused: 10 actions are pending in this thread; wait for the user to decide them` with outcome `refused`; otherwise the gate opens or answers the pending request, and the link (`requestId`, `threadId`, `jobId`, `toolCallId`, the tool's name, the preview) is inserted unless one exists for that request, inside `bookkeeping('assistant.action-request-link', ...)`. The call answers `pending <requestId>: awaiting approval; do not retry`, outcome `pending`. After the commit, one `thread` frame is published on `ThreadEventBus` for a newly linked request.
3. A throw from the gate or the transaction is caught outside the transaction and answers `error: <tool> failed`, with the stack logged.
4. **`none`:** in US-005 the existing `directWrite` still runs (it records a `PendingAction` through `recordDirect`); US-006 replaces it.

`koda_get_action` in a thread reads `findScopedInThread(id, ctx.projectId, ctx.threadId)` from US-005 on. Its lines: `action <id> <tool> <status>`, `requested <createdAt>`, `decided <decidedAt>` when set, `settled <settledAt>` when set, then `result:` and the fenced result `text` when the request has one. `ActionTools` injects both the link repository and `PENDING_ACTION_REPOSITORY` until US-009 moves the MCP read; from US-009 on it injects only the link repository.

The context is the one `executeUnstored` already opens (`SYSTEM/assistant`, on behalf of the requester, origin `thread`), so the gate's subject is `ASSISTANT`.

### Direct thread writes (US-006)

**`none`:** `gate(tool.key, { projectId, threadId, jobId, args }, { projectId })` with no transaction. `executed` answers `result.text` with outcome `ok`. A thrown `NotFoundAppException` answers `not_found`, a `ToolActionError` its masked text with outcome `error`, anything else `error: <tool> failed` with the stack logged (the mapping `directWrite` applies today). If the gate answers `pending` (a policy changed between the two resolutions), the link is written as in the waiting path, without the cap. `directWrite` is no longer called for a thread origin.

### Thread detail and deciding (US-007, US-008)

The thread detail's `pendingActions` (`PrismaChatThreadRepository.pendingActions`) reads linked requests with status `pending`, scoped as today, oldest first, at most `MAX_PENDING_ACTIONS`. Each answers `id` = `approvalId` = the request id, `tool` and `preview` from the link, `projectSlug` of the request's project, `expiresAt` of the request, `createdAt` of the link. `PendingActionDto` keeps its shape.

Deciding is the engine's `POST /approvals/:id/decisions` (approval-api), unchanged. US-007 pins who may decide and what an approve or reject writes; US-008 pins the notes, the failure outcomes and expiry through the relay and the engine's sweeper.

### MCP write calls (US-009)

For an origin of kind `mcp`, `writeTool` keeps the permission check and the preview (whose `not_found`, `invalid_input` and `forbidden` refusals still answer before any request), then calls `gate(tool.key, { projectId, threadId: null, jobId: null, args }, { projectId })` with no transaction, no lock and no link. `executed` answers `result.text`. `pending` answers `pending <requestId>: awaiting approval; do not retry`, outcome `pending`. Errors map as on the direct thread path. The context is the MCP one `executeFor` already opens (actor `AGENT`, origin `mcp`).

`koda_get_action` over MCP reads `findOwnRequest(id, projectId, { type: 'AGENT', id })`. The tool name in the first line is the link's when one exists, otherwise the request's `permissionKey`.

### Outcome notes (US-003) and delivery (US-004)

`requestOutcomeNote({ requestId, tool, status, result })` answers, with `<text>` capped at `NOTE_RESULT_MAX` (500) characters plus `…`:

| Request status | Result | Note |
|:--|:--|:--|
| `executed` | `{ text }` | `Action <id> (<tool>) was approved and done: <text>` |
| `failed` | `name` `NotFoundAppException` | `Action <id> (<tool>) was approved but failed: not_found` |
| `failed` | any other | `Action <id> (<tool>) was approved but failed: error: <tool> failed` |
| `rejected` | — | `Action <id> (<tool>) was rejected.` |
| `expired` | — | `Action <id> (<tool>) expired without a decision.` |
| `cancelled` | — | `Action <id> (<tool>) was cancelled.` |

`AssistantActionOutcomeSubscriber` (registered on `FanOutPublisher` for `APPROVAL_REQUEST_CHANGED`; `AssistantModule` imports `OutboxCoreModule` for it) handles a payload whose status is one of those five:
1. No link for `requestId`, or a link with no `threadId`: nothing.
2. In one transaction: `lockThread(threadId)` (false: nothing), `lockByRequest(requestId)`, and if `notedAt` is set, nothing. Otherwise read the request (`ApprovalRequestQueries.findById`), insert the system note and `markNoted`.
3. After the commit: a `message` frame with the note's id and a `thread` frame on `ThreadEventBus`.

Any other status is ignored. A malformed payload is skipped with a `warn`.

Delivery reads the link and request tables instead of `PendingAction`:
- `PrismaChatThreadRepository.deliverOutcomeNotes(threadId, messageId, userText)`: the thread's links whose request status is one of the five and whose `deliveredAt` is null, oldest first, at most `MAX_DELIVERED_NOTES`; notes from `requestOutcomeNote`; `deliveryText`; the first `delivered` marked with `deliveredAt` and `deliveredMessageId`.
- `PrismaFleetJobRepository.initialMessageText(message)`: the links delivered on `message.id`, rebuilt the same way.

`DELIVERABLE_STATUSES` becomes the five lowercase request statuses.

### Web (US-010)

`useApprovalRequests()` (new composable) exposes `decide(id, decision, comment?)`, which posts `{ decision }` (plus `comment` when it is a non-empty string) to `/approvals/<id>/decisions`. `ThreadActionCard.vue` decides through it with `action.id` and no longer uses `useFleetApprovals`.

### Removal (US-011, US-012)

US-011 deletes the assistant side: `PendingAction` (migration `20261105090100_drop_pending_action`, which also deletes `FleetApproval` rows of type `assistant_action`), `pending-action.domain.ts`, `prisma-pending-action.repository.ts`, `assistant-action.service.ts`, `assistant-action-decisions.ts`, `pending-action-expiry.sweeper.ts`, `approval-policy.ts`, `outcome-note.ts`, the executor's approve-path methods and `directWrite`, the system key `system.assistant-action.expire` (with its action-inventory row), and the bookkeeping reasons `assistant.action-proposal`, `assistant.direct-action-record` and `assistant.action-finalize`.

US-012 deletes the fleet side: `assistant-action.port.ts`, `ApprovalCloser.openAssistant` and `AssistantActionAsk`, the `assistant_action` branch of `ApprovalsService.decide` and of `FleetApprovalRequestedSubscriber`, `actionRequestedDraft`, the assistant fields of the fleet approval notification payload, and `assistant_action` in `APPROVAL_TYPES` and the DTO enums derived from it.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| Command input without a string `projectId`, or `threadId`/`jobId` neither string nor null | `parse` throws | US-002 |
| Command arguments the tool's parser refuses | `parse` throws the tool's `ToolInputError` | US-002 |
| Principal gone, user disabled, agent paused, or not a member of the project at execution | `AssistantCommandRefusedError`; on the approved path the engine marks the request `failed` | US-002 |
| Any tool error in the command | Rethrown; on the approved path the request is `failed` and its writes roll back | US-002, US-008 |
| Thread gone when a waiting thread write takes the lock | Answers `not_found`; no request | US-005 |
| 10 linked requests already pending in the thread | Answers `refused: 10 actions are pending...`; no request, no link | US-005 |
| Gate answers an existing pending request for a second call with the same input | Answers that request's id; no second link | US-005, US-009 |
| Gate or transaction throws on the waiting path | Answers `error: <tool> failed` and logs | US-005 |
| Direct write whose target is missing | Answers `not_found` | US-006 |
| Direct write that fails partway (`ToolActionError`) | Answers the tool's masked text; the writes already made stand | US-006 |
| Direct write with any other error | Answers `error: <tool> failed` and logs | US-006, US-009 |
| Decide by a principal without the action's key | 403 `approvals.decideForbidden`, request stays pending | US-007 |
| Approve after the target was deleted | Request `failed`; note `...was approved but failed: not_found` | US-008 |
| Outcome event for a request with no link or no thread | Nothing written | US-003 |
| Outcome event redelivered after the note was written | Nothing written | US-003 |
| Outcome event after the thread was deleted | Nothing written, no throw | US-003 |
| Malformed `approval_request_changed` payload | Skipped with `warn` | US-003 |
| Decide from the thread card fails | The card toasts the API's message and stays decidable | US-010 |

### Integration

Symbols this feature reads (verified on `main` at `313dfb60`):
- `ApprovalGate.gate`, `GateOutcome`, `ApprovalCommand`, `ApprovalCommandRegistry.register`/`get`, `ApprovalPolicyResolver.resolve`, `ApprovalExecutionService`, `ApprovalRequestExpirySweeper.tick`, `ApprovalPolicyService.create`, `ApprovalRequestQueries.findById`, `APPROVAL_REQUEST_CHANGED`, `parseApprovalRequestChangedPayload`, `ApprovalRequestRecord`: `src/approvals/`.
- `FanOutPublisher.register`: `src/outbox/fan-out-publisher.ts`; `OutboxCoreModule`: `src/outbox/outbox-core.module.ts`. Pattern: `ApprovalRequestLiveSubscriber` (`src/live/approval-request-live.subscriber.ts`). `SystemWriter`: `src/permissions/system-writer.decorator.ts`.
- `bookkeeping`: `src/action-context/audit-coverage.ts`. `runWithActionContext`, `currentContext`: `src/action-context/action-context.ts`.
- `AssistantTool`, `ToolContext`, `ToolActionError`, `ToolInputError`, `ToolForbiddenError`: `src/fleet/assistant/assistant-tool.types.ts`. `capText`, `fenceData`, `maskSecrets`: `src/fleet/assistant/assistant-tool-safety.ts`. `RESULT_CAP_BYTES`: `src/fleet/assistant/assistant-tool.executor.ts`.
- `ProjectAccessService.resolveMembership`: `src/projects/project-access.service.ts`. `PermissionService.can`: `src/permissions/permission.service.ts`.
- `ThreadEventBus.publish`: `src/live/thread-event-bus.ts`. `deliveryText`, `MAX_DELIVERED_NOTES`, `DELIVERY_HEADER`: `src/fleet/assistant/actions/outcome-delivery.ts`. `allocateThreadSeq`: `src/fleet/threads/domain/chat-thread.domain.ts`.
- Test helpers: `bootHttpApp`, `seedFleetHttpWorld`, `fixtureDb`, `withTestActor`, `resetDb`, `createTestPrismaClient` (`test/helpers/`); `grantKeys` (`src/approvals/test-helpers/approval-fixtures.ts`); `OutboxRelay.dispatchPendingBatch` (pattern `test/integration/outbox/outbox-relay.integration.spec.ts`); the sweeper is provided but not exported, so tests reach it with `app.get(ApprovalRequestExpirySweeper, { strict: false })`.
- Web: `useApi` (`apps/web/composables/useApi.ts`), `extractApiError`, `useAppToast`.

Symbols this feature changes. The baseline only locates the code and is never the interface to implement:
- `ApprovalEngineModule` exports. Baseline: the policy service, registry, gate, decision and execution services, queries and MCP tools. Target: also `ApprovalPolicyResolver` (US-005).
- `userPrincipal`, `agentPrincipal` in `assistant-tool.executor.ts`. Baseline: module-private. Target: exported, unchanged (US-002).
- `AssistantToolExecutor.writeTool`. Baseline: `approvalModeFor`, then `directWrite` (records a `PendingAction` through `recordDirect`) or `proposeWrite` (`ActionProposer.propose`). Target: waiting thread writes (US-005), direct thread writes (US-006), MCP writes (US-009). The executor gains `ApprovalGate`, `ApprovalPolicyResolver`, `ASSISTANT_ACTION_REQUEST_REPOSITORY`, `ThreadEventBus` and `TRANSACTION_MANAGER` in its constructor (US-005).
- `AssistantToolExecutor.checkAction`, `executeAction`, `attachActions`, `proposeWrite`, `directWrite`. Baseline: the PendingAction paths. Target: deleted (US-011).
- `AssistantToolCallRepository`. Baseline: `findUserActor`, `findByCall`, `record`, `findCallContext`. Target: gains `findAgentActor(agentId): Promise<AgentToolCallCreator | null>` and `findProjectSlug(projectId): Promise<string | null>` (US-002).
- `getActionTool`. Baseline: takes `Pick<PendingActionRepository, 'findScopedById' | 'findScopedByActor'>`. Target: takes both repositories, reading linked requests in a thread (US-005); takes only the link repository and reads the caller's own requests over MCP (US-009).
- `PrismaChatThreadRepository.pendingActions`. Baseline: reads `PendingAction`. Target: reads linked pending requests (US-007). `deliverOutcomeNotes` and `PrismaFleetJobRepository.initialMessageText`: read links joined to requests (US-004).
- `DELIVERABLE_STATUSES`. Baseline: `['EXECUTED', 'FAILED', 'REJECTED', 'EXPIRED']`. Target: `['executed', 'failed', 'rejected', 'expired', 'cancelled']` (US-004).
- `AssistantModule`. Baseline: provides the `PendingAction` services and imports `ApprovalStoreModule`. Target: provides the link repository (US-001), `AssistantToolCommands` (US-002), `AssistantActionOutcomeSubscriber` and imports `OutboxCoreModule` (US-003); drops the `PendingAction` providers and `ApprovalStoreModule` (US-011).
- `ThreadActionCard.vue`. Baseline: `useFleetApprovals(...).decide(action.approvalId, ...)`. Target: `useApprovalRequests().decide(action.id, decision)` (US-010).

## Out of Scope

- The fleet approvals inbox stops showing assistant actions: no `assistant_action` approval is opened after US-005. The web inbox's assistant panel stays in the code until `permissions-p3-web`, which lists `ApprovalRequest`s in the unified inbox.
- The `pendingApprovals` count of `koda_my_projects` keeps counting fleet approvals only; assistant requests join it with `permissions-p3-approval-fleet`.
- Notifying the thread's requester of a new assistant request is not added: the thread card and the live `thread` frame show it, and approval-api's notification goes to users holding `approval.decide`.
- `fleet.approval.decide.assistant` stays in the catalog and in `PENDING_SURFACE_KEYS`; it is retired with the other fleet approval keys in `permissions-p3-approval-fleet`.
- Pending `PendingAction` rows are not migrated (design decision 2); the drop discards them.
- The `PendingActionDto.approvalId` description keeps its wording; the DTO is replaced by the unified inbox's types in `permissions-p3-web`.
- An approved command that fails does not carry the tool's own failure sentence to the agent; the note names `not_found` or `error: <tool> failed`, and the request's `result` holds the error name.
- A pending request whose thread is deleted keeps its `ApprovalRequest` (only the link cascades); it can still be decided or expire. Deciding does not check `threadsEnabled` (the engine's decide route has no thread knowledge).
- Moving `FleetApproval` (bash asks, budget overrides) onto `ApprovalRequest` is `permissions-p3-approval-fleet`; gating REST and CLI writes is `permissions-p3-approval-gate`; the policy pages are `permissions-p3-web`.
- US-005 only: two concurrent waiting writes of one thread are serialised by the thread row lock, so they cannot both take the last cap slot; the concurrent race itself is not tested here (the lock is the 2a-D4 one, whose concurrency test is deleted with the propose service).
- US-007 only: two concurrent approves of one request are serialised by the engine's `lockById` (approval-core); the loser answers 409 `approvals.notPending`.
- US-008 only: an outcome note lags the decision by one outbox relay interval.
- US-009 only: an MCP request has no preview and no link row; `koda_list_approvals` and `GET /approvals/:id` show its frozen input.
- The assistant never decides requests: `SYSTEM/assistant` is refused by decide eligibility (approval-core).
- Editing `.nax/rules/` or `.nax/mono/` context files is not part of any story.

## Stories

1. **US-001: The thread link table and its repository** — `Workdir: apps/api` — No dependencies. The `AssistantActionRequest` model and migration, the relations on `ApprovalRequest` and `ChatThread`, `MAX_PENDING_ACTIONS` in the new domain module, and `PrismaAssistantActionRequestRepository` (insert, lookups, thread and link locks, system note, cap count, the caller's own request) behind `ASSISTANT_ACTION_REQUEST_REPOSITORY`, provided by `AssistantModule`.
2. **US-002: One approval command per write tool** — `Workdir: apps/api` — No dependencies. `assistantToolCommand`, `AssistantCommandInput`, `AssistantCommandResult`, `AssistantCommandRefusedError`, the exported `userPrincipal`/`agentPrincipal`, `AssistantToolCallRepository.findAgentActor` and `findProjectSlug`, and `AssistantToolCommands`, which registers the nine write tools' commands at module init.
3. **US-003: Outcome notes from request events** — `Workdir: apps/api` — Depends on US-001. `requestOutcomeNote` and `AssistantActionOutcomeSubscriber` with its `@SystemWriter`; `AssistantModule` imports `OutboxCoreModule`.
4. **US-004: Outcome delivery from requests** — `Workdir: apps/api` — Depends on US-003. The new `DELIVERABLE_STATUSES` and the delivery reads of `PrismaChatThreadRepository` and `PrismaFleetJobRepository` moved onto the link table.
5. **US-005: Waiting thread writes through the gate** — `Workdir: apps/api` — Depends on US-001, US-002. `ApprovalPolicyResolver` exported; the waiting branch of `writeTool` for thread origins (resolve, lock, cap, gate, link, live frame); `koda_get_action` in a thread; the bookkeeping reason `assistant.action-request-link`.
6. **US-006: Direct thread writes through the gate** — `Workdir: apps/api` — Depends on US-005. The `none` branch of `writeTool` for thread origins goes through the gate with no transaction, replacing `directWrite` there.
7. **US-007: Thread detail and deciding thread requests** — `Workdir: apps/api` — Depends on US-005. The thread detail's `pendingActions` from linked requests, and who may decide a thread request through `POST /approvals/:id/decisions` and what approve and reject write.
8. **US-008: Decided thread requests: notes, failures and expiry** — `Workdir: apps/api` — Depends on US-003, US-007. The outcome notes, failed outcomes and expiry of decided thread requests through the relay and the engine's sweeper.
9. **US-009: MCP write calls through the gate** — `Workdir: apps/api` — Depends on US-002, US-006. The MCP branch of `writeTool` and `koda_get_action` over MCP.
10. **US-010: The thread card decides through the approvals route** — `Workdir: apps/web` — Depends on US-007. `useApprovalRequests` and `ThreadActionCard.vue` deciding through `POST /approvals/:id/decisions`.
11. **US-011: Remove PendingAction** — `Workdir: apps/api` — Depends on US-004, US-006, US-008, US-009. Deletion only: the `PendingAction` model and code, `approvalModeFor`, the executor's PendingAction paths, `system.assistant-action.expire` and the three bookkeeping reasons.
12. **US-012: Remove the assistant fleet approval type** — `Workdir: apps/api` — Depends on US-011. Deletion only: `AssistantActionPort`, `ApprovalCloser.openAssistant`, the `assistant_action` branches of the fleet approvals service and notification subscriber, `actionRequestedDraft`, and the type itself.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma` — `ApprovalRequest`, `ChatThread`, `PendingAction` (the model this replaces)
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — `lockThread`, `insertSystemNote` and the queries this replaces
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — repository and `lockById` pattern
- `apps/api/src/fleet/assistant/assistant.module.ts` — where the repository is provided
- `.nax/rules/api-repositories.md` — repository conventions

**US-002**
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand`
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `executeAction`, `actionContext`, `userPrincipal`, `agentPrincipal`
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `AssistantTool`, `ToolContext`, tool errors
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — `findUserActor`, where the two lookups go
- `.nax/rules/api-testing.md` — module registration tests are unit tests

**US-003**
- `apps/api/src/fleet/assistant/actions/outcome-note.ts` — today's note texts
- `apps/api/src/live/approval-request-live.subscriber.ts` — the outbox subscriber pattern
- `apps/api/src/notifications/approvals/approval-requested.subscriber.ts` — a writing subscriber with `@SystemWriter`
- `apps/api/src/approvals/approval-execution.service.ts` — the `failed` result shape
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer map

**US-004**
- `apps/api/src/fleet/assistant/actions/outcome-delivery.ts` — `deliveryText`, `DELIVERABLE_STATUSES`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `deliverOutcomeNotes`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `initialMessageText`
- `apps/api/src/fleet/assistant/requests/request-outcome-note.ts` — created by US-003, integrated here

**US-005**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `writeTool`, `proposeWrite`
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — the propose transaction this replaces
- `apps/api/src/approvals/approval-gate.service.ts` — `gate`, `GateOutcome`
- `apps/api/src/approvals/approval-policy.resolver.ts` — `resolve`, the `ASSISTANT` subject
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `getActionTool`

**US-006**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `directWrite`, the error mapping
- `apps/api/test/integration/fleet/assistant-thread-gate.integration.spec.ts` — created by US-005, the thread route fixtures

**US-007**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `pendingActions`
- `apps/api/src/approvals/approval-requests.controller.ts` — the decide route
- `apps/api/src/approvals/approval-eligibility.ts` — who may decide

**US-008**
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — `tick`
- `apps/api/test/integration/outbox/outbox-relay.integration.spec.ts` — running the relay in a test
- `apps/api/src/fleet/assistant/tools/link-tickets-tool.ts` — the batch tool of AC-5

**US-009**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `executeFor`, `writeTool`
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `getActionTool`
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — the MCP entry point
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — MCP route test pattern

**US-010**
- `apps/web/components/fleet/threads/ThreadActionCard.vue` — the card
- `apps/web/composables/useFleetApprovals.ts` — the composable it stops using
- `apps/web/composables/useApi.ts` — `$api.post`
- `apps/web/tests/components/thread-action-card.spec.ts` — the card's tests

**US-011**
- `apps/api/src/fleet/assistant/assistant.module.ts` — providers to drop
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the PendingAction paths
- `apps/api/src/permissions/catalog.ts` — `system.assistant-action.expire`
- `apps/api/src/action-context/audit-coverage.reasons.ts` — the three reasons

**US-012**
- `apps/api/src/fleet/approvals/approvals.service.ts` — the `assistant_action` branch
- `apps/api/src/fleet/approvals/approval-closer.ts` — `openAssistant`
- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — the `assistant_action` branch
- `apps/api/src/fleet/approvals/dto/list-approvals.query.ts` — the `type` filter

### Creates

**US-001**
- `apps/api/prisma/migrations/20261105090000_assistant_action_request/migration.sql`
- `apps/api/src/fleet/assistant/requests/assistant-action-request.domain.ts`
- `apps/api/src/fleet/assistant/requests/prisma-assistant-action-request.repository.ts`
- `apps/api/test/integration/fleet/assistant-action-request.repository.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/assistant/commands/assistant-tool.command.ts`
- `apps/api/src/fleet/assistant/commands/assistant-tool-commands.ts`
- `apps/api/src/fleet/assistant/commands/assistant-tool.command.spec.ts`
- `apps/api/test/integration/fleet/assistant-tool-call-lookups.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/assistant/requests/request-outcome-note.ts`
- `apps/api/src/fleet/assistant/requests/request-outcome-note.spec.ts`
- `apps/api/src/fleet/assistant/requests/assistant-action-outcome.subscriber.ts`
- `apps/api/test/integration/fleet/assistant-action-outcome.integration.spec.ts`

**US-004**
- `apps/api/test/integration/fleet/assistant-request-delivery.integration.spec.ts`

**US-005**
- `apps/api/test/integration/fleet/assistant-thread-gate.integration.spec.ts`

**US-006**
- `apps/api/test/integration/fleet/assistant-thread-direct.integration.spec.ts`

**US-007**
- `apps/api/test/integration/fleet/assistant-thread-decide.integration.spec.ts`

**US-008**
- `apps/api/test/integration/fleet/assistant-thread-outcomes.integration.spec.ts`

**US-009**
- `apps/api/test/integration/fleet/assistant-mcp-gate.integration.spec.ts`

**US-010**
- `apps/web/composables/useApprovalRequests.ts`
- `apps/web/tests/composables/useApprovalRequests.spec.ts`

**US-011**
- `apps/api/prisma/migrations/20261105090100_drop_pending_action/migration.sql`

**US-012**
None.

### Modifies

**US-001**
- `apps/api/prisma/schema.prisma` — adds the `AssistantActionRequest` model and the `assistantAction` / `assistantActionRequests` relation fields on `ApprovalRequest` and `ChatThread`; no existing field changes.
- `apps/api/src/fleet/assistant/assistant.module.ts` — provides `PrismaAssistantActionRequestRepository` and the `ASSISTANT_ACTION_REQUEST_REPOSITORY` alias.

**US-002**
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — `AssistantToolCallRepository` gains `findAgentActor` and `findProjectSlug`.
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — implements `findAgentActor` (id, slug, status, null when absent) and `findProjectSlug` (the slug, null when absent or soft-deleted).
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — exports `userPrincipal` and `agentPrincipal` unchanged.
- `apps/api/src/fleet/assistant/assistant.module.ts` — provides `AssistantToolCommands` after the tool group providers.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains one test: after `module.init()`, `ApprovalCommandRegistry.get` answers a command for each of the nine write tool keys; existing tests are unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — its `AssistantToolCallRepository` double gains `findAgentActor` and `findProjectSlug` stubs so it still satisfies the interface; no assertion changes.
- `apps/api/src/fleet/assistant/assistant-tool.executor.actor.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.
- `apps/api/src/fleet/assistant/assistant-tool.executor.direct.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.
- `apps/api/src/fleet/assistant/assistant-tool.executor.agent-caller.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.
- `apps/api/src/fleet/assistant/assistant-tool.executor.caller.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.
- `apps/api/src/fleet/assistant/assistant-tool.executor.workspace.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.
- `apps/api/src/fleet/assistant/tools/kb-tools.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.
- `apps/api/src/fleet/assistant/tools/workspace-tools.spec.ts` — its `AssistantToolCallRepository` double gains the two stubs; no assertion changes.

**US-003**
- `apps/api/src/fleet/assistant/assistant.module.ts` — provides `AssistantActionOutcomeSubscriber` and imports `OutboxCoreModule`.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer map gains `[AssistantActionOutcomeSubscriber, 'system.thread.ingest']`; the expected writer count goes from 36 to 37; the declared key set is unchanged.

**US-004**
- `apps/api/src/fleet/assistant/actions/outcome-delivery.ts` — `DELIVERABLE_STATUSES` becomes the five lowercase request statuses.
- `apps/api/src/fleet/assistant/actions/outcome-delivery.spec.ts` — an assertion pinning the four uppercase PendingAction statuses becomes one pinning the five lowercase request statuses.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `deliverOutcomeNotes` reads and marks links joined to requests instead of PendingAction, with notes from `requestOutcomeNote`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `initialMessageText` rebuilds notes from links delivered on the message.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.find-thread-assign.spec.ts` — fixtures that seed PendingAction rows to drive `initialMessageText` seed a request and a delivered link instead; the invariant (the assign rebuilds the same note text from the message's delivered outcomes) is unchanged, and note texts follow `requestOutcomeNote`.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — delivery cases that seed PendingAction rows seed requests and links instead; the invariant (undelivered terminal outcomes are prefixed once, then marked on the message) is unchanged, and note texts follow `requestOutcomeNote`.
- `apps/api/test/integration/fleet/assistant-action-delivery.integration.spec.ts` — seeds requests and links instead of proposing through AssistantActionService; the delivery invariant is unchanged, note texts follow `requestOutcomeNote`, and cancelled joins the deliverable statuses.
- `apps/api/test/integration/fleet/assistant-action-send-delivery.integration.spec.ts` — seeds requests and links instead of PendingAction rows; the send-path delivery invariant is unchanged and note texts follow `requestOutcomeNote`.

**US-005**
- `apps/api/src/approvals/approval-engine.module.ts` — exports `ApprovalPolicyResolver`.
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the waiting branch of `writeTool` for thread origins goes through the resolver, the thread lock and the gate as in "Waiting thread writes"; the constructor gains the gate, the resolver, the link repository, `ThreadEventBus` and `TRANSACTION_MANAGER`.
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `getActionTool` reads linked requests in a thread; `ActionTools` injects the link repository beside the PendingAction repository.
- `apps/api/src/action-context/audit-coverage.reasons.ts` — adds `assistant.action-request-link`: "The thread link of a waiting assistant write: its thread, job, tool call, tool and preview; the request is `approval.request-open`."
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — `EXPECTED_REASON_IDS` gains `assistant.action-request-link`.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — thread write cases that expected ActionProposer.propose expect the resolver call, then a gate call with `{ projectId, threadId, jobId, args }` and the pending answer; refusal and replay cases are unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.agent-caller.spec.ts` — the agent-requester thread write cases (AC-9, AC-10 and both B1 cases) that asserted recordDirect or propose now assert a pending request opened through the gate on behalf of the agent (subject ASSISTANT, default human).
- `apps/api/src/fleet/assistant/write-tool-errors.spec.ts` — thread cases that expected a proposal expect the gate's answers; the preview refusal cases are unchanged.
- `apps/api/src/fleet/assistant/tools/action-tools.spec.ts` — `koda_get_action` thread cases read requests and links; the not_found invariant for another thread or project is unchanged; status texts are the lowercase request statuses.
- `apps/api/test/integration/fleet/assistant-actions-propose.integration.spec.ts` — delete: it pins AssistantActionService.propose, which this story stops calling; the lock, cap and duplicate behaviour is this story's AC-6, AC-7 and AC-11; the concurrency race is declared out of scope.
- `apps/api/test/integration/fleet/assistant-action-actor.integration.spec.ts` — the two thread-write cases assert the actor on the ApprovalRequest (SYSTEM/assistant on behalf of the requester) instead of the PendingAction; the remaining PendingAction and sweeper cases are left for US-011.
- `apps/api/test/integration/fleet/assistant-action-tools.integration.spec.ts` — koda_add_comment and koda_get_action through the runner route answer pending with a request id and read the request; every prisma.pendingAction assertion is replaced by its ApprovalRequest or link equivalent; status texts are lowercase.
- `apps/api/test/integration/fleet/assistant-actor-approve.integration.spec.ts` — approves through POST /approvals/:id/decisions as the on-behalf-of user; every prisma.pendingAction assertion is replaced by its ApprovalRequest equivalent; the written row's actor invariant is unchanged.
- `apps/api/test/integration/fleet/assistant-add-memory-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; the tool's write invariants are unchanged.
- `apps/api/test/integration/fleet/assistant-cancel-job-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; a failed-approve case asserts a failed request with its error name instead of the tool's text.
- `apps/api/test/integration/fleet/assistant-create-tickets-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; a partial-batch-after-approval case asserts a failed request with none of the batch's tickets written.
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; a failed-approve case asserts a failed request with its error name instead of the tool's text.
- `apps/api/test/integration/fleet/assistant-link-tickets-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; the partial-batch-after-approval case asserts a failed request with no link of the batch written instead of the tool's text.
- `apps/api/test/integration/fleet/assistant-record-decision-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; the tool's write invariants are unchanged.
- `apps/api/test/integration/fleet/assistant-requeue-job-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; a failed-approve case asserts a failed request with its error name instead of the tool's text.
- `apps/api/test/integration/fleet/assistant-update-ticket-tool.integration.spec.ts` — the approve step goes through POST /approvals/:id/decisions; prisma.pendingAction assertions become ApprovalRequest assertions; the case asserting the transition refusal text after approval asserts a failed request with its error name instead.
- `apps/api/test/integration/fleet/permissions-assistant-tools.integration.spec.ts` — thread write cases answer pending with a request id; every prisma.pendingAction assertion (counts, lookups and status) is replaced by its ApprovalRequest equivalent; the permission refusal invariants are unchanged.
- `apps/api/test/integration/audit/audit-fleet-assistant-actions.integration.spec.ts` — cases pinning fleet.approval.decide.assistant and system.assistant-action.expire are deleted (the engine's approval.decide and system.approval.expire replace them); a thread write's request open records no audit entry (bookkeeping).
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the S5b 2a US-005 assistant_action decide block is deleted: nothing opens that approval type any more; the approvals routes' own blocks cover deciding.

**US-006**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the none branch of `writeTool` for thread origins calls the gate with no transaction as in "Direct thread writes"; `directWrite` is no longer called for a thread origin.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — thread cases driven to recordDirect drive the none branch through a resolver answering none and assert the gate's executed answer with no action line.

**US-007**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `pendingActions` reads linked pending requests and imports `MAX_PENDING_ACTIONS` from the requests domain module.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — the `PrismaChatThreadRepository.pendingActions (S5b US-004)` block mocks the link and request reads instead of `client.pendingAction.findMany`; `approvalId` is the request id (never null); the scope and order invariants are unchanged.
- `apps/api/src/fleet/threads/threads.service.spec.ts` — `pendingActions` doubles answer request ids in `id` and `approvalId`; the detail shape is unchanged.
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — `pendingActions` doubles answer request ids in `id` and `approvalId`; the detail shape is unchanged.
- `apps/api/test/integration/fleet/assistant-action-detail.integration.spec.ts` — the detail's pendingActions comes from linked pending requests; fixtures seed requests and links; the scope and order invariants are unchanged.
- `apps/api/test/integration/fleet/assistant-actions-approve.integration.spec.ts` — delete: it approves through the assistant_action fleet approval, which is no longer opened; this story's ACs and US-008's pin approving, rejecting, a revoked requester, the widened decider and failed approvals through the approvals route.
- `apps/api/test/integration/fleet/assistant-actions-decide.integration.spec.ts` — delete: it pins the creator-only decide of AssistantActionDecisions, replaced by the engine's eligibility and this story's AC-7 to AC-11.

**US-008**
- `apps/api/test/integration/fleet/assistant-actions-expiry.integration.spec.ts` — delete: it pins PendingActionExpirySweeper; this story's AC-7 and AC-8 pin expiry through the engine's sweeper and the note.

**US-009**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the MCP branch of `writeTool` goes through the gate as in "MCP write calls".
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `getActionTool` reads the caller's own requests over MCP; `ActionTools` stops injecting the PendingAction repository.
- `apps/api/src/fleet/assistant/assistant-tool.executor.direct.spec.ts` — its MCP cases that mock approvalModeFor and assert recordDirect (the recorded row, masking and recording failure) are rewritten to assert the gate's executed answer with no action line, or deleted where they pin the recorded row.
- `apps/api/src/fleet/assistant/tools/action-tools.spec.ts` — `koda_get_action` MCP cases read the caller's own request; status texts are lowercase.
- `apps/api/test/integration/fleet/assistant-direct-action.integration.spec.ts` — its MCP write cases assert the tool's text without an action line and no PendingAction row; its AC-15 `koda_get_action` actor read reads an ApprovalRequest opened under an AGENT policy.
- `apps/api/test/integration/fleet/assistant-direct-action-record.integration.spec.ts` — delete: it pins the PendingAction row recordDirect wrote, which no longer exists; the direct path's audit entry is the record.
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — the MCP write case answers the tool's text without an action line; every prisma.pendingAction count is replaced by an ApprovalRequest count.
- `apps/api/test/integration/fleet/permissions-mcp-tools.integration.spec.ts` — MCP write cases answer without an action line; the prisma.pendingAction count is replaced by an ApprovalRequest count; the permission refusal invariants are unchanged.

**US-010**
- `apps/web/components/fleet/threads/ThreadActionCard.vue` — decides through `useApprovalRequests().decide(action.id, decision)`.
- `apps/web/tests/components/thread-action-card.spec.ts` — the useFleetApprovals mock becomes a useApprovalRequests mock; approve and reject assert decide with the action id; the toast and hide invariants are unchanged.

**US-011**
- `apps/api/prisma/schema.prisma` — removes `PendingAction` and `ChatThread.pendingActions`.
- `apps/api/src/fleet/assistant/assistant.module.ts` — drops the PendingAction providers and the ApprovalStoreModule import.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — the tests that resolve PendingActionExpirySweeper, AssistantActionDecisions and AssistantActionPort (the sweeper's decisions handler, and the shared port between ApprovalsService and the decisions handler) are deleted with those providers.
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — drops attachActions, checkAction, executeAction, actionScope, proposeWrite, directWrite, approvalFor, approverTier and the ActionProposer field.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — cases for checkAction, executeAction and attachActions are deleted with those methods.
- `apps/api/src/fleet/assistant/assistant-tool.executor.actor.spec.ts` — delete: every case drives checkAction or executeAction, which this story deletes, and it imports pending-action.domain.
- `apps/api/src/fleet/assistant/assistant-tool.executor.direct.spec.ts` — the approvalModeFor mock and the remaining ActionProposer double are removed with those modules.
- `apps/api/src/fleet/assistant/assistant-tool.executor.agent-caller.spec.ts` — the remaining ActionProposer double and attachActions call are removed with them.
- `apps/api/src/fleet/assistant/write-tool-errors.spec.ts` — the attachActions setup and the executeAction cases are removed with those methods.
- `apps/api/test/integration/fleet/assistant-action-actor.integration.spec.ts` — the cases pinning the PendingAction table, PrismaPendingActionRepository and PendingActionExpirySweeper are deleted with them; the two request-actor cases stay.
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts` — the PendingAction and assistant_action approval fixtures, their cleanup, and the AC-13 assistant_action creator-only case are deleted; the engine's eligibility is pinned by approval-core and US-007.
- `apps/api/src/permissions/catalog.ts` — removes `system.assistant-action.expire` from the inventory rows.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — drops the PendingActionExpirySweeper row (system.assistant-action.expire), which catalog.spec.ts checks against the catalog.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — loses the PendingActionExpirySweeper entry; the expected writer count goes from 37 to 36.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — loses the rows for system.assistant-action.expire.
- `apps/api/src/action-context/audit-coverage.reasons.ts` — removes assistant.action-proposal, assistant.direct-action-record and assistant.action-finalize.
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — EXPECTED_REASON_IDS loses the three reasons.
- `apps/api/src/fleet/assistant/actions/assistant-action.service.spec.ts` — delete: it tests assistant-action.service.ts, which this story deletes.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.spec.ts` — delete: it tests assistant-action-decisions.ts, which this story deletes.
- `apps/api/src/fleet/assistant/actions/pending-action-expiry.sweeper.spec.ts` — delete: it tests pending-action-expiry.sweeper.ts, which this story deletes.
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.spec.ts` — delete: it tests prisma-pending-action.repository.ts, which this story deletes.
- `apps/api/src/fleet/assistant/actions/approval-policy.spec.ts` — delete: it tests approval-policy.ts, which this story deletes.
- `apps/api/src/fleet/assistant/actions/outcome-note.spec.ts` — delete: it tests outcome-note.ts, which this story deletes.
- `apps/api/src/fleet/assistant/actions/action-result-masking.spec.ts` — delete: it pins masking in executeAction; the command's masking is US-002's AC.
- `apps/api/test/integration/fleet/assistant-action-actor-migration.integration.spec.ts` — delete: it pins a PendingAction column migration on a table this story drops.
- `apps/api/test/integration/fleet/pending-action-drop-legacy-columns-migration.integration.spec.ts` — delete: it pins a PendingAction column drop on a table this story drops.
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — delete.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — delete.
- `apps/api/src/fleet/assistant/actions/pending-action-expiry.sweeper.ts` — delete.
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — delete.
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — delete; its last importer moved to the requests domain module in US-007.
- `apps/api/src/fleet/assistant/actions/approval-policy.ts` — delete.
- `apps/api/src/fleet/assistant/actions/outcome-note.ts` — delete.

**US-012**
- `apps/api/src/fleet/approvals/assistant-action.port.ts` — delete.
- `apps/api/src/fleet/approvals/assistant-action.port.spec.ts` — delete: it tests assistant-action.port.ts, which this story deletes.
- `apps/api/src/fleet/approvals/approvals.service.ts` — drops the assistant_action branch and AssistantActionPort.
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — the assistant_action decide cases are deleted with the branch.
- `apps/api/src/fleet/approvals/approval-closer.ts` — drops openAssistant, AssistantActionAsk and AssistantApprovalChange.
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — the openAssistant cases are deleted with the method.
- `apps/api/src/fleet/approvals/approval-store.module.ts` — drops AssistantActionPort.
- `apps/api/src/fleet/approvals/approval-store.module.spec.ts` — its provider and export lists lose AssistantActionPort.
- `apps/api/src/fleet/approvals/domain/approval.domain.ts` — APPROVAL_TYPES loses assistant_action.
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts` — the comment about the assistant_action ask goes with the type.
- `apps/api/src/home/dto/home-dashboard.dto.ts` — the approval type enum loses assistant_action.
- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — drops the assistant_action branch.
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — the approval payload loses requestedById, threadPath and tool.
- `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts` — the assistant payload cases are deleted with the fields.
- `apps/api/src/notifications/fleet/fleet-notification-drafts.ts` — drops actionRequestedDraft.
- `apps/api/src/notifications/fleet/fleet-notification-drafts.spec.ts` — the actionRequestedDraft cases are deleted with it.
- `apps/api/src/notifications/fleet/fleet-subscribers.spec.ts` — the assistant_action ask cases (AC-10, AC-11/13/14/15 and the answered-before case) are deleted with the branch.
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts` — gains the AC-1 case: GET /api/projects/:slug/fleet/approvals?type=assistant_action by a project member holding fleet.approval.read answers 400; the existing bash and budget cases are unchanged.
- `openapi.json` — regenerated with bun run api:export-spec from the repo root; every approval type enum derived from APPROVAL_TYPES (the list query, the fleet approval DTO, the home dashboard DTO) loses assistant_action, and nothing else changes.

### Seams

- US-002 → US-005, US-006, US-009: `AssistantToolCommands` registers a command for every write tool key; the gate finds them. US-005 AC-1 and US-009 AC-3 drive the outermost routes and assert a request opened under the tool's key; US-006 AC-1 and US-009 AC-1 assert the registered command ran the tool.
- US-001 → US-003, US-005: the link repository. US-005 AC-4 asserts the link a thread write writes; US-003 AC-1 asserts the subscriber reads it.
- US-003 → US-008: the subscriber. US-008 AC-1 approves a thread request through the approvals route, runs the outbox relay, and asserts the note in the thread.
- US-007 → US-010: `pendingActions[].id` is the request id the card posts to `/approvals/<id>/decisions`.

## Acceptance Criteria

### US-001: The thread link table and its repository

- AC-1 [integration] After migrations, `insert` of a link for an existing `ApprovalRequest` with a thread, job, `toolCallId`, `tool: 'koda_add_comment'` and `preview: 'p'`, then `findByRequest(requestId)`, answers a row equal to those values with null `notedAt`, `deliveredAt` and `deliveredMessageId`.
- AC-2 [integration] `countPendingInThread(threadId)` answers 2 for a thread with two linked `pending` requests and one linked `rejected` request, while a third `pending` request is linked to another thread.
- AC-3 [integration] Inside a transaction, `lockThread(threadId)` answers true for an existing thread.
- AC-4 [integration] `lockThread` answers false for a thread id that does not exist.
- AC-5 [integration] Inside a transaction, `lockByRequest(requestId)` answers the link row.
- AC-6 [integration] `lockByRequest` answers null for a request with no link.
- AC-7 [integration] `insertSystemNote(threadId, 'note')` on a thread whose last message has `seq` 4 answers the id of a stored `system` message whose content is `note` and whose `seq` is 5.
- AC-8 [integration] `markNoted(requestId, 'm1', at)` then `findByRequest` answers `noteMessageId` `'m1'` and `notedAt` equal to `at`.
- AC-9 [integration] `findScopedInThread(requestId, projectId, threadId)` answers the link with its request's `status` when the link's thread is `threadId` and the request's project is `projectId`.
- AC-10 [integration] `findScopedInThread` answers null when the link belongs to another thread.
- AC-11 [integration] `findScopedInThread` answers null when the request belongs to another project.
- AC-12 [integration] Deleting the `ChatThread` deletes its link rows.
- AC-13 [integration] `findOwnRequest(requestId, projectId, { type: 'AGENT', id: 'a1' })` answers the request opened by agent `a1` in that project, with a null link.
- AC-14 [integration] `findOwnRequest` with actor `AGENT/a2` for that request answers null.

Verification note: `bun run db:generate` (repo root) runs after the schema change; `bun run --cwd apps/api type-check` passes.

### US-002: One approval command per write tool

- AC-1 [unit] In `assistant.module.spec.ts`, after `module.init()`, `ApprovalCommandRegistry.get(key)` answers a command for every one of `comment.create`, `ticket.create`, `ticket.update`, `ticket.link.add`, `memory.create`, `memory.decision.record`, `fleet.job.dispatch`, `fleet.job.cancel` and `fleet.job.requeue`.
- AC-2 [unit] `assistantToolCommand(tool, deps).key` equals `tool.key`.
- AC-3 [unit] `parse({ projectId: 'p1', threadId: 't1', jobId: 'j1', args })` answers `{ projectId: 'p1', threadId: 't1', jobId: 'j1', args: tool.parse(args) }`.
- AC-4 [unit] `parse` throws for an input whose `projectId` is missing, not a string or empty.
- AC-5 [unit] `parse` throws for an input whose `threadId` or `jobId` is neither a string nor null.
- AC-6 [unit] `parse` throws the tool's `ToolInputError` when `tool.parse(args)` throws it.
- AC-7 [unit] For each of the nine write tools, `parse` of its own output for a valid sample input answers a value deep-equal to that output.
- AC-8 [unit] `execute` inside an action context with actor `SYSTEM/assistant` and `onBehalfOf` user `u1` calls `tool.execute` with a `ToolContext` whose `actor.id` is `u1`, whose `projectId`, `threadId` and `jobId` are the input's, and whose `projectSlug` is the slug `findProjectSlug` answers.
- AC-9 [unit] `execute` inside an action context with actor `AGENT/a1` and no `onBehalfOf` calls `tool.execute` with a `ToolContext` whose `actor` is `agentPrincipal` of the record `findAgentActor('a1')` answers.
- AC-10 [unit] For each of a missing user, a disabled user, a `PAUSED` agent, and a principal `resolveMembership` refuses in the project, `execute` throws `AssistantCommandRefusedError` without calling `tool.execute`.
- AC-11 [unit] When `tool.execute` answers a text holding a secret, `execute` answers `{ text }` with the secret masked by `maskSecrets` and capped at `RESULT_CAP_BYTES`.
- AC-12 [unit] For each of `NotFoundAppException`, `ToolActionError` and a plain `Error` thrown by `tool.execute`, `execute` rethrows that same error.
- AC-13 [unit] `toResult` answers its argument unchanged.
- AC-14 [integration] `PrismaAssistantToolCallRepository.findAgentActor(id)` answers `{ type: 'AGENT', id, slug, status }` for an existing agent.
- AC-15 [integration] `PrismaAssistantToolCallRepository.findProjectSlug(id)` answers the project's slug.

### US-003: Outcome notes from request events

- AC-1 [integration] Publishing an `approval_request_changed` outbox record through `FanOutPublisher.publish` for a linked request settled `executed` with result `{ text: 'comment c1 added' }` inserts one `system` message in the link's thread with content `Action <requestId> (koda_add_comment) was approved and done: comment c1 added`.
- AC-2 [integration] After that publish, the link's `noteMessageId` is the new message's id.
- AC-3 [integration] Publishing the same record a second time inserts no second message.
- AC-4 [integration] Publishing a record for a request with no link inserts no message.
- AC-5 [integration] Publishing a record for a link whose `threadId` is null inserts no message.
- AC-6 [integration] Publishing a record whose status is `pending` or `approved` for a linked request inserts no message.
- AC-7 [integration] After the note commits, `ThreadEventBus.publish` receives, in this order, a `message` frame whose `messageId` is the note's id and a `thread` frame for the link's thread.
- AC-8 [integration] Publishing a record for a linked request whose thread was deleted resolves without inserting a message.
- AC-9 [unit] For a payload `parseApprovalRequestChangedPayload` answers null for, the subscriber logs one `warn`.
- AC-10 [unit] `requestOutcomeNote` for status `failed` with result `{ error: 'execution-failed', name: 'NotFoundAppException' }` answers `Action r1 (koda_add_comment) was approved but failed: not_found`.
- AC-11 [unit] `requestOutcomeNote` for status `failed` with result `{ error: 'permission-revoked' }` answers `Action r1 (koda_add_comment) was approved but failed: error: koda_add_comment failed`.
- AC-12 [unit] For each of `rejected`, `expired` and `cancelled`, `requestOutcomeNote` answers the table's note for that status (`Action r1 (koda_add_comment) was rejected.`, `... expired without a decision.`, `... was cancelled.`).
- AC-13 [unit] `requestOutcomeNote` for an `executed` request whose result text is 600 characters answers `was approved and done: ` followed by the first 500 characters and `…`.

### US-004: Outcome delivery from requests

- AC-1 [unit] `DELIVERABLE_STATUSES` equals `['executed', 'failed', 'rejected', 'expired', 'cancelled']`.
- AC-2 [integration] `PrismaChatThreadRepository.sendMessage` on a thread with two undelivered linked requests settled `executed` and `cancelled` hands the agent a text made of `Updates on actions you proposed:`, both notes from `requestOutcomeNote` in creation order, a blank line, then the user's text.
- AC-3 [integration] That send sets `deliveredMessageId` to the new message's id on both links.
- AC-4 [integration] A second `sendMessage` on the same thread hands over the user's text unchanged.
- AC-5 [integration] A linked request still `pending` is not delivered and keeps a null `deliveredAt`.
- AC-6 [integration] `PrismaFleetJobRepository.findThreadAssign` for the job of a message on which two links were delivered answers `initialMessage.text` equal to the text that send handed over.
- AC-7 [integration] A second `findThreadAssign` for the same job answers the same `initialMessage.text`.

### US-005: Waiting thread writes through the gate

- AC-1 [integration] `POST /api/fleet/runner/jobs/:jobId/tools/koda_add_comment` for a user's thread job with no approval policy opens one `ApprovalRequest` with `permissionKey` `comment.create`, actor `SYSTEM/assistant`, `onBehalfOf` the job's requester, `origin` `thread`, `requiredMode` `human` and `input` `{ projectId, threadId, jobId, args: { ref, body } }`.
- AC-2 [integration] That call adds no comment.
- AC-3 [integration] That call answers content `pending <requestId>: awaiting approval; do not retry` with `isError` false.
- AC-4 [integration] That call writes one `AssistantActionRequest` with the request's id, the thread, the job, the call's `toolCallId`, `tool` `koda_add_comment` and the tool's preview text.
- AC-5 [integration] After the call commits, `ThreadEventBus.publish` receives one `thread` frame for the thread.
- AC-6 [integration] With 10 linked pending requests in the thread, a write call answers `refused: 10 actions are pending in this thread; wait for the user to decide them` and no request is added.
- AC-7 [integration] A second write call in the thread with a different `toolCallId` and the same tool and arguments, while the first request is pending, answers `pending <the first requestId>` and no request is added.
- AC-8 [integration] A write call on a thread job requested by an agent opens a pending request with actor `SYSTEM/assistant`, `onBehalfOf` `AGENT/<agentId>` and `requiredMode` `human`.
- AC-9 [unit] On the waiting path, `lockThread` is called before `gate`, both inside one `TRANSACTION_MANAGER.run` callback.
- AC-10 [unit] When `lockThread` answers false on the waiting path, the call answers content `not_found` and `gate` is not called.
- AC-11 [unit] When the gate answers a pending request that already has a link, `insert` is not called and the call answers that request's id.
- AC-12 [unit] When the gate throws on the waiting path, the call answers content `error: koda_add_comment failed` with `isError` true and does not rethrow.
- AC-13 [integration] `koda_get_action` through the runner route with the request id answers first line `action <requestId> koda_add_comment pending` followed by a `requested <createdAt ISO>` line.
- AC-14 [integration] `koda_get_action` with the id of a request linked to another thread answers `not_found`.

### US-006: Direct thread writes through the gate

- AC-1 [integration] With a global `ApprovalPolicy` for `comment.create` on subject type `ASSISTANT` with mode `none`, a thread `koda_add_comment` call adds the comment and answers content `comment <id> added to <ref> <path>` with no `action` line.
- AC-2 [integration] With that `none` policy, the call opens no request and writes no link.
- AC-3 [unit] When the resolver answers `none`, the executor calls `gate` without `TRANSACTION_MANAGER.run` and without `lockThread`.
- AC-4 [unit] On the direct path, when the gate throws `ToolActionError` with text `linked SB-1 https://x` and a second line `failed at link 2: not_found`, the call answers that text (masked) with `isError` true.
- AC-5 [unit] On the direct path, when the gate throws `NotFoundAppException`, the call answers content `not_found` with `isError` true.
- AC-6 [unit] On the direct path, when the gate throws a plain `Error`, the call answers content `error: koda_add_comment failed` with `isError` true and logs the error.
- AC-7 [unit] When the resolver answers `none` but the gate answers a pending request, the call inserts its link and answers `pending <requestId>: awaiting approval; do not retry`.

### US-007: Thread detail and deciding thread requests

- AC-1 [integration] `GET` of the thread detail answers `pendingActions` with one entry whose `id` and `approvalId` are the request id, `tool` `koda_add_comment`, `preview` the link's preview, `projectSlug` the request's project slug and `expiresAt` the request's `expiresAt`.
- AC-2 [integration] A linked request that was rejected is not in the detail's `pendingActions`.
- AC-3 [integration] `POST /api/approvals/<requestId>/decisions` with `{ decision: 'approve' }` by the thread's requester adds the comment authored by that requester.
- AC-4 [integration] After that approve the request's status is `executed`.
- AC-5 [integration] `{ decision: 'reject' }` by the requester adds no comment.
- AC-6 [integration] After that reject the request's status is `rejected`.
- AC-7 [integration] After the requester's project binding is removed, their approve answers 403 `approvals.decideForbidden` with reason `missing-action-permission`.
- AC-8 [integration] After that refused approve the request's status is still `pending`.
- AC-9 [integration] A Project Admin of the project who is not the requester approves the request, and its status is `executed`.
- AC-10 [integration] That admin's approve records `approverId` the admin on the request.
- AC-11 [integration] A principal granted `approval.decide` without `comment.create` in the project gets 403 `approvals.decideForbidden` with reason `missing-action-permission`.

### US-008: Decided thread requests: notes, failures and expiry

- AC-1 [integration] After an approve by the requester and `OutboxRelay.dispatchPendingBatch`, the thread holds one note `Action <requestId> (koda_add_comment) was approved and done: comment <id> added to <ref> <path>`.
- AC-2 [integration] After a reject by the requester and the relay, the thread holds one note `Action <requestId> (koda_add_comment) was rejected.`.
- AC-3 [integration] After the request's ticket is soft-deleted, the requester's approve settles the request `failed` with result name `NotFoundAppException`.
- AC-4 [integration] After that failed approve and the relay, the thread holds `Action <requestId> (koda_add_comment) was approved but failed: not_found`.
- AC-5 [integration] With `koda_link_tickets` pending for links on tickets SB-1 and SB-2, and SB-2 soft-deleted after the proposal, the approve settles the request `failed`.
- AC-6 [integration] After that failed batch approve, SB-1 has no link from the batch.
- AC-7 [integration] `ApprovalRequestExpirySweeper.tick` at a time past the request's `expiresAt` settles it `expired`.
- AC-8 [integration] After that expiry and the relay, the thread holds `Action <requestId> (koda_add_comment) expired without a decision.`.

### US-009: MCP write calls through the gate

- AC-1 [integration] `koda_add_comment` through `POST /api/mcp` by an agent with no approval policy adds the comment authored by the agent and answers the tool's text with no `action` line.
- AC-2 [integration] That call opens no request.
- AC-3 [integration] With a project `ApprovalPolicy` for `comment.create` on principal type `AGENT` with mode `agent`, the call opens one request with actor `AGENT/<agentId>`, no `onBehalfOf`, `origin` `mcp` and `input` `{ projectId, threadId: null, jobId: null, args }`.
- AC-4 [integration] That call answers `pending <requestId>: awaiting approval; do not retry`.
- AC-5 [integration] That call adds no comment.
- AC-6 [integration] That pending request has no `AssistantActionRequest` row.
- AC-7 [integration] The same call repeated while the request is pending answers the same request id.
- AC-8 [integration] `koda_get_action` through `POST /api/mcp` with that request id by the same agent answers first line `action <requestId> comment.create pending`.
- AC-9 [integration] `koda_get_action` with that request id by another agent rostered on the project answers `not_found`.
- AC-10 [integration] `koda_add_comment` through `POST /api/mcp` with a ticket ref that does not exist answers `not_found` from the preview and opens no request.
- AC-11 [unit] When the gate throws a plain `Error` for an MCP write call, the call answers `error: koda_add_comment failed` with `isError` true.

### US-010: The thread card decides through the approvals route

- AC-1 [unit] `useApprovalRequests().decide('r1', 'approve')` posts `{ decision: 'approve' }` to `/approvals/r1/decisions`.
- AC-2 [unit] `decide('r1', 'reject', 'no')` posts `{ decision: 'reject', comment: 'no' }`.
- AC-3 [unit] `decide('r1', 'reject', '')` posts `{ decision: 'reject' }`.
- AC-4 [unit] Clicking the card's approve button calls `useApprovalRequests().decide` with the action's `id` and `'approve'`.
- AC-5 [unit] Clicking the card's reject button calls `decide` with the action's `id` and `'reject'`.
- AC-6 [unit] After a successful decide the card is no longer rendered.
- AC-7 [unit] When `decide` rejects with an API error, the card shows a toast with `extractApiError`'s message.
- AC-8 [unit] After that failed decide the card is still rendered with both buttons enabled.
- AC-9 [unit] Mounting the card does not call `useFleetApprovals`.

Verification note: `bun run --cwd apps/web type-check` and `bun run --cwd apps/web lint` pass.

### US-011: Remove PendingAction

- AC-1 [integration] Applying migration `20261105090100_drop_pending_action` to a database holding one `FleetApproval` of each of the three types deletes the `assistant_action` row and keeps the `budget_override_required` and `nax_bash_escalate` rows.

Verification note: removals are verified by `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.

### US-012: Remove the assistant fleet approval type

- AC-1 [integration] `GET /api/projects/:slug/fleet/approvals?type=assistant_action` by a project member answers 400.

Verification note: removals are verified by `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`; `openapi.json` is regenerated with `bun run api:export-spec` (repo root).
