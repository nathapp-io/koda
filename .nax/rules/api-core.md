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
- Register `CombinedAuthGuard` globally; mark public routes with `@Public()` from `@nathapp/nestjs-auth` (no custom `@IsPublic()`)
- Inject the actor with `@Principal() principal: KodaPrincipal` (typed `UserPrincipal | AgentPrincipal` discriminated union); do not use `@CurrentUser()` / `@CurrentActor()` (removed) or `request.agent` / `request.user` directly
- Authorize with `@RequiredPermission('ADMIN')` (or `[action, subject]` for CASL) on the route; do not duplicate the check inline

## Quality Gates
- `bun run --cwd apps/api lint`
- `bun run --cwd apps/api type-check`
- `cd apps/api && DATABASE_URL=file:./koda-test.db npx jest --forceExit test/e2e`

## Implementation Anti-Patterns
- Do not use `@Req() req: any`; use `@Principal() principal: KodaPrincipal`
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
