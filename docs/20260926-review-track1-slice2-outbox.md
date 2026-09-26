# Deep Code Review: Track 1 Slice 2 — Outbox on `@nathapp/nestjs-outbox`

**Date:** 2026-09-26
**Reviewer:** Subrina (AI)
**Branch:** `feat/track1-outbox` (merge-base `main` @ `202121e9`)
**Plan:** `docs/superpowers/plans/2026-09-26-track-1-slice-2-outbox.md`
**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` § "Slice 2 — Outbox"
**Scope:** 78 files changed (`apps/api`, `apps/cli`, `openapi.json`, docs); `apps/web` untouched.
**Stack:** NestJS 11 + Fastify + Prisma 6/Postgres 16, `@nathapp/nestjs-outbox@^3.3.0`, Jest.

---

## Overall Grade: A- (88/100)

This is a careful, well-verified refactor. The hand-rolled cron processor is fully replaced by
`@nathapp/nestjs-outbox`, every producer that has a business write now records its outbox row
**inside the same transaction**, and the one known idempotency gap (memory replay) is closed. The
migration is hand-written, preserves data, and is drift-checked against the schema. All five
review-focus items from the plan are pinned by tests. I could not find a CRITICAL or HIGH defect.

The remaining items are operational/perf and polish: no index supports the lease-reclaim branch of
`claimBatch`, published/dead rows have no retention, and a few small observability/consistency
nits. One MEDIUM and several LOW.

**Verified locally (evidence, not assertion):**

| Check | Result |
|:--|:--|
| `bun run type-check` (api) | clean |
| `bun run lint` (api, `--max-warnings=0`) | clean |
| `bun run test` (api unit, DB stopped) | **152 suites / 1930 tests pass** |
| `bun run test:integration` (api, DB up) | **89 suites / 1566 tests pass**, 1 skipped |
| `test/integration/outbox` | 4 suites / 31 tests pass |
| `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` | **No difference detected** |
| CLI `type-check` + `test` | clean, 503 tests pass |
| Stale vocabulary grep (`dead_letter`, `OutboxFanOutRegistry`, `processPending`, `.enqueue(`) | only in the migration test's legacy-row fixture |

---

## Fixes applied (review follow-up, 2026-09-26)

| ID | Status | Change |
|:--|:--|:--|
| PERF-1 | **Partial** | Added `@@index([status, leaseUntil])` (schema + the slice-2 migration) so `claimBatch`'s expired-lease reclaim branch is index-served instead of scanned. Terminal-row retention is left as an explicit follow-up (below). |
| ENH-1 | **Fixed** | `FanOutPublisher` now logs the handler count in `onApplicationBootstrap` (after every consumer's `onModuleInit` registers), not `onModuleInit`. |
| BUG-1 | **Fixed** | `GET /admin/outbox` returns a real `total` via `PrismaOutboxRepository.countByStatus`; the response shape (`{ items, total }`) is unchanged, so no contract regen was needed. |
| ENH-2 | **Fixed** | `OUTBOX_RELAY_ENABLED` is now case-insensitive in both the class-validator schema (`@Matches(/^(true\|false)$/i)`) and the factory (`.toLowerCase() === 'true'`), matching the Joi rule. |
| ENH-3 | **Fixed** | Missing outbox config now throws `InternalAppException` (500) per the repo's `AppException` convention. |

**Re-verified after the fixes:** type-check + lint clean; **1932 unit tests** pass; outbox integration
**31/31**; `prisma migrate diff` still reports **No difference detected**.

**Remaining follow-up for PERF-1:** add a retention purge for terminal rows
(`published`/`dead` older than N days) via a `@Cron` task, as in
`memory-governance.processor.ts`. Tracked in
[#135](https://github.com/nathapp-io/koda/issues/135). The new index keeps the claim query fast
regardless, so this is a storage-hygiene item, not a blocker.

---

## Findings

### 🔴 CRITICAL

None.

### 🟠 HIGH

None.

### 🟡 MEDIUM

#### PERF-1: `claimBatch`'s lease-reclaim branch has no supporting index and there is no outbox retention

**Severity:** MEDIUM | **Category:** Performance / Reliability

The claim query (`prisma-outbox.store.ts:48-59`) is:

```sql
WHERE ("status" = 'pending' AND "nextAttemptAt" <= $now)
   OR ("status" = 'processing' AND "leaseUntil" < $now)
ORDER BY "nextAttemptAt"
LIMIT $n
FOR UPDATE SKIP LOCKED
```

The only relevant index is `@@index([status, nextAttemptAt])` (`schema.prisma:379-381`). No index
covers `leaseUntil`, so the second `OR` branch cannot be served from an index and Postgres will fall
back to scanning/filtering. Because the relay polls every 1 s (`pollIntervalMs 1000`), and because
`published`/`dead` rows are never purged (there is no retention job anywhere in the branch, and the
deleted `outbox.service.ts`/`outbox-processor.ts` never pruned either), the table grows without
bound and every poll pays for it.

**Risk:** Latency/CPU grows with lifetime outbox volume, not with pending backlog. The migration
deliberately requeues a legacy backlog, so the first post-deploy polls run against the largest table
the outbox will ever see.

**Fix:** Either (a) add a partial index for the reclaim branch, e.g.
`CREATE INDEX "OutboxEvent_leaseUntil_idx" ON "OutboxEvent"("leaseUntil") WHERE "status" = 'processing';`
(schema + migration + re-run the drift check), and/or (b) split the claim into two statements
(`pending` then expired `processing`), and/or (c) add a periodic purge of terminal rows
(`published`/`dead` older than N days). At minimum, document the missing index as a deliberate
trade-off.

### 🟢 LOW

#### ENH-1: `FanOutPublisher.onModuleInit` logs the handler count before consumers register

**Severity:** LOW | **Category:** Observability / Bug

`FanOutPublisher` is provided by `OutboxCoreModule`, which initializes before the consumer modules
(memory, entity-graph, code-intel, webhook, rag) that call `register(...)` in *their* `onModuleInit`.
The one-shot log therefore reports `Registered 0 handlers` every boot.

```ts
// fan-out-publisher.ts:38-41
onModuleInit(): void {
  const total = [...this.handlers.values()].reduce((count, list) => count + list.length, 0);
  this.logger.log(`Registered ${total} handlers`);
}
```

**Risk:** A misleading startup log; no functional impact (the relay starts in
`onApplicationBootstrap`, after every `onModuleInit`).
**Fix:** Move the log to `onApplicationBootstrap`, or drop it.

#### BUG-1: `GET /admin/outbox` `total` is the page length, not the total count

**Severity:** LOW | **Category:** API Design

```ts
// admin.controller.ts:26-30
const items = await this.outboxAdmin.list(query.status);
return { items, total: items.length };
```

`total` is capped at `LIST_LIMIT = 100`, so an operator cannot tell a 5-row queue from a
1000-row one.
**Fix:** Return a real `count` from the repository/DTO, or rename the field to `returned`.

#### ENH-2: `OUTBOX_RELAY_ENABLED` is validated twice with divergent semantics

**Severity:** LOW | **Category:** Consistency

`env.validation.ts:23-26` uses `Joi.boolean().truthy('true').falsy('false')` (Joi also accepts
`1`/`true`), while `outbox.config.ts:21-25` re-validates the raw `process.env` with
`@IsIn(['true', 'false'])`. `1`, `TRUE`, `yes` pass Joi but throw in `outboxConfig()`. The config
reads `process.env` directly rather than the validated value, so the two can disagree.
**Fix:** Pick one source of truth (validated config value) and one rule.

#### ENH-3: `OutboxModule` throws a bare `Error` on missing config

**Severity:** LOW | **Category:** Conventions

`outbox.module.ts:22-24` throws `new Error(...)`. The repo's convention is `AppException`
subclasses. This is bootstrap-only wiring, so it is acceptable, but it is the lone raw `throw new
Error` added by the branch in production code.

---

## By-Design / Known Residuals (acknowledged, not defects against this branch)

These are documented in the plan (lines 2661-2664) and/or in code comments. I confirmed each is
pre-existing and no worse than `main`:

1. **Lease-expiry double delivery.** A handler that runs longer than `leaseMs` (30 s) can have its
   row reclaimed (`claimBatch`'s expired-lease branch) and published a second time. Inherent to
   lease-based relays; handlers are required to be idempotent. Consider raising `leaseMs` or adding
   a heartbeat if any handler can exceed 30 s.
2. **Out-of-order / stale replay.** The new memory no-op
   (`prisma-memory-item.repository.ts:137-146`) only suppresses an *identical* fact from the *same*
   source. A retried older event can still supersede a newer fact (no staleness guard), and a
   retried `status_changed`/`code_commit` can overwrite newer state. Pre-existing; the no-op removes
   the most common replay, not the ordering hazard.
3. **`graphify_import` payload carries only counts.** `koda-domain-writer.service.ts:259-263`
   records `{ projectId, nodeCount, linkCount }`, but `entity-graph-outbox.subscriber.ts:37-56`
   reads `p.nodes` / `p.links`. The handler therefore receives empty arrays on every import.
   Pre-existing; a payload-shape mismatch worth a follow-up.
4. **`document_indexed` payload has no `projectId`.** The RAG lexical warmup keys off a project id
   the payload never carries, so it never fires for these events. Pre-existing.
5. **PATCH `{status, ...fields}` is two transactions.** `tickets.service.ts:213-228` applies field
   updates (`applyUpdate`, own `txManager.run`) and then the transition (another `txManager.run`).
   A failing transition leaves the field update committed. Pre-existing shape.
6. **VCS push `code_commit` records outside a transaction** (`vcs-webhook.service.ts:627-634`) —
   correct and commented: the row is the handler's only write. `importGraphify` similarly records
   after the vector-store import (`koda-domain-writer.service.ts:257-263`).

---

## Positives worth recording

- **Migration is exemplary**: renames preserve values, legacy status vocabulary is remapped,
  `failed`/lease-less `processing` rows are requeued, `nextAttemptAt` is backfilled before
  `SET NOT NULL`, and the data rewrite is exercised by a scratch-schema integration test. The
  drift check is clean.
- **Atomicity is real and tested**: `producer-atomicity.integration.spec.ts` proves rollback leaves
  no ticket/TicketEvent/outbox row and commit leaves exactly one, for both ticket create and a
  status transition (event + webhook row).
- **Failure isolation**: a malformed `payload` is handed on as raw text instead of wedging
  `claimBatch`; a malformed webhook `events` column is skipped, not thrown; `recordLastError`
  failing does not mask the handler failure.
- **Admin retry race is handled** at two levels: service-level 409 for `processing`/`published`,
  plus a conditional `updateMany` that 409s if the row changed between read and reset.
- **No `any` in the new production code; no `console.log`; no raw env access outside config.**
- **Contract regenerated** (`openapi.json` shows the `status` enum and the 409), CLI updated.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P1 | PERF-1 | S | Add `leaseUntil` partial index and/or a terminal-row retention job; re-run the drift check |
| P2 | ENH-1 | XS | Move the "Registered N handlers" log to `onApplicationBootstrap` (or delete) |
| P3 | BUG-1 | S | Return a real outbox count (or rename `total`) |
| P4 | ENH-2 | XS | Consolidate `OUTBOX_RELAY_ENABLED` validation on one source |
| P5 | ENH-3 | XS | Use an `AppException` for the missing-config bootstrap error |

---

## Verification appendix

- Coverage check on all 14 cited paths: `no_recorded_issue` (some `metadata_changed`; those were read
  directly from source, and the branch is a later generation than the index).
- The plan's five review-focus items map to tests I ran:
  1. legacy-row requeue → `outbox-migration.integration.spec.ts`
  2. unparseable payload doesn't throw in `claimBatch` → `prisma-outbox-store.integration.spec.ts`
  3. malformed webhook `events` JSON skipped → `webhook-dispatcher.service.spec.ts`
  4. admin retry on `processing` → 409 → `outbox-admin.service.spec.ts` (+ relay retry test)
  5. 2000-char `lastError` truncation + write-failure non-masking → `fan-out-publisher.spec.ts`
- DB stopped for the unit run; `docker compose` Postgres 16 on 5433 for integration.

No push, PR, or deployment was performed.
