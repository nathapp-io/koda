<!-- spec-writing: completed-through-phase-6 -->
# SPEC: Webhook Outbox Unification

## Summary

Route outbound webhook delivery through the existing outbox pipeline (`apps/api/src/outbox/`) instead of the current fire-and-forget `fetch()` call, so that failed deliveries are retried with exponential backoff and eventually dead-lettered instead of silently dropped.

## Motivation

`WebhookDispatcherService.dispatch()` (`apps/api/src/webhook/webhook-dispatcher.service.ts`) looks up matching active webhooks and calls `fetch()` directly, catching failures with a `.catch()` that only logs a warning. There is no persistence of the delivery attempt, no retry, and no record of failure (gap-analysis defect #3, `docs/20260706-gap-analysis-missing-features.md`). The outbox module already has claim-based concurrency, exponential backoff (`nextAttemptAt`, shipped under defect #4), and dead-letter handling — but webhook delivery doesn't use it, so a webhook receiver that is briefly down loses events permanently.

## Out of Scope

- Delivery idempotency/dedup tracking on the receiver side.
- Changes to webhook CRUD (`WebhookService`, `WebhookController`) or the `Webhook` Prisma model.
- Admin UI changes — existing outbox admin/dead-letter endpoints already expose dead-lettered events.
- The GitLab VCS provider stub (gap-analysis defect #2) — unrelated, tracked separately.
- `openapi.json` / CLI client regeneration — this spec adds no controller routes and changes no DTO shapes, so there is no public API contract change to regenerate.

## Design

### Design Decisions

1. **Delivery re-fetches live webhook config by id**, rather than snapshotting `url`/`secret` into the outbox payload. The handler looks up the `Webhook` row at delivery time. This avoids duplicating the secret into the outbox `payload` column, and correctly no-ops if the webhook was deleted/deactivated/rotated between enqueue and a later retry (retries can be up to ~16s+ later).
2. **One outbox event per matching webhook**, not one event per ticket action fanning out to N webhooks. Each webhook gets its own row, attempt count, and backoff/dead-letter lifecycle, so one flaky endpoint's retries don't block or re-trigger delivery to webhooks that already succeeded.
3. **Constructor-based optional injection**, following the existing convention in `OutboxFanOutRegistry` (`codeCommitHandler`, `astIndexService`, `entityGraphService` are all `@Optional()` constructor params registered internally in the constructor) rather than an external imperative `.register()` call from another module.
4. **Enqueue independent per-webhook outbox writes concurrently** (`Promise.all`), not with sequential `await`s in a loop — per this repo's async-pattern convention (`.nax/rules/api-core.md`: "Use `Promise.all([...])` for independent async calls"). The enqueue calls have no data dependency on one another.
5. **Unit tests for `WebhookDeliveryHandler` and `WebhookDispatcherService` use direct instantiation** (`new WebhookDeliveryHandler(mockRepo)`, `new WebhookDispatcherService(mockRepo, mockOutboxService)`), not `Test.createTestingModule`. Neither class has a Nest lifecycle hook (no `OnModuleInit`, no decorator metadata under test), matching this repo's testing convention (`.nax/rules/api-testing.md`) and the existing style already used in `outbox-fan-out-registry.spec.ts`. `Test.createTestingModule` is reserved for the module-wiring smoke tests (US-002's `webhook.module.spec.ts`, US-003's `outbox.module.spec.ts`), whose entire purpose is verifying DI resolution.

### Integration

Verified existing symbols this spec builds on:

- `WebhookDispatcherService.dispatch(projectId: string, event: string, payload: object): Promise<void>` (`apps/api/src/webhook/webhook-dispatcher.service.ts:11`) — the sole call site is `TicketTransitionsService.dispatchStatusChangeWebhook()` (`apps/api/src/tickets/state-machine/ticket-transitions.service.ts:75-95`), which calls it fire-and-forget with a `.catch()` that logs a warning. This call site is unchanged by this spec.
- `PrismaWebhookRepository.findActiveByProject(projectId: string): Promise<WebhookDomain[]>` and `findById(id: string): Promise<WebhookDomain | null>` (`apps/api/src/webhook/prisma-webhook.repository.ts:78-88`).
- `OutboxService.enqueue(event: OutboxEventInput): Promise<OutboxEventData>` (`apps/api/src/outbox/outbox.service.ts:22-24`), where `OutboxEventInput = { projectId: string; eventType: string; eventId: string; payload: unknown }` (`apps/api/src/outbox/domain/outbox-event.domain.ts:16-21`).
- `OutboxFanOutRegistry` (`apps/api/src/outbox/outbox-fan-out-registry.ts`) — constructor currently takes five `@Optional()` params (`extractionService`, `memoryRepository`, `astIndexService`, `codeCommitHandler`, `entityGraphService`); `register(eventType: string, handler: (payload: unknown) => void | Promise<void>): void` and `dispatch(input: { eventType: string; payload: unknown }): Promise<void>` are the public methods this spec relies on. `dispatch()` already catches per-handler errors and tracks `lastDispatchFailureCount`, which `OutboxService.processEvent` (`apps/api/src/outbox/outbox.service.ts:64-76`) already uses to decide whether to throw (triggering retry/backoff via `markFailed`).
- `OutboxProcessor` (`apps/api/src/outbox/outbox-processor.ts`) already runs `OutboxService.processPending()` on a 5-second cron — no changes needed here.
- `WebhookModule` (`apps/api/src/webhook/webhook.module.ts`) currently imports only `PrismaModule` and exports `WebhookService`, `WebhookDispatcherService`.
- `OutboxModule` (`apps/api/src/outbox/outbox.module.ts`) currently imports `PrismaModule`, `ScheduleModule`, `forwardRef(() => MemoryModule)`, `EntityGraphModule`, `forwardRef(() => CodeIntelModule)`, and exports `OutboxService`, `OutboxFanOutRegistry`. Nothing in this import graph currently imports `WebhookModule`, so introducing `forwardRef(() => WebhookModule)` here does not create any cycle beyond the direct one being introduced by this spec.

New symbol introduced:

- `WebhookDeliveryHandler.handle(payload: { webhookId: string; event: string; payload: unknown }): Promise<void>` (`apps/api/src/webhook/webhook-delivery.handler.ts`, new file).

### Failure Handling

| Condition | Behavior |
|---|---|
| Webhook deleted or `active: false` by delivery time | `handle()` resolves without throwing (no-op) — not counted as a failed attempt, since retrying can't help |
| Non-2xx HTTP response | `handle()` throws an `Error` including the status code; counted as a failed attempt, retried with existing exponential backoff (`OUTBOX_BACKOFF_MS`: 1s/4s/16s) |
| Network error or timeout (5s `AbortSignal`) | `handle()` rejects/propagates the error; counted as a failed attempt, retried with backoff |
| 3 failed attempts | Existing `OutboxService.markFailed` logic moves the event to `dead_letter`; visible via existing outbox admin endpoints — no new UI |
| `OutboxService.enqueue` itself rejects when `WebhookDispatcherService.dispatch()` tries to enqueue | `dispatch()` propagates the rejection (does not swallow it internally); the existing caller (`TicketTransitionsService.dispatchStatusChangeWebhook`) already wraps the call in `.catch()` and logs a warning, so the failure is still surfaced, just one level up — consistent with "never swallow errors" |

## Stories

- **US-001: Webhook delivery handler** — no dependencies
- **US-002: Wire `WebhookModule`** — depends on US-001
- **US-003: Wire `OutboxModule` / `OutboxFanOutRegistry`** — depends on US-002
- **US-004: `WebhookDispatcherService` enqueues instead of fetching** — depends on US-002

All stories: `Workdir: apps/api` (this is a Bun/Turborepo workspace monorepo; this spec touches only the `apps/api` package).

### US-001: Webhook delivery handler

Create the handler that owns the actual signed HTTP delivery, looked up fresh by webhook id at delivery time.

- **Workdir:** `apps/api`
- **Context Files:** `apps/api/src/webhook/prisma-webhook.repository.ts`, `apps/api/src/webhook/domain/webhook.domain.ts`, `apps/api/src/webhook/webhook-dispatcher.service.ts`
- **Creates:** `apps/api/src/webhook/webhook-delivery.handler.ts`, `apps/api/src/webhook/webhook-delivery.handler.spec.ts`
- **Depends on:** none

### US-002: Wire `WebhookModule`

`WebhookModule` provides and exports `WebhookDeliveryHandler`, and imports `OutboxModule` so `WebhookDispatcherService` (US-004) can later inject `OutboxService`.

- **Workdir:** `apps/api`
- **Context Files:** `apps/api/src/webhook/webhook.module.ts`, `apps/api/src/webhook/webhook-delivery.handler.ts` (created by US-001)
- **Creates:** `apps/api/src/webhook/webhook.module.spec.ts`
- **Depends on:** US-001

### US-003: Wire `OutboxModule` / `OutboxFanOutRegistry`

`OutboxModule` imports `forwardRef(() => WebhookModule)`; `OutboxFanOutRegistry` gains an optional `webhookDeliveryHandler` constructor param and registers it for the `webhook_delivery` event type, following the same pattern already used for `codeCommitHandler`.

- **Workdir:** `apps/api`
- **Context Files:** `apps/api/src/outbox/outbox.module.ts`, `apps/api/src/outbox/outbox-fan-out-registry.ts`, `apps/api/src/outbox/outbox-fan-out-registry.spec.ts`, `apps/api/src/webhook/webhook-delivery.handler.ts` (created by US-001, integrated here — this is the Seam)
- **Creates:** `apps/api/src/outbox/outbox.module.spec.ts`
- **Depends on:** US-002

### US-004: `WebhookDispatcherService` enqueues instead of fetching

`dispatch()` keeps its existing "find active webhooks matching event" filter but now enqueues one outbox event per matching webhook via `OutboxService.enqueue` (issued concurrently via `Promise.all`), instead of calling `fetch()` directly. The `sign()` method and direct `fetch` call are removed from this file (that logic now lives solely in `WebhookDeliveryHandler`, US-001).

> This story both adds (enqueue path) and removes (direct fetch/sign) code in the same method. It is **not** split into a separate terminal-cleanup story: the removal has no independent value on its own (an incomplete removal would silently stop delivering webhooks with no replacement), it is a single-method behavioral rewrite rather than a bulk/cross-file consolidation, and no AC encodes the removal as a static "file does not contain X" claim — AC18 asserts the new runtime behavior (fetch is not invoked by `dispatch()` after the rewrite), which is agent-implementable, unlike a source-text absence check.

- **Workdir:** `apps/api`
- **Context Files:** `apps/api/src/webhook/webhook-dispatcher.service.ts`, `apps/api/src/webhook/webhook-dispatcher.service.spec.ts`, `apps/api/src/webhook/prisma-webhook.repository.ts`
- **Creates:** none
- **Depends on:** US-002
- **Verification note:** the removal of the unused `crypto` import and the `sign()`/`fetch` call from this file is verified by the existing `bun run --cwd apps/api lint` and `bun run --cwd apps/api type-check` gates (an unused import fails lint), not by a separate acceptance criterion.

### Seams

- **Seam: `WebhookDeliveryHandler` (introduced in US-001, exported via US-002) is consumed by `OutboxFanOutRegistry` in US-003.** US-003's AC14 stubs `handle` and asserts `OutboxFanOutRegistry.dispatch({ eventType: 'webhook_delivery', ... })` invokes it with the expected payload — proving the handler is registered and wired, not just present.

## Acceptance Criteria

### US-001: Webhook delivery handler

- **AC1** `[unit]` Given `PrismaWebhookRepository.findById(webhookId)` resolves `{ id: 'w1', url: 'https://example.com/hook', secret: 's3cret', active: true }`, calling `WebhookDeliveryHandler.handle({ webhookId: 'w1', event: 'STATUS_CHANGE', payload: { a: 1 } })` calls the global `fetch` exactly once with `'https://example.com/hook'` as the first argument.
- **AC2** `[unit]` The `fetch` call's second argument (`RequestInit`) has `method: 'POST'` and a `headers['X-Koda-Event']` equal to `'STATUS_CHANGE'`.
- **AC3** `[unit]` The `fetch` call's second argument has `headers['X-Koda-Signature']` equal to `` `sha256=${hex}` `` where `hex` is the HMAC-SHA256 hex digest of `JSON.stringify({ a: 1 })` keyed by `'s3cret'` (computed independently in the test via Node's `crypto` module for comparison).
- **AC4** `[unit]` The `fetch` call's second argument has `signal` that is an instance of `AbortSignal`.
- **AC5** `[unit]` When `fetch` resolves with `{ ok: true }`, `handle()` resolves without throwing.
- **AC6** `[unit]` When `fetch` resolves with `{ ok: false, status: 503 }`, `handle()` rejects with an `Error` whose `message` includes `'503'`.
- **AC7** `[unit]` When `fetch` rejects with `new Error('network down')`, `handle()` rejects with that same error.
- **AC8** `[unit]` When `findById(webhookId)` resolves `null`, `handle()` resolves without throwing, and `fetch` is not called.
- **AC9** `[unit]` When `findById(webhookId)` resolves `{ id: 'w1', active: false, ... }`, `handle()` resolves without throwing, and `fetch` is not called.

### US-002: Wire `WebhookModule`

- **AC10** `[unit]` Constructing a Nest testing module with `WebhookDeliveryHandler` as a provider and a mocked `PrismaWebhookRepository` provider (`useValue`) compiles successfully, and `module.get(WebhookDeliveryHandler)` returns a defined instance.

### US-003: Wire `OutboxModule` / `OutboxFanOutRegistry`

- **AC11** `[unit]` Constructing `OutboxFanOutRegistry` directly (no DI container) passing a mock object `{ handle: jest.fn() }` as the `webhookDeliveryHandler` constructor argument, then calling `dispatch({ eventType: 'webhook_delivery', payload: { webhookId: 'w1', event: 'STATUS_CHANGE', payload: {} } })`, results in the mock's `handle` being called exactly once with `{ webhookId: 'w1', event: 'STATUS_CHANGE', payload: {} }`. *(Seam AC — proves `WebhookDeliveryHandler` is wired, not just present.)*
- **AC12** `[unit]` After construction with a defined `webhookDeliveryHandler`, `getHandlers('webhook_delivery')` returns an array of length 1.
- **AC13** `[unit]` Constructing `OutboxFanOutRegistry` with `webhookDeliveryHandler` left `undefined` results in `getHandlers('webhook_delivery')` returning an empty array.
- **AC14** `[unit]` Constructing a Nest testing module with `OutboxFanOutRegistry` as the sole provider (no other constructor args supplied) compiles successfully, and `module.get(OutboxFanOutRegistry)` returns a defined instance.

### US-004: `WebhookDispatcherService` enqueues instead of fetching

- **AC15** `[unit]` Given `findActiveByProject(projectId)` resolves one webhook `{ id: 'w1', events: JSON.stringify(['STATUS_CHANGE']), active: true }`, calling `dispatch(projectId, 'STATUS_CHANGE', payload)` calls `OutboxService.enqueue` exactly once with an argument deep-equal to `{ projectId, eventType: 'webhook_delivery', eventId: expect.any(String), payload: { webhookId: 'w1', event: 'STATUS_CHANGE', payload } }`.
- **AC16** `[unit]` Given two active webhooks (`w1`, `w2`) both matching the dispatched event, `dispatch()` calls `OutboxService.enqueue` exactly twice, once per webhook id, issued via `Promise.all` (both calls happen before either enqueue's mocked promise resolves — i.e. the second call is not gated on the first's resolution).
- **AC17** `[unit]` Given a webhook whose `events` array does not include the dispatched event, `dispatch()` does not call `OutboxService.enqueue` for that webhook.
- **AC18** `[unit]` Calling `dispatch()` never calls the global `fetch` function (delivery now happens exclusively through the outbox pipeline, not inline).
- **AC19** `[unit]` When `OutboxService.enqueue` rejects for a matching webhook, the promise returned by `dispatch()` rejects (the failure is not swallowed inside `dispatch()`).
