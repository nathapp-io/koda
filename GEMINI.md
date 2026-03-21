# Gemini CLI Context

This file is auto-generated from `nax/context.md`.
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

## Quality Gates — Run Before Completing Any Story

After writing or editing any file in `apps/api/`, **always run these two commands** and fix all errors before considering the story done:

```bash
# Lint (zero warnings allowed)
bun run --cwd apps/api lint

# TypeScript typecheck (zero errors allowed)
bun run --cwd apps/api type-check
```

**Common lint fixes:**
- Unused imports → remove them or rename with `_` prefix
- Unused variables → prefix with `_`
- `any` types in production code → use proper types
- `any` types in test files → allowed (configured in `.eslintrc.js` overrides)

## Test Organization Rules

| Type | Location | Naming | Purpose |
|:-----|:---------|:-------|:--------|
| Unit | `src/**/*.spec.ts` | Co-located next to source file | Test individual services/controllers |
| Integration | `src/**/*.integration.spec.ts` | Co-located next to source file | Test module interactions, DB queries |
| E2E | `test/e2e/*.e2e.spec.ts` | Grouped in `test/e2e/` | Full API lifecycle tests |

**Rules:**
1. Unit and integration tests are **co-located** with the source files they test
2. E2E tests live in `test/e2e/` — they bootstrap the full app and make HTTP requests
3. **No `us-XXX` or user-story folders** — nax acceptance tests go in `nax/features/<feature>/acceptance.test.ts`, NOT in `apps/api/test/`
4. Test file naming: `<name>.spec.ts` (unit), `<name>.integration.spec.ts` (integration), `<name>.e2e.spec.ts` (e2e)
5. Use `test-setup.ts` for global test configuration (env loading, custom matchers)

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

## Enums — Local TypeScript Types (NOT Prisma)

SQLite doesn't support Prisma enums. All enums are defined in `apps/api/src/common/enums.ts` as const objects with matching type aliases:

```typescript
export const TicketStatus = { CREATED: 'CREATED', VERIFIED: 'VERIFIED', ... } as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];
```

Available enums: `TicketStatus`, `TicketType`, `Priority`, `CommentType`, `ActivityType`, `AgentRole`

**Never import enums from `@prisma/client`** — they don't exist for SQLite schemas.

## Response & Exception Patterns

### Controller responses — `JsonResponse.Ok<T>(data)`

```typescript
// ✅ Correct
return JsonResponse.Ok<AgentResponseDto>(data);

// ❌ Wrong — do NOT double-cast
return JsonResponse.Ok(data as unknown as Dto) as unknown as JsonResponse<Dto>;
```

### Exceptions — `AppException(code, args?, prefix?, httpStatus?)`

```typescript
// ✅ Correct — numeric code + httpStatus
throw new AppException(CommonExceptionCode.NOT_FOUND, {}, 'tickets', HttpStatus.NOT_FOUND);

// ❌ Wrong — no string i18n keys
throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
```

### Convenience exception classes
```typescript
throw new NotFoundAppException();     // 404
throw new ForbiddenAppException();    // 403
throw new AuthException();            // 401
throw new ValidationAppException();   // 400
```

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

| Actor | Method | How |
|:------|:-------|:----|
| Human (web) | Email + password → JWT | `@nathapp/nestjs-auth` global guard |
| Agent (CLI/API) | API key → Bearer token | API key guard (HMAC-SHA256 hash) |
| Protected routes | Either JWT or API key | Global guard; open routes use `@Public()` |
| Current user | `@Principal()` decorator | Injects JWT payload or agent into handler |

- API keys: `crypto.randomBytes(32).toString('hex')` — shown once, stored as HMAC-SHA256 hash
- No custom guards — `@nathapp/nestjs-auth` handles everything via `useAppGlobalGuards()`

## Prisma & Database

- **Schema at:** `apps/api/prisma/schema.prisma` (NOT monorepo root)
- `DATABASE_URL` env: connection string (default: `file:./koda.db` for SQLite)
- `@nathapp/nestjs-prisma` PrismaService — registered as global module
- Access via `this.prisma.client` (PrismaClient instance)
- Ticket `number` is auto-incremented per project (not global) — use a transaction to safely get `MAX(number)+1`

### Key schema notes
- `Comment` uses `authorUserId` / `authorAgentId` (not `userId` / `agentId`)
- `TicketActivity` uses `actorUserId` / `actorAgentId` (not `actorId` / `actorType`)
- `AgentCapabilityEntry` (not `AgentCapability`) — note the full model name

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

## Environment Variables

See `apps/api/.env.example`. Key vars:

| Variable | Purpose | Default |
|:---------|:--------|:--------|
| `DATABASE_URL` | DB connection string | `file:./koda.db` |
| `JWT_SECRET` | JWT signing secret | *(required)* |
| `JWT_EXPIRES_IN` | JWT expiry | `7d` |
| `JWT_REFRESH_SECRET` | Refresh token secret | *(required)* |
| `API_KEY_SECRET` | HMAC secret for agent API keys | *(required)* |
| `API_PORT` | API server port | `3100` |

## NestJS Development — Mandatory Skill

**Before writing any NestJS code**, read and follow the `nathapp-nestjs-patterns` skill. This skill is the **authoritative source** for all Nathapp NestJS patterns. Do NOT use generic NestJS alternatives when a Nathapp pattern exists.
