# Project Context

This file is auto-generated from `nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-api`

**Language:** TypeScript

**Key dependencies:** @fastify/static, @nathapp/nestjs-prisma, @nestjs/common, @nestjs/config, @nestjs/core, @nestjs/platform-fastify, @nestjs/swagger, @prisma/client, @nestjs/cli, @nestjs/testing

---
# CLAUDE.md — Koda API (apps/api)

## ⚠️ Read First

**Before writing any NestJS code**, read the skill at:
`nathapp-nestjs-patterns`

That skill contains the authoritative patterns for:
- AppFactory bootstrap (Fastify)
- JWT auth with `@nathapp/nestjs-auth` v3
- Guard patterns, decorators, module structure
- TDD approach for NestJS services

---

## Project: Koda API

NestJS 11 + Fastify REST API for the Koda dev ticket tracker.

### Stack
- **Framework:** NestJS 11 + Fastify (`@nathapp/nestjs-app` AppFactory)
- **Auth:** `@nathapp/nestjs-auth` v3 — JWT (humans) + HMAC API key (agents)
- **ORM:** Prisma 6 — SQLite default, PostgreSQL/MySQL via `DATABASE_PROVIDER` env
- **Validation:** `class-validator` + `class-transformer`
- **Docs:** `@nestjs/swagger` v11 — spec at `/api/docs`
- **Tests:** Jest

### Key Constraints

1. **NEVER use `nestjs-iam`** — use `@nathapp/nestjs-auth` v3 only
2. **API key hashing: HMAC-SHA256** (not bcrypt) — must be deterministic for lookup:
   ```typescript
   createHmac('sha256', process.env.API_KEY_SECRET).update(rawKey).digest('hex')
   ```
3. **Password hashing: bcrypt** (rounds: 12)
4. **Ticket number auto-increment** — use `MAX(number)+1` in a Prisma transaction, NOT `autoincrement()`
5. **Soft deletes** — never hard-delete Tickets or Projects; set `deletedAt = now()`
6. **Global guard** — `CombinedAuthGuard` registered via `APP_GUARD`; mark public routes with `@IsPublic()`

### Project Structure
```
src/
├── main.ts                  # AppFactory.create — Fastify, prefix 'api', Swagger
├── app.module.ts            # Root module
├── prisma/                  # PrismaService (global)
├── auth/                    # JWT auth, strategies, guards, decorators
│   ├── strategies/jwt.strategy.ts
│   ├── guards/jwt-auth.guard.ts
│   ├── guards/combined-auth.guard.ts
│   └── decorators/          # @IsPublic(), @CurrentUser()
├── agents/                  # Agent CRUD + ApiKeyGuard
├── projects/                # Project CRUD
├── tickets/                 # Ticket CRUD + state machine
│   └── state-machine/       # validateTransition()
├── comments/                # Comment CRUD
└── labels/                  # Label CRUD
```

### Auth Model
- **Humans:** email + password → JWT (Bearer access token)
- **Agents:** API key → HMAC lookup → `req.agent` + `req.actorType = 'agent'`
- **`CombinedAuthGuard`:** tries JWT first, falls back to ApiKeyGuard

### Ticket State Machine
```
CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
                                              ↘ IN_PROGRESS (fix failed)
CREATED → REJECTED
VERIFIED → REJECTED
```
All transitions require a comment of the matching `CommentType`. See `src/tickets/state-machine/ticket-transitions.ts`.

### Ticket References
Format: `KODA-42` where `KODA` = `Project.key` and `42` = `Ticket.number`  
Resolve via: `{ projectId_number: { projectId, number } }`

### Environment Variables
```bash
DATABASE_PROVIDER=sqlite          # sqlite | postgresql | mysql
DATABASE_URL=file:./koda.db
JWT_SECRET=                       # REQUIRED
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=               # REQUIRED
JWT_REFRESH_EXPIRES_IN=30d
API_KEY_SECRET=                   # REQUIRED — used for HMAC key hashing
API_PORT=3100
API_PREFIX=api
```

### Commands
```bash
bun run build          # tsc compile
bun run dev            # nest start --watch
bun run test           # jest
bun run type-check     # tsc --noEmit
bun run lint           # eslint src
bun run db:migrate     # prisma migrate dev
bun run db:generate    # prisma generate
```

### Swagger Decorators (required on all controllers)
```typescript
@ApiTags('tickets')
@ApiBearerAuth()
@ApiOperation({ summary: 'Create a ticket' })
@ApiResponse({ status: 201, type: TicketResponseDto })
@ApiResponse({ status: 401, description: 'Unauthorized' })
```

All response DTO fields must have `@ApiProperty()`.
