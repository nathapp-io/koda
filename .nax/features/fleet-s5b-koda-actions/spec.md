# SPEC: Fleet S5b-2a-1 — Koda Actions API (PendingAction, `assistant_action` Approvals, Outcome Notes, `koda_add_comment`)

## Summary

A koda thread can read koda data (S5b-1b..1d) but cannot change anything. This feature adds the API half of
human-confirmed writes (umbrella row 5, S5b-2a). A write tool never runs when the agent calls it. The executor stores a
`PendingAction`, mirrors it as a `FleetApproval` of the new type `assistant_action`, and answers the agent at once
`pending <actionId>: awaiting user approval; do not retry`.

- Only the thread creator may approve or reject the action, through the existing approvals decide routes.
- An approve runs the tool as the creator.
- Actions nobody decides expire after 24 hours.
- Every outcome is written to the thread as a `system` message.
- The thread detail lists the pending actions.
- Only the creator is notified of a new ask.
- `koda_get_action` lets the agent check an action.
- One pilot write tool, `koda_add_comment`, ships with the machinery so the path is real end to end. The other write
  tools stay in S5b-2b.

S5b-2a ships as two features (user ruling 2a-R4). The second, `fleet-s5b-koda-actions-web`, delivers the outcome
notes into the agent's next input, adds the web inbox panel and the thread cards, and closes koda#294.

Umbrella design `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R4..R10; §6; §7; §8;
§10 row 5).

## Motivation

S5b-R2 and S5b-R4 put confirmed writes in scope (tickets, comments, fleet dispatch, KB / memory). S5b-R5 requires that
no write runs without a human approving the exact preview.

Today nothing in the tool layer can wait for a human:

- `AssistantTool` has no read/write distinction (`apps/api/src/fleet/assistant/assistant-tool.types.ts:18-27`).
- The executor runs every tool at once (`assistant-tool.executor.ts:149-168`).

The approvals inbox cannot hold such an ask either:

- `ApprovalsService.decide` sends every type that is not `nax_bash_escalate` into the ADMIN-only budget branch
  (`apps/api/src/fleet/approvals/approvals.service.ts:92-96`).
- The expiry sweeper only expires bash asks, and it needs a job lock (`prisma-approval.repository.ts:73-79`,
  `approval-expiry-sweeper.ts:60-65`).
- Every new ask notifies all global admins (`notifications/fleet/fleet-approval-requested.subscriber.ts:45-48`).

S5b-2b's write tools all need this machinery, so it ships first. The pilot tool exists so the feature can be
live-checked on koda-wk through the API (user ruling 2a-R1).

## Design

### Rulings that bind every story

User rulings from the umbrella design, 2026-10-15:

- **S5b-R4.** Every write is confirmed by a human.
- **S5b-R5.** Tools run on the API, and confirmed writes are executed by the server.
- **S5b-R6.** Permissions are CASL per tool. They are evaluated on every call and again at approval time.
- **S5b-R7.** The executor owns the project scope.
- **S5b-R8.** `assistant_action` gets its own approvals branch, its own decisions, its own expiry and a creator-only
  notification.
- **S5b-R10.** Outcomes are stored as `system`-role thread messages, and `koda_get_action` reads them.

User rulings for this feature, 2026-10-17:

- **2a-R1 pilot write tool.** `koda_add_comment` ships in S5b-2a; every other write tool stays in S5b-2b.
- **2a-R2 creator-only decisions.** Only the action's requester (the thread creator) may approve or reject it, on either
  inbox prefix; a global admin who is not the requester gets 403. The requester's tool permission is re-checked at
  decide time.
- **2a-R3 koda#294** rides in S5b-2a.
- **2a-R5 story sizes accepted.** After review pass 2 (the cap), the user accepted the seven stories as drafted,
  knowing `nax plan` may split compound ACs past 15 per story.
- **2a-R4 split.** Counted as assertions, S5b-2a needs about 11 stories, so it ships as two features:
  - **This feature** covers the API, in 7 stories.
  - **`fleet-s5b-koda-actions-web`** covers outcome delivery into the THREAD_INPUT and new-turn text, the web inbox
    panel, the web thread action cards and system-note rendering, and koda#294.

Drafting calls (spec author, 2026-10-17):

- **2a-D1 units and wiring.** All new units live in `AssistantModule` (`apps/api/src/fleet/assistant/actions/`). That
  module already holds the registry and the executor, and already imports `ApprovalsModule`. The new units are:
  - `AssistantActionService` (propose)
  - `AssistantActionDecisions` (decide)
  - `PendingActionExpirySweeper`
  - `PrismaPendingActionRepository`

  US-001 creates `AssistantActionService` with `propose` only (no executor parameter, no `onModuleInit`); US-002 adds
  the executor parameter and the `onModuleInit` attach. Two late bindings keep the provider graph acyclic. Both use the register-at-init pattern the tool groups already use
  with the registry.
  - **Executor to proposer.** The executor gains `attachActions(actions: ActionProposer)`, and
    `AssistantActionService.onModuleInit` calls `executor.attachActions(this)`. The executor's constructor is
    unchanged. `AssistantActionDecisions` injects the executor (for `checkAction` and `executeAction`) and the service.
  - **Decide route to handler.** `ApprovalsModule` cannot import `AssistantModule`, because that would be a cycle. So
    the decide route reaches the handler through `AssistantActionPort`, which `ApprovalStoreModule` provides and
    exports. `ApprovalStoreModule` is one shared instance for both importers.
    `AssistantActionDecisions.onModuleInit` calls `port.register(this)`, and `ApprovalsService.decide` calls
    `port.decide(...)` for an `assistant_action`.
- **2a-D2 write tool contract.** `AssistantTool` gains two members:
  - `kind?: 'read' | 'write'`. Absent means `read`.
  - `preview?(ctx, input): Promise<string>`. Required when `kind` is `write`.

  For a write tool, the executor runs every step it runs today: creator, scope, `project` argument, parse, membership
  and ability. Then it calls `preview` instead of `execute`, then `actions.propose`.
  - `preview` throwing `NotFoundAppException` answers `not_found`, as `execute` does today.
  - A write call when no proposer is attached answers `error: <tool> failed` (outcome `error`) and logs a warning.
- **2a-D3 PendingAction.** A new Prisma model, `apps/api/prisma/schema.prisma`:

  ```prisma
  model PendingAction {
    id            String    @id @default(cuid())
    projectId     String
    threadId      String
    jobId         String
    toolCallId    String
    tool          String
    input         Json
    preview       String    @db.Text
    status        String    @default("PENDING") // PENDING | APPROVED | REJECTED | EXPIRED | EXECUTED | FAILED
    requestedById String
    approvalId    String?   @unique
    decidedById   String?
    decidedAt     DateTime?
    result        String?   @db.Text
    deliveredAt   DateTime?
    expiresAt     DateTime
    createdAt     DateTime  @default(now())

    thread ChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

    @@unique([jobId, toolCallId])
    @@index([threadId, status])
    @@index([status, expiresAt])
  }
  ```

  - `ChatThread` gains `pendingActions PendingAction[]`. The `AssistantToolCall.outcome` comment gains `pending` and
    `refused`.
  - The migration `apps/api/prisma/migrations/20261023090000_pending_action/migration.sql` creates the table.
  - `input` is the tool's parsed input, with the WORKSPACE `project` key already removed.
  - `projectId` is the project the action acts in. For a WORKSPACE call it is the resolved project.
  - `PendingActionRecord` (the domain type) carries `projectSlug` as well: every repository read joins the action's
    project and fills it. `checkAction`, `executeAction`, the thread detail and `koda_get_action` take the slug from
    the record, never from the job's or the thread's project.
  - `deliveredAt` is written by `fleet-s5b-koda-actions-web`. This feature only creates the column.
  - The constants live in `pending-action.domain.ts`: `ACTION_TTL_MS = 86_400_000` and `MAX_PENDING_ACTIONS = 10`.
- **2a-D4 propose (under the thread lock).** The call is `AssistantActionService.propose({ projectId, threadId,
  threadKind, threadProjectSlug, jobId, toolCallId, tool, input, preview, requestedById, now })`. `threadKind` and
  `threadProjectSlug` are the thread's own kind and project slug (`ToolCallContext.kind`, `context.project.slug`).

  One `txManager.run` does the following:
  1. Lock the thread row: `SELECT "id" FROM "ChatThread" WHERE "id" = $1 FOR UPDATE`, as `lockIdleThread` does
     (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:80-86`).
  2. If an action with the same `(jobId, toolCallId)` already exists, answer its id and write nothing. The thread lock
     serialises every call of a job, so this read is authoritative.
  3. Count the thread's `PENDING` actions. At `MAX_PENDING_ACTIONS`, answer `{ refused: true }` and write nothing.
  4. Insert the `PendingAction` with status `PENDING` and `expiresAt = now + ACTION_TTL_MS`.
  5. `ApprovalCloser.openAssistant(action, threadPath, now)` creates the approval (2a-D5) and returns its live events.
  6. Set the action's `approvalId` to the approval's id.

  After the commit, the service publishes the approval's live events. It also publishes
  `{ id: randomUUID(), threadId, at: now ISO, type: 'thread' }` on `ThreadEventBus`.

  The executor answers one of two ways:
  - **Proposed:** `pending <actionId>: awaiting user approval; do not retry`, with outcome `pending` and
    `isError: false`.
  - **At the cap:** `refused: 10 actions are pending in this thread; wait for the user to decide them`, with outcome
    `refused` and `isError: true`.

  `ToolCallOutcome` gains `pending` and `refused`. The executor's `isError` is true for every outcome except `ok` and
  `pending`.
- **2a-D5 the approval row.** `ApprovalCloser.openAssistant(action, threadPath, now)` creates a `FleetApproval`:
  - `type: 'assistant_action'`.
  - `projectId` and `jobId` from the action.
  - `policyId: null` and `requestedAt: now`.
  - `expiresAt` equal to the action's.
  - `payload` exactly `{ actionId, tool, threadId, threadPath, requestedById }`.

  The preview and the input are never on the approval. So the inbox, the detail route, the webhooks and the home
  dashboard only ever carry this summary. `threadPath` is `/threads/<threadId>` for a WORKSPACE thread and
  `/<threadProjectSlug>/threads/<threadId>` otherwise.

  Then `openAssistant`:
  - records activity `approval.requested`, with actor `userActor(requestedById)` and payload
    `approvalActivityPayload(approval, { threadId })`;
  - dispatches the webhook `fleet.approval.requested`;
  - enqueues the outbox event `fleet_approval_requested`. Its payload is `approvalWebhookPayload(approval, slug)` plus
    `{ requestedById, threadPath, tool }`. The private `enqueueRequested` gains optional extra fields for this.
- **2a-D6 notification (creator only).** `FleetApprovalRequestedSubscriber.handle` sends an `assistant_action` ask to
  `requestedById` only, never to the global admins. It delivers one `NotificationDraft`, built by
  `actionRequestedDraft` in `fleet-notification-drafts.ts`:
  - category `FLEET_NEEDS_YOU`, kind `action_requested`;
  - title `Approval needed: <tool> in a thread`;
  - link `threadPath`, params `{ tool }`;
  - sourceType `fleet_approval`, sourceId the approval id.

  `parseApprovalRequestedPayload` keeps `requestedById`, `threadPath` and `tool` when they are strings, and omits each
  key when it is absent. An
  `assistant_action` payload missing any of them is logged and skipped. Every other type keeps today's admin fan-out.
  The existing pending check applies to both: the subscriber skips when `approvalContext(...).status !== 'pending'`.
- **2a-D7 types and decisions.**
  - `APPROVAL_TYPES` gains `assistant_action`.
  - `APPROVAL_DECISIONS` gains `approve` and `reject`. It stays one global list, as today, because each branch
    validates its own decisions. The budget branch refuses anything but `keep_paused` and `raise_budget_and_resume`
    (`approvals.service.ts:95`). `checkBashDecision` refuses anything but `allow`, `allow_for_job` and `deny`
    (`bash-decision.ts:8-9`).
  - The `HomeApprovalDto.type` enum (`apps/api/src/home/dto/home-dashboard.dto.ts:23`) gains `assistant_action`.
- **2a-D8 the decide handler.** When `current.type === 'assistant_action'`, `ApprovalsService.decide` calls
  `this.assistantActions.decide(caller, current, dto, now)` before the budget gate. It answers `FleetApprovalDto.from`
  of the returned approval.

  `AssistantActionDecisions.decide` runs these steps in order:
  1. Read the action named by the payload's `actionId`. A missing action answers 409 `fleet.approvalNotPending`.
  2. If the caller is not the payload's `requestedById`, answer 403 `ForbiddenAppException` with key
     `threads.notCreator` (2a-R2).
  3. If `dto.decision` is not `approve` or `reject`, answer 400 `fleet.approvalDecisionInvalid` with reason
     `<decision> does not apply to an assistant action`.
  4. If `FLEET_THREADS_ENABLED` is off, answer 409 `threads.disabled`.
  5. For `approve` only, call `AssistantToolExecutor.checkAction(action)`.
     - It loads the requester through `findCallContext(action.jobId).creator`; the job's thread creator is the
       requester.
     - It takes the action's project slug from `action.projectSlug` (2a-D3).
     - It returns `forbidden` when the requester is disabled, is not a member of `action.projectId`, or has a role that
       lacks the tool's ability.

     A tool no longer in the registry, or `findCallContext` answering null, also returns `forbidden`. This check runs
     before the status checks of step 6, so a requester who lost access gets 403 even for an action that is no longer
     pending.

     On `forbidden`, the handler answers 403 `ForbiddenAppException` with key `projects`. Nothing is written, and the
     action stays `PENDING`.
  6. In one `txManager.run`, lock the thread, then the approval, then the action (2a-D11 lock order).
     - If the approval is not `pending`, or the action is not `PENDING`, answer 409 `fleet.approvalNotPending`.
     - If `expiresAt` is at or before `now`, call `AssistantActionDecisions.expireLocked(action, approval, now)` (2a-D10).
       After the commit, answer 409 `fleet.approvalNotPending`.
  7. For `reject`:
     - Resolve the approval `rejected`, with decision `reject`, `resolvedBy: 'user'`, `decidedById` and `comment`.
     - Set the action `REJECTED`, with `decidedById` the caller and `decidedAt` `now`.
     - Write its outcome note (2a-D9).
  8. For `approve`, first, inside the same transaction:
     - Resolve the approval `approved`, with decision `approve`.
     - Set the action `APPROVED`, with `decidedById` and `decidedAt`.
     - Commit.

     Then `AssistantToolExecutor.executeAction(action)` runs the tool as the requester:
     - It builds a fresh `ToolContext`: the action's project and slug, the requester with their project role, the
       action's `threadId` and `jobId`, `now`, and a fresh fence.
     - It re-parses `action.input` with `tool.parse`.
     - It answers `{ ok: true, text }` when the tool returns. When the tool throws, it answers `{ ok: false, text }`,
       where `text` is `not_found` for `NotFoundAppException` and `error: <tool> failed` for anything else. Anything
       else also has its stack logged.

     `text` is capped at `RESULT_CAP_BYTES` (16 KB) and stored as `result`. A second transaction locks the thread,
     then the action. It sets the action `EXECUTED` or `FAILED` and writes its outcome note.

  Approval closes go through `ApprovalCloser.recordResolved` with `userActor(caller.id)`. So activity, webhook and live
  events fire as they do for every other type.

  After each commit, the handler publishes the approval live events. It also publishes two thread-bus events:
  `{ id, threadId, at, type: 'message', messageId: <note id> }` and `{ id, threadId, at, type: 'thread' }`.

  An archived thread does not block a decision.
- **2a-D9 outcome notes.** Each terminal outcome (`EXECUTED`, `FAILED`, `REJECTED`, `EXPIRED`) inserts one
  `ChatMessage` in the action's thread. The insert happens in the same transaction as the status change, under the
  thread lock. The message has:
  - `role: 'system'` and `status: 'complete'`;
  - no author;
  - `seq` from `allocateThreadSeq`;
  - content from `outcomeNote(action)`:
    - `EXECUTED`: `Action <id> (<tool>) was approved and done: <result>`
    - `FAILED`: `Action <id> (<tool>) was approved but failed: <result>`
    - `REJECTED`: `Action <id> (<tool>) was rejected by the user.`
    - `EXPIRED`: `Action <id> (<tool>) expired without a decision.`

  `outcomeNote` is a pure function in `apps/api/src/fleet/assistant/actions/outcome-note.ts`. It caps `<result>` at 500
  characters with a trailing `…`.

  Note texts are English only, like the agent's own instructions. They are written for the agent first, and stored once
  for every reader.
- **2a-D10 expiry.** `PendingActionExpirySweeper` runs on `fleetConfig.approvalSweepMs` when `fleetConfig.sweepEnabled`
  is on, like `ApprovalExpirySweeper`.

  The sweeper injects `AssistantActionDecisions` and reuses its `expireLocked`, which steps 3 to 5 below describe.

  `tick(now)` takes up to 100 `PENDING` actions whose `expiresAt` is at or before `now`, ordered by `expiresAt` then
  `id`. Each one runs in its own transaction:
  1. Lock the thread, then the approval, then the action.
  2. Re-check that the action is `PENDING` and past `expiresAt`.
  3. Set the action `EXPIRED`, with `decidedAt` `now` and no `decidedById`.
  4. Resolve the approval `expired` (`resolvedBy: 'timeout'`) through `ApprovalCloser.recordResolved`, with
     `{ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: requestedById }`.
  5. Write the note.

  After the commit, the sweeper publishes the approval live events and the thread `message` and `thread` events. A
  failing action is logged and counted in `failed`, and the tick goes on.

  The sweeper and the decide handler are the only closers of an `assistant_action`. `ApprovalExpirySweeper`,
  `findExpiredPending` and `closeForJob` stay bash-only. So a job end never closes an action: actions belong to the
  thread (umbrella §6).
- **2a-D11 lock order.** Every writer of an action takes the thread row lock first, then the approval, then the action.
  That covers propose, decide and expiry. This is the order `allocateThreadSeq` assumes: its caller holds the thread lock
  (`threads/domain/chat-thread.domain.ts:35`). The thread id comes from the action row, which is read before the
  transaction.
- **2a-D12 thread detail.** `ChatThreadDetail` and `ThreadDetailDto` gain `pendingActions: PendingActionDto[]`. It lists
  the thread's `PENDING` actions, oldest first, at most `MAX_PENDING_ACTIONS`. Each entry is
  `{ id, approvalId, tool, preview, projectSlug, expiresAt, createdAt }`. `projectSlug` is the slug of the project the
  action acts in, read by the same join.

  Both detail builders fill it through a new `ChatThreadRepository.pendingActions(threadId)`:
  - `ThreadsService` (`threads.service.ts:58`)
  - `WorkspaceThreadsService` (`workspace-threads.service.ts:77`)

  Thread visibility is unchanged, so the preview reaches exactly the readers of the thread.
- **2a-D13 `koda_add_comment`.** Kind `write`, permission ability `create` `Comment`.
  - **Input** is `{ ref, body }`. `ref` is a ticket ref, parsed as `koda_get_ticket` parses it. `body` is a string of 1
    to 10000 characters after trim. The parser refuses with reason `ref` or `body`.
  - **`preview`** reads the ticket through `TicketsService.findByRef(ctx.projectSlug, ref)`. It answers
    `Add a comment to <REF> "<ticket title>":`, then a blank line, then the body. The whole text goes through
    `maskSecrets`.
  - **`execute`** calls `CommentsService.create(ctx.projectSlug, ref, { body, type: 'GENERAL' }, ctx.actor)`. It answers
    `comment <comment id> added to <REF> /<slug>/tickets/<REF>`.
- **2a-D14 `koda_get_action`.** Kind `read`, permission `member`.
  - **Input** is `{ id }`, a non-empty string of at most 64 characters. The parser refuses with reason `id`.
  - **Scope.** It reads the action whose `id` matches, whose `projectId` is `ctx.projectId`, and whose `threadId` is
    `ctx.threadId`. Any other id answers `not_found`, so there is no existence leak. Another member's thread in the same
    project stays out of reach, even though its approval summary is visible in the inbox.
  - **Output** is these lines, in order:
    - `action <id> <tool> <status>`
    - `requested <ISO createdAt>`
    - `decided <ISO decidedAt>`, when decided
    - `result:` followed by `ctx.data(result)`, when there is a result
- **2a-D15 catalog.** `koda-tool-descriptors.ts` gains `KODA_GET_ACTION` and `KODA_ADD_COMMENT`, in a new group
  `ACTION_TOOL_DESCRIPTORS`. `KODA_TOOL_DESCRIPTORS` spreads that group after the knowledge group.
  - REPO and PROJECT threads get 14 descriptors.
  - WORKSPACE threads get 15 through `kodaToolDescriptorsFor`, with the `project` argument.

  Both counts are under `KODA_TOOL_LIMITS.maxTools` (32). The `koda_add_comment` description says the comment is only
  added after the user approves. The two tools register from a new provider, `ActionTools` (`tools/action-tools.ts`),
  like the other groups.

### Integration

Symbols this feature only reads (verified 2026-10-17 at `ebbea193`):

- **Approvals**
  - `ApprovalCloser.recordResolved(approval, actor)` (`apps/api/src/fleet/approvals/approval-closer.ts:90-94`) and
    `userActor` (`:29`).
  - `approvalActivityPayload(a, extra)` and `approvalWebhookPayload(a, slug)` (`approval-payloads.ts`).
  - `ApprovalLivePublisher`.
  - `IApprovalRepository.create`, `lockById`, `resolve` and `findProjectSlug` (`domain/approval.domain.ts:88-111`).
- **Threads**
  - `ThreadEventBus.publish` (`apps/api/src/live/thread-event-bus.ts:28`).
  - `ThreadLiveEvent` (`:3-8`). It requires `id` and `at`; this feature adds no variant.
  - `allocateThreadSeq(client, threadId)` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts:35`).
- **Assistant tool layer**
  - `AssistantToolCallRepository.findCallContext(jobId)` (`assistant-tool-call.domain.ts:38`). It returns the creator,
    project, thread and kind.
  - `fenceData`, `maskSecrets` and `capText` (`assistant-tool-safety.ts`).
- **Tickets and comments**
  - `TicketsService.findByRef(slug, ref)`.
  - `CommentsService.create(projectSlug, ticketRef, dto, principal)` (`apps/api/src/comments/comments.service.ts:107`).
- **Notifications**
  - `NotificationWriter.deliver(drafts)` (`apps/api/src/notifications/notification-writer.ts:41`).
  - `NotificationDraft` (`notification.types.ts:31-43`).
- **Config and constants**
  - `SYSTEM_ACTOR` (`apps/api/src/fleet/common/system-actor.ts`).
  - `FLEET_CFG`: `sweepEnabled`, `approvalSweepMs` and `threadsEnabled`.
- **Runner tool route**
  - `POST /fleet/runner/jobs/:jobId/tools/:name?leaseEpoch=<n>` (`assistant/runner-tool.controller.ts:19-38`).

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- **`AssistantTool`** (`apps/api/src/fleet/assistant/assistant-tool.types.ts:18-27`). Target: gains
  `kind?: 'read' | 'write'` and `preview?(ctx: ToolContext, input: I): Promise<string>`.
- **`ToolCallOutcome`** (`assistant-tool-call.domain.ts:7`). Target: adds `pending` and `refused`.
- **`AssistantToolExecutor`** (`assistant-tool.executor.ts`).
  - Baseline: `execTool` (`:149-168`) always calls `tool.execute`, and `execute` (`:52-66`) sets
    `isError: outcome !== 'ok'`.
  - Target: a write tool's `execTool` calls `preview`, then the attached `ActionProposer.propose` (2a-D4).
  - Target: `isError` is false for `ok` and `pending`.
  - Target: new public methods `attachActions(actions)`, `checkAction(action): Promise<'ok' | 'forbidden'>` and
    `executeAction(action): Promise<{ ok: boolean; text: string }>`.
  - The constructor is unchanged.
- **`ApprovalsService.decide`** (`apps/api/src/fleet/approvals/approvals.service.ts:88-96`).
  - Baseline: line 92 routes bash, and everything else falls into the budget gate.
  - Target: an `assistant_action` goes to `AssistantActionPort.decide` before line 93.
  - Target: the constructor gains `AssistantActionPort` as its last parameter.
- **`APPROVAL_TYPES`, `APPROVAL_DECISIONS`** (`domain/approval.domain.ts:4,10`) and **`HomeApprovalDto.type`**. Target:
  2a-D7.
- **`ApprovalCloser`** (`approval-closer.ts`). Target: gains `openAssistant` (2a-D5), and `enqueueRequested` takes
  optional extra fields.
- **`ApprovalStoreModule`** (`approval-store.module.ts`). Target: provides and exports `AssistantActionPort`.
- **Notifications.** Target: 2a-D6. The changed symbols are:
  - `FleetApprovalRequestedSubscriber.handle` (`fleet-approval-requested.subscriber.ts:36-49`)
  - `parseApprovalRequestedPayload` (`fleet-notification-events.ts`)
  - `fleet-notification-drafts.ts`
- **Thread detail.** Target: 2a-D12. The changed symbols are:
  - `ChatThreadDetail` (`threads/domain/chat-thread.domain.ts:89`)
  - `ChatThreadRepository`
  - `ThreadDetailDto` (`threads/dto/thread.dto.ts:38-41`)
  - the `ThreadsService` detail (`threads.service.ts:58-59`)
  - the `WorkspaceThreadsService` detail (`workspace-threads.service.ts:77-78`)
- **`KODA_TOOL_DESCRIPTORS`** (`koda-tool-descriptors.ts:291-293`). Target: 2a-D15.
- **`AssistantModule`** (`assistant.module.ts`). Target:
  - imports `LiveModule` and `ApprovalStoreModule`;
  - provides `AssistantActionService`, `AssistantActionDecisions`, `PrismaPendingActionRepository` with its token,
    `PendingActionExpirySweeper` and `ActionTools`.

Worked skeleton for the two late bindings. This is a novel shape in this codebase: a handler registered by the
importing unit.

```ts
// apps/api/src/fleet/approvals/assistant-action.port.ts
export interface AssistantActionDecider {
  decide(caller: ApprovalCaller, approval: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalRecord>;
}

@Injectable()
export class AssistantActionPort {
  private decider: AssistantActionDecider | null = null;
  register(decider: AssistantActionDecider): void { this.decider = decider; }
  decide(caller: ApprovalCaller, approval: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalRecord> {
    if (!this.decider) throw new ConflictAppException({}, 'threads.disabled');
    return this.decider.decide(caller, approval, dto, now);
  }
}

// apps/api/src/fleet/assistant/actions/assistant-action.service.ts
@Injectable()
export class AssistantActionService implements OnModuleInit, ActionProposer {
  constructor(private readonly executor: AssistantToolExecutor /* , repository, closer, live, bus, txManager */) {}
  onModuleInit(): void { this.executor.attachActions(this); }
  async propose(input: ProposeInput): Promise<{ actionId: string } | { refused: true }> { /* 2a-D4 */ }
}
```

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Write tool, creator lacks the tool's ability | `forbidden: <tool> needs <action> <subject> on <slug>`; no preview, no action | US-002 |
| Write tool, preview finds no target | `not_found`; no action | US-002 |
| Write tool, no proposer attached | `error: <tool> failed`; warning logged | US-002 |
| 11th pending action in a thread | `refused: 10 actions are pending in this thread; wait for the user to decide them`; nothing written | US-001 |
| Repeat call with the same `toolCallId` | the same `pending <id>` text; no second action | US-001 |
| `koda_add_comment` with an empty or over-long body | `invalid_input: body` | US-003 |
| `koda_get_action` id from another thread or project, or unknown | `not_found` | US-003 |
| `koda_get_action` id longer than 64 characters | `invalid_input: id` | US-003 |
| `assistant_action` outbox payload missing `requestedById`, `threadPath` or `tool` | warning logged; no notification | US-004 |
| Decide by anyone but the requester (project or admin prefix) | 403 `threads.notCreator`; nothing written | US-005 |
| Decide with a decision other than `approve` / `reject` | 400 `fleet.approvalDecisionInvalid` | US-005 |
| Decide while `FLEET_THREADS_ENABLED` is off | 409 `threads.disabled`; nothing written | US-005 |
| Decide an approval whose action row is gone | 409 `fleet.approvalNotPending` | US-005 |
| Decide an action already decided or expired | 409 `fleet.approvalNotPending` | US-005 |
| Decide after `expiresAt` but before the sweep | action `EXPIRED` with its note; 409 `fleet.approvalNotPending` | US-005 |
| Approve when the requester lost membership or the ability, or is disabled | 403 `projects`; action stays `PENDING` | US-006 |
| Two approves of one action at once | one answers 200 and executes once; the other answers 409 | US-006 |
| Approved tool throws `NotFoundAppException` | action `FAILED`, result `not_found`, note written | US-006 |
| Approved tool throws anything else | action `FAILED`, result `error: <tool> failed`, stack logged, note written (note text pinned in US-007) | US-006 |
| Approved tool result over 16 KB | stored capped at 16 KB | US-006 |
| Approve on an archived thread | executes; note written | US-006 |
| Action past `expiresAt` | sweeper sets `EXPIRED`, approval `expired`, note written | US-007 |
| One action fails to expire in a tick | logged, counted in `failed`; the others still expire | US-007 |
| Job ends while an action is pending | action and approval untouched | US-007 |

## Out of Scope

- Delivering outcome notes into the agent's next THREAD_INPUT or new-turn text, and setting `PendingAction.deliveredAt`: `fleet-s5b-koda-actions-web` (2a-R4).
- Every web change: the inbox panel and label for `assistant_action`, the thread action cards, rendering `system` messages, the `action_requested` notification strings, and koda#294 — all `fleet-s5b-koda-actions-web` (2a-R4).
- Write tools other than `koda_add_comment` (`koda_create_tickets`, `koda_update_ticket`, `koda_link_tickets`, `koda_add_kb_doc`, `koda_add_memory`, `koda_record_decision`, `koda_dispatch_job`, `koda_requeue_job`, `koda_cancel_job`): S5b-2b.
- Editing a proposed action's input before deciding (reject and ask again, umbrella §12), and deciding several actions in one request.
- A server-to-session command for outcome notes (outcomes ride the next user message, S5b-R10).
- Recovering an action left `APPROVED` when the API stops between the approve commit and the tool's result; it stays `APPROVED` with no note.
- Annotating the comment's own ticket events or timeline with `via: thread <id>`; the approval activity row carries the `threadId`.
- PendingActions with no thread (the MCP front door, S5b-3); `PendingAction.threadId` stays required here.
- A per-tool or per-project configurable action lifetime or pending cap; both are constants (`ACTION_TTL_MS`, `MAX_PENDING_ACTIONS`).
- Delegating a decision to anyone other than the requester, including project admins and global admins (2a-R2).
- Changes to the runner, the fleet protocol or `FLEET_PROTOCOL_VERSION`.
- Changes to `ApprovalExpirySweeper`, `findExpiredPending`, `findPendingForJob` or `closeForJob` (they stay bash-only).
- Filtering `assistant_action` rows out of the approval badge counts (`countPending`), the job's pending approval count (`countPendingByJob`) or the home dashboard's pending list; every project member sees the summary row there, and only the requester can decide it.
- Deciding an action from the CLI: `apps/cli/src/commands/fleet-approval.ts` keeps its decision list, so agents and the CLI cannot approve or reject (2a-R2).
- Showing the exact unmasked body on the preview: the preview masks secret-like values (2a-D13) while the approved comment posts the body as written; the human sees the masked form.
- Deploying this feature to koda-wk without `fleet-s5b-koda-actions-web`: until the web feature ships, the inbox shows `assistant_action` rows with the generic label and no panel, so the two deploy together.
- Translating outcome note texts; they are English, like the agent instructions (2a-D9).
- US-001 only: two write calls racing for the 10th slot are serialised by the thread row lock; the call that loses is refused, not queued.
- US-007 only: a decide racing the sweep on the same action is serialised by the thread, approval and action locks (2a-D11); no AC drives the two concurrently.
- US-006 only: the approve re-check (`checkAction`) and the tool's own write are not one transaction; a membership change that commits between them is not detected for that one action.

## Stories

1. **US-001: PendingAction storage and the propose service** — `Workdir: apps/api` — No dependencies.
2. **US-002: Write-tool contract in the executor** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: `koda_add_comment` and `koda_get_action`** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: Thread detail pending actions and creator-only notification** — `Workdir: apps/api` — Depends on US-001.
5. **US-005: Decide `assistant_action`: gates, reject and outcome notes** — `Workdir: apps/api` — Depends on US-001.
6. **US-006: Approve and execute** — `Workdir: apps/api` — Depends on US-003, US-005.
7. **US-007: Action expiry sweep** — `Workdir: apps/api` — Depends on US-005.

- US-001 changes the Prisma schema, and every later story uses it.
- US-004 adds `ThreadDetailDto.pendingActions`, which changes a response shape.
- US-005 adds the `approve` and `reject` decision values and the `assistant_action` type to the approvals DTOs.
- Because US-004 and US-005 change the API contract, each runs `bun run generate` and commits `openapi.json` and the
  CLI client.
- DB-backed tests seed a `PendingAction` through `AssistantActionService.propose`. US-007 also sets `expiresAt` in the
  past.

### Context Files

**US-001**

- `apps/api/src/fleet/approvals/approval-closer.ts` — `openBash` (the open pattern to mirror), `enqueueRequested`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `lockIdleThread` (the thread `FOR UPDATE` pattern)
- `apps/api/src/fleet/approvals/domain/approval.domain.ts` — `APPROVAL_TYPES`, `IApprovalRepository`
- `apps/api/prisma/schema.prisma` — `FleetApproval`, `ChatThread`, `AssistantToolCall`
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — the `AbstractPrismaRepository` pattern in this module

**US-002**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `execute`, `run`, `execTool`, `store`
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `AssistantTool`, `ToolContext`
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — `ToolCallOutcome`, `ToolCallContext`
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — the executor test harness to extend
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — created by US-001; this story adds its `AssistantToolExecutor` constructor parameter and `onModuleInit` calling `executor.attachActions(this)` (2a-D1)

**US-003**

- `apps/api/src/fleet/assistant/tools/ticket-tools.ts` — `koda_get_ticket` (ref parsing, `findByRef`), the group provider pattern
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — descriptor groups, `KODA_TOOL_DESCRIPTORS`
- `apps/api/src/comments/comments.service.ts` — `create`
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — created by US-001, read by `koda_get_action`

**US-004**

- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — `handle`
- `apps/api/src/notifications/fleet/fleet-notification-drafts.ts` — `jobOutcomeDraft` (the single-user draft to mirror)
- `apps/api/src/fleet/threads/threads.service.ts` — the project detail builder
- `apps/api/src/fleet/threads/workspace-threads.service.ts` — the WORKSPACE detail builder
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `handoff`, the repository the new read joins

**US-005**

- `apps/api/src/fleet/approvals/approvals.service.ts` — `decide`, `decideBash`
- `apps/api/src/fleet/approvals/dto/decide-approval.dto.ts` — `DecideApprovalDto`
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `allocateThreadSeq`
- `apps/api/src/live/thread-event-bus.ts` — `ThreadEventBus`, `ThreadLiveEvent`
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — created by US-001

**US-006**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `run`, `membership`, `execParsed`, `userPrincipal`
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — created by US-005, extended here
- `apps/api/src/fleet/assistant/actions/outcome-note.ts` — created by US-005
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — created by US-003, `koda_add_comment` is what an approve runs

**US-007**

- `apps/api/src/fleet/approvals/approval-expiry-sweeper.ts` — the sweeper to mirror
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — created by US-005, `expireLocked` (the expire-and-note step the sweeper reuses)
- `apps/api/src/config/fleet.config.ts` — `sweepEnabled`, `approvalSweepMs`

### Creates

**US-001**

- `apps/api/prisma/migrations/20261023090000_pending_action/migration.sql` — the `PendingAction` table
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — `PendingActionRecord`, `PendingActionStatus`, `PENDING_ACTION_REPOSITORY`, `ACTION_TTL_MS`, `MAX_PENDING_ACTIONS`, `ActionProposer`
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — `PrismaPendingActionRepository` (extends `AbstractPrismaRepository`)
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — `AssistantActionService.propose`
- `apps/api/test/integration/fleet/assistant-actions-propose.integration.spec.ts` — DB-backed propose tests

**US-002**

None. Tests extend `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts`.

**US-003**

- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `addCommentTool`, `getActionTool`, the `ActionTools` provider
- `apps/api/test/integration/fleet/assistant-action-tools.integration.spec.ts` — DB-backed tool tests

**US-004**

- `apps/api/test/integration/fleet/assistant-action-detail.integration.spec.ts` — DB-backed detail and notification tests

**US-005**

- `apps/api/src/fleet/approvals/assistant-action.port.ts` — `AssistantActionPort`, `AssistantActionDecider`
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — `AssistantActionDecisions.decide` (gates, reject, expire-on-decide, the note writer)
- `apps/api/src/fleet/assistant/actions/outcome-note.ts` — `outcomeNote`
- `apps/api/test/integration/fleet/assistant-actions-decide.integration.spec.ts` — DB-backed decide tests

**US-006**

- `apps/api/test/integration/fleet/assistant-actions-approve.integration.spec.ts` — DB-backed approve and execute tests

**US-007**

- `apps/api/src/fleet/assistant/actions/pending-action-expiry.sweeper.ts` — `PendingActionExpirySweeper`
- `apps/api/test/integration/fleet/assistant-actions-expiry.integration.spec.ts` — DB-backed expiry tests

### Modifies

This section lists the existing files whose assertions or shared contracts a story changes. A source file that a story
only extends additively (a new method, a new type member, a provider) is named in Design § Integration and not
repeated here.

**US-001**

- `apps/api/prisma/schema.prisma` — gains the `PendingAction` model and `ChatThread.pendingActions` (2a-D3); no existing field changes.
- `apps/api/src/fleet/approvals/domain/approval.domain.ts` — `APPROVAL_TYPES` gains `assistant_action` here; US-005 adds `approve` and `reject` to `APPROVAL_DECISIONS` in the same file (2a-D7). One entry per path, because `nax plan` keeps one reason per file.
- `apps/api/src/fleet/approvals/approval-closer.ts` — gains `openAssistant`; `enqueueRequested` takes optional extra outbox fields; existing methods unchanged.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — the module-compile test keeps its assertions; if compiling `AssistantModule` with its new `LiveModule` and `ApprovalStoreModule` imports needs a provider stub the test lacks, it gains that stub.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — only if compiling `AssistantModule` with its new imports needs a stub the global module lacks; it may gain that stub provider without touching any assertion.

**US-002**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the write branch in `execTool`, `attachActions`, and `isError` for `pending` (2a-D2, 2a-D4); US-006 later adds the public `checkAction` and `executeAction` to the same file (2a-D8 steps 5 and 8). Read tools behave as today. One entry per path, because `nax plan` keeps one reason per file.

**US-003**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — gains `KODA_GET_ACTION`, `KODA_ADD_COMMENT` and `ACTION_TOOL_DESCRIPTORS`; `KODA_TOOL_DESCRIPTORS` spreads the new group last (2a-D15).

**US-004**

- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — the `assistant_action` branch (2a-D6); the admin fan-out for other types is unchanged.
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDetailDto` gains `pendingActions` (with `@ApiProperty`).
- `apps/api/src/fleet/threads/threads.service.spec.ts` — its mocked thread repository (with `handoff: vi.fn()...`) gains `pendingActions: vi.fn().mockResolvedValue([])`; a detail assertion that compares the whole detail object with `toEqual` gains `pendingActions: []`; no other assertion changes.
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — its mocked thread repository gains `pendingActions: vi.fn().mockResolvedValue([])`; a detail assertion that compares the whole detail object with `toEqual` gains `pendingActions: []`; no other assertion changes.

**US-005**

- `apps/api/src/fleet/approvals/approvals.service.ts` — the `assistant_action` branch before the budget gate; the constructor gains `AssistantActionPort` last.
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — the two `new ApprovalsService(...)` calls at `:51` and `:88` gain an 11th argument (an `AssistantActionPort` stub); no assertion changes.
- `apps/api/src/home/dto/home-dashboard.dto.ts` — `HomeApprovalDto.type`'s enum gains `assistant_action` (2a-D7).
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains a decide test for an `assistant_action` (a reject by the requester answers 200, a decide by another user answers 403) and asserts the project thread detail answers `pendingActions` as an array (the US-004 shape); every existing test is unchanged.

**US-006**

None. The approve branch extends `assistant-action-decisions.ts`, which US-005 creates (a created file needs no entry), and the executor's `checkAction` and `executeAction` are covered by the US-002 entry for that file.

**US-007**

None. The sweeper is a new provider; `ApprovalExpirySweeper` and its specs are untouched.

### Seams

- **US-001 → US-002.** `AssistantActionService.onModuleInit` attaches the service to the executor. US-002 AC-1 compiles
  `AssistantModule` and calls `AssistantToolExecutor.execute` for a stub write tool, entering at the executor's public
  `execute`.
- **US-002 → US-003.** `koda_add_comment` is a write tool, so the real path stores an action. US-003 AC-4 enters at the
  runner tool route (`POST /fleet/runner/jobs/:jobId/tools/koda_add_comment?leaseEpoch=<n>`) for a seeded RUNNING
  THREAD job.
- **US-001 → US-004.** `openAssistant` enqueues the outbox payload that the subscriber reads. US-004 AC-6 runs
  `FleetApprovalRequestedSubscriber.handle` on the payload a real `AssistantActionService.propose` enqueued.
- **US-001 → US-005.** `AssistantActionPort.register` is the only way the decide route reaches the handler. US-005 AC-1
  enters at `POST /projects/:slug/fleet/approvals/:id/decide`.
- **US-003 → US-006.** `koda_add_comment.execute` is what an approve runs. US-006 AC-1 asserts the comment exists after
  the decide route answers.
- **US-005 → US-007.** `AssistantActionDecisions.expireLocked` is shared. US-007 AC-1 enters at `PendingActionExpirySweeper.tick`.

## Acceptance Criteria

### US-001: PendingAction storage and the propose service (`Workdir: apps/api`)

1. [integration] `AssistantActionService.propose` for a REPO thread returns `{ actionId }` naming a stored `PendingAction` whose `status` is `PENDING`.
2. [integration] The stored action's `input` equals the `input` passed to `propose`.
3. [integration] The stored action's `expiresAt` is exactly `ACTION_TTL_MS` after the `now` passed to `propose`.
4. [integration] `propose` stores one `FleetApproval` whose `type` is `assistant_action` and whose `status` is `pending`.
5. [integration] That approval's `payload` equals `{ actionId, tool, threadId, threadPath, requestedById }` with no other keys.
6. [integration] That approval's `expiresAt` equals the action's `expiresAt`.
7. [integration] The action's `approvalId` equals that approval's id.
8. [integration] `propose` for a REPO thread of project `web` stores an approval whose payload `threadPath` is `/web/threads/<threadId>`.
9. [integration] `propose` for a WORKSPACE thread stores an approval whose payload `threadPath` is `/threads/<threadId>`.
10. [integration] A second `propose` with the same `jobId` and `toolCallId` returns the same `actionId`, and the thread still has one action.
11. [integration] With 10 `PENDING` actions in a thread, `propose` with a new `toolCallId` returns `{ refused: true }`, and the thread still has 10 actions.
12. [integration] With 9 `PENDING` actions in a thread, two `propose` calls with different `toolCallId`s run concurrently leave exactly 10 `PENDING` actions in the thread.
13. [unit] After `propose` commits, `ThreadEventBus.publish` receives an event whose `type` is `thread` and whose `threadId` is the action's thread.
14. [integration] The `approval.requested` activity row recorded by `propose` has actor id equal to the requester and a payload whose `threadId` is the thread's id.
15. [integration] `propose` enqueues one `fleet_approval_requested` outbox row whose payload carries the requester's id as `requestedById`.

### US-002: Write-tool contract in the executor (`Workdir: apps/api`)

1. [unit] In the compiled `AssistantModule` testing module, with `ASSISTANT_TOOL_CALL_REPOSITORY` and `ProjectAccessService` overridden by stubs and `AssistantActionService.propose` spied to answer `{ actionId: 'a1' }`, after `init()` `AssistantToolExecutor.execute` calling a registered stub tool with `kind: 'write'` returns content `pending a1: awaiting user approval; do not retry`, which proves `onModuleInit` attached the service.
2. [unit] `AssistantToolExecutor.execute` calling a stub write tool, with a stub proposer attached, never calls the stub tool's `execute`.
3. [unit] `AssistantToolExecutor.execute` calling a stub write tool calls the tool's `preview` with the parsed input.
4. [unit] `AssistantToolExecutor.execute` calling a stub write tool calls the attached proposer's `propose` with the text the tool's `preview` returned as `preview`.
5. [unit] For a WORKSPACE thread calling a stub write tool with `{ project: 'b' }`, the attached proposer's `propose` receives `projectId` equal to project `b`'s id.
6. [unit] For a WORKSPACE thread calling a stub write tool with `{ project: 'b' }`, the attached proposer's `propose` receives an `input` with no `project` key.
7. [unit] For a WORKSPACE thread calling a stub write tool, the attached proposer's `propose` receives `threadKind` `WORKSPACE`.
8. [unit] `AssistantToolExecutor.execute` (real `KodaCaslAbilityFactory`) calling a stub write tool whose permission is the ability `create` `FleetJob`, for a creator whose role is `VIEWER`, returns content starting `forbidden:` and never calls the tool's `preview`.
9. [unit] `AssistantToolExecutor.execute` calling a stub write tool whose `preview` throws `NotFoundAppException` returns `{ isError: true, content: 'not_found' }` and never calls `propose`.
10. [unit] When the attached proposer answers `{ actionId: 'a1' }`, `AssistantToolExecutor.execute` returns `isError` `false`.
11. [unit] When the attached proposer answers `{ actionId: 'a1' }`, the `AssistantToolCall` row the executor records has `outcome` `pending`.
12. [unit] When the attached proposer answers `{ refused: true }`, `AssistantToolExecutor.execute` returns `{ isError: true, content: 'refused: 10 actions are pending in this thread; wait for the user to decide them' }`.
13. [unit] When no proposer is attached, `AssistantToolExecutor.execute` calling a stub write tool named `w` returns `{ isError: true, content: 'error: w failed' }`.
14. [unit] `AssistantToolExecutor.execute` calling a read tool (no `kind`) still calls the tool's `execute` and never calls `propose`.

### US-003: `koda_add_comment` and `koda_get_action` (`Workdir: apps/api`)

1. [unit] `addCommentTool(...).parse({ ref: 'KODA-1', body: '   ' })` throws `ToolInputError` with reason `body`.
2. [unit] `addCommentTool(...).parse` with a body of 10001 characters throws `ToolInputError` with reason `body`.
3. [unit] `addCommentTool(...).parse({ ref: 'not a ref', body: 'x' })` throws `ToolInputError` with reason `ref`.
4. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_add_comment?leaseEpoch=<n>` from the runner holding a RUNNING REPO THREAD job, body `{ toolCallId: 't1', input: { ref: 'KODA-1', body: 'hello' } }`, answers 200 with content starting `pending `.
5. [integration] After that call, ticket `KODA-1` has no comment.
6. [integration] After that call, the stored `PendingAction`'s `preview` starts with `Add a comment to KODA-1 "` followed by the ticket's title.
7. [integration] `koda_add_comment` for a ref that matches no ticket of the project answers `{ isError: true, content: 'not_found' }` and stores no `PendingAction`.
8. [unit] `addCommentTool(...).execute` calls `CommentsService.create` with the context's project slug, the ref, `{ body: 'hello', type: 'GENERAL' }` and `ctx.actor`.
9. [unit] `addCommentTool(...).execute` returns `comment <id> added to KODA-1 /<slug>/tickets/KODA-1` for a created comment with id `<id>`.
10. [integration] `koda_get_action` in the thread that proposed a `PENDING` `koda_add_comment` action, with its id, answers a first line `action <id> koda_add_comment PENDING`.
11. [integration] `koda_get_action` with the id of an action of another thread in the same project answers `{ isError: true, content: 'not_found' }`.
12. [unit] `getActionTool(...).parse({ id: 'x'.repeat(65) })` throws `ToolInputError` with reason `id`.
13. [unit] `getActionTool(...).execute` for an `EXECUTED` action with result `r` returns a `result:` line followed by `ctx.data('r')`.
14. [unit] `kodaToolDescriptorsFor('REPO')` ends with the descriptors named `koda_get_action` and `koda_add_comment`, in that order.
15. [unit] After the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_add_comment')` returns a tool whose `kind` is `write`.

### US-004: Thread detail pending actions and creator-only notification (`Workdir: apps/api`)

1. [integration] `GET /projects/:slug/threads/:id` for a thread with one `PENDING` and one `REJECTED` action answers `pendingActions` with exactly one entry.
2. [integration] That entry's `id`, `approvalId`, `tool` and `preview` equal the pending action's.
3. [integration] That entry's `projectSlug` is the project's slug.
4. [integration] `GET /threads/:id` for a WORKSPACE thread whose `PENDING` action acts in project `b` answers a `pendingActions` entry whose `projectSlug` is `b`.
5. [integration] `GET /projects/:slug/threads/:id` for a thread with no actions answers `pendingActions` as an empty array.
6. [integration] `FleetApprovalRequestedSubscriber.handle`, given the outbox payload a real `propose` enqueued, creates exactly one notification.
7. [integration] That notification's user is the requester.
8. [integration] That notification's kind is `action_requested`.
9. [integration] That notification's link equals the approval payload's `threadPath`.
10. [unit] `FleetApprovalRequestedSubscriber.handle` for an `assistant_action` payload never calls `NotificationEligibility.findGlobalAdminIds`.
11. [unit] `FleetApprovalRequestedSubscriber.handle` for an `assistant_action` payload without `requestedById` calls `NotificationWriter.deliver` zero times.
12. [unit] `FleetApprovalRequestedSubscriber.handle` for a `nax_bash_escalate` payload still delivers one draft per id `findGlobalAdminIds` answers.

### US-005: Decide `assistant_action`: gates, reject and outcome notes (`Workdir: apps/api`)

1. [integration] `POST /projects/:slug/fleet/approvals/:id/decide` with `{ decision: 'reject' }` by the requester of a pending action answers 200 with approval `status` `rejected`.
2. [integration] After that reject, the action's `status` is `REJECTED` and its `decidedById` is the requester.
3. [integration] After that reject, the thread has a `ChatMessage` with `role` `system` and content `Action <actionId> (<tool>) was rejected by the user.`
4. [integration] `POST /fleet/approvals/:id/decide` with `{ decision: 'reject' }` by the requester, who is a global ADMIN, answers 200.
5. [integration] A decide on the project prefix by a project ADMIN who is not the requester answers 403, and the action stays `PENDING`.
6. [integration] A decide on the admin prefix by a global ADMIN who is not the requester answers 403, and the action stays `PENDING`.
7. [integration] A decide with `{ decision: 'allow' }` by the requester answers 400, and the action stays `PENDING`.
8. [unit] `AssistantActionDecisions.decide` with `FLEET_THREADS_ENABLED` off throws the 409 `threads.disabled` exception and writes nothing.
9. [integration] A second reject of a `REJECTED` action answers 409.
10. [integration] A decide of an `assistant_action` approval whose action row was deleted answers 409.
11. [integration] A reject of an action whose `expiresAt` is in the past answers 409, and the action's `status` is then `EXPIRED`.
12. [unit] `outcomeNote` for an `EXECUTED` action whose result is 600 characters returns a note whose result part is the first 500 characters followed by `…`.
13. [unit] After a reject commits, `ThreadEventBus.publish` receives a `message` event naming the system note's id.
14. [unit] `ApprovalsService.decide` for an approval of type `assistant_action` calls `AssistantActionPort.decide` with the caller, the approval and the dto.
15. [unit] `ApprovalsService.decide` for an approval of type `assistant_action` never calls `BudgetsService.resume`.

### US-006: Approve and execute (`Workdir: apps/api`)

1. [integration] `POST /projects/:slug/fleet/approvals/:id/decide` with `{ decision: 'approve' }` by the requester of a pending `koda_add_comment` action answers 200, and ticket `KODA-1` then has a comment with body `hello`.
2. [integration] That comment's author is the requester.
3. [integration] After that approve, the action's `status` is `EXECUTED` and its `result` starts with `comment `.
4. [integration] After that approve, the approval's `decision` is `approve`.
5. [integration] After that approve, the thread has a system message starting `Action <actionId> (koda_add_comment) was approved and done: comment `.
6. [integration] Two approves of the same pending action sent concurrently produce one 200 and one 409, and the ticket has one new comment.
7. [integration] An approve by a requester who was removed from the action's project after the proposal answers 403, and the action stays `PENDING`.
8. [unit] `AssistantToolExecutor.checkAction` for an action whose requester is disabled returns `forbidden`.
9. [unit] `AssistantToolExecutor.checkAction`, with `KodaCaslAbilityFactory` stubbed so the requester's project role is denied `create Comment`, returns `forbidden` for a `koda_add_comment` action (every built-in role holds `create Comment`, so the ability-loss case is a unit test).
10. [integration] An approve of a `koda_add_comment` action whose ticket was soft-deleted after the proposal answers 200, and the action is `FAILED` with `result` `not_found`.
11. [unit] `AssistantToolExecutor.executeAction` for an action whose tool's `execute` throws a plain `Error` returns `{ ok: false, text: 'error: <tool> failed' }`.
12. [unit] `AssistantActionDecisions.decide` stores a result of at most 16384 bytes when the tool's `execute` returns 20000 bytes.
13. [integration] An approve of an action on an archived thread answers 200, and the action is `EXECUTED`.
14. [unit] `AssistantToolExecutor.executeAction` runs the tool with a context whose `projectSlug` is the slug of the action's project, not the thread's home project.
15. [unit] After an approve completes, `ThreadEventBus.publish` receives a `thread` event for the action's thread.

### US-007: Action expiry sweep (`Workdir: apps/api`)

1. [integration] `PendingActionExpirySweeper.tick(now)` with one `PENDING` action whose `expiresAt` is before `now` returns `{ expired: 1, failed: 0 }`.
2. [integration] After that tick, the action's `status` is `EXPIRED`.
3. [integration] After that tick, the action's approval has `status` `expired` and `resolvedBy` `timeout`.
4. [integration] After that tick, the action's thread has a system message `Action <actionId> (<tool>) expired without a decision.`
5. [integration] `PendingActionExpirySweeper.tick(now)` leaves a `PENDING` action whose `expiresAt` is after `now` with status `PENDING`.
6. [unit] `PendingActionExpirySweeper.tick` where expiring the first of two due actions throws returns `{ expired: 1, failed: 1 }`.
7. [unit] `PendingActionExpirySweeper.tick` with 101 due actions expires 100.
8. [integration] A `PENDING` action whose job is completed through `JobTransitionsService` (which calls `closeForJob`) still has status `PENDING`.
9. [unit] `PendingActionExpirySweeper.onModuleInit` with `sweepEnabled` false starts no timer.
10. [unit] `outcomeNote` for a `FAILED` action with result `not_found` returns `Action <id> (<tool>) was approved but failed: not_found`.
