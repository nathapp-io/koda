# Codex Instructions

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

Turborepo monorepo with NestJS 11 + Fastify API, Nuxt 3 + Shadcn-nuxt web UI, and a Commander.js CLI. Built for human developers and AI agents to collaborate on bug fixes and enhancement tickets.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | **Node.js 22 + Bun 1.3.7+** — Bun as package manager |
| Language | **TypeScript strict** throughout all apps |
| API | **NestJS 11 + Fastify** via `@nathapp/nestjs-app` AppFactory |
| Web | **Nuxt 3 + Shadcn-nuxt + Tailwind CSS** |
| CLI | **Commander.js 12** — bin: `koda` |
| ORM | **Prisma 6** — SQLite (dev) / PostgreSQL / MySQL |
| Auth | **`@nathapp/nestjs-auth` v3** — JWT + API key, `@Public()` / `@Principal()` decorators |
| Responses | **`JsonResponse.Ok<T>(data)`** from `@nathapp/nestjs-common` v3 |
| Exceptions | **`AppException(code, args?, prefix?, httpStatus?)`** from `@nathapp/nestjs-common` v3 |
| Config | **Typed config** via `registerAs` + Joi validation (fail-fast on missing vars) |
| Logging | **`@nathapp/nestjs-logging`** — structured logging, no `console.log` |
| i18n | **`I18nCoreModule`** from `@nathapp/nestjs-common` — all user-facing messages use i18n keys |
| Rate limiting | **`@nathapp/nestjs-throttler`** — auth endpoints throttled (10 req/min) |
| Prisma | **`@nathapp/nestjs-prisma`** — replaces custom PrismaService |
| Test | **Jest 29** — API & CLI. `.env.test` auto-loaded via `dotenv` in `test-setup.ts` |
| Build | **Turborepo** — `bun run build` |
| Lint | **ESLint** — `bun run lint` |

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build all apps |
| `bun run dev` | Start all apps in dev mode |
| `bun run test` | Run all Jest tests |
| `bun run lint` | ESLint across all apps |
| `bun run db:generate` | Regenerate Prisma client (turbo delegates to `apps/api`) |
| `bun run db:migrate` | Run pending SQLite migrations (turbo delegates to `apps/api`) |
| `bun run db:studio` | Open Prisma Studio (turbo delegates to `apps/api`) |
| `bun run db:reset` | Reset database (turbo delegates to `apps/api`) |
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

## Test Organization Rules

| Type | Location | Naming |
|:-----|:---------|:-------|
| Unit | `src/**/*.spec.ts` | Co-located with source |
| Integration | `test/integration/**/*.integration.spec.ts` | Grouped in `test/integration/` |
| E2E | `test/e2e/**/*.e2e.spec.ts` | Grouped in `test/e2e/` |

**Rules:**
- No `us-XXX` folders in `test/` — nax acceptance tests go in `.nax/features/<feature>/`
- See `apps/api/CLAUDE.md` for the full API endpoint test rule (supertest, mandatory on every endpoint change)

## Repository Structure

```
koda/                              ← monorepo root
├── apps/
│   ├── api/                       ← NestJS 11 + Fastify backend
│   │   ├── prisma/
│   │   │   └── schema.prisma     ← Prisma schema (lives here, not root)
│   │   ├── src/
│   │   │   ├── main.ts           ← AppFactory bootstrap
│   │   │   ├── app.module.ts     ← Clean module (no APP_GUARD, no raw config)
│   │   │   ├── common/
│   │   │   │   └── enums.ts      ← Local TypeScript enums (SQLite can't use Prisma enums)
│   │   │   ├── config/
│   │   │   │   ├── app.config.ts
│   │   │   │   ├── auth.config.ts
│   │   │   │   ├── database.config.ts
│   │   │   │   └── env.validation.ts  ← Joi schema, fail-fast
│   │   │   ├── i18n/
│   │   │   │   ├── en/           ← English translations (source of truth)
│   │   │   │   └── zh/           ← Chinese translations
│   │   │   ├── auth/             ← @nathapp/nestjs-auth (no custom guards)
│   │   │   │   ├── auth.module.ts
│   │   │   │   ├── auth.controller.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── decorators/   ← @Public(), @Principal() re-exports
│   │   │   │   └── dto/
│   │   │   ├── agents/           ← Agent CRUD + API key auth
│   │   │   ├── projects/         ← Project CRUD
│   │   │   ├── tickets/          ← Ticket CRUD + state machine
│   │   │   │   └── state-machine/  ← validateTransition()
│   │   │   ├── comments/         ← Comments on tickets
│   │   │   └── labels/           ← Label CRUD + ticket labelling
│   │   ├── test/                 ← Acceptance tests (us-001 through us-009)
│   │   ├── .env.test             ← Test env vars (auto-loaded by test-setup.ts)
│   │   ├── .env.example
│   │   ├── test-setup.ts         ← dotenv + custom matchers
│   │   └── package.json          ← packageManager: bun@1.3.7
│   └── web/                      ← Nuxt 3 + Shadcn-nuxt
├── nax/
│   ├── config.json
│   ├── context.md                ← This file
│   └── constitution.md
├── package.json                  ← Bun workspaces root, db:* delegates via turbo
├── turbo.json
├── tsconfig.base.json
└── openapi.json                  ← Generated OpenAPI spec
```

## Ticket State Machine (Overview)

```
CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
   └→ REJECTED        └→ REJECTED    └→ IN_PROGRESS (fix failed)
```

All transitions enforced in `apps/api/src/tickets/state-machine/`. See `apps/api/CLAUDE.md` for the full transition rules table.

## Auth Model (Overview)

| Actor | Auth method |
|:------|:------------|
| Human | Email + password → JWT Bearer token |
| Agent | Raw API key → HMAC-SHA256 lookup |

See `apps/api/CLAUDE.md` for full auth model details.

## OpenAPI Spec & Client Generation

```
apps/api (NestJS + @nestjs/swagger)
  → bun run api:export-spec
  → openapi.json (monorepo root — source of truth)
  → bun run generate:cli  → apps/cli/src/generated/
  → bun run generate:web  → apps/web/generated/
```

**Rules:**
- Run `bun run generate` after ANY API endpoint change before touching CLI or web code
- Never manually edit files inside `*/generated/`
- `openapi.json` is committed so CI can regenerate clients without booting the API

## NestJS Development — Mandatory Skill

**Before writing any NestJS code**, read and follow the `nathapp-nestjs-patterns` skill. This skill is the **authoritative source** for all Nathapp NestJS patterns. Do NOT use generic NestJS alternatives when a Nathapp pattern exists.
