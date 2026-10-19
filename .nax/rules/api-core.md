---
description: "Core apps/api rules: nathapp-nestjs-patterns first, nestjs-auth v3 with @Principal and @RequiredPermission, API key and password hashing, quality gates, async patterns, DI and response anti-patterns"
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
- Authorize with a permission key from `src/permissions/catalog.ts`: `@Requires('<key>')` plus `@UseGuards(ProjectMembershipGuard, RequiresGuard)` on project routes (`RequiresGuard` alone on global routes). Row-level checks (`X.own` ownership, a ticket transition edge) call `PermissionService.can(principal, key, { projectId, resource })` in the service and mark the route `@Requires(key, { enforcedBy: 'service' })`. A refused key is `new ForbiddenAppException({}, 'permissions')`. Do not add new `@RequiredPermission`, `@ProjectPermission` or `@ProjectRoles` uses: they remain only on routes not yet migrated (fleet, vcs, webhooks, skills, code-intel, context) and are removed by the permissions P1 cleanup

## Quality Gates
- `bun run --cwd apps/api lint`
- `bun run --cwd apps/api type-check`
- `bun run --cwd apps/api test` (Vitest unit specs; no database)
- `bun run --cwd apps/api test:integration` (`KODA_DB_TESTS=1`; needs the test Postgres up: `bun run --cwd apps/api test:db:up`)

## Async Patterns
- Use `Promise.all([...])` for independent async calls — do not chain sequential `await` when calls have no data dependency
- Maps/Sets used for deduplication or short-term caching must have an explicit eviction strategy or size cap; unbounded collections grow without limit in long-running services

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
