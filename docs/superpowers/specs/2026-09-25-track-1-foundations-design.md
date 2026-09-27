# Track 1 Foundations — Design

**Date:** 2026-09-25
**Base:** `main` @ `eb18be6c` (after PR #127 and HIGH remediation PRs #128-#132)
**Source:** fleet platform design doc §9.3 (Track 1), whole-repo review `docs/20260925-review-whole-repo.md`
**Status:** Approved design. Slices 1-4 merged (#133, #134, #137, #139). Slice 5 implemented on `feat/track1-sse`.

## Goal

Lay the koda foundations that every later feature (and the future nax fleet plane) needs, as five
independently mergeable slices, each useful on its own:

1. PostgreSQL as the only database (fresh baseline)
2. Outbox on `@nathapp/nestjs-outbox` (scheduled backoff, leases, no overlap)
3. Pagination on the `@nathapp` canonical types
4. User administration and project membership management
5. Live ticket updates over SSE

## Decisions (user rulings, 2026-09-25)

- **Fresh start.** No SQLite data migration. The `koda-local` SQLite db is archived, the deployment is re-created on Postgres.
- **Postgres only.** No dual-provider support.
- **Registration closed by default** (`REGISTRATION_ENABLED=false`); global ADMIN creates users; project admins add existing users by email. Invite links are out of scope.
- **SSE = infrastructure plus one real consumer** (ticket board + ticket detail).
- **Pagination uses the `@nathapp` types** (`PageOption` / `IPageOption` in, `Page<T>` / `IPageResult<T>` out, `Paginate()` for Prisma). Only unbounded lists move; small lists stay plain `T[]`.
- **Timeline and `/context` keep a keyset cursor** with pushed-down `take` (the one documented exception to the `Page<T>` rule).
- **Adopt `@nathapp/nestjs-outbox@3.3.0`**; delete koda's hand-rolled outbox service, cron and retry.

## Constraints

- API stays single-instance (in-process cron, in-process SSE bus). No Redis.
- String-typed enum fields and JSON-as-String columns stay as they are (conversion is recorded debt).
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses, `registerAs` config, repository → service → controller layering, outbox `record()` inside `txManager.run`.
- TDD for every slice. DB-backed behavior gets integration tests against real Postgres. Module/DI wiring tests stay DB-free unit tests (`src/<feature>/<feature>.module.spec.ts`), per `apps/api` context.

## Delivery

Five PRs, landed in order. Each PR regenerates `openapi.json` and the CLI client when it changes the contract.

| # | Slice | Closes |
|---|---|---|
| 1 | Postgres baseline | M6, M14 |
| 2 | Outbox on `@nathapp/nestjs-outbox` | M4 (both halves) |
| 3 | Pagination | M20 |
| 4 | Users + membership | bootstrap-admin race (LOW) |
| 5 | SSE live ticket updates | — |

Order rationale: Postgres first so every later migration is written once; outbox before SSE because
SSE is an outbox subscriber; pagination before membership so the members list is paginated from the
start.

---

## Slice 1 — Postgres baseline

### Schema and migrations

- `apps/api/prisma/schema.prisma`: `datasource db { provider = "postgresql" }`.
- Delete `apps/api/prisma/migrations/` (28 SQLite migrations). Generate one baseline `0_init` with `prisma migrate dev --name init` against an empty Postgres. `migration_lock.toml` → `postgresql`.
- The baseline is a faithful port of the current schema, with no model changes. The `OutboxEvent` reshape belongs to slice 2 and ships with its own migration, so slice 1 leaves the existing outbox code working unchanged.
- Remove `DATABASE_PROVIDER` everywhere: `src/config/database.config.ts`, `src/config/env.validation.ts` (the `sqlite|postgresql|mysql` validator), `.env.example`, `.env.test`, `docker-compose.yml`, `docker-compose.dev.yml`, `.nax/context.md` (root: "Prisma with SQLite default" → "PostgreSQL") and regenerate `CLAUDE.md`/`AGENTS.md` with `nax generate`.

### Behavior changes handled deliberately

**M6 — ticket-number race.** Three `max+1` allocators exist: `src/tickets/tickets.service.ts` (the `txManager.run` block that calls `findLastTicketInProject`), `src/ci-webhook/prisma-ci-webhook.repository.ts` (`createTicket`) and `src/vcs/prisma-vcs.repository.ts` (`createTicketFromIssue`, VCS issue import). All three move to one shared helper that:

- runs the allocate-and-create in a fresh `txManager.run` per attempt (a P2002 aborts the Postgres transaction, so the retry must never be inside the failed transaction);
- retries only on P2002 whose target includes `number`, up to 10 attempts with jitter growing per attempt (`attempt × 10-50 ms`) — 10 concurrent creators need up to 10 rounds in the worst case;
- when already inside an outer transaction (`PrismaTransactionManager.run` joins it, so a retry would reuse the aborted transaction) it runs once and maps a conflict straight to 409;
- after the last attempt throws `new HttpException(..., HttpStatus.CONFLICT)` (409), never a 500. `@nathapp/nestjs-common` has no conflict `AppException`; this is koda's existing 409 convention (`ticket-transitions.service.ts:429`, `webhook-replay.guard.ts:149`).

The false `@design` comment ("callers retry") is replaced with an accurate one.

**Case sensitivity.** SQLite `LIKE` is ASCII case-insensitive; Postgres `contains` is not.

- `src/code-intel/prisma-code-intel.repository.ts` symbol search (`name` and `file` `contains`) adds `mode: 'insensitive'` to keep current behavior.
- Memory `subject startsWith` and symbol-id `endsWith` stay case-sensitive (key matches; case-sensitive is correct).

**M14 — `code_document`.** `src/rag/prisma-rag.repository.ts` raw `SELECT ... FROM code_document` (table never existed) becomes `graphNode.findMany({ where: { projectId } })` mapped to the same `RagCodeDocumentRow` shape. Koda then has no raw SQL outside the outbox store (slice 2).

### Test infrastructure

- **Test script split.** Today `bun run test` loads `.env.test` (which sets a SQLite `DATABASE_URL`), so it pushes the schema and runs the `test/e2e/*` suites; that only works because SQLite needs no server. After the switch `bun run test` / `test:unit` must stay DB-free: `testPathIgnorePatterns` becomes `integration|e2e`; `.env.test` keeps a `DATABASE_URL` (the Joi schema requires it) pointing at the PG test database; `test/global-setup.ts` is gated on `KODA_DB_TESTS=1` instead of on `DATABASE_URL` being set; `test:integration` sets `KODA_DB_TESTS=1` and matches `integration|e2e`.
- `test/global-setup.ts`: unchanged mechanism (`prisma db push --force-reset` once), gated on `KODA_DB_TESTS=1`, so it is a no-op for `bun run test`.
- `test/global-teardown.ts`: the SQLite file cleanup is removed (the PG test DB is reset by `global-setup` on the next run).
- `test/helpers/reset-db.ts`: replace the `sqlite_master` / `sqlite_sequence` logic with one `TRUNCATE <all tables> RESTART IDENTITY CASCADE`, table list from `pg_tables WHERE schemaname = current_schema()`, excluding `_prisma_migrations`.
- Test database URL: `postgresql://koda:koda@localhost:5433/koda_test` (port 5433 so tests cannot hit a dev DB on 5432); CI overrides it through the job env (dotenv never overrides an existing variable).
- Doc comments in integration/e2e specs that say `DATABASE_URL=file:./koda-test.ephemeral.db` are updated to the PG command.
- A `docker-compose.test.yml` (or a `test-db` profile) starts `postgres:16` on 5433 for local runs.

### CI

CI currently never runs integration tests (`test` excludes `integration`; `evaluate` uses a SQLite file).

- New `integration` job: `postgres:16` service container, `bun run test:integration`.
- `evaluate` job: `DATABASE_URL` from `file:` to a `postgres:16` service container.
- `smoke` job + `scripts/smoke-test-cli.sh`: the script applies migrations and promotes the admin with the `sqlite3` CLI. It switches to `bunx prisma migrate deploy` and `psql` (preinstalled on GitHub `ubuntu-latest`), against a `postgres:16` service container.
- Web Playwright (`apps/web/playwright.config.ts`): the API `webServer` deletes and recreates a SQLite `koda-e2e.db`. It switches to `prisma migrate reset --force --skip-seed` against `postgresql://koda:koda@localhost:5433/koda_e2e`, then `seed-e2e.ts`.

### Deployment

- `docker-compose.yml`, `docker-compose.dev.yml`: add a `postgres:16` service with a named volume and healthcheck; api `DATABASE_URL=postgresql://...@postgres:5432/koda`, `depends_on: service_healthy`.
- `deployments/koda-local` (outside the repo, operational step documented in the PR): archive `data/koda.db` to `backups/sqlite-final-<date>/`, wipe the LanceDB directory (its vectors reference SQLite-era ids), redeploy. `backup-db.sh` / `rollback.sh` switch to `pg_dump` / `pg_restore`.

### Tests

- Integration: 10 concurrent ticket creates in one project → 10 distinct, gapless numbers, through each of the three allocators.
- Integration: `graphify_import` path returns `GraphNode` rows (M14).
- Integration: case-insensitive symbol search.
- Integration: `reset-db` leaves every table empty and sequences reset.

---

## Slice 2 — Outbox on `@nathapp/nestjs-outbox`

Verified against the published 3.3.0 tarball: relay has an `inFlight` overlap guard, computes `nextAttemptAt` with capped exponential backoff, claims under a lease with an owner token, statuses `pending → processing → published | dead`. It ships no Prisma store.

### Wiring

- `src/outbox/outbox.module.ts` imports `OutboxModule.registerAsync` from the package with `store: PrismaOutboxStore`, `publisher: FanOutPublisher`, `relay` options from a new `registerAs('outbox')` config: `pollIntervalMs 1000`, `batchSize 20`, `leaseMs 30000`, `maxAttempts 8`, `backoffBaseMs 2000`, `backoffCapMs 300000`.
- The package silently falls back to `InMemoryOutboxStore` when `store` is missing. A DB-free module spec asserts the resolved `OUTBOX_STORE` is a `PrismaOutboxStore` and `relay.enabled` is true outside tests.

### Table (slice 2 migration)

Slice 2 adds a migration reshaping `OutboxEvent` that also rewrites existing rows (`completed`→`published`, `dead_letter`→`dead`, `failed`→`pending` with `nextAttemptAt = now()`, `eventType`→`type`, `processedAt`→`publishedAt`). Target columns: `id`, `type`, `payload` (String JSON), `status` (`pending|processing|published|dead`), `attempts`, `nextAttemptAt`, `leaseUntil?`, `owner?`, `publishedAt?`, `headers?` (String JSON), `lastError?`, `projectId` (FK, cascade), `eventId`, `createdAt`, `updatedAt`. Index `(status, nextAttemptAt)` and `(projectId, createdAt)`.

`projectId` and `eventId` stay real columns (cascade on project delete, admin filtering). Producers pass them in `metadata`; the store maps them onto the columns and rejects a record missing `projectId`.

### `PrismaOutboxStore` (implements `IOutboxStore`)

- `save(record, client)` writes through the passed client (the active transaction client from `txManager.getClient()`), so `record()` is atomic with the business write **only when called inside `txManager.run`**. Trap: `PrismaTransactionManager.getClient()` returns the root client outside `run()`, so a `record()` outside a transaction silently succeeds non-atomically instead of failing. Every producer must wrap it.
- `claimBatch(limit, leaseMs, now, owner)`: one statement — `UPDATE "OutboxEvent" SET status='processing', owner=$owner, "leaseUntil"=$now+lease WHERE id IN (SELECT id FROM "OutboxEvent" WHERE (status='pending' AND "nextAttemptAt" <= $now) OR (status='processing' AND "leaseUntil" < $now) ORDER BY "nextAttemptAt" LIMIT $limit FOR UPDATE SKIP LOCKED) RETURNING *`. This is deliberate raw SQL (Prisma has no `SKIP LOCKED`); it replaces the per-row optimistic claim and `requeueStaleProcessing`.
- `markPublished` / `markRetry` / `markDead` all include `WHERE id = $id AND owner = $owner`; a relay whose lease expired cannot overwrite a newer claim. `markRetry` sets `status='pending'`, `attempts`, `nextAttemptAt`, clears `owner`/`leaseUntil`.

### `FanOutPublisher` (the existing registry, reshaped) — M4

- `publish(record)` runs every registered handler for `record.type`, collects failures, and throws one aggregate error if any failed.
- Before throwing, it writes `lastError` for the record (the package's store interface never receives the error, so `lastError` would otherwise go blank on the admin page).
- The singleton `lastDispatchFailureCount` / `consumeLastDispatchFailureCount` are deleted (M4 second half). The relay's `inFlight` guard closes M4's first half (overlapping cycles).
- One failing handler re-runs all handlers for that event on retry (unchanged semantics). The plan must list every current subscriber — webhook (`webhook-outbox.subscriber.ts`), memory (`memory-outbox.subscriber.ts`), entity-graph (`entity-graph-outbox.subscriber.ts`), code-intel (`code-intel-outbox.subscriber.ts`), rag (`rag.module.ts` registration) — with its idempotency basis, and add a dedupe check where none exists.

### Producers

Every `outboxService.enqueue(...)` call site becomes `outbox.record({ type, payload, metadata: { projectId, eventId } })` inside the business write's `txManager.run`:

- `src/tickets/tickets.service.ts` (ticket events, currently fire-and-forget after the write)
- `src/tickets/state-machine/ticket-transitions.service.ts`
- `src/koda-domain-writer/koda-domain-writer.service.ts` (5 sites)
- `src/vcs/vcs-webhook.service.ts`
- `src/webhook/webhook-dispatcher.service.ts`

Each site is audited; any that enqueue after the commit move inside the transaction. The ticket event emitters in `tickets.service.ts` are currently called as `void this.emitTicketEvent(...)` (never awaited, outside the write's transaction); those call sites drop the `void` and the `record()` moves into the write's `txManager.run`. Where a site has no enclosing transaction today, the plan adds one around the business write and the `record()`.

### Deleted

Koda's `OutboxService` (enqueue/process/retry/markFailed/delay), `OutboxProcessor` (5 s cron), `OUTBOX_BACKOFF_MS`, and the hand-rolled claim/requeue methods in `prisma-outbox.repository.ts` (the repository keeps only admin read/reset queries).

### Admin

`src/outbox/admin.controller.ts` (`GET /admin/outbox`, `POST /admin/outbox/:eventId/retry`) uses the new status names (`published`, `dead`). There is no web outbox page today; adding one is Track 2 (admin UIs), not this slice. Manual retry resets the row to `pending`, `attempts = 0`, `nextAttemptAt = now()`, clears `owner`/`leaseUntil`/`lastError`.

### Tests

- Integration (PG): a rolled-back transaction leaves no outbox row; two concurrent `claimBatch` calls never return the same row; an expired lease is reclaimed; a stale-owner `markPublished` is a no-op; `markRetry` sets `nextAttemptAt` and the row is not claimed before it; `maxAttempts` reached → `dead`.
- Unit: `FanOutPublisher` aggregates failures, writes `lastError`, succeeds when all handlers succeed.
- Unit (DB-free): module resolves `PrismaOutboxStore`.

---

## Slice 3 — Pagination

**Status:** implemented on feat/track1-pagination (M20 closed).

Package map: `PageOption`, `IPageOption`, `Page<T>` (class with `remap`) from `@nathapp/nestjs-common`; `IPageResult<T>` (interface) from `@nathapp/nestjs-data`; `Paginate()` from `@nathapp/nestjs-prisma`. Repositories and services declare `IPageResult<T>`; concrete repositories return `Page<T>` instances.

### Shared query base

`src/common/dto/koda-page.query.ts`: `KodaPageQuery extends PageOption` (from `@nathapp/nestjs-common`) with `@Type(() => Number) @IsInt() @Min(1)` on `current` (default 1) and `@Type(() => Number) @IsInt() @Min(1) @Max(100)` on `size` (default 20). Every paginated list query DTO extends it.

### Endpoints

| Endpoint | After |
|---|---|
| `GET /projects/:slug/tickets` | `ListTicketsQuery extends KodaPageQuery` with validated `status`, `type`, `priority`, `assignedTo`, `unassigned`. Replaces `@Query() Record<string, any>` and hand-parsed `page`/`limit`. Repo uses `Paginate()`; service returns `IPageResult<TicketResponseDto>` via `remap`. |
| `GET /projects/:slug/memory` | `ListMemoryQuery extends KodaPageQuery` with `kind`, `subject`, `status`, `orderBy`. Koda's `PaginatedResult<T>` (`memory-item-repository.ts`) is deleted. |
| `GET /projects/:slug/timeline` | Keyset cursor kept (contract unchanged): each of `ticketEvent`, `agentEvent`, `decisionEvent` is queried with `where (createdAt, id) < cursor` and `take: limit + 1`, ordered `createdAt desc, id desc`; results merged, cut to `limit`, `nextCursor` from the last kept row. `limit` validated `1..100`. |
| `GET /context/:slug` | Same pushed-down `take` in `prisma-canonical-state.repository.ts` (M20). |
| comments, labels, agents, links | Unchanged: plain `T[]`, no paging params. |

The timeline/context cursor is the one documented exception to the `Page<T>` rule: an append-only merged feed over three tables, where `total` is meaningless and offset cost grows with depth.

### Clients

- Regenerate `openapi.json` and the CLI client. CLI `ticket list` / `memory` read `records` + `hasNext`, flags `--page` / `--size`.
- Web ticket board and memory page read `records`; "load more" driven by `hasNext`.

### Tests

- Unit: `KodaPageQuery` rejects `size=101`, `size=0`, non-numeric `current`; defaults applied.
- Integration (PG): ticket filters + paging return correct `total` / `hasNext`; timeline paging across three tables with interleaved timestamps returns every event exactly once, including a same-`createdAt` tie broken by `id`.

---

## Slice 4 — Users and membership

### Registration

- New config `auth.registrationEnabled` from `REGISTRATION_ENABLED` (default `false`).
- `POST /auth/register`: allowed when the user table is empty (bootstrap; that user becomes global ADMIN); otherwise `ForbiddenAppException` unless the flag is true.
- `GET /auth/registration-status` (`@Public`): `{ open: boolean }`. The web register page and login-page link hide when closed.
- `findAnyUserAndCreate` (`src/auth/prisma-auth.repository.ts`) relied on SQLite write serialization; on Postgres it takes `pg_advisory_xact_lock(<constant key>)` inside the transaction before the existence check.

### Global user administration (`/admin/users`, global ADMIN only)

- `User` gains `disabled Boolean @default(false)` (migration in this slice).
- `GET /admin/users` — `KodaPageQuery` + optional `email` filter → `IPageResult<UserAdminDto>`.
- `POST /admin/users` — `{ email, name, password, role }`; 409 on duplicate email. The admin hands the temporary password over out of band (no email infrastructure).
- `PATCH /admin/users/:id` — `{ role?, disabled? }`. Disabling increments `tokenVersion` (kills sessions via the H1 mechanism). Login and the JWT strategy reject disabled users.
- Guards: an admin cannot disable or demote themselves; the last active global ADMIN cannot be demoted or disabled (check + write in one transaction).
- No user deletion (tickets, comments, activity reference users); disabling is the removal mechanism.

### Project membership (`/projects/:slug/members`)

- `GET` — `KodaPageQuery` → `IPageResult<ProjectMemberDto>` (user id, email, name, role, joinedAt).
- `POST` — `{ email, role }`; 404 unknown email, 409 already a member.
- `PATCH /:userId` — `{ role }`.
- `DELETE /:userId`.
- Authorization: new `ProjectAccessService.assertProjectAdmin(projectId, principal)` — global ADMIN, or a member whose project role is `ADMIN`.
- Last-ADMIN guard: a role change or removal that would leave zero project `ADMIN` members is refused unless the actor is a global ADMIN. Count and write in one transaction.
- Membership is not cached (`assertProjectMembership` queries `findMembershipRole` on every call; only `tokenVersion` is cached, 60 s, in `jwt-auth.provider.ts`), so membership writes need no cache invalidation.

### Web

- `/admin/users` page (global ADMIN only): table, create dialog, disable toggle.
- Project `settings.vue`: Members section — list, add by email, role select, remove.
- Register page hidden when closed.
- All strings in `apps/web/i18n/locales/{en,zh}.json`; API messages in `apps/api/src/i18n/{en,zh}`.

### CLI

`koda user create|list|disable`, `koda member list|add|role|remove` over the regenerated client.

### Tests

- Integration (PG): 5 concurrent registrations on an empty DB → exactly one ADMIN; registration closed → 403; disabled user's existing token rejected; last project ADMIN guard (project admin refused, global admin allowed); DEVELOPER cannot add members; last global ADMIN cannot be disabled.
- Unit: DTO validation, guard logic.

---

## Slice 5 — SSE live ticket updates

Re-designed 2026-09-26 against `main` @ `bba91e23` (brainstorm rulings below supersede the
original 09-25 sketch). Rulings: the envelope is generic so fleet S2 can add event types, while
tickets remain the only producer; live events are an outbox subscriber (no second publish path);
comment create emits a new `COMMENT_ADDED` ticket event; the web e2e suite is repaired and runs in a
new CI job.

### Verified facts this design depends on

- The outbox relay runs in the API process: 1 s poll, batch 20, records processed serially
  (`apps/api/src/config/outbox.config.ts`). A slow sibling handler (webhook fetch, 5 s timeout)
  delays later records in the batch. Expected live latency: 1-2 s, worst case about 6 s.
- `FanOutPublisher.publish` runs every handler; if any throws, the whole record retries and **all**
  handlers run again, so live events can be delivered more than once.
- `ticket_event` actions actually emitted: `TICKET_CREATED`, `TICKET_UPDATED`, `TICKET_DELETED`,
  `assigned`, `status_changed` (all transitions, including PATCH with `status`). Payload:
  `{ id, type, action, timestamp, ticketId, projectId, actorId, actorType, data }`; no ticket ref.
  Comments, labels and links emit nothing today.
- Nest `@Sse` (core 11.1.28) cannot write SSE comment lines and defers response headers until the
  first message (`@nestjs/core/router/sse-stream.js`). It writes to the raw response on both
  Express (integration tests, `test/helpers/http-app.ts`) and Fastify (production), and unsubscribes
  the returned Observable when the client socket closes. No `@Sse` exists in koda yet, so the
  Express/Fastify parity is framework behavior, first proven by this slice's integration and e2e
  tests.
- `CommentsService.create` (`src/comments/comments.service.ts`) runs no transaction today, and
  `TicketsService.recordTicketEvent` is private.
- The existing `ticket_event` handlers tolerate an unknown action: memory `extractFromEvent`
  falls through to `return []`, `EntityGraphService.onTicketEvent` has no matching `case`, and
  RAG `EntityStore.handleOutboxEvent` re-indexes the ticket on every event regardless of action
  (redundant, harmless).
- `kodaTokenExtractor` (Bearer, then `koda_token` cookie) is a module-local const in
  `src/auth/auth.module.ts`; `JwtAuthProvider` is not exported from `AuthModule`.
- Board and detail pages render `LoadingState` while their `useAsyncData` is `pending`, and
  `refresh()` sets `pending`; `CommentThread` likewise swaps its list for a loading line.
- Several e2e specs wait for `networkidle`, which never settles while an `EventSource` is open.
- The h3 `proxyRequest` used by `apps/web/server/api/[...].ts` streams unbuffered but passes no
  `AbortSignal` upstream: a closed browser tab leaves the API stream open.
- The authenticated principal carries no token expiry; `JwtAuthProvider.getPrincipal()` re-checks
  `tokenVersion` and `disabled` through the 60 s `user-auth-state` cache.
- The API is single instance; the production API runs on Bun (`apps/runtime`).

### API

- **`LiveEvent`** (`src/live/live-event.ts`):
  `{ id, type: 'ticket', action, projectId, ticketId, actorId, at }`, `action ∈ created | updated |
  transitioned | assigned | commented | deleted`. `type` is a union with one member now; fleet S2
  extends it. No ticket content and no ref: clients refetch through access-checked endpoints. `id`
  is the envelope's `id` (the `TicketEvent` row id, which the handler receives in the payload), so a
  retried delivery keeps its id and clients drop duplicates.
- **`ProjectEventBus`** (`src/live/project-event-bus.ts`): in-process map
  `projectId → Set<callback>`; `subscribe` returns an unsubscribe function; `publish` never throws
  (a failing callback is logged and skipped).
- **`TicketLiveSubscriber`**: registers on `ticket_event` via `FanOutPublisher.register`. Maps
  `TICKET_CREATED→created`, `TICKET_UPDATED→updated`, `status_changed→transitioned`,
  `assigned→assigned`, `COMMENT_ADDED→commented`, `TICKET_DELETED→deleted`; unknown actions are
  dropped. Never throws, so it never causes an outbox retry.
- **`COMMENT_ADDED` producer**: `CommentsService.create` wraps the comment insert in
  `txManager.run` (new; injects `TRANSACTION_MANAGER`) and, in the same transaction, writes the
  `TicketEvent` row via `TicketEventService` (`CommentsModule` imports `EventsModule`) and the
  `ticket_event` outbox row via the global `@nathapp/nestjs-outbox` `OutboxService`, with
  `buildTicketEventOutboxPayload`, `data: { commentId }` (no comment body). This mirrors
  `TicketsService.recordTicketEvent`; `TicketsService` is not imported (no module cycle). Comments
  created inside a transition keep emitting only `status_changed` (one user action, one event).
  Comment edit/delete emit nothing (out of scope). The new `TicketEvent` row also shows in the
  ticket timeline. The three existing handlers need no change (see verified facts); tests pin that
  `COMMENT_ADDED` produces no memory items and no entity-graph write.
- **`GET /projects/:slug/events`** (`LiveController`, `@Sse`):
  - on connect: resolve slug, `assertProjectMembership` (403); agent principals refused (403,
    CLI/agent subscribers deferred); per-user cap of 5 concurrent streams, in-memory, 429 beyond;
    emit a `ready` event immediately so headers flush;
  - every `LIVE_HEARTBEAT_MS` (default 25 000): re-validate via `JwtAuthProvider.getPrincipal`
    (`tokenVersion`, `disabled`, 60 s cache) and membership via a live query; close on failure,
    otherwise emit a named `ping` event (`EventSource` ignores named events without a listener);
  - close at the access token's `exp`: `AuthModule` exports `kodaTokenExtractor`, the controller
    extracts the raw token (already verified by the guard) and base64url-decodes its payload for
    `exp`; the browser reconnects with the refreshed cookie;
  - on client close: unsubscribe and release the cap slot;
  - `@SkipThrottle()` (a long-lived stream would miscount the global throttler);
  - `@ApiExcludeEndpoint()`: browser-only, agents refused, so it stays out of `openapi.json` and the
    generated CLI client.
- `AuthModule` additionally exports `JwtAuthProvider` for the heartbeat re-validation.
- Revocation bound: disabled user or bumped `tokenVersion` closes the stream within one heartbeat
  plus the 60 s cache TTL (at most 85 s); membership removal within one heartbeat (at most 25 s).
- Auth needs no new mechanism: the API already accepts the `koda_token` cookie and the web proxy
  forwards cookies.

### Web

- **Dedicated proxy route** `server/api/projects/[slug]/events.get.ts` (more specific than the
  `[...]` catch-all): `fetch` upstream with an `AbortController` aborted when the browser request
  closes; forward cookies; stream the body back with `content-type: text/event-stream`,
  `cache-control: no-cache`, `x-accel-buffering: no`, no `content-length` or `content-encoding`.
  All other `/api` traffic stays on `proxyRequest`.
- **`composables/useProjectEvents.ts`** (client-only): wraps
  `EventSource('/api/projects/:slug/events')`; exposes `on(action, handler)` and `onResync(handler)`;
  closes on unmount; drops duplicate ids (bounded memory of the last 200). Transient drops and server
  closes: the browser reconnects and the composable fires `resync` on reopen. Terminal failure
  (`readyState === CLOSED`, e.g. 401 after cookie expiry, 403, 429): call `useAuth().refresh()`, then
  reopen with backoff 1 s, 2 s, 4 s … capped at 30 s; if the refresh fails, stop silently and the
  page keeps working as a static page.
- **Silent refetch**: live updates never call `useAsyncData` `refresh()` (it sets `pending`, which
  swaps the page for `LoadingState` and would unmount an open edit form). They fetch with `$api` and
  assign the result to the existing data ref instead.
- **Ticket board** (`pages/[project]/index.vue`): every action except `commented`, plus `resync`,
  triggers a 300 ms debounced reload. New `reloadLoaded()` in `useTicketBoardPages` refetches page 1
  and every already-loaded extra page and swaps them in together (today `refresh()` drops loaded
  extra pages).
- **Ticket detail** (`pages/[project]/tickets/[ref].vue`): any event for the open `ticketId`
  silently refetches the ticket; `commented` and `resync` also refetch comments and assign them via
  `useNuxtData('comments-<slug>-<ref>')` (the `CommentThread` key, component unchanged);
  `deleted` for the open ticket shows a "ticket was deleted" notice instead of refetching into a 404.
- No `Last-Event-ID` replay (single instance; reconnect triggers a refetch).

### E2E repair and CI

- **429 fix in the tests, not the product**: a worker-scoped auth fixture logs each role in once per
  worker and reuses cookies via `storageState`, replacing `webLogin` in `beforeEach`. The login
  throttle (5/min per IP) is unchanged. `networkidle` waits on pages that open the event stream
  (board, ticket detail) are replaced by explicit locator waits. Remaining failures exposed after the 429 fix are fixed; a
  failure that is a real product bug is escalated, not papered over.
- `playwright.config.ts`: `E2E_WEB_MODE=build` runs the web server from the built
  `.output/server/index.mjs` instead of `nuxt dev`.
- **New CI job `e2e`** in `.github/workflows/ci.yml`: `postgres:16` on 5433, cached Playwright
  Chromium, web build, Playwright with `E2E_WEB_MODE=build`; report and traces uploaded on failure.
  Becomes a required check once green on `main`.

### Tests

- Unit: bus subscribe/publish/unsubscribe and failing-callback isolation; subscriber mapping of all
  six actions, unknown-action drop, never throws; controller heartbeat closes on revoked/disabled
  user, lost membership and token `exp`, releases the cap slot; 6th stream → 429; composable dedup,
  `resync` on reopen, refresh-then-backoff on terminal failure; `reloadLoaded()` keeps loaded pages.
- Integration (PG, Express `bootHttpApp`, relay driven with `relay.dispatchPendingBatch()`, streams
  read with `fetch` against `app.listen(0)`): member receives `ready`, then `transitioned` carrying
  the outbox event id; non-member → 403; agent key → 403; member removal closes the stream within
  one heartbeat (`LIVE_HEARTBEAT_MS` shortened); comment create records `COMMENT_ADDED`; memory,
  entity-graph and RAG handlers pinned against it.
- E2E `live-board.spec.ts`: two browser contexts on one board, A transitions a ticket, B's card moves
  without reload within 5 s; B on ticket detail sees A's comment appear.
- Manual (recorded in the PR): two tabs against `docker compose up` to prove SSE on the Bun
  production runtime, which no automated suite exercises. A failure blocks the slice.

### Deferred

- CLI/agent subscribers (agent-key auth on the stream); live events for comment edit/delete, labels,
  links, memory, timeline, agents; `Last-Event-ID` replay; multi-instance fan-out.

---

## Out of scope

- Invite links; email delivery.
- Redis, multi-instance API, distributed cron, SSE fan-out across instances.
- Live updates beyond tickets (memory, timeline, agents).
- Converting string enums / JSON-as-String columns.
- Remaining review items: M5, M7-M13, M15-M19, M21, M24-M28 and LOWs (except the bootstrap-admin race, closed in slice 4).
- Fleet runner/dispatch (fleet S1) and all nax-coupled work.

## Success criteria

- `bun run test`, `bun run test:integration` (on Postgres), `bun run lint`, `bun run type-check` green; CI runs the new `integration` job.
- M4, M6, M14, M20 (defined in `docs/20260925-review-whole-repo.md`) re-verified closed against source at the final HEAD.
- `koda-local` runs on Postgres with an admin bootstrap, registration closed, a second user created and added to a project.
- Two browsers on one ticket board see each other's transitions live through the Nuxt proxy, proven by the `e2e` CI job and a manual check on the Bun production runtime.
