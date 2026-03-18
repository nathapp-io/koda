# Project Context

This file is auto-generated from `nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `koda`

**Language:** TypeScript

**Key dependencies:** @prisma/client, @typescript-eslint/eslint-plugin, @typescript-eslint/parser, typescript, prisma

---
# Koda — Dev Ticket Tracker

Turborepo monorepo with NestJS 11 + Fastify API, Nuxt 3 + Shadcn-nuxt web UI, and a Commander.js CLI. Built for human developers and AI agents to collaborate on bug fixes and enhancement tickets.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | **Node.js 22 + Bun 1.3.7+** — Bun as package manager |
| Language | **TypeScript strict** throughout all apps |
| API | **NestJS 11 + Fastify** via AppFactory |
| Web | **Nuxt 3 + Shadcn-nuxt + Tailwind CSS** |
| CLI | **Commander.js 12** — bin: `koda` |
| ORM | **Prisma 6** — SQLite (dev) / PostgreSQL / MySQL |
| Auth (guards) | **`@nathapp/nestjs-auth` v3** — JWT + CASL |
| Test | **Jest 29** — API & CLI |
| Build | **Turborepo** — `bun run build` |
| Lint | **ESLint** — `bun run lint` |

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build all apps |
| `bun run dev` | Start all apps in dev mode |
| `bun run test` | Run all Jest tests |
| `bun run lint` | ESLint across all apps |
| `bun run db:generate` | Regenerate Prisma client |
| `bun run db:migrate` | Run pending SQLite migrations |
| `bun run db:studio` | Open Prisma Studio |
| `bun run api:export-spec` | Export OpenAPI spec → `openapi.json` at root |
| `bun run generate` | Export spec + regenerate CLI + web clients |
| `cd apps/api && bun run test` | API tests only |
| `cd apps/cli && bun run test` | CLI tests only |

## Engineering Persona

- **Senior Engineer mindset**: check edge cases, null/undefined, race conditions, and error states.
- **TDD first**: write or update tests before implementation when the story calls for it.
- **Stuck rule**: if the same test fails 2+ iterations, stop, summarise failed attempts, reassess approach.
- **Never push to remote** — the human reviews and pushes.
- **State machine is the law** — all ticket transitions must go through `validateTransition()`. Never update ticket status directly.

## Quality Gates — Run Before Completing Any Story

After writing or editing any file in `apps/api/`, **always run these two commands** and fix all errors before considering the story done:

```bash
# Lint (zero warnings allowed)
bun run --cwd apps/api lint

# TypeScript typecheck (zero errors allowed)
bun run --cwd apps/api type-check
```

**Common lint fixes:**
- Unused imports → remove them or rename with `_` prefix (e.g. `import { Foo as _Foo }`)
- Unused variables → prefix with `_` (e.g. `const _result = ...`)
- `any` types in production code → use proper types (e.g. `Record<string, unknown>`, Prisma types from `@prisma/client`, `FastifyRequest`)
- `any` types in test files → allowed (configured in `.eslintrc.js` overrides)
- `no-explicit-any` in `*.spec.ts` → suppressed by ESLint override, no action needed

**TypeScript fixes:**
- Missing types → add explicit type annotations
- Import order issues → reorder and re-export as needed
- Prisma return types → import from `@prisma/client` (e.g. `import type { Agent } from '@prisma/client'`)

## Mandatory Quality Checks (run after EVERY file change)

After writing or modifying any file in `apps/api/`, you **must** run both checks and fix all errors before considering the story done:

```bash
# Lint — must exit 0 with 0 warnings
bun run --cwd apps/api lint

# TypeScript — must exit 0
bun run --cwd apps/api type-check
```

**Rules for common lint errors:**
- Unused variables/imports in test files (`*.spec.ts`): prefix with `_` (e.g. `let _configService`)
- `no-explicit-any` in production code: add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` above the line
- `no-explicit-any` in test files: already disabled by ESLint override — no action needed
- Fix all errors before committing; warnings count as errors (`--max-warnings=0`)

## Repository Structure

```
koda/                              ← monorepo root
├── apps/
│   ├── api/                       ← NestJS 11 + Fastify backend
│   │   ├── src/
│   │   │   ├── main.ts            ← AppFactory bootstrap
│   │   │   ├── app.module.ts
│   │   │   ├── auth/              ← Login/register/refresh + JWT strategy
│   │   │   │   ├── auth.module.ts
│   │   │   │   ├── auth.controller.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── strategies/    ← jwt.strategy.ts
│   │   │   │   ├── guards/        ← combined-auth.guard.ts (JWT + API key)
│   │   │   │   └── dto/
│   │   │   ├── agents/            ← Agent CRUD + API key auth
│   │   │   │   ├── agents.module.ts
│   │   │   │   ├── agents.controller.ts
│   │   │   │   ├── agents.service.ts
│   │   │   │   ├── guards/        ← api-key.guard.ts
│   │   │   │   └── dto/
│   │   │   ├── projects/          ← Project CRUD
│   │   │   │   ├── projects.module.ts
│   │   │   │   ├── projects.controller.ts
│   │   │   │   ├── projects.service.ts
│   │   │   │   └── dto/
│   │   │   ├── tickets/           ← Ticket CRUD + state machine
│   │   │   │   ├── tickets.module.ts
│   │   │   │   ├── tickets.controller.ts
│   │   │   │   ├── tickets.service.ts
│   │   │   │   ├── state-machine/ ← validateTransition()
│   │   │   │   └── dto/
│   │   │   ├── comments/          ← Comments on tickets
│   │   │   │   ├── comments.module.ts
│   │   │   │   ├── comments.controller.ts
│   │   │   │   ├── comments.service.ts
│   │   │   │   └── dto/
│   │   │   └── prisma/            ← PrismaService + PrismaModule (global)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── nest-cli.json
│   └── web/                       ← Nuxt 3 + Shadcn-nuxt
│       ├── pages/
│       │   ├── index.vue          ← Project list dashboard
│       │   ├── login.vue
│       │   └── [project]/
│       │       ├── index.vue      ← Ticket board (kanban by status)
│       │       ├── tickets/[id].vue
│       │       └── agents.vue
│       ├── components/
│       │   ├── ui/                ← Shadcn-nuxt generated components
│       │   ├── TicketCard.vue
│       │   ├── TicketBoard.vue
│       │   └── AgentBadge.vue
│       ├── composables/
│       │   └── useApi.ts          ← API client wrapper
│       ├── layouts/
│       ├── nuxt.config.ts
│       └── package.json
├── packages/
│   └── cli/                       ← Commander.js CLI (@nathapp/koda bin)
│       ├── src/
│       │   ├── index.ts           ← Program entrypoint
│       │   ├── config.ts          ← ~/.koda/config.json (apiUrl + apiKey)
│       │   ├── commands/
│       │   │   ├── login.ts       ← koda login --api-key <key>
│       │   │   ├── project.ts     ← koda project list|show
│       │   │   ├── ticket.ts      ← koda ticket create|list|show|verify|...
│       │   │   ├── comment.ts     ← koda comment add
│       │   │   └── agent.ts       ← koda agent me|pickup
│       │   └── utils/
│       │       ├── api.ts         ← axios client, reads config, Bearer token
│       │       └── output.ts      ← human-readable vs --json output
│       ├── package.json           ← bin: { koda: ./dist/index.js }
│       └── tsconfig.json
├── prisma/
│   └── schema.prisma              ← Shared schema (SQLite/PG/MySQL)
├── nax/
│   ├── config.json                ← nax run config
│   ├── context.md                 ← This file
│   └── constitution.md            ← Coding standards
├── package.json                   ← Bun workspaces root
├── turbo.json
├── tsconfig.base.json
└── .env.example
```

## OpenAPI Spec & Client Generation

The CLI and web app get their typed API clients from a generated OpenAPI spec.

```
apps/api (NestJS + @nestjs/swagger)
  → bun run api:export-spec
  → openapi.json (monorepo root — source of truth)
  → bun run generate:cli  → apps/cli/src/generated/   (@hey-api/client-axios)
  → bun run generate:web  → apps/web/generated/            (@hey-api/client-fetch)
```

**Rules:**
- Run `bun run generate` after ANY API endpoint change before touching CLI or web code
- Never manually edit files inside `*/generated/` — they are overwritten on next generate
- `openapi.json` is committed to the repo so CI can regenerate clients without booting the API
- Export script: `apps/api/scripts/export-spec.ts` — boots NestJS, dumps spec, exits

---

## Ticket State Machine

```
Bug / Enhancement:
  CREATED ──→ VERIFIED ──→ IN_PROGRESS ──→ VERIFY_FIX ──→ CLOSED
     │            │              │               │
     └→ REJECTED  └→ REJECTED   └→ VERIFIED     └→ IN_PROGRESS
                                (sent back)      (fix failed)
```

**Transition rules — all enforced in `tickets/state-machine/`:**

| Transition | Required comment type |
|:-----------|:---------------------|
| CREATED → VERIFIED | `VERIFICATION` |
| IN_PROGRESS → VERIFY_FIX | `FIX_REPORT` |
| VERIFY_FIX → CLOSED | `REVIEW` |
| VERIFY_FIX → IN_PROGRESS | `REVIEW` |
| Any → REJECTED | `GENERAL` |

## Auth Model

| Actor | Method | Guard |
|:------|:-------|:------|
| Human (web) | Email + password → JWT | `JwtAuthGuard` |
| Agent (CLI/API) | API key → Bearer token | `ApiKeyGuard` |
| Protected routes | Either JWT or API key | `CombinedAuthGuard` |

- API keys: `crypto.randomBytes(32).toString('hex')` — shown once, stored as bcrypt hash
- JWT via `@nathapp/nestjs-auth` v3 guards + strategies

## Prisma & Database

- Schema at: `prisma/schema.prisma` (monorepo root level)
- `DATABASE_PROVIDER` env: `"sqlite"` | `"postgresql"` | `"mysql"`
- `DATABASE_URL` env: connection string for chosen provider
- `PrismaService` lives in `apps/api/src/prisma/` — registered as global module
- Ticket `number` is auto-incremented per project (not global) — use a transaction to safely get `MAX(number)+1`

## NestJS Development — Mandatory Skill

**Before writing any NestJS code**, read and follow the `nathapp-nestjs-patterns` skill:

This skill is the **authoritative source** for all Nathapp NestJS patterns including:
- App bootstrapping with Fastify via `AppFactory`
- JWT auth with CASL permissions
- Module registration (`register` / `registerAsync`)
- TDD-driven development with `@golevelup/ts-jest`
- Enterprise-grade error handling and service patterns

Do NOT use generic NestJS alternatives when a Nathapp pattern exists in this skill.

---

## Coding Standards & Architecture Patterns

- **NestJS patterns**: follow `@nathapp/nestjs-app` AppFactory bootstrap pattern
- **DTOs**: use `class-validator` + `class-transformer` for all request bodies
- **Swagger**: all controllers decorated with `@ApiTags`, DTOs with `@ApiProperty`
- **Error handling**: throw NestJS built-in exceptions (`BadRequestException`, `NotFoundException`, etc.)
- **Guards**: apply `CombinedAuthGuard` globally; mark public routes with `@IsPublic()`
- **Services**: no business logic in controllers — all logic in services
- **Dependency injection**: use NestJS DI for all service dependencies
- **Testing**: `@nestjs/testing` TestingModule, mock `PrismaService` with `jest.fn()`
- **Git**: conventional commits, one concern per commit

## CLI Output Pattern

```typescript
// All commands support --json flag
if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  // Human-readable table / chalk-colored output
}
```

## Environment Variables

See `.env.example` at monorepo root. Key vars:

| Variable | Purpose | Default |
|:---------|:--------|:--------|
| `DATABASE_PROVIDER` | DB engine | `sqlite` |
| `DATABASE_URL` | DB connection string | `file:./koda.db` |
| `JWT_SECRET` | JWT signing secret | *(required)* |
| `JWT_EXPIRES_IN` | JWT expiry | `7d` |
| `API_PORT` | API server port | `3100` |
| `NUXT_PUBLIC_API_BASE_URL` | Web → API base URL | `http://localhost:3100/api` |
