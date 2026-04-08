---
paths:
  - "apps/api/**/*"
---

# API Rules — apps/api

## NestJS
- Before writing any NestJS code, read and follow the `nathapp-nestjs-patterns` skill
- This skill is the **authoritative source** — do NOT use generic NestJS alternatives when a Nathapp pattern exists

## Auth
- **NEVER use `nestjs-iam`** — use `@nathapp/nestjs-auth` v3 only
- API key hashing: **HMAC-SHA256** (not bcrypt) — must be deterministic for lookup
- Password hashing: **bcrypt** (rounds: 12)
- Global guard: `CombinedAuthGuard` via `APP_GUARD` — mark public routes with `@IsPublic()`

## Data
- **Soft deletes only** — never hard-delete Tickets or Projects; set `deletedAt = now()`
- Ticket number auto-increment: use `MAX(number)+1` in a Prisma transaction, NOT `autoincrement()`; always include soft-deleted tickets so numbers are never reused
- **Never import enums from `@prisma/client`** — SQLite doesn't support native Prisma enums; use `src/common/enums.ts`

## State Machine
- **State machine is the law** — all ticket transitions must go through `validateTransition()`
- Never update ticket status directly via Prisma
- Ticket references use `PROJECT_KEY-NUMBER` format (e.g. `KODA-42`)

## Prisma
- Inject `PrismaService<PrismaClient>` from `@nathapp/nestjs-prisma`
- Access client via `this.prisma.client`
- Schema lives at `apps/api/prisma/schema.prisma` — never at monorepo root
- In tests, use official Prisma testing utilities from `@nathapp/nestjs-prisma`:
  ```ts
  import { createMockPrismaClient, createMockPrismaService } from '@nathapp/nestjs-prisma';
  ```

## Responses & Exceptions
- Controllers return `JsonResponse.Ok<T>(data)` — never double-cast
- Use convenience exception classes: `NotFoundAppException`, `ForbiddenAppException`, `AuthException`, `ValidationAppException`

## Swagger
- All controllers must have `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse` decorators
- All response DTO fields must have `@ApiProperty()`

## Testing
- Every API endpoint change must be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`
- E2E file is the single source of truth for API lifecycle — do not split it
- Test both happy path AND at least one error case per endpoint
- Assert exact status codes — no range checks
- For unit/integration tests that mock DB access, must use `createMockPrismaService()` as the provider value for `PrismaService`
- Use `createMockPrismaClient()` when you need direct client-level mocking behavior
- Avoid hand-rolled Prisma mock objects unless there is a clear gap in the provided utilities

## Quality Gates (run before completing any story)
```bash
bun run --cwd apps/api lint          # zero warnings
bun run --cwd apps/api type-check    # zero errors
cd apps/api && DATABASE_URL=file:./koda-test.db npx jest --forceExit test/e2e
```

## i18n
- Translation files: `src/i18n/{en,zh}/*.json` — one file per module
- Keys are flat within each file: `"notFound": "Ticket not found"`
- Usage: `this.i18n.t('tickets.notFound')`
- When adding a new module, create `{module}.json` in both `en/` and `zh/`

## Request Context Anti-Patterns
- **Never use `@Req() req: any`** — extract user/agent from typed request context
  ```ts
  // ❌ Wrong
  @Req() req: any
  const actorType = req.user?.extra?.role

  // ✅ Correct — use @CurrentUser() decorator with proper typing
  ```
- **Never pass `actorType` through method chains** — extract from request context at controller entry point
- **Never use `@Optional()` for required dependencies** — inject normally, don't null-check everywhere

## Dependency Injection Anti-Patterns
- **Use constructor injection with types** — never string-based DI tokens
  ```ts
  // ❌ Wrong
  @Inject('PrismaService') private prisma: PrismaService

  // ✅ Correct
  constructor(private readonly prisma: PrismaService) {}
  ```

## Prisma Anti-Patterns
- **Return DTOs, not raw Prisma objects** — map to response DTOs before returning
  ```ts
  // ❌ Wrong
  return this.prisma.ticket.findUnique({ where: { id } })

  // ✅ Correct
  return JsonResponse.Ok(TicketDTO.from(ticket))
  ```
- **Use Prisma error codes (`err.code`)** — not string matching on error messages
- **DTOs must have `@ApiProperty()` decorators** — Swagger won't document undocumented types
