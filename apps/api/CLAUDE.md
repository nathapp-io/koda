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
4. **Ticket number auto-increment** — use `MAX(number)+1` in a Prisma transaction, NOT `autoincrement()`; always include soft-deleted tickets in the `findFirst` so numbers are never reused
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

---

## Enums — Local TypeScript Types (NOT Prisma)

SQLite doesn't support Prisma enums. All enums are defined in `src/common/enums.ts` as const objects:

```typescript
export const TicketStatus = { CREATED: 'CREATED', VERIFIED: 'VERIFIED', ... } as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];
```

Available enums: `TicketStatus`, `TicketType`, `Priority`, `CommentType`, `ActivityType`, `AgentRole`

**Never import enums from `@prisma/client`** — they don't exist for SQLite schemas.

---

## Response & Exception Patterns

### Controller responses — `JsonResponse.Ok<T>(data)`

```typescript
// ✅ Correct
return JsonResponse.Ok<AgentResponseDto>(data);

// ❌ Wrong — do NOT double-cast
return JsonResponse.Ok(data as unknown as Dto) as unknown as JsonResponse<Dto>;
```

### Exceptions — use convenience classes

```typescript
throw new NotFoundAppException();     // 404
throw new ForbiddenAppException();    // 403
throw new AuthException();            // 401
throw new ValidationAppException();   // 400
```

For custom codes: `throw new AppException(CommonExceptionCode.NOT_FOUND, {}, 'tickets', HttpStatus.NOT_FOUND);`

---

## Ticket State Machine

```
CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
   │           │            │              └→ IN_PROGRESS (fix failed)
   └→ REJECTED └→ REJECTED  └→ VERIFIED (sent back)
```

**Transition rules — enforced in `src/tickets/state-machine/`:**

| Transition | Required comment type |
|:-----------|:---------------------|
| CREATED → VERIFIED | `VERIFICATION` |
| IN_PROGRESS → VERIFY_FIX | `FIX_REPORT` |
| VERIFY_FIX → CLOSED | `REVIEW` |
| VERIFY_FIX → IN_PROGRESS | `REVIEW` |
| Any → REJECTED | `GENERAL` |

**Rules:**
- All transitions must go through `validateTransition()` — never update ticket status directly
- `verifyFix` endpoint must guard that ticket is in `VERIFY_FIX` status before proceeding
- Ticket references: `KODA-42` format where `KODA` = `Project.key`, `42` = `Ticket.number`

---

## Prisma & Database

- **Schema at:** `apps/api/prisma/schema.prisma`
- Access via `this.prisma.client` (PrismaClient instance from `@nathapp/nestjs-prisma`)

### Key schema notes
- `Comment` uses `authorUserId` / `authorAgentId` (not `userId` / `agentId`)
- `TicketActivity` uses `actorUserId` / `actorAgentId` (not `actorId`)
- `AgentCapabilityEntry` (not `AgentCapability`) — note the full model name

---

## Test Rules

### Test Organization

| Type | Location | Naming | Command |
|:-----|:---------|:-------|:--------|
| Unit | `src/**/*.spec.ts` | Co-located with source | `bun run test` |
| Integration | `test/integration/**/*.integration.spec.ts` | Grouped by concern | `npx jest test/integration` |
| E2E (API endpoint) | `test/e2e/api-endpoint/endpoint.e2e.spec.ts` | Single file, all endpoints | `npx jest test/e2e` |

### E2E Test Rule — **Mandatory**

**Every API endpoint addition or change must be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`.**

- Tests use **supertest** against a bootstrapped NestJS app (no live server needed)
- The file is the single source of truth for the full API lifecycle — do not split it
- Each `describe` block maps to a resource or workflow section
- Response shape must match the actual `JsonResponse.Ok(data)` wrapper: `res.body.data`
- Use the `body<T>(res)` helper to unwrap: `const data = body<MyDto>(res);`

**Template for a new endpoint test block:**

```typescript
describe('N. Resource — Action', () => {
  it('METHOD /api/path — description', async () => {
    const res = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ /* payload */ })
      .expect(201);

    const data = body<{ id: string; name: string }>(res);
    expect(data.name).toBe('expected');
  });
});
```

**Rules:**
1. Add the test block before implementing the endpoint — TDD
2. Use `userAccessToken` (JWT) for human-auth routes, `agentApiKey` (raw key) for agent routes
3. Test both happy path AND at least one error case (400/401/404) per endpoint
4. Assert the **exact status code** — do not use `.expect(res => res.status < 300)`
5. After running, all 50+ tests in the file must still pass — no regressions

---

## Quality Gates — Run Before Completing Any Story

```bash
# Lint (zero warnings allowed)
bun run --cwd apps/api lint

# TypeScript typecheck (zero errors allowed)
bun run --cwd apps/api type-check

# E2E tests (all must pass)
cd apps/api && DATABASE_URL=file:./koda-test.db npx jest --forceExit test/e2e
```

**Common lint fixes:**
- Unused imports → remove or rename with `_` prefix
- Unused variables → prefix with `_`
- `any` types in production code → use proper types
- `any` types in test files → allowed (configured in `.eslintrc.js` overrides)

---

## Environment Variables

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

---

## Commands

```bash
bun run build          # tsc compile
bun run dev            # nest start --watch
bun run test           # jest (unit tests)
bun run type-check     # tsc --noEmit
bun run lint           # eslint src
bun run db:migrate     # prisma migrate dev
bun run db:generate    # prisma generate
```

---

## Swagger Decorators (required on all controllers)

```typescript
@ApiTags('tickets')
@ApiBearerAuth()
@ApiOperation({ summary: 'Create a ticket' })
@ApiResponse({ status: 201, type: TicketResponseDto })
@ApiResponse({ status: 401, description: 'Unauthorized' })
```

All response DTO fields must have `@ApiProperty()`.
