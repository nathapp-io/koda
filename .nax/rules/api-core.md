---
paths:
  - "apps/api/*"
priority: 50
---

# API Core Rules — apps/api

## Read-First
- Follow `nathapp-nestjs-patterns` before implementing NestJS changes
- Prefer Nathapp patterns over generic alternatives when both exist

## Auth
- Use `@nathapp/nestjs-auth` v3; do not use `nestjs-iam`
- API key hashing: deterministic HMAC-SHA256 for lookup
- Password hashing: bcrypt (rounds 12)
- Register `CombinedAuthGuard` globally (`APP_GUARD`); mark public routes with `@IsPublic()`

## Quality Gates
- `bun run --cwd apps/api lint`
- `bun run --cwd apps/api type-check`
- `cd apps/api && DATABASE_URL=file:./koda-test.db npx jest --forceExit test/e2e`

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
