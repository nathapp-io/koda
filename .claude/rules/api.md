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
