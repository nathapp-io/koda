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
- **Prisma DI:** `@nathapp/nestjs-prisma` — inject `PrismaService<PrismaClient>`, access via `this.prisma.client`
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
├── main.ts                     # AppFactory.create — Fastify, prefix 'api', Swagger
├── app.module.ts               # Root module — imports all feature modules
├── @types/
│   └── jest-matchers.d.ts      # Custom Jest matcher types
├── auth/                       # JWT auth — uses @nathapp/nestjs-auth v3
│   ├── auth.module.ts          # NathappAuthModule.forRootAsync config
│   ├── auth.controller.ts      # Login, register, refresh endpoints
│   ├── auth.service.ts         # User CRUD, password hashing
│   ├── jwt-auth.provider.ts    # JwtAuthProvider — user lookup for JWT strategy
│   ├── types.ts                # Auth-related type definitions
│   ├── guards/
│   │   └── combined-auth.guard.ts  # Tries JWT first, falls back to ApiKeyGuard
│   ├── decorators/
│   │   └── current-user.decorator.ts  # @CurrentUser() — extracts user/agent from request
│   └── dto/                    # Login, register DTOs
├── agents/                     # Agent CRUD + API key auth
├── projects/                   # Project CRUD
├── tickets/                    # Ticket CRUD + state machine
│   └── state-machine/          # validateTransition()
├── comments/                   # Comment CRUD
├── labels/                     # Label CRUD + ticket labelling
├── ticket-links/               # External URL links (GitHub/GitLab PRs)
├── rag/                        # RAG-based knowledge base
│   ├── rag.module.ts           # Configurable embedding provider
│   ├── rag.service.ts          # Search, add, optimize operations
│   ├── rag.controller.ts       # KB endpoints
│   ├── embedding.service.ts    # Embedding generation
│   ├── embedding.interface.ts  # Provider contract
│   ├── providers/
│   │   ├── ollama-embedding.provider.ts
│   │   └── openai-embedding.provider.ts
│   └── strategies/             # FTS optimization strategies
│       ├── counter-optimize.strategy.ts
│       ├── cron-optimize.strategy.ts
│       └── manual-optimize.strategy.ts
├── webhook/                    # Outbound webhook dispatching
│   ├── webhook.module.ts
│   ├── webhook.service.ts      # CRUD for webhook subscriptions
│   ├── webhook-dispatcher.service.ts  # Fires webhooks on events
│   ├── webhook.controller.ts
│   └── webhook.dto.ts
├── ci-webhook/                 # Inbound CI/CD webhook receiver
│   ├── ci-webhook.module.ts
│   ├── ci-webhook.service.ts   # Processes CI events → ticket updates
│   ├── ci-webhook.controller.ts
│   └── ci-webhook.dto.ts
├── health/                     # Health check endpoint
│   ├── health.module.ts
│   └── health.controller.ts
├── common/
│   └── enums.ts                # Local TypeScript enums (SQLite can't use Prisma enums)
├── config/
│   ├── app.config.ts
│   ├── auth.config.ts
│   ├── database.config.ts
│   ├── rag.config.ts
│   └── env.validation.ts       # Joi schema, fail-fast
└── i18n/
    ├── en/                     # English translations (source of truth)
    └── zh/                     # Chinese translations
```

### Auth Model
- **Humans:** email + password → JWT (Bearer access token + refresh token)
- **Agents:** API key → HMAC lookup → `req.agent` + `req.actorType = 'agent'`
- **`CombinedAuthGuard`:** tries JWT first, falls back to ApiKeyGuard
- **`@CurrentUser()`** — custom decorator, extracts user/agent from request
- **`@IsPublic()`** — from `@nathapp/nestjs-auth`, bypasses auth guard
- **Auth module** uses `NathappAuthModule.forRootAsync` with `JwtAuthProvider` + `JwtStrategy` + `JwtRefreshStrategy`

---

## Enums — Local TypeScript Types (NOT Prisma)

SQLite doesn't support Prisma enums. All enums are defined in `src/common/enums.ts` as const objects:

```typescript
export const TicketStatus = { CREATED: 'CREATED', VERIFIED: 'VERIFIED', ... } as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];
```

Available enums: `TicketStatus`, `TicketType`, `Priority`, `CommentType`, `ActivityType`, `AgentRole`, `AutoAssignMode`

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
- **DI:** Inject `PrismaService<PrismaClient>` from `@nathapp/nestjs-prisma`
- **Access:** `this.prisma.client` returns the `PrismaClient` instance

### Key models
- `User`, `Agent`, `AgentRoleEntry`, `AgentCapabilityEntry`
- `Project`, `Ticket`, `Comment`, `Label`, `TicketLabel`
- `TicketActivity` — audit trail for status changes, assignments, etc.
- `TicketLink` — external URLs (GitHub/GitLab PRs linked to tickets)
- `Webhook` — outbound webhook subscriptions per project

### Key schema notes
- `Comment` uses `authorUserId` / `authorAgentId` (not `userId` / `agentId`)
- `TicketActivity` uses `actorUserId` / `actorAgentId` (not `actorId`)
- `AgentCapabilityEntry` (not `AgentCapability`) — note the full model name
- `Ticket.deletedAt` — soft delete field; filter with `deletedAt: null` in queries

---

## i18n — Server-Side Translations

Uses `@nathapp/nestjs-common` `I18nCoreModule` with file-based JSON loader.

### Translation files
```
src/i18n/
├── en/                    ← English (source of truth)
│   ├── agents.json
│   ├── auth.json
│   ├── comments.json
│   ├── common.json
│   ├── date.json
│   ├── exception.json
│   ├── projects.json
│   ├── tickets.json
│   └── validation.json
└── zh/                    ← Chinese (must mirror en/ structure)
    └── (same files)
```

### Key naming convention
- File = module name (e.g. `tickets.json` for `TicketsModule`)
- Keys are **flat** within each file: `"notFound": "Ticket not found"`
- Usage in services: `this.i18n.t('tickets.notFound')`
- Exception messages use `exception.json` keys

### Rules
1. **Every user-facing string** must use an i18n key — no hardcoded English in services/controllers
2. When adding a new module, create `{module}.json` in **both** `en/` and `zh/`
3. `en/` is the source of truth — add English keys first, then Chinese
4. Keys must be short and descriptive: `"slugTaken"` not `"theSlugIsAlreadyInUse"`

---

## Test Rules

### Test Organization

| Type | Location | Naming | Command |
|:-----|:---------|:-------|:--------|
| Unit | `src/**/*.spec.ts` | Co-located with source | `bun run test` |
| Integration | `test/integration/**/*.integration.spec.ts` | Grouped by concern | `npx jest test/integration` |
| E2E (API endpoint) | `test/e2e/api-endpoint/endpoint.e2e.spec.ts` | Single file, all endpoints | `npx jest test/e2e` |

### Integration test areas
- `test/integration/agent-permissions/` — agent role-based access control
- `test/integration/openapi-client/` — generated client compatibility
- `test/integration/openapi-spec/` — spec integrity validation
- `test/integration/rag/` — RAG search + embedding
- `test/integration/tickets/` — ticket status transitions

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

## Swagger Decorators (required on all controllers)

```typescript
@ApiTags('tickets')
@ApiBearerAuth()
@ApiOperation({ summary: 'Create a ticket' })
@ApiResponse({ status: 201, type: TicketResponseDto })
@ApiResponse({ status: 401, description: 'Unauthorized' })
```

All response DTO fields must have `@ApiProperty()`.

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
# Application
NODE_ENV=development
API_PORT=3100
GLOBAL_PREFIX=api

# Database
DATABASE_PROVIDER=sqlite          # sqlite | postgresql | mysql
DATABASE_URL=file:./koda.db

# JWT Auth
JWT_SECRET=                       # REQUIRED
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=               # REQUIRED
JWT_REFRESH_EXPIRES_IN=30d

# Agent API Key
API_KEY_SECRET=                   # REQUIRED — used for HMAC key hashing
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
