# Project Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `koda`

**Language:** TypeScript

**Key dependencies:** @prisma/client, @typescript-eslint/eslint-plugin, @typescript-eslint/parser, typescript

---
# Koda — Dev Ticket Tracker

Koda is a Bun-managed Turborepo monorepo for tracking developer tickets and coordinating work between humans and AI agents.

## Context Source Of Truth

This file is the root source-of-truth for Codex/NAX repository guidance.

Rules:
- `AGENTS.md` at the repo root is generated from this file
- app-specific context must live under `.nax/mono/apps/<app>/context.md`
- in this monorepo, do not treat `apps/*/AGENTS.md` as the authoring source
- when repo-level architecture or workflow changes, update this file first

## Monorepo Shape

```text
koda/
├── apps/
│   ├── api/     # NestJS API, system of record
│   ├── cli/     # Commander.js API client for agents/terminals
│   └── web/     # Nuxt SSR app for humans
├── packages/
│   ├── eslint-config/
│   └── typescript-config/
├── docs/
├── .nax/
│   ├── context.md
│   └── mono/apps/{api,cli,web}/context.md
├── openapi.json
├── package.json
├── turbo.json
└── tsconfig.base.json
```

## System Architecture

The architecture is client-server within a monorepo:
- `apps/api` owns persistence, auth, domain rules, workflow transitions, RAG, and integrations
- `apps/web` is a Nuxt 3 SSR client that proxies `/api/**` to the API service
- `apps/cli` is a thin CLI client that calls the API through a generated OpenAPI client
- shared TypeScript and ESLint config live in `packages/*`

The detailed architecture reference lives in `docs/architecture.md`.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | Node.js 22+ and Bun workspaces |
| Language | TypeScript strict |
| Monorepo | Turborepo |
| API | NestJS 11 + Fastify + Prisma |
| Web | Nuxt 3 + Shadcn-nuxt + Tailwind CSS |
| CLI | Commander.js 12 |
| Database | Prisma with SQLite default; PostgreSQL/MySQL supported |
| Test | Jest; Playwright in web |
| i18n | API and web maintain separate translation systems |

## Workspace Responsibilities

### `apps/api`
- source of truth for business logic
- exports the OpenAPI spec to `openapi.json`
- owns Prisma schema and migrations
- owns ticket state transitions, auth, RAG, webhooks, and CI webhook intake

### `apps/cli`
- remains thin
- should use generated client code in `apps/cli/src/generated/`
- should not reimplement API business rules locally
- resolves auth and project context from flags, env, user config, and local project config

### `apps/web`
- remains a UI client over the API
- intentionally uses Nuxt-native composables for API access instead of a generated client
- proxies browser requests through Nuxt to the API host
- should not duplicate backend business rules in components/pages

### `packages/*`
- shared config packages used by the apps
- keep repo-wide lint/type rules centralized here when possible

## OpenAPI And Client Generation

Current code-backed flow:

```text
apps/api
  -> bun run api:export-spec
  -> openapi.json
  -> bun run generate:cli
  -> apps/cli/src/generated/
```

Rules:
- run `bun run generate` after API contract changes that affect the CLI
- do not edit generated files under `apps/cli/src/generated/`
- `openapi.json` is committed and should reflect the current API contract
- `apps/web/generated/` is intentionally not part of the current architecture
- web client generation was dropped because Nuxt composables and proxying are the preferred integration pattern for `apps/web`

## Monorepo Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build all workspaces through Turbo |
| `bun run dev` | Run workspace dev tasks |
| `bun run test` | Run tests across workspaces |
| `bun run lint` | Run ESLint across workspaces |
| `bun run type-check` | Run type checks across workspaces |
| `bun run db:generate` | Regenerate Prisma client in `apps/api` |
| `bun run db:migrate` | Apply/create Prisma migrations in `apps/api` |
| `bun run db:studio` | Open Prisma Studio from `apps/api` |
| `bun run db:reset` | Reset the database in `apps/api` |
| `bun run api:export-spec` | Build/export API spec to `openapi.json` |
| `bun run generate` | Export spec and regenerate CLI client |

## Engineering Rules

- keep business logic in the API unless there is a strong reason not to
- prefer updating tests alongside behavior changes
- treat soft-delete, auth, and workflow constraints as API-owned invariants
- never manually edit generated client files
- never manually edit generated `AGENTS.md`; edit the matching `context.md` source instead
- when changing app-specific guidance, update the file under `.nax/mono/apps/<app>/context.md`

## Tests

Default organization rules:
- unit tests: `src/**/*.spec.ts`
- integration tests: `test/integration/**/*.integration.spec.ts`
- e2e tests: `test/e2e/**/*.e2e.spec.ts`

Repository rules:
- do not create `us-XXX` folders under app `test/` directories
- nax acceptance material belongs under `.nax/features/<feature>/`
- app-specific test guidance belongs in `.nax/mono/apps/<app>/context.md`

## i18n

API and web both support English and Chinese, but they are separate systems.

Rules:
- API strings must use API i18n files under `apps/api/src/i18n/{en,zh}`
- web strings must use web i18n files under `apps/web/i18n/locales/{en,zh}.json`
- do not assume keys are shared across API and web

## App-Specific Contexts

Read the matching app context before making app-local changes:
- `.nax/mono/apps/api/context.md`
- `.nax/mono/apps/cli/context.md`
- `.nax/mono/apps/web/context.md`

If a new app is added to this monorepo, create its context file under `.nax/mono/apps/<new-app>/context.md`.