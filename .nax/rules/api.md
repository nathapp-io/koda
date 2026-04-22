---
paths:
  - "apps/api/*"
---

# API Rules — apps/api

## Read-First
- Follow `nathapp-nestjs-patterns` before implementing NestJS changes
- Prefer Nathapp patterns over generic alternatives when both exist

## Auth
- Use `@nathapp/nestjs-auth` v3; do not use `nestjs-iam`
- API key hashing: deterministic HMAC-SHA256 for lookup
- Password hashing: bcrypt (rounds 12)
- Register `CombinedAuthGuard` globally (`APP_GUARD`); mark public routes with `@IsPublic()`

## Data & Domain
- Soft-delete Projects/Tickets only (`deletedAt`), no hard deletes
- Ticket numbers: allocate with `MAX(number)+1` in Prisma transaction
- Include soft-deleted tickets in numbering; do not reuse numbers
- Do not import enums from `@prisma/client`; use `src/common/enums.ts`
- All ticket transitions must go through `validateTransition()`
- Do not update ticket status directly via Prisma
- Ticket refs use `PROJECT_KEY-NUMBER` format
- Keep workflow constraints centralized in state-machine validation

## Prisma
- Inject `PrismaService<PrismaClient>` from `@nathapp/nestjs-prisma`
- Access client via `this.prisma.client`
- Schema path is `apps/api/prisma/schema.prisma`
- In tests, prefer `createMockPrismaService()` / `createMockPrismaClient()` from `@nathapp/nestjs-prisma`
- Avoid hand-rolled Prisma mock shapes unless there is a specific gap

## Responses & Exceptions
- Controllers return `JsonResponse.Ok<T>(data)`
- Prefer exceptions from `@nathapp/nestjs-common`
- Use app exception classes (`NotFoundAppException`, `ForbiddenAppException`, `AuthException`, `ValidationAppException`) where applicable
- For domain/authz 403, throw `ForbiddenAppException`
- If no app exception equivalent exists, document the exception choice inline

## Swagger
- Controllers require `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse`
- Response DTO fields must have `@ApiProperty()`

## Testing
- API endpoint changes must be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`
- Keep API lifecycle e2e coverage in this file (do not split)
- Cover happy path and at least one error case per endpoint
- Assert exact status codes
- When mocking DB access in unit/integration tests, use official mock helpers as provider values

## Quality Gates
- `bun run --cwd apps/api lint`
- `bun run --cwd apps/api type-check`
- `cd apps/api && DATABASE_URL=file:./koda-test.db npx jest --forceExit test/e2e`

## i18n
- API translation files: `src/i18n/{en,zh}/*.json`
- Keep one file per module; create in both locales for new modules
- Use keys (for example `this.i18n.t('tickets.notFound')`) instead of hardcoded text

## Implementation Anti-Patterns
- Do not use `@Req() req: any`; use typed request context helpers (for example `@CurrentUser()`)
- Do not pass request-derived actor data through long method chains
- Use constructor injection with typed dependencies (not string DI tokens)
- Return DTO/enveloped responses instead of raw Prisma records
- Use Prisma `err.code` checks, not message string matching
- Do not use `@Optional()` for required dependencies
- Do not throw Nest built-in exceptions for domain auth failures when an App exception exists

## Quick Reference
- Wrong: `@Inject('PrismaService') private prisma: PrismaService`
- Correct: constructor injection with typed `PrismaService`
- Wrong: return raw Prisma result from controller
- Correct: map to DTO and wrap with `JsonResponse.Ok(...)`
