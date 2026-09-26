# Track 1 Foundations — Design

**Date:** 2026-09-25
**Base:** `main` @ `eb18be6c` (after PR #127 and HIGH remediation PRs #128-#132)
**Source:** fleet platform design doc §9.3 (Track 1), whole-repo review `docs/20260925-review-whole-repo.md`
**Status:** Approved design. Slice 1 merged (#133); Slice 2 implemented on `feat/track1-outbox`; Slice 3 merged (#137); Slice 4 implemented on `feat/track1-users-membership`.

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

### API

- **`ProjectEventBus`** (`src/live/project-event-bus.ts`): in-process map `projectId → Set<callback>`; `subscribe` returns an unsubscribe function; `publish(projectId, event)` never throws (a failing callback is logged and skipped).
- **`TicketLiveSubscriber`**: fan-out handler for `ticket_event`. Maps the payload to `LiveEvent { id, type: 'ticket', action, ticketId, ref, actorId, at }` with `action ∈ created|updated|transitioned|assigned|commented|deleted`. Carries no ticket content; clients refetch through access-checked endpoints. Never throws, so it never causes an outbox retry.
- **`GET /projects/:slug/events`** (`LiveController`, Nest `@Sse()` on Fastify):
  - `assertProjectMembership` on connect;
  - `: ping` comment every 25 s;
  - on each heartbeat re-validate: `tokenVersion` via the existing 60 s cache (`jwt-auth.provider.ts`), `disabled` and membership via a live query (one cheap indexed read per 25 s per stream); close the stream on failure; also close at access-token expiry (the browser `EventSource` reconnects with the refreshed cookie);
  - unsubscribe on client close;
  - excluded from the global throttler (a long-lived stream would miscount);
  - max 5 concurrent streams per user, 429 beyond.
- Auth needs no new code: the API already accepts the `koda_token` cookie (`src/auth/auth.module.ts`), and the browser `/api` proxy forwards cookies.

### Web

- `server/api/[...].ts`: ensure the proxied response streams unbuffered for `text/event-stream` (pass through `cache-control: no-cache`, `x-accel-buffering: no`; no compression).
- `composables/useProjectEvents.ts`: client-only `EventSource` wrapper, `on(action, handler)`, closes on unmount; on `onopen` after an error it fires a `resync` callback.
- Ticket board: `created|transitioned|assigned|deleted` → debounced (300 ms) refetch of the current page; `resync` → refetch.
- Ticket detail: any event for the open `ticketId` → refetch ticket + comments.
- No `Last-Event-ID` replay (single instance; reconnect triggers a refetch).

### Tests

- Unit: bus subscribe/publish/unsubscribe, failing callback isolation; subscriber payload mapping; heartbeat revocation close.
- Integration (PG + in-process app): member opens the stream, transitions a ticket, receives `transitioned` within 2 s; non-member → 403; removing the member closes the stream within one heartbeat.
- E2E (Playwright through the real Nuxt proxy): two browser contexts on the same board; A transitions a ticket; B's board updates without reload. This is the proof that streaming survives the proxy.

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
- M4, M6, M14, M20 re-verified closed against source at the final HEAD.
- `koda-local` runs on Postgres with an admin bootstrap, registration closed, a second user created and added to a project.
- Two browsers on one ticket board see each other's transitions live through the Nuxt proxy.
