# Koda — Dev Ticket Tracker

Turborepo monorepo with a NestJS API, Nuxt 3 web UI, and a Commander.js CLI. Built for human developers and AI agents to collaborate on bug fixes and enhancement tickets.

## Tech Stack (Overview)

| Layer | Choice |
|:------|:-------|
| Runtime | **Node.js 22 + Bun 1.3.7+** — Bun as package manager |
| Language | **TypeScript strict** throughout all apps |
| API | **NestJS 11 + Fastify** via `@nathapp/nestjs-app` AppFactory |
| Web | **Nuxt 3 + Shadcn-nuxt + Tailwind CSS** |
| CLI | **Commander.js 12** — bin: `koda` |
| ORM | **Prisma 6** — SQLite (dev) / PostgreSQL / MySQL |
| Test | **Jest 29** — all apps |
| Build | **Turborepo** |
| Lint | **ESLint** |

## Monorepo Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build all apps |
| `bun run dev` | Start all apps in dev mode |
| `bun run test` | Run all Jest tests |
| `bun run lint` | ESLint across all apps |
| `bun run type-check` | TypeScript check across all apps |
| `bun run db:generate` | Regenerate Prisma client (delegates to `apps/api`) |
| `bun run db:migrate` | Run pending migrations (delegates to `apps/api`) |
| `bun run db:studio` | Open Prisma Studio (delegates to `apps/api`) |
| `bun run db:reset` | Reset database (delegates to `apps/api`) |
| `bun run api:export-spec` | Export OpenAPI spec → `openapi.json` at root |
| `bun run generate` | Export spec + regenerate CLI + web clients |

## Repository Structure

```
koda/                              ← monorepo root
├── apps/
│   ├── api/                       ← NestJS 11 + Fastify backend
│   │   ├── prisma/schema.prisma   ← Prisma schema (lives here, not root)
│   │   ├── src/
│   │   │   ├── main.ts            ← AppFactory bootstrap
│   │   │   ├── app.module.ts      ← Root module
│   │   │   ├── @types/            ← Custom type declarations
│   │   │   ├── auth/              ← JWT + API key auth
│   │   │   ├── agents/            ← Agent CRUD + API key auth
│   │   │   ├── projects/          ← Project CRUD
│   │   │   ├── tickets/           ← Ticket CRUD + state machine
│   │   │   ├── comments/          ← Comment CRUD
│   │   │   ├── labels/            ← Label CRUD + ticket labelling
│   │   │   ├── ticket-links/      ← External links (GitHub/GitLab PRs)
│   │   │   ├── rag/               ← RAG-based knowledge base (embeddings)
│   │   │   ├── webhook/           ← Outbound webhook dispatching
│   │   │   ├── ci-webhook/        ← Inbound CI/CD webhook receiver
│   │   │   ├── health/            ← Health check endpoint
│   │   │   ├── common/enums.ts    ← Local TypeScript enums (SQLite can't use Prisma enums)
│   │   │   ├── config/            ← Typed config (app, auth, database, rag)
│   │   │   └── i18n/              ← en/ + zh/ translations
│   │   └── test/                  ← Integration + E2E tests
│   ├── cli/                       ← Commander.js CLI (bin: `koda`)
│   │   └── src/
│   │       ├── index.ts           ← Program entry, registers all commands
│   │       ├── commands/          ← login, init, config, project, ticket, comment, agent, label, kb
│   │       ├── generated/         ← Auto-generated from OpenAPI (do NOT edit)
│   │       └── utils/             ← output, error, auth helpers
│   └── web/                       ← Nuxt 3 + Shadcn-nuxt
│       ├── pages/                 ← File-based routing
│       ├── composables/           ← useApi, useAuth, useAppToast
│       ├── components/ui/         ← Shadcn-nuxt components
│       ├── layouts/               ← default, auth
│       └── tests/                 ← Component/page tests
├── .nax/                          ← nax config + context files
├── package.json                   ← Bun workspaces root
├── turbo.json                     ← Turborepo pipeline config
├── tsconfig.base.json             ← Shared TS config
└── openapi.json                   ← Generated OpenAPI spec (committed)
```

## OpenAPI Spec & Client Generation

```
apps/api (NestJS + @nestjs/swagger)
  → bun run api:export-spec
  → openapi.json (monorepo root — source of truth)
  → bun run generate:cli  → apps/cli/src/generated/
  → bun run generate:web  → apps/web/generated/
```

**Rules:**
- Run `bun run generate` after ANY API endpoint change before touching CLI or web code
- Never manually edit files inside `*/generated/`
- `openapi.json` is committed so CI can regenerate clients without booting the API

## Engineering Persona

- **Senior Engineer mindset**: check edge cases, null/undefined, race conditions, and error states.
- **TDD first**: write or update tests before implementation when the story calls for it.
- **Stuck rule**: if the same test fails 2+ iterations, stop, summarise failed attempts, reassess approach.
- **Never push to remote** — the human reviews and pushes.

## Test Organization Rules

| Type | Location | Naming |
|:-----|:---------|:-------|
| Unit | `src/**/*.spec.ts` | Co-located with source |
| Integration | `test/integration/**/*.integration.spec.ts` | Grouped in `test/integration/` |
| E2E | `test/e2e/**/*.e2e.spec.ts` | Grouped in `test/e2e/` |

**Rules:**
- No `us-XXX` folders in `test/` — nax acceptance tests go in `.nax/features/<feature>/`
- See each app's CLAUDE.md for app-specific test details

## i18n — Internationalization

Both the API and web app support i18n. Languages: **English (en)** and **Chinese (zh)**.

| App | Library | Translation files | Key style |
|:----|:--------|:-----------------|:----------|
| API | `@nathapp/nestjs-common` `I18nCoreModule` | `apps/api/src/i18n/{en,zh}/*.json` | Flat per module (e.g. `agents.json`, `tickets.json`) |
| Web | `@nuxtjs/i18n` | `apps/web/i18n/locales/{en,zh}.json` | Nested single file (e.g. `auth.login.title`) |

**Rules:**
- All user-facing strings must use i18n keys — no hardcoded strings in API responses or web UI
- When adding a new API module, create corresponding `{module}.json` in both `en/` and `zh/`
- When adding web UI text, add keys to both `en.json` and `zh.json`
- API and web use **separate** translation systems — keys are NOT shared between them

## NestJS Development — Mandatory Skill

**Before writing any NestJS code**, read and follow the `nathapp-nestjs-patterns` skill. This skill is the **authoritative source** for all Nathapp NestJS patterns. Do NOT use generic NestJS alternatives when a Nathapp pattern exists.
