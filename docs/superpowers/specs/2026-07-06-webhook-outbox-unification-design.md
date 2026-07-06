# Webhook → Outbox Unification — Design

**Date:** 2026-07-06
**Source:** Defect #3 in `docs/20260706-gap-analysis-missing-features.md` — outbound webhooks are fire-and-forget (no persistence, retry, or dead-letter record).

## Problem

`WebhookDispatcherService.dispatch()` (`apps/api/src/webhook/webhook-dispatcher.service.ts`) looks up matching active webhooks and calls `fetch()` directly, swallowing failures with a `.catch()` that only logs a warning. There is no persistence of the delivery attempt, no retry, and no record of failure. Meanwhile the outbox module (`apps/api/src/outbox/`) already has claim-based concurrency, exponential backoff (`nextAttemptAt`, fixed under defect #4), and dead-letter handling — but webhooks don't use it.

## Goals

- Route outbound webhook delivery through the existing outbox pipeline so failed deliveries are retried with backoff and eventually dead-lettered instead of silently dropped.
- Reuse existing outbox infrastructure (`OutboxService`, `OutboxFanOutRegistry`, `OutboxProcessor`) rather than building a parallel retry mechanism.
- Preserve today's caller contract: `TicketTransitionsService` still calls `webhookDispatcher.dispatch(projectId, event, payload)` fire-and-forget with a `.catch()` for logging only.

## Non-goals

- No delivery idempotency/dedup tracking (out of scope; not required for this defect).
- No changes to webhook CRUD (`WebhookService`, `WebhookController`) or to the `Webhook` Prisma model.
- No admin UI changes; existing outbox admin/DLQ endpoints already expose dead-lettered events.

## Design decisions

1. **Delivery re-fetches live webhook config by id, rather than snapshotting url/secret into the outbox payload.** The handler looks up the `Webhook` row at delivery time. This avoids duplicating the secret into the outbox `payload` column, and correctly no-ops if the webhook was deleted/deactivated/rotated between enqueue and a later retry (retries can be up to ~16s+ later).
2. **One outbox event per matching webhook, not one event per ticket action fanning out to N webhooks.** Each webhook gets its own row, attempt count, and backoff/DLQ lifecycle. A single flaky endpoint's retries don't block or re-trigger delivery to webhooks that already succeeded (there's no idempotency tracking, so bundling would risk re-delivering to healthy endpoints on a partial failure).

## Architecture

### New: `WebhookDeliveryHandler`

`apps/api/src/webhook/webhook-delivery.handler.ts` — owns the actual HTTP delivery logic (moved out of `WebhookDispatcherService`).

```typescript
handle(payload: { webhookId: string; event: string; payload: unknown }): Promise<void>
```

Behavior:
- Look up the webhook via `PrismaWebhookRepository.findById(webhookId)`.
- If not found or `!active`: log at debug level and return (no-op — retrying a deleted/deactivated webhook can't help).
- Otherwise: sign the JSON body with the *current* `webhook.secret` (HMAC-SHA256, same as today), POST to `webhook.url` with the existing headers (`X-Koda-Signature`, `X-Koda-Event`) and 5s timeout.
- If the response is non-2xx, throw an `Error` including the status code.
- If `fetch` throws (network error, timeout abort), let it propagate.

### `OutboxFanOutRegistry` wiring

Follows the existing pattern used for `codeCommitHandler`/`astIndexService` (constructor-based optional injection + internal registration — not an external imperative `.register()` call):

- Add `@Optional() webhookDeliveryHandler?: WebhookDeliveryHandler` to the constructor.
- If present, `this.register('webhook_delivery', this.handleWebhookDelivery.bind(this))`, where `handleWebhookDelivery` delegates to `webhookDeliveryHandler.handle(payload)`.
- Update the `onModuleInit` handler-count log to include this handler.

### `WebhookDispatcherService` changes

- Constructor gains `OutboxService` (already exported from `OutboxModule`).
- `dispatch(projectId, event, payload)`: keeps the existing "find active webhooks matching event" filter, but for each matching webhook calls:
  ```typescript
  this.outboxService.enqueue({
    projectId,
    eventType: 'webhook_delivery',
    eventId: crypto.randomUUID(),
    payload: { webhookId: webhook.id, event, payload },
  })
  ```
  issued in parallel via `Promise.all`.
- Remove the `sign()` method and the direct `fetch` call — that logic now lives solely in `WebhookDeliveryHandler`.
- `crypto` import is removed from this file (no longer needed here).

### Module wiring

- `WebhookModule` exports `WebhookDeliveryHandler` (new provider) in addition to its existing exports.
- `OutboxModule` imports `forwardRef(() => WebhookModule)` and provides `WebhookDeliveryHandler` as an optional constructor dependency to `OutboxFanOutRegistry`. This mirrors the existing `forwardRef` cycles already documented in `outbox.module.ts` (e.g. `OutboxModule -> CodeIntelModule -> RagModule -> OutboxModule`); confirmed no new cycle exists today since nothing in `OutboxModule`'s current import graph (`MemoryModule`, `EntityGraphModule`, `CodeIntelModule`) imports `WebhookModule`.
- `WebhookModule` gains `OutboxModule` as an import so `WebhookDispatcherService` can inject `OutboxService`.

## Data flow

1. `TicketTransitionsService.dispatchStatusChangeWebhook()` calls `webhookDispatcher.dispatch(projectId, 'STATUS_CHANGE', payload)`, unchanged at the call site.
2. `WebhookDispatcherService` enqueues one outbox row per matching active webhook (fast DB insert; the caller still doesn't await meaningful work, preserving the current fire-and-forget shape).
3. `OutboxProcessor`'s existing 5-second cron claims pending rows and calls `OutboxService.processEvent`, which calls `OutboxFanOutRegistry.dispatch({ eventType: 'webhook_delivery', payload })`.
4. `WebhookDeliveryHandler.handle()` performs the signed POST.
5. On success: `OutboxService.markCompleted`. On failure (thrown error): `OutboxService.markFailed`, which applies the existing exponential backoff (`OUTBOX_BACKOFF_MS`: 1s/4s/16s) and moves the event to `dead_letter` after 3 attempts. Dead-lettered webhook deliveries are visible through the existing outbox admin/DLQ endpoints — no new UI needed.

## Error handling

| Condition | Behavior |
|---|---|
| Webhook deleted/deactivated by delivery time | No-op, treated as success (not retried) |
| Non-2xx HTTP response | Thrown error, counted as a failed attempt, retried with backoff |
| Network error / timeout | Thrown error, counted as a failed attempt, retried with backoff |
| 3 failed attempts | Moved to `dead_letter`, visible in outbox admin endpoints |

## Testing

- Rewrite `webhook-dispatcher.service.spec.ts`: assert it enqueues one outbox event per matching *active* webhook (via a mocked `OutboxService.enqueue`), skips inactive/non-matching webhooks, and no longer performs any `fetch` call directly.
- New `webhook-delivery.handler.spec.ts`: mocks `PrismaWebhookRepository` and global `fetch`.
  - Signs and POSTs correctly on the happy path.
  - Throws on a non-2xx response.
  - Throws/propagates on a network error.
  - No-ops (does not throw, does not fetch) when the webhook is missing or `active: false`.
- Extend `outbox-fan-out-registry.spec.ts` to cover the new optional `webhookDeliveryHandler` wiring and the handler-count log.
- No new e2e test: there is no existing e2e coverage of real webhook HTTP delivery to extend (the e2e suite doesn't stand up an external HTTP receiver), so this stays at the unit level, consistent with how the rest of the outbox module is tested.

## Files touched

| Action | File |
|---|---|
| Create | `apps/api/src/webhook/webhook-delivery.handler.ts` |
| Create | `apps/api/src/webhook/webhook-delivery.handler.spec.ts` |
| Modify | `apps/api/src/webhook/webhook-dispatcher.service.ts` |
| Modify | `apps/api/src/webhook/webhook-dispatcher.service.spec.ts` |
| Modify | `apps/api/src/webhook/webhook.module.ts` |
| Modify | `apps/api/src/outbox/outbox-fan-out-registry.ts` |
| Modify | `apps/api/src/outbox/outbox-fan-out-registry.spec.ts` |
| Modify | `apps/api/src/outbox/outbox.module.ts` |
