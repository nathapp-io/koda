# SPEC: Permissions P2a — The Full Action Context

## Summary

This feature grows the action context of `apps/api` from P1d's actor-only slice into the full `ActionContext` of design §5, and makes every entry point that leads to a database write set one:
- **The model.** `ActionContext` carries the actor (`USER`, `AGENT`, `RUNNER` or `SYSTEM`), an optional on-behalf-of principal, the origin (`rest`, `mcp`, `thread`, `runner`, `system`), an approval block (`requiredMode`, `satisfiedBy`, approver, request id) and a correlation id. System actors carry a component id instead of the generic `'system'`.
- **HTTP.** The global interceptor gives runner requests a `RUNNER` context and public requests a `SYSTEM/anonymous` context, so every request runs inside one.
- **Assistant tools.** A thread tool call runs as `SYSTEM/assistant` on behalf of the thread's creator; an approved action runs the same way with the approval block taken from the action; an MCP tool call keeps its caller as the actor and marks the origin `mcp`.
- **System writers.** Every background entry (interval and cron ticks, queue drains, webhook intake, boot seeders, outbox fan-out) runs inside a `SYSTEM/<component>` context. The two `@OnEvent` listeners only enqueue, so the drain they start carries the context. A scheduled fire runs as `SYSTEM/schedule` on behalf of the schedule's owner (decision 7).
- **Outbox.** The ticket and agent event envelopes gain the context's approval block.

Domain columns do not change: `requestedByType`, `createdByType`, `authorType`, `FleetActivity` actors and the `PendingAction` actor keep the values they record today, because `actorTypeFor` now also looks at the on-behalf-of principal.

This is the first of seven features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order (ruled 2026-10-24): **context**, context-guard, audit-entry, audit-core, audit-fleet, audit-integrations, web.

## Motivation

P2 records who acted and who approved on every write (design principle 5, gap A/ENH-1 and C/ENH-1). Today:
- `src/action-context/action-context.ts` (P1d US-001) holds only `{ actor: { type: 'USER' | 'AGENT', id } }`.
- A runner request and a public request run outside any context (`ActionContextInterceptor` returns early).
- The 35 `@SystemWriter` classes, the boot seeders and the outbox fan-out run outside any context, so their writes have no recorded actor.
- A thread tool call runs as the thread's creator, so the audit trail cannot tell "the user did it" from "the assistant did it for the user".
- A scheduled fire runs as the schedule's owner, not as the scheduler on the owner's behalf.

The next feature, `permissions-p2-context-guard`, makes a write with no context throw in dev and test. That guard can only be switched on once every entry point sets a context, which is this feature's job. The audit features after it read the context to fill `AuditEntry`.

**Rulings that bind this feature** (user, 2026-10-24):
- **P2 is seven features**, in order: context, context-guard, audit-entry, audit-core, audit-fleet, audit-integrations, web.
- **The runner is an actor of its own**: `{ type: 'RUNNER', id: <runner id> }`, not a system component.
- **The design approach stays**: an `ActionContext` in `AsyncLocalStorage`, `AuditEntry` written by the command layer in the write's transaction, and the context-less write rule (strict in tests, delivered by context-guard).

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **`schedule`, not the design's `scheduler`.** Design §5 lists `scheduler`; the key-family rule gives `schedule` (`system.schedule.dispatch`), and the rule wins so every id is derivable.
- **System component ids** are the second segment of the writer's `@SystemWriter` key (`system.schedule.dispatch` → `schedule`), so each `system.*` key family has one id (design §5: "one id per `system.*` key family"). Three ids have no key family: `assistant` (thread tool calls, design §4), `anonymous` (a public HTTP request before any principal exists) and `seed` (boot-time seeders). `outbox` is also the family of `system.outbox.dispatch` and `system.outbox.retention`. `unknown` is reserved for the context-guard feature's production fallback.
- **Every outbox handler runs as `SYSTEM/outbox`**, whichever subscriber registered it. The writer's own key is what `AuditEntry` will name later, so a per-subscriber id adds nothing and would change `FanOutPublisher.register` for 16 registrants.
- **An entry that is also reachable from a request keeps the request's context.** Only the background entry (the interval callback, the cron method, the boot hook) opens a system context. For example `VcsPrSyncService.syncPrStatus` called from `vcs.controller.ts` runs as the calling user.
- **A queue drain always runs as its component**, whoever enqueued: `KnowledgeIndexQueue` keeps one drain loop alive for every enqueuer and `BundleIngestService.kick` chains drains, so the context of the first enqueuer would otherwise leak into later passes. `KnowledgeIndexQueue.drain` runs as `knowledge`; the drain `BundleIngestService.kick` starts runs as `ingest`. A drain also takes a fresh `correlationId` (it passes `{ correlationId: randomUUID() }`), so it never carries the first enqueuer's id. `KnowledgePoller` and `BundleIngestSweeper` only enqueue and kick, so they are not wrapped.
- **The two webhook intake services override `SYSTEM/anonymous`** with their own component (`vcs`, `ci`): their requests are public, and the intake is the system's own write.
- **`ThreadIngestHook` (`system.thread.ingest`) is not wrapped**: its hook runs inside the runner's log-upload request (`fleet/logs/log-upload.service.ts:106`, awaited), so thread folds record the uploading runner (`RUNNER`). Only `ThreadIngestBootstrap`'s boot catch-up runs as `thread`.
- **The correlation id comes from `LoggerContext`** of `@nathapp/nestjs-logging` (already imported by `app.module.ts`); `.nax/rules/api-logging.md` restricts that package's `Logger`, not `LoggerContext`.
- **The three RAG optimize strategies are not wrapped**: they write only to LanceDB, never to Postgres.
- **Approval before P3.** A direct action has `requiredMode: 'none'`, `satisfiedBy: 'none'`. An approved assistant action carries the `PendingAction`'s mode, and `satisfiedBy` is the approver's tier (`USER` approver → `human`, `AGENT` approver → `agent`, no approver → `none`).

### The context model (US-001)

`src/action-context/action-context.ts` keeps its module-level `AsyncLocalStorage` and every existing export; it gains the full shape:

```typescript
import type { ApprovalMode } from '../permissions/catalog';
import type { FleetActorType } from '../common/enums';

export type ActorType = 'USER' | 'AGENT';                 // unchanged: the principal types actorTypeFor answers
export type ActionActorType = FleetActorType;            // 'USER' | 'AGENT' | 'RUNNER' | 'SYSTEM'
export interface ActionActor { type: ActionActorType; id: string }
export type ActionOrigin = 'rest' | 'mcp' | 'thread' | 'runner' | 'system';
export interface ActionApproval {
  requiredMode: ApprovalMode;
  satisfiedBy: ApprovalMode;
  approverType?: ActorType;
  approverId?: string;
  requestId?: string;
}
export interface ActionContext {
  actor: ActionActor;
  onBehalfOf?: { type: ActorType; id: string };
  origin: ActionOrigin;
  approval: ActionApproval;
  correlationId: string;
}
export type ActionContextInput = Omit<ActionContext, 'approval' | 'correlationId'> & Partial<Pick<ActionContext, 'approval' | 'correlationId'>>;

export const NO_APPROVAL: ActionApproval;                        // { requiredMode: 'none', satisfiedBy: 'none' }
export const SYSTEM_ACTOR_IDS: ReadonlySet<string>;              // derived, see below
export function runWithActionContext<T>(input: ActionContextInput, fn: () => T): T;  // named apart from nestjs-logging's runWithContext
export function currentContext(): ActionContext | undefined;
export function runAsSystem<T>(component: string, fn: () => T, opts?: { onBehalfOf?: ActionContext['onBehalfOf']; correlationId?: string }): T;
export function runAsSystemWriter<T>(writer: object, fn: () => T): T;
// kept:
export function runWithActor<T>(actor: { type: ActorType; id: string }, fn: () => T): T;
export function currentActor(): ActionActor | undefined;
export function actorTypeFor(actorId: string): ActorType;
```

- `runWithActionContext` fills `approval` with `NO_APPROVAL`. It fills `correlationId`, when the input has none, from the enclosing action context's `correlationId`, else `LoggerContext.current().requestId` from `@nathapp/nestjs-logging`, else a new `randomUUID()`, so one tick or request keeps one id through nested runs. A nested run replaces the context for its extent.
- `SYSTEM_ACTOR_IDS` is derived, never hand-copied: the second segment of every `PERMISSION_CATALOG` key whose access is `system`, plus `assistant`, `outbox`, `anonymous`, `seed` and `unknown`.
- `runAsSystem(component, fn, opts)` runs `fn` with actor `{ type: 'SYSTEM', id: component }`, origin `system` and the optional `onBehalfOf`. It throws `Error('unknown system actor id: <component>')` when `component` is not in `SYSTEM_ACTOR_IDS`.
- `runAsSystemWriter(writer, fn)` reads `SYSTEM_WRITER_METADATA` from `writer.constructor` and calls `runAsSystem(<second segment of the key>, fn)`. It throws `Error('runAsSystemWriter needs a @SystemWriter class, got <ClassName>')` when the class carries no key.
- `runWithActor(actor, fn)` is `runWithActionContext({ actor, origin: 'rest' }, fn)`.
- `actorTypeFor(actorId)`: the actor's type when the actor is a `USER` or `AGENT` with that id; else the on-behalf-of type when the on-behalf-of id matches; else `'USER'`.

### HTTP requests (US-002)

`ActionContextInterceptor.intercept` stops returning early. It runs the handler inside:

| Request | Context |
|:--|:--|
| user principal | actor `USER/<id>`, origin `rest` |
| agent principal | actor `AGENT/<id>`, origin `rest` |
| runner principal | actor `RUNNER/<id>`, origin `runner` |
| no principal (`@Public()` route) | actor `SYSTEM/anonymous`, origin `rest` |

The approval block is `NO_APPROVAL`; the correlation id is the request id of `@nathapp/nestjs-logging` when the logging middleware set one.

### Assistant tools (US-003)

In `src/fleet/assistant/assistant-tool.executor.ts`:
- `executeUnstored` (a thread tool call, arriving on the runner route) runs the tool inside actor `SYSTEM/assistant`, `onBehalfOf` = the thread creator (`AGENT` when `isAgentCreator(creator)`, else `USER`), origin `thread`.
- `executeAction` (an approved action) runs the tool inside actor `SYSTEM/assistant`, `onBehalfOf` = `USER/<scope.actor.id>`, origin `thread`, approval `{ requiredMode: action.approvalMode, satisfiedBy: <approver tier>, approverType, approverId, requestId: action.id }`. `approverType` maps `'user'` → `'USER'` and `'agent'` → `'AGENT'`.
- `executeFor` with `caller.origin.kind === 'mcp'` runs the tool inside a context whose actor is `caller.principal` (`AGENT/<id>` or `USER/<id>`) and whose origin is `mcp`, whether or not a context is already current. A caller with any other origin runs unchanged.

Because `actorTypeFor` reads `onBehalfOf`, every service the tool calls keeps recording the creator's type (`requestedByType`, `createdByType`, `authorType`) exactly as today.

### System writers (US-004, US-005)

Each background entry wraps its body in `runAsSystemWriter(this, …)`, or `runAsSystem('<id>', …)` for a class with no `@SystemWriter` key:

| Story | Class (file under `apps/api/src/`) | Entry wrapped | Component |
|:--|:--|:--|:--|
| US-004 | `PendingActionExpirySweeper` (`fleet/assistant/actions/pending-action-expiry.sweeper.ts`) | `tick` | `assistant-action` |
| US-004 | `ApprovalExpirySweeper` (`fleet/approvals/approval-expiry-sweeper.ts`) | `tick` | `approval` |
| US-004 | `BundleIngestService` (`fleet/ingest/bundle-ingest.service.ts`) | the `drain()` call chained by `kick` | `ingest` (`runAsSystem`) |
| US-004 | `ScheduleTicker` (`fleet/schedules/schedule-ticker.ts`) | `runOnce` | `schedule` |
| US-004 | `FleetPrStateRefresher` (`fleet/tickets/fleet-pr-state.refresher.ts`) | `refresh` | `ticket-link` |
| US-004 | `BudgetSweeper` (`fleet/budgets/budget-sweeper.ts`) | `tick` | `budget` |
| US-004 | `EnrollmentRetentionProcessor` (`fleet/runners/enrollment-retention.processor.ts`) | `scheduledPurge` | `enrollment` |
| US-004 | `FleetSweeper` (`fleet/sync/fleet-sweeper.ts`) | `sweep` | `job` |
| US-004 | `FleetLogRetentionProcessor` (`fleet/logs/fleet-log-retention.processor.ts`) | `scheduledPurge` | `log` |
| US-004 | `KnowledgeIndexQueue` (`fleet/knowledge/knowledge-index.queue.ts`) | `drain` | `knowledge` |
| US-005 | `OutboxRetentionProcessor` (`outbox/outbox-retention.processor.ts`) | `scheduledPurge` | `outbox` |
| US-005 | `MemoryGovernanceProcessor` (`memory/memory-governance.processor.ts`) | `scheduledCleanup` | `memory` |
| US-005 | `VcsPollingService` (`vcs/vcs-polling.service.ts`) | `tick` | `vcs` |
| US-005 | `VcsWebhookService` (`vcs/vcs-webhook.service.ts`) | `handleWebhook` | `vcs` |
| US-005 | `CiWebhookService` (`ci-webhook/ci-webhook.service.ts`) | `processCiWebhook` | `ci` |
| US-005 | `FleetHealthDetector` (`notifications/fleet/fleet-health.detector.ts`) | `detect` | `health` |
| US-005 | `EmailDispatcher` (`email/email-dispatcher.ts`) | `runScheduledTick` | `email` |
| US-005 | `NotificationRetentionProcessor` (`notifications/notification-retention.processor.ts`) | `scheduledPurge` | `notification` |
| US-005 | `ThreadIngestBootstrap` (`fleet/threads/ingest/thread-ingest.bootstrap.ts`) | `onApplicationBootstrap` | `thread` (`runAsSystem`) |
| US-005 | `SystemRoleSeeder` (`permissions/system-role.seeder.ts`) | `onApplicationBootstrap` | `seed` (`runAsSystem`) |
| US-005 | `EmailTemplateSeeder` (`email/email-template.seeder.ts`) | `onApplicationBootstrap` | `seed` (`runAsSystem`) |

**Scheduled dispatch (decision 7).** `ScheduleTicker.dispatchFresh` already checks the owner's access and keys at fire time and disables the schedule with `owner_lost_access` (P1 US-005); that stays. Its `runWithActor(owner, …)` around `FleetJobsService.dispatch` becomes `runAsSystem('schedule', …, { onBehalfOf: owner })`, so the dispatch runs as the scheduler on the owner's behalf and `actorTypeFor(s.createdById)` still answers the owner's type.

### Outbox (US-006)

- `FanOutPublisher.publish(record)` invokes each handler inside `runAsSystem('outbox', () => handler(record.payload))`. Failure collection, `recordLastError` and the thrown `OutboxFanOutError` are unchanged.
- `buildTicketEventOutboxPayload` and `buildAgentEventOutboxPayload` add `approval: currentContext().approval` to the envelope when a context is current, and omit the key when none is.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `runAsSystem` given an id outside `SYSTEM_ACTOR_IDS` | throws `Error('unknown system actor id: <id>')` before running `fn` | US-001 |
| `runAsSystemWriter` given an instance whose class has no `@SystemWriter` key | throws `Error('runAsSystemWriter needs a @SystemWriter class, got <ClassName>')` before running `fn` | US-001 |
| no enclosing context and no logging request id | `correlationId` is a new `randomUUID()` | US-001 |
| `fn` rejects inside any run | the rejection propagates unchanged; the context ends with `fn` | US-001 |
| an approved action's `approverType` is `null` | `satisfiedBy` is `none`, no approver fields | US-003 |
| an outbox handler throws inside `SYSTEM/outbox` | collected as today; `recordLastError` and `OutboxFanOutError` unchanged (pinned by the existing `fan-out-publisher.spec.ts` cases) | US-006 |
| an envelope is built with no context current | the `approval` key is omitted | US-006 |

### Integration

Verified at main `314af4b6`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `SYSTEM_WRITER_METADATA` and `SystemWriter(key)` — `src/permissions/system-writer.decorator.ts` (class metadata via `SetMetadata`).
- `PERMISSION_CATALOG` and `findCatalogEntry(key)` — `src/permissions/catalog.ts`; `ApprovalMode` from the same file.
- `FleetActorType` — `src/common/enums.ts:127`.
- `LoggerContext.current(): { requestId?: string }` — `@nathapp/nestjs-logging` 4.1.0.
- `isAgentPrincipal`, `isRunnerPrincipal`, `KodaPrincipal` — `src/auth/principal/koda-principal.types.ts`.
- `PendingActionRecord.approvalMode`, `.approverType`, `.approverId`, `.id` — `src/fleet/assistant/actions/pending-action.domain.ts`.

Changed (baseline → target):
- `ActionContext` — Baseline: `{ actor: { type: 'USER' | 'AGENT'; id } }`. Target: the full shape above.
- `currentActor()` — Baseline returns `{ type: 'USER' | 'AGENT', id }`. Target returns `ActionActor` (type widened to `ActionActorType`).
- `actorTypeFor(actorId)` — Baseline: the actor's type on an id match, else `'USER'`. Target: also answers the on-behalf-of type on an id match.
- `ActionContextInterceptor.intercept` — Baseline: no context for a runner or a public request. Target: the table in "HTTP requests".
- `AssistantToolExecutor.executeUnstored`, `.executeAction` — Baseline: `runWithActor` with the creator or requester. Target: "Assistant tools".
- `AssistantToolExecutor.executeFor` — Baseline: no context of its own; the MCP request's context comes from the interceptor. Target: "Assistant tools".
- `ScheduleTicker.dispatchFresh` — Baseline: `runWithActor(owner, …)`. Target: `runAsSystem('schedule', …, { onBehalfOf: owner })`.
- `FanOutPublisher.publish` — Baseline: `await handler(record.payload)`. Target: the same call inside `runAsSystem('outbox', …)`.
- `buildTicketEventOutboxPayload`, `buildAgentEventOutboxPayload` — Baseline: no `approval`. Target: `approval` from the current context.
- Each entry in the system-writer table — Baseline: the body runs with no context. Target: wrapped as listed.

## Out of Scope

- The context-less write guard (dev and test throw, production `SYSTEM/unknown`) and wrapping direct service calls in the integration suite are out of scope (feature `permissions-p2-context-guard`).
- The `AuditEntry` table, its storage and `GET /audit` are out of scope (feature `permissions-p2-audit-entry`).
- Domain columns keep their current values: `PendingAction.actorType`/`actorId` (a thread action's requester), `FleetJob.requestedByType`, `JobSchedule.createdByType`, `ChatThread.createdByType`, comment and message author types, and `FleetActivity` actors are out of scope (P3 replaces `PendingAction`; `AuditEntry` carries the context).
- Replacing `FleetActivity.responsibleUserId` with on-behalf-of is out of scope (feature `permissions-p2-audit-fleet`).
- Giving outbox handlers per-subscriber component ids is out of scope (designer's call: all run as `SYSTEM/outbox`).
- Wrapping the three RAG optimize strategies is out of scope (they write only to LanceDB).
- Wrapping the `@nathapp/nestjs-outbox` relay's own bookkeeping writes (`markPublished`, `markRetry`, `markDead`) is out of scope (feature `permissions-p2-context-guard` decides how the guard treats them).
- Setting the authenticated user as the actor of the public auth and invite routes (login, refresh, register, invite accept, runner enroll) is out of scope; they run as `SYSTEM/anonymous` here (feature `permissions-p2-audit-core`).
- Changing the fleet `SYSTEM_ACTOR` constant (`src/fleet/common/system-actor.ts`) or `TransitionActorRef` is out of scope; they name the system in fleet domain rows, not in the action context.
- The webhook replay-guard writes in `ci-webhook.controller.ts` (`WebhookReplayGuard.assertFresh`, `forget`) run as `SYSTEM/anonymous`, outside the intake services; giving them the `ci` id is out of scope (feature `permissions-p2-audit-integrations`).
- Approval policies, `ApprovalRequest` and the unified inbox are out of scope (P3).
- Regenerating `openapi.json` and `apps/cli/src/generated/` is out of scope; no contract changes.

## Stories

1. **US-001: The full action context** — `Workdir: apps/api` — No dependencies. The `ActionContext` model, `runWithActionContext`, `currentContext`, `runAsSystem`, `runAsSystemWriter`, the derived `SYSTEM_ACTOR_IDS`, and the kept `runWithActor`/`currentActor`/`actorTypeFor` with on-behalf-of.
2. **US-002: Every HTTP request runs in a context** — `Workdir: apps/api` — Depends on US-001. Runner and public requests get contexts; user and agent requests get the full shape.
3. **US-003: Assistant tool calls run as the assistant** — `Workdir: apps/api` — Depends on US-001. Thread calls and approved actions run as `SYSTEM/assistant` on behalf of the creator or requester; MCP calls mark origin `mcp`.
4. **US-004: Fleet system writers run as system components** — `Workdir: apps/api` — Depends on US-001. The ten fleet entries in the system-writer table, and the scheduled fire on behalf of the owner.
5. **US-005: Other system writers and boot seeders run as system components** — `Workdir: apps/api` — Depends on US-001. The eleven non-fleet entries in the system-writer table.
6. **US-006: Outbox fan-out runs as the outbox, and envelopes carry the approval** — `Workdir: apps/api` — Depends on US-001.

### Context Files

**US-001**
- `apps/api/src/action-context/action-context.ts`
- `apps/api/src/permissions/system-writer.decorator.ts`
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/common/enums.ts`

**US-002**
- `apps/api/src/action-context/action-context.interceptor.ts`
- `apps/api/src/auth/principal/koda-principal.types.ts`
- `apps/api/src/action-context/action-context.interceptor.spec.ts`

**US-003**
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts`
- `apps/api/src/fleet/assistant/assistant-tool.types.ts`
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts`
- `apps/api/src/fleet/assistant/assistant-tool.executor.agent-caller.spec.ts`

**US-004**
- `apps/api/src/fleet/schedules/schedule-ticker.ts`
- `apps/api/src/fleet/sync/fleet-sweeper.ts`
- `apps/api/src/fleet/budgets/budget-sweeper.ts`
- `apps/api/src/fleet/knowledge/knowledge-index.queue.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/fleet/assistant/actions/pending-action-expiry.sweeper.ts`
- `apps/api/src/fleet/approvals/approval-expiry-sweeper.ts`
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts`
- `apps/api/src/fleet/runners/enrollment-retention.processor.ts`
- `apps/api/src/fleet/logs/fleet-log-retention.processor.ts`

**US-005**
- `apps/api/src/vcs/vcs-webhook.service.ts`
- `apps/api/src/ci-webhook/ci-webhook.service.ts`
- `apps/api/src/permissions/system-role.seeder.ts`
- `apps/api/src/email/email-dispatcher.ts`
- `apps/api/src/vcs/vcs-polling.service.ts`
- `apps/api/src/outbox/outbox-retention.processor.ts`
- `apps/api/src/memory/memory-governance.processor.ts`
- `apps/api/src/notifications/fleet/fleet-health.detector.ts`
- `apps/api/src/notifications/notification-retention.processor.ts`
- `apps/api/src/fleet/threads/ingest/thread-ingest.bootstrap.ts`
- `apps/api/src/email/email-template.seeder.ts`

**US-006**
- `apps/api/src/outbox/fan-out-publisher.ts`
- `apps/api/src/events/outbox-envelope.util.ts`

### Creates

**US-001**
- None (the change is in `apps/api/src/action-context/action-context.ts`; its tests extend `apps/api/src/action-context/action-context.spec.ts`).

**US-002**
- None.

**US-003**
- None.

**US-004**
- None.

**US-005**
- None.

**US-006**
- `apps/api/src/events/outbox-envelope.util.spec.ts` — unit tests for the envelope `approval` block.

### Modifies

**US-001**
- `apps/api/src/action-context/action-context.spec.ts` — gains the cases for the full shape, `runAsSystem`, `runAsSystemWriter` and on-behalf-of in `actorTypeFor`; its existing `runWithActor`/`currentActor`/`actorTypeFor` cases, including the nested-run restore case, keep their expectations.

**US-002**
- `apps/api/src/action-context/action-context.interceptor.spec.ts` — the case asserting that a runner request runs with no context becomes "runs with actor `{ type: 'RUNNER', id: <the runner principal's id> }`, origin `runner`"; the case asserting that a request with no principal runs with no context becomes "runs with actor `{ type: 'SYSTEM', id: 'anonymous' }`, origin `rest`".

**US-003**
- `apps/api/src/fleet/assistant/assistant-tool.executor.agent-caller.spec.ts` — AC-11's two cases assert `currentActor()` equals the creator (`{ type: 'AGENT', id: 'a1' }`, `{ type: 'USER', id: 'u1' }`); they become: `currentActor()` is `{ type: 'SYSTEM', id: 'assistant' }` and `currentContext().onBehalfOf` is the creator.

**US-004**
- `apps/api/src/fleet/schedules/schedule-ticker.spec.ts` — the dispatch-actor case asserts `currentActor()` inside `dispatch` is the owner; it becomes: actor `{ type: 'SYSTEM', id: 'schedule' }` with `onBehalfOf` the owner. The case asserting no actor remains after `tick()` keeps its expectation (`tick` is not the wrapped entry).

**US-005**
None. Wrapping an entry body leaves every existing assertion on these classes unchanged.

**US-006**
- `apps/api/src/outbox/fan-out-publisher.spec.ts` — gains the case asserting each handler observes `{ type: 'SYSTEM', id: 'outbox' }`; its existing failure-collection cases keep their expectations.

### Seams

- US-002, US-003, US-004, US-005 and US-006 consume `runWithActionContext`, `currentContext`, `runAsSystem` and `runAsSystemWriter` from US-001. Each consumer's ACs trigger its own entry point (the interceptor, an executor method, an entry method, `publish`) with a stub collaborator that records `currentContext()`, and assert the recorded context.
- US-003 and US-004 rely on US-001's on-behalf-of rule in `actorTypeFor` (US-001 AC-13): domain services called inside the new contexts keep recording the creator's or owner's type, which the existing `thread-creator-type.integration.spec.ts` and `enforce-fleet-requesters.integration.spec.ts` cases pin.

## Acceptance Criteria

### US-001: The full action context

1. [unit] `runWithActionContext({ actor: { type: 'AGENT', id: 'a1' }, origin: 'rest' }, fn)` makes `currentContext().actor` inside `fn` equal `{ type: 'AGENT', id: 'a1' }`.
2. [unit] A context started by `runWithActionContext` without an `approval` field has `approval` equal to `NO_APPROVAL` (`{ requiredMode: 'none', satisfiedBy: 'none' }`).
3. [unit] Inside `runWithContext({ requestId: 'req-1' }, …)` from `@nathapp/nestjs-logging`, `runWithActionContext` without a `correlationId` gives the context `correlationId` `'req-1'`.
4. [unit] With no enclosing context and no logging request id, two `runWithActionContext` calls without a `correlationId` give two different `correlationId` strings.
5. [unit] `runAsSystem('outbox', fn)` called inside a context whose `correlationId` is `'c-1'` gives the inner context `correlationId` `'c-1'`.
6. [unit] `runAsSystem('schedule', fn)` makes `currentContext().actor` inside `fn` equal `{ type: 'SYSTEM', id: 'schedule' }`.
7. [unit] `runAsSystem('schedule', fn, { onBehalfOf: { type: 'AGENT', id: 'a1' } })` makes `currentContext().onBehalfOf` inside `fn` equal `{ type: 'AGENT', id: 'a1' }`.
8. [unit] `runAsSystem('no-such-component', fn)` throws `Error` with message `unknown system actor id: no-such-component`.
9. [unit] `SYSTEM_ACTOR_IDS` equals the set of second segments of every `PERMISSION_CATALOG` key whose access is `system`, together with `assistant`, `outbox`, `anonymous`, `seed` and `unknown`.
10. [unit] `runAsSystemWriter(instance, fn)` on an instance of a class decorated `@SystemWriter('system.budget.window-reset')` makes `currentContext()` inside `fn` return actor `{ type: 'SYSTEM', id: 'budget' }`.
11. [unit] `runAsSystemWriter(instance, fn)` on an instance of an undecorated class `Plain` throws `Error` with message `runAsSystemWriter needs a @SystemWriter class, got Plain`.
12. [unit] When `fn` passed to `runWithActionContext` rejects with error `E`, the returned promise rejects with the same `E`.
13. [unit] Inside `runAsSystem('assistant', fn, { onBehalfOf: { type: 'AGENT', id: 'a1' } })`, `actorTypeFor('a1')` returns `'AGENT'`.
14. [unit] Inside `runWithActor({ type: 'USER', id: 'u1' }, fn)`, `currentContext().origin` is `'rest'`.

### US-002: Every HTTP request runs in a context

1. [unit] `ActionContextInterceptor.intercept` for a request whose `user` is a user principal `u1` runs the handler with `currentContext()` actor `{ type: 'USER', id: 'u1' }`.
2. [unit] For a request whose `user` is a user principal, the handler's `currentContext().origin` is `'rest'`.
3. [unit] For a request whose `user` is an agent principal `a1`, the handler's `currentContext()` actor is `{ type: 'AGENT', id: 'a1' }`.
4. [unit] For a request whose `user` is a runner principal `r1`, the handler's `currentContext()` actor is `{ type: 'RUNNER', id: 'r1' }`.
5. [unit] For a request whose `user` is a runner principal, the handler's `currentContext().origin` is `'runner'`.
6. [unit] For a request with no `user`, the handler's `currentContext()` actor is `{ type: 'SYSTEM', id: 'anonymous' }`.
7. [unit] For a request with no `user`, the handler's `currentContext().origin` is `'rest'`.
8. [unit] For any request the handler's `currentContext().approval` equals `NO_APPROVAL`.
9. [unit] When `intercept` runs inside `runWithContext({ requestId: 'req-9' }, …)` from `@nathapp/nestjs-logging`, the handler's `currentContext().correlationId` is `'req-9'`.
10. [integration] `POST /api/projects/:slug/tickets` called with an agent API key runs `TicketsService.create` with `currentContext()` actor `{ type: 'AGENT', id: <that agent's id> }` (a spy on `TicketsService.create` records `currentContext()`).
11. [integration] `POST /api/auth/login` (a public route) runs `AuthService.login` with `currentContext()` actor `{ type: 'SYSTEM', id: 'anonymous' }` (a spy on `AuthService.login` records `currentContext()`).

### US-003: Assistant tool calls run as the assistant

1. [unit] `AssistantToolExecutor.execute` for a thread call of a read tool whose job's creator is user `u1`, with membership defined and the tool's key allowed (the `assistant-tool.executor.agent-caller.spec.ts` harness), runs the tool with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'assistant' }`.
2. [unit] For that call, the tool observes `currentContext().onBehalfOf` equal `{ type: 'USER', id: 'u1' }`.
3. [unit] For that call, the tool observes `currentContext().origin` equal `'thread'`.
4. [unit] For a thread tool call whose job's creator is agent `a1`, the tool observes `currentContext().onBehalfOf` equal `{ type: 'AGENT', id: 'a1' }`.
5. [unit] `AssistantToolExecutor.executeAction` for a `PendingActionRecord` with `id` `pa1`, `actorType` `'user'`, `actorId` `u1`, `approvalMode` `'human'`, `approverType` `'user'`, `approverId` `u2`, with `findUserActor` returning enabled user `u1`, membership defined and the tool's key allowed (the `assistant-tool.executor.actor.spec.ts` harness), runs the tool with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'assistant' }`.
6. [unit] For that action, the tool observes `currentContext().onBehalfOf` equal `{ type: 'USER', id: 'u1' }`.
7. [unit] For that action, the tool observes `currentContext().approval` equal `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' }`.
8. [unit] For an action with `approverType` `'agent'` and `approverId` `a9`, the tool observes `approval.satisfiedBy` `'agent'` and `approval.approverType` `'AGENT'`.
9. [unit] For an action with `approvalMode` `'none'` and `approverType` `null`, the tool observes `approval` equal `{ requiredMode: 'none', satisfiedBy: 'none', requestId: <the action id> }`.
10. [unit] `AssistantToolExecutor.executeFor` with a caller whose `origin.kind` is `'mcp'` and whose principal is agent `a1`, called inside a `SYSTEM/anonymous` context, runs the tool with `currentContext().origin` `'mcp'`.
11. [unit] For that MCP call, the tool observes `currentContext().actor` equal `{ type: 'AGENT', id: 'a1' }`.
12. [unit] `AssistantToolExecutor.executeFor` with an MCP caller whose principal is user `u1`, called with no context current, runs the tool with `currentContext().actor` equal `{ type: 'USER', id: 'u1' }`.

### US-004: Fleet system writers run as system components

Each interval case builds the class with `sweepEnabled: true` (or the class's own enable flag) and fake timers, calls `onModuleInit`, and advances the clock past one interval; the named collaborator is a stub that records `currentContext()`.

1. [unit] With `sweepEnabled: true` and one due schedule, the `ScheduleTicker` interval callback calls the schedule repository's `findDue` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'schedule' }`.
2. [unit] `ScheduleTicker.tick` for a due schedule created by agent `a1`, whose owner holds `fleet.job.dispatch` and whose `claimFire` succeeds with no active job, calls `FleetJobsService.dispatch` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'schedule' }`.
3. [unit] In that dispatch, `currentContext().onBehalfOf` equals `{ type: 'AGENT', id: 'a1' }`.
4. [unit] With `sweepEnabled: true`, the `PendingActionExpirySweeper` interval callback calls the pending-action repository's `findDue` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'assistant-action' }`.
5. [unit] With `sweepEnabled: true`, the `ApprovalExpirySweeper` interval callback calls the approval repository's `findExpiredPending` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'approval' }`.
6. [unit] `BundleIngestService.kick()` called inside a context with actor `{ type: 'RUNNER', id: 'r1' }`, then awaited through `idle()`, calls the ingest repository's `claimNext` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'ingest' }`.
7. [unit] With `sweepEnabled: true` and one link with `prState` `'open'` on a GitHub repo with an installation id, whose `getPullRequest` resolves `null`, the `FleetPrStateRefresher` interval callback calls `vcsRepo.updateTicketLinkWithPrState(link.id, 'closed')` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'ticket-link' }`.
8. [unit] With `sweepEnabled: true`, the `BudgetSweeper` interval callback calls the budget repository's `findAll` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'budget' }`.
9. [unit] With an enrollment retention day count above 0, `EnrollmentRetentionProcessor.scheduledPurge` calls `deleteSpentEnrollmentsBefore` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'enrollment' }`.
10. [unit] With `sweepEnabled: true`, the `FleetSweeper` interval callback calls the job repository's `findSilentHeldIds` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'job' }`.
11. [unit] With a log retention day count above 0, `FleetLogRetentionProcessor.scheduledPurge` calls its retention repository's `findCandidates` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'log' }`.
12. [unit] With `knowledgeIndexEnabled: true`, `KnowledgeIndexQueue.onRepoMerged` called with no context runs `KnowledgeRepoIndexer.indexRepo` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'knowledge' }`.
13. [unit] With `knowledgeIndexEnabled: true`, `KnowledgeIndexQueue.enqueue` called inside a context with actor `{ type: 'USER', id: 'u1' }` runs `KnowledgeRepoIndexer.indexRepo` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'knowledge' }`.

### US-005: Other system writers and boot seeders run as system components

1. [unit] With an outbox retention day count above 0, `OutboxRetentionProcessor.scheduledPurge` calls `deleteTerminalBefore` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'outbox' }`.
2. [unit] With `findAllProjectIds` returning one project id, `MemoryGovernanceProcessor.scheduledCleanup` calls `MemoryGovernanceService.runCleanup` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'memory' }`.
3. [unit] With polling scheduled for one connection and fake timers, the `VcsPollingService` interval callback calls `vcsRepo.findVcsConnectionById` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'vcs' }`.
4. [unit] `VcsWebhookService.handleWebhook` for a `pull_request` event with action `opened` that matches a ticket link, called inside a `SYSTEM/anonymous` context, calls `vcsRepo.updateTicketLinkWithPrState` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'vcs' }`.
5. [unit] `CiWebhookService.processCiWebhook` for a `pipeline_failed` payload with one failure, called inside a `SYSTEM/anonymous` context, calls the CI webhook repository's `createTicket` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'ci' }`.
6. [integration] `POST /api/projects/:slug/ci-webhook` with a valid signature and a `pipeline_failed` payload with one failure creates its ticket while `currentContext().actor` is `{ type: 'SYSTEM', id: 'ci' }` (a spy on the CI webhook repository's `createTicket` records `currentContext()`).
7. [unit] With `sweepEnabled: true` and fake timers, the `FleetHealthDetector` interval callback calls its repository's `findRunners` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'health' }`.
8. [unit] `EmailDispatcher.runScheduledTick` calls the email schedule's `claimDue` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'email' }`.
9. [unit] With a notification retention day count above 0, `NotificationRetentionProcessor.scheduledPurge` calls `purgeRead` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'notification' }`.
10. [unit] With `findUnfolded` returning one stream, `ThreadIngestBootstrap.onApplicationBootstrap` calls `ThreadIngestor.catchUp` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'thread' }`.
11. [unit] With the role repository's `findOne` returning null for a seed, `SystemRoleSeeder.onApplicationBootstrap` calls `createRole` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'seed' }`.
12. [unit] With `findTemplate` returning null for a template, `EmailTemplateSeeder.onApplicationBootstrap` calls the template service's `create` with `currentContext().actor` equal `{ type: 'SYSTEM', id: 'seed' }`.

### US-006: Outbox fan-out runs as the outbox, and envelopes carry the approval

1. [unit] `FanOutPublisher.publish` invokes a registered handler with `currentContext()` actor `{ type: 'SYSTEM', id: 'outbox' }`.
2. [unit] `FanOutPublisher.publish` invokes a registered handler with `currentContext().origin` `'system'`.
3. [unit] `buildTicketEventOutboxPayload` called inside a context whose approval is `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' }` returns an envelope whose `approval` equals that object.
4. [unit] `buildTicketEventOutboxPayload` called inside a context with `NO_APPROVAL` returns an envelope whose `approval` equals `{ requiredMode: 'none', satisfiedBy: 'none' }`.
5. [unit] `buildTicketEventOutboxPayload` called outside any context returns an envelope with no `approval` key.
6. [unit] `buildAgentEventOutboxPayload` called inside a context with `NO_APPROVAL` returns an envelope whose `approval` equals `{ requiredMode: 'none', satisfiedBy: 'none' }`.
7. [unit] `buildAgentEventOutboxPayload` called outside any context returns an envelope with no `approval` key.
8. [integration] `POST /api/projects/:slug/tickets` by a user enqueues a `ticket_event` outbox row whose payload `approval` is `{ requiredMode: 'none', satisfiedBy: 'none' }`.
