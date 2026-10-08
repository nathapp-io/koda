# Gemini CLI Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-api`

**Language:** TypeScript

**Key dependencies:** @fastify/helmet, @fastify/static, @nathapp/nestjs-notify-prisma, @nathapp/nestjs-prisma, @nestjs/cache-manager, @nestjs/common, @nestjs/config, @nestjs/core, @nestjs/event-emitter, @nestjs/platform-fastify

**Commands:** test: `npx turbo test` | lint: `bunx turbo lint` | typecheck: `bunx turbo type-check`

---
# Koda API Context

This is the app-specific source-of-truth context for `apps/api`.

## Read First

Before writing NestJS code in this app:
- read and follow the `nathapp-nestjs-patterns` skill
- prefer Nathapp platform patterns over generic NestJS alternatives

## Role In The Monorepo

`apps/api` is the system of record for Koda.

It owns:
- authentication for humans and agents
- Prisma schema, migrations, and data integrity
- project, ticket, comment, label, ticket-link, and agent workflows
- ticket state transition rules
- knowledge-base ingestion and retrieval
- outbound webhooks and inbound CI webhook handling
- OpenAPI generation to the repo root

Other apps should stay thin and call this API instead of reimplementing business rules.

## Stack

- NestJS 11 + Fastify via `@nathapp/nestjs-app`
- Prisma 7 via `@nathapp/nestjs-prisma` 4.1 (driver adapter `@prisma/adapter-pg`)
- `@nathapp/nestjs-auth` v3 for auth
- `@nathapp/nestjs-common` for JSON envelope, exceptions, i18n helpers
- `@nathapp/nestjs-logging`
- `@nathapp/nestjs-throttler`
- Jest for unit, integration, and e2e tests
- no Redis at runtime: `@nathapp/nestjs-cache` runs with `CacheStrategy.MEMORY` (single API instance; `@keyv/redis` and `@qified/redis` are installed but unused), so tests need Postgres only. Introducing Redis is an architecture change: it needs its own logical DB index (and key prefix) on the shared dev Redis, plus a test-tier Redis in `test/helpers/test-database.ts`

## Architecture

Key bootstrap details:
- `apps/api/src/main.ts` creates the Fastify app with `AppFactory`
- a Fastify `preParsing` hook converts empty JSON request bodies into `{}`
- `CombinedAuthGuard` is retrieved from DI and registered globally before app init completes
- global prefix, pipes, filters, guards, and dev-only Swagger are configured at bootstrap

Top-level module composition is defined in `apps/api/src/app.module.ts`.

Imported modules:
- `AuthModule`
- `AgentsModule`
- `ProjectsModule`
- `TicketsModule`
- `CommentsModule`
- `LabelsModule`
- `TicketLinksModule`
- `HealthModule`
- `RagModule`
- `WebhookModule`
- `CiWebhookModule`

Cross-cutting modules:
- `ConfigModule` with `app`, `auth`, `database`, and `rag` config
- `I18nCoreModule`
- `PrismaModule`
- `ThrottlerModule`

## Important Domain Rules

- do not use Prisma enums; use local constants/types from `src/common/enums.ts`
- ticket numbers are allocated per project via transaction and must never be reused
- projects and tickets use soft deletes
- ticket workflow transitions must go through the state-machine code
- user-facing strings should come from API i18n files, not hardcoded literals
- API responses should use the Nathapp JSON envelope pattern
- Prisma 7: import `PrismaClient`, `Prisma` and model types from the generated client
  (`src/generated/prisma/client`; gitignored, rebuilt by `bun install` or `bun run db:generate`), never from
  `@prisma/client` (ESLint blocks it). Build every client through `createPgAdapter(url)` (`src/prisma/pg-adapter.ts`);
  tests use `createTestPrismaClient()` (`test/helpers/test-prisma.ts`). The datasource URL lives in `prisma.config.ts`.
- Unique violations: driver adapters drop `meta.target`. Match fields with `isUniqueViolation` (backed by
  `getUniqueConstraintTarget`), never by reading `error.meta` yourself.

## Auth Model

Two actor types exist:
- humans authenticate with email/password and receive JWTs
- agents authenticate with API keys looked up by deterministic HMAC hash

Important rules:
- use `@nathapp/nestjs-auth` v3, not `nestjs-iam`
- password hashing uses bcrypt
- API key lookup must stay deterministic for lookup-by-hash behavior
- public routes must opt out explicitly

## Data Model

Prisma schema lives at `apps/api/prisma/schema.prisma`.

High-value models:
- `User`
- `Agent`
- `AgentRoleEntry`
- `AgentCapabilityEntry`
- `Project`
- `Ticket`
- `Comment`
- `Label`
- `TicketLabel`
- `TicketActivity`
- `TicketLink`
- `Webhook`

Schema notes:
- `Comment` uses `authorUserId` and `authorAgentId`
- `TicketActivity` uses `actorUserId` and `actorAgentId`
- `TicketLink` is unique on `(ticketId, url)`
- soft-deleted tickets still count for ticket-number allocation

## Main Folders

```text
apps/api/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── scripts/
├── src/
│   ├── auth/
│   ├── agents/
│   ├── projects/
│   ├── tickets/
│   ├── comments/
│   ├── labels/
│   ├── ticket-links/
│   ├── rag/
│   ├── webhook/
│   ├── ci-webhook/
│   ├── health/
│   ├── config/
│   ├── common/
│   └── i18n/
└── test/
    ├── integration/
    └── e2e/
```

## RAG And Integrations

RAG details:
- lives in `src/rag/`
- uses `EmbeddingService` plus provider abstractions
- FTS optimization strategy is selected by config: `counter`, `cron`, or `manual`

Integration details:
- `src/webhook/` handles outbound webhook subscriptions and dispatch
- `src/ci-webhook/` handles inbound CI events
- `src/ticket-links/` normalizes external ticket-related URLs

## Testing Rules

- unit tests live beside source files as `*.spec.ts`
- integration tests live under `test/integration/`
- e2e tests live under `test/e2e/`
- keep API behavior covered when changing workflow, auth, persistence, or contract behavior

### Module registration / DI tests must be unit-level (no DB)

- module-compilation and dependency-injection wiring tests are **unit tests**, not integration tests
- co-locate them with the module as `src/<feature>/<feature>.module.spec.ts` so they run under `bun run test`
- they must NOT live under `test/integration/` and must NOT contain `integration` in the filename (the default `test` script excludes any path matching `integration`)
- they must NOT require a database: compile the module with `Test.createTestingModule({ imports: [FeatureModule] }).compile()` and mock external collaborators (`PrismaService`, `TRANSACTION_MANAGER`, `ConfigService`) via provider `useValue`
- `test/integration/` is reserved for behavior that genuinely needs a real DB: repository round-trips, constraints, soft-delete semantics, transactions

Rationale: `bun run test` runs without a database, so DI/module-registration breakage must surface there. `test:integration` requires a real Postgres (the compose one from `bun run test:db:up` on port 5433, else a throwaway Testcontainers one; see below) and is not always run, so module-wiring tests hidden inside it can mask failures.

### Which test Postgres a DB-mode run uses

- integration and e2e specs only run under `KODA_DB_TESTS=1`; without it they are `describe.skip` and pass as zero tests
- nax's scoped test command (`bun run test:scoped <files>`) sets `KODA_DB_TESTS=1` whenever a targeted path matches `integration` or `e2e`, and the acceptance command always sets it
- jest globalSetup picks the database in this order (`test/helpers/test-database.ts`): `KODA_TEST_DATABASE_URL` when set (CI); else the compose test database named in `.env.test` (localhost:5433) when it answers; else a throwaway Postgres 16 started with Testcontainers (needs Docker) and stopped after the run. An inherited `DATABASE_URL` is never used
- nax's agent shell is sandboxed without Docker access, so agent-run DB tests need the compose database: run `bun run test:db:up` before a nax run that touches `apps/api`. nax's own quality and acceptance commands run outside the sandbox and fall back to Testcontainers
- a story that writes a `test/integration/**` spec must see it run and pass under `test:scoped`, not just compile
- every DB-mode run force-resets the test database (only a local `*_test` database is accepted), so do not run two DB-mode jest runs against the same database at once. A second checkout (worktree, clone) sets `KODA_TEST_DB_CONTAINER=1` to skip the compose database and use a private container

### nax acceptance tests

- One generated file per feature, `apps/api/.nax/features/<feature>/.nax-acceptance.test.ts`, holds every story's ACs as `it('AC-<n>: ...')`. The default jest config (`testRegex` `.*\.spec\.ts`) does not pick it up.
- Run it from `apps/api` with the compose test Postgres up (`bun run test:db:up`): `KODA_DB_TESTS=1 npx jest --config jest.nax.config.js .nax/features/<feature>/.nax-acceptance.test.ts -t "AC-<a>:|AC-<b>:"`, filtered to your story's AC ids (listed per `storyId` in the repo-root `.nax/features/<feature>/acceptance-refined.json`). Keep the trailing colon so `AC-1` does not also match `AC-10`.
- This is the same config nax's acceptance stage runs (`.nax/mono/apps/api/config.json` `acceptance.command`). `KODA_DB_TESTS=1` is required: without it the PG-backed ACs get no database.
- Never copy the file into `src/` or `test/`, never edit it, and never override `--testRegex`/`--testPathIgnorePatterns` to run it.

Useful scripts (run from `apps/api`):
- `bun run test`
- `bun run test:scoped <files>` (jest on the given files; DB mode when any is an integration/e2e spec)
- `bun run test:db:up` (start the compose test Postgres on 5433; `test:db:down` stops it; optional when Docker is available)
- `bun run test:integration`
- `bun run db:generate`
- `bun run db:migrate`

## OpenAPI Contract

The API is responsible for `openapi.json` at the repo root.

Rules:
- when controller/DTO contract changes are made, regenerate the spec from the monorepo root
- downstream CLI client generation depends on this spec
- do not edit generated downstream clients manually to compensate for stale API contracts

## Fleet (S1)

- Spec: `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`. Code under `src/fleet/`.
- Runner keys start with `kr_` and work only on `@RunnerRoute()` routes; `CombinedAuthGuard` fails closed in both directions. Never add a runner route without `@RunnerRoute()`, and never let a runner principal reach a ticket, comment or project route.
- `apps/api` may import `@nathapp/fleet-protocol` with `import type` only (the production image does not ship workspace packages); `src/fleet/common/protocol.spec.ts` enforces it.
- Runner capabilities are untrusted input: always pass them through `parseCapabilities`.
- Forge HTTP goes through `FleetHttpClient` (timeout, no redirects). Minted git tokens are never stored or logged.
- `FleetActivityService.record` runs inside the mutating `txManager.run`; payloads must not carry secrets.
- Jobs (`src/fleet/jobs/`): every state change goes through `JobTransitionsService` (table in `job-state.ts`, spec §5.4). Never write `FleetJob.state` directly.
- Assignment is `casAssign` only (spec §6.1); placement locks runner rows in id order and takes job rows with SKIP LOCKED during a fill.
- Server-owned terminal transitions of a held job bump `leaseEpoch` and withdraw pending commands (plan D4). Requeue bumps it too.
- Publish `fleet_job` live events and wake runners only after the transaction commits.
- Budgets (`src/fleet/budgets/`, S1b spec §2): window math, scope keys and the effective-pause rule live in `budget-rules.ts`; money is compared with `Prisma.Decimal`, never floats. Dispatch, requeue and both placement entry points read pauses through `BudgetGate`; the evaluator runs only after the sync transaction commits (`BudgetEvaluator.signal`). Budget activity payloads must not carry a `*Key` field (`FleetActivityService` rejects key-like names).
- Schedules (`src/fleet/schedules/`, S1b spec §3): `cron-schedule.ts` is the only importer of `cron-parser` (five fields, zone proof, 15-minute gap). The ticker claims a due schedule by compare-and-set on `nextFireAt`, then calls `FleetJobsService.dispatch` with no transaction open; a unique violation inside a transaction would abort it. A scheduled job's end is counted in `JobTransitionsService.apply` through `ScheduleProgressService` (same transaction, counted once through `scheduleCountedAt`). `JobSchedule.repoId` and `pinnedRunnerId` have no foreign key on purpose: a deleted repo or runner disables the schedule (`template_invalid`) instead of deleting it.
- Tests build the schema with `prisma db push --force-reset`; partial unique indexes live in `test/helpers/partial-indexes.ts` and must also be shipped verbatim by a migration.
- Every runner write (events, acks, token requests, bundles) is fenced by `(runnerId, leaseEpoch)` through `FenceService`; a mismatch queues one `ABANDON` and stores nothing.
- Never hold a transaction across the sync long-poll or forge HTTP. One failing job or ack in a sync is logged and skipped, never allowed to fail the whole request.
- Runner strings are untrusted: parse through `parseSyncRequest` (NUL replaced) and `interpretEvent` (bounded fields dropped, never fatal).
- Git tokens exist only in `GitTokenBroker`'s memory cache and the sync response: never logged, stored, or put in a command or activity payload.
- Fleet logs (S2a): `src/fleet/logs/`. `LogStore.append`/`replace` assume the caller holds `withLock(key)`; every
  `FleetJobLog` write for that key happens inside the same lock. Upload outcomes are HTTP 200 bodies, not errors.
  Reads are lock-free and bounded: one entries request scans at most `FLEET_LOG_SCAN_BYTES` and always moves its
  cursor (`log-lines.ts` is the cursor contract). Retention (`FleetLogRetentionProcessor`) deletes files first, then
  marks rows expired under the job row lock, and never touches attempts newer than the epoch it selected.
- `src/fleet/ingest/` (S2b): parses uploaded run bundles of terminal jobs into `FleetCostEvent`, `FleetStoryResult`
  and `FleetReviewResult` rows (kept forever), and corrects the job: cost raised to the ledger total, COMPLETED ->
  ESCALATED from finish-audit, "nothing pushed" reason. The queue is `FleetBundleIngest` (enqueued in the bundle
  upload transaction, drained by a kick plus a 30 s sweeper gated by `FLEET_SWEEP_ENABLED`). Bundle contents are
  untrusted: only allowlisted paths, capped sizes, typed field readers. Admin routes: `fleet/ingest`.
- `src/fleet/analytics/` (S2b): read-only cost and quality analytics over the ingest tables. The repository returns
  unrounded `Prisma.Decimal` sums; money becomes a 4-place string only in `AnalyticsService` (`usd4`, A7), never
  summed after rounding. SQL fragments for `groupBy`/`bucket` come from fixed maps keyed by validated enums. Project
  routes `projects/:slug/fleet/analytics/*` and `jobs/:id/analytics` (any member, agents 403); admin routes
  `fleet/analytics/spend` and `DELETE fleet/analytics` (confirmation required, ingest rows kept and marked). Spend takes
  `top` (1..12) and reports `medianJobCostUsd`; `analytics/ingest` counts pending and failed ingests for the project
  page notice.
- `src/fleet/dashboard/` (S2b (c)): read-only fleet health snapshot for `GET /fleet/dashboard` (global admin) and
  `GET /projects/:slug/fleet/dashboard` (member, agents 403). Attention rules are pure functions in `attention-*.ts`;
  the "queued but not placed" dry-run calls `evaluateRunners` from `jobs/placement-rules.ts`, never a copy of the
  placement logic. The API sends structured attention fields, no prose (clients word them). Project scope must not
  carry another project's job ids, features, repos or slugs, nor any credential provider, expiry or version.

## Notifications (fleet S4a)

- `src/notifications/` owns in-app notifications. Producers are outbox fan-out handlers (`FanOutPublisher.register`);
  domain services only enqueue events. `NotificationWriter.deliver` is the only insert path (eligibility, IN_APP
  preference, `createManyAndReturn({ skipDuplicates })` on `(userId, sourceType, sourceId, kind)`, then
  `UserEventBus.publish`). A producer throws only on database failure; a missing or deleted source ends quietly.
- `TicketWatcher` rows are insert-if-absent; unwatch is a sticky `muted` flag. Assignment and mentions ignore mute.
- `/me/*` routes are users-only and never take a user id. `/me/events` shares `LiveStreamRegistry` with project
  streams.
- Notification text: English `title`/`body` (CLI fallback, truncated to 200/280), web renders from `kind` + `params`.
- Mentions (S4a slice 3): `notifications/ticket-mention.resolver.ts` resolves `ticket_event` mentions (create description,
  comment body, newly added on description update via `data.previousDescription`) to enabled project members or
  global admins. `TICKET_UPDATED` events that change the description carry `previousDescription`.
- Fleet producers (S4a Part D) live in `src/notifications/fleet/`. Fleet modules never import the notifications
  module: they enqueue outbox events (`fleet_job_outcome` from `FleetJobOutcomeRecorder` inside
  `JobTransitionsService.apply` and the ingest transaction; `fleet_budget_incident` from `BudgetIncidentRecorder` inside
  `BudgetEvaluator.evaluate`; `fleet_health_alert` from `FleetHealthDetector`). Only the types in
  `src/outbox/global-outbox-types.ts` may omit `metadata.projectId`.
