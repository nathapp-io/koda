# Phase 1 — API Foundation

## Overview
Bootstrap the NestJS 11 + Fastify API with Prisma (SQLite), JWT auth for humans, and API key auth for agents. This is the foundation all other phases depend on.

## Tech Stack
- NestJS 11 + Fastify via `@nathapp/nestjs-app` AppFactory
- Prisma with SQLite (DATABASE_PROVIDER env)
- `@nathapp/nestjs-auth` v3 for JWT strategy (NOT nestjs-iam)
- bcrypt for password hashing (rounds: 12)
- HMAC-SHA256 (not bcrypt) for API key hashing — deterministic lookup
- Swagger at `/api/docs` via NestJS built-in swagger module

## Stories

### US-001: App Bootstrap
Create `apps/api/src/main.ts` and `apps/api/src/app.module.ts`.
- `main.ts` uses AppFactory.create with Fastify platform, prefix `api`, Swagger enabled (title: "Koda API")
- Port from `API_PORT` env (default 3100)
- `app.module.ts` imports ConfigModule (global), PrismaModule, AuthModule, AgentsModule, ProjectsModule, TicketsModule, CommentsModule
- Acceptance: `bun run build` passes, server starts on port 3100, `GET /api/docs` returns 200

### US-002: Prisma Module
Create `apps/api/src/prisma/prisma.service.ts` and `prisma.module.ts`.
- PrismaService extends PrismaClient, implements OnModuleInit ($connect) and OnModuleDestroy ($disconnect)
- PrismaModule is `@Global()`, exports PrismaService
- Run `bun run db:migrate --name init` to create SQLite DB
- Acceptance: PrismaService connects without error, `prisma.user.count()` returns 0

### US-003: Human Auth (JWT)
Create `apps/api/src/auth/` — module, controller, service, JWT strategy, guards, DTOs.
- `POST /api/auth/register` — `{ email, name, password }` → creates User (bcrypt hash rounds 12) → returns `{ accessToken, refreshToken, user }`
- `POST /api/auth/login` — `{ email, password }` → verifies → returns tokens
- `POST /api/auth/refresh` — Bearer refreshToken → returns new token pair
- `GET /api/auth/me` — Bearer accessToken → returns User
- JWT payload: `{ sub: userId, email, role }`. Access token: JWT_SECRET + JWT_EXPIRES_IN (default 7d). Refresh: JWT_REFRESH_SECRET + JWT_REFRESH_EXPIRES_IN (default 30d)
- Use `@nathapp/nestjs-auth` JwtStrategy pattern
- Acceptance: register creates user + returns tokens; login with wrong password → 401; /auth/me with no token → 401

### US-004: Agent Auth (API Key)
Create `apps/api/src/agents/guards/api-key.guard.ts` and `src/auth/guards/combined-auth.guard.ts`.
- ApiKeyGuard: extracts Bearer token, computes HMAC-SHA256 with API_KEY_SECRET env, looks up Agent by apiKeyHash, attaches agent to `request.agent`, sets `request.actorType = 'agent'`
- Only ACTIVE agents are allowed (reject PAUSED/OFFLINE)
- CombinedAuthGuard: tries JwtAuthGuard first, falls back to ApiKeyGuard
- Create stub `POST /api/agents` (admin JWT only) that generates `crypto.randomBytes(32).toString('hex')` raw key, computes HMAC-SHA256, stores hash, returns raw key ONCE
- Acceptance: invalid API key → rejected; valid API key → agent attached to request; CombinedAuthGuard accepts both auth types

### US-005: Global Guards & App Wiring
Create `@IsPublic()` decorator and `@CurrentUser()` param decorator. Register CombinedAuthGuard globally via APP_GUARD. Mark auth endpoints as `@IsPublic()`.
- `@IsPublic()` uses SetMetadata('isPublic', true)
- CombinedAuthGuard checks isPublic metadata — skips auth for public routes
- `@CurrentUser()` returns `req.user` (JWT) or `req.agent` (API key)
- Acceptance: protected endpoint → 401 without auth; `@IsPublic()` endpoint → accessible without auth; `@CurrentUser()` returns correct entity based on auth type

## Exit Criteria
- `bun run build` passes
- `bun run type-check` passes  
- `bun run lint` passes
- `bun run test` passes
- Swagger UI at http://localhost:3100/api/docs
- Full auth flow works end-to-end (register → login → me → agent API key)
