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
- Prisma 6 via `@nathapp/nestjs-prisma`
- `@nathapp/nestjs-auth` v3 for auth
- `@nathapp/nestjs-common` for JSON envelope, exceptions, i18n helpers
- `@nathapp/nestjs-logging`
- `@nathapp/nestjs-throttler`
- Jest for unit, integration, and e2e tests

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

Useful scripts:
- `bun run test`
- `bun run test:integration`
- `bun run db:generate`
- `bun run db:migrate`

## OpenAPI Contract

The API is responsible for `openapi.json` at the repo root.

Rules:
- when controller/DTO contract changes are made, regenerate the spec from the monorepo root
- downstream CLI client generation depends on this spec
- do not edit generated downstream clients manually to compensate for stale API contracts
