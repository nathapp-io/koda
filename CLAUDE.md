# Project Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `koda`

**Language:** TypeScript

**Key dependencies:** @typescript-eslint/eslint-plugin, @typescript-eslint/parser, typescript

**Commands:** test: `npx turbo test` | lint: `bunx turbo lint` | typecheck: `bunx turbo type-check`

---
# Koda — Dev Ticket Tracker

Koda is a Bun-managed Turborepo monorepo for tracking developer tickets and coordinating work between humans and AI agents.

## Context Source Of Truth

This file is the root source-of-truth for Codex/NAX repository guidance.

Rules:
- `AGENTS.md` at the repo root is generated from this file
- app-specific context must live under `.nax/mono/apps/<app>/context.md`
- in this monorepo, do not treat `apps/*/AGENTS.md` as the authoring source
- when repo-level architecture or workflow changes, update this file first

## Monorepo Shape

```text
koda/
├── apps/
│   ├── api/     # NestJS API, system of record
│   ├── cli/     # Commander.js API client for agents/terminals
│   ├── runner/  # Bun fleet runner daemon (executes nax jobs)
│   └── web/     # Nuxt SSR app for humans
├── packages/
│   ├── eslint-config/
│   └── typescript-config/
├── docs/
├── .nax/
│   ├── context.md
│   └── mono/apps/{api,cli,runner,web}/context.md
├── openapi.json
├── package.json
├── turbo.json
└── tsconfig.base.json
```

## System Architecture

The architecture is client-server within a monorepo:
- `apps/api` owns persistence, auth, domain rules, workflow transitions, RAG, and integrations
- `apps/web` is a Nuxt 4 SSR client that proxies `/api/**` to the API service
- `apps/cli` is a thin CLI client that calls the API through a generated OpenAPI client
- shared TypeScript and ESLint config live in `packages/*`; `apps/api` lints with oxlint (`apps/api/.oxlintrc.json`) instead of ESLint

The detailed architecture reference lives in `docs/architecture.md`.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | Node.js 22.22.3+ and Bun 1.4.4 workspaces |
| Language | TypeScript strict |
| Monorepo | Turborepo |
| API | NestJS 12 + Fastify + Prisma |
| Web | Nuxt 4 + Shadcn-nuxt + Tailwind CSS |
| CLI | Commander.js 12 |
| Runner | Bun-only ESM (`bun:sqlite`, `bun build --compile`), Commander.js 12 |
| Database | Prisma on PostgreSQL 16 |
| Test | Vitest in api; Jest in cli and web; Playwright in web |
| Lint | oxlint in api; ESLint in cli, web, runner |
| i18n | API and web maintain separate translation systems |

## Workspace Responsibilities

### `apps/api`
- source of truth for business logic
- exports the OpenAPI spec to `openapi.json`
- owns Prisma schema and migrations
- owns ticket state transitions, auth, RAG, webhooks, and CI webhook intake

### `apps/cli`
- remains thin
- should use generated client code in `apps/cli/src/generated/`
- should not reimplement API business rules locally
- resolves auth and project context from flags, env, user config, and local project config

### `apps/runner`
- fleet runner daemon: runs nax jobs dispatched by the API on a host checkout
- talks only to `/fleet/runner/*` and the bundle upload; never embeds business rules
- Bun-only; see `.nax/mono/apps/runner/context.md`

### `apps/web`
- remains a UI client over the API
- intentionally uses Nuxt-native composables for API access instead of a generated client
- proxies browser requests through Nuxt to the API host
- should not duplicate backend business rules in components/pages

### `packages/*`
- shared config packages used by the apps
- keep repo-wide lint/type rules centralized here when possible

## OpenAPI And Client Generation

Current code-backed flow:

```text
apps/api
  -> bun run api:export-spec
  -> openapi.json
  -> bun run generate:cli
  -> apps/cli/src/generated/
```

Rules:
- run `bun run generate` after API contract changes that affect the CLI
- do not edit generated files under `apps/cli/src/generated/`
- `openapi.json` is committed and should reflect the current API contract
- `apps/web/generated/` is intentionally not part of the current architecture
- web client generation was dropped because Nuxt composables and proxying are the preferred integration pattern for `apps/web`

## Monorepo Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build all workspaces through Turbo |
| `bun run dev` | Run workspace dev tasks |
| `bun run test` | Run tests across workspaces |
| `bun run lint` | Run linters across workspaces (oxlint in api, ESLint elsewhere) |
| `bun run type-check` | Run type checks across workspaces |
| `bun run db:generate` | Regenerate Prisma client in `apps/api` |
| `bun run db:migrate` | Apply/create Prisma migrations in `apps/api` |
| `bun run db:studio` | Open Prisma Studio from `apps/api` |
| `bun run db:reset` | Reset the database in `apps/api` |
| `bun run api:export-spec` | Build/export API spec to `openapi.json` |
| `bun run generate` | Export spec and regenerate CLI client |

## Engineering Rules

- keep business logic in the API unless there is a strong reason not to
- prefer updating tests alongside behavior changes
- treat soft-delete, auth, and workflow constraints as API-owned invariants
- never manually edit generated client files
- never manually edit generated `AGENTS.md`; edit the matching `context.md` source instead
- when changing app-specific guidance, update the file under `.nax/mono/apps/<app>/context.md`

## Code Navigation (codebase-memory MCP)

Use `codebase-memory-mcp` for graph-first code navigation. In nax, the server ID is `codebase-memory` and its tools are named `codebase-memory__<tool>`; use the equivalent exposed names in other hosts. Availability depends on the host's MCP configuration and session stage.

Pass the absolute **Execution repository/worktree root** supplied in the nax prompt directly as the `project` argument (for example `"project": "/Users/alice/src/koda"`); the server resolves a repository root path to its index. If the host does not supply a root, obtain it with `git rev-parse --show-toplevel` (nax Git tool: `{"subcommand":"rev-parse"}`). The path must be the repository root, not a package directory such as `apps/api`.

Do not start with `codebase-memory__list_projects`: it returns every repository indexed on the machine (no name or path filter), and nax truncates the result, which costs several paging calls. Call it only when a tool fails with `project not found or not indexed`: call it once with `{"limit": 100}` (no `include_details`) and use the entry whose `root_path` equals the repository root. If no entry matches, the repository is not indexed; fall back to direct reads and text search. Never select a different repository's project.

Then call the appropriate MCP tool before structural exploration with directory listings, whole-file reads or grep:
- `search_graph` to find symbols or routes
- `trace_path` for callers and callees
- `get_code_snippet` to read a symbol's exact source
- `get_architecture` for a module or package overview
- `search_code` for text across indexed code (see the regex rule below)
- `detect_changes` for symbols touched by the diff
- `check_index_coverage` to verify the relevant files are indexed and current

Rules:
- fall back to direct reads or text search for structural discovery only when the MCP server is unavailable, no matching project is indexed, or a graph query returns insufficient results; explain the fallback
- the index can lag behind recent edits: read the known file before editing; this does not replace graph-first discovery
- `search_code` matches `pattern` as a literal string unless you pass `"regex": true`. An alternation such as `interface Foo|type Foo` or a call such as `git.run(` without it silently returns zero matches. For any pattern with `|`, `(`, `.` or other regex syntax, pass `"regex": true` and escape literal characters (`git\.run\(`). Treat a zero-match `search_code` result as unconfirmed until a text search agrees
- use text search directly for config files, JSON, Markdown, i18n keys and Prisma schema

## Tests

Default organization rules:
- unit tests: `src/**/*.spec.ts`
- integration tests: `test/integration/**/*.integration.spec.ts`
- e2e tests: `test/e2e/**/*.e2e.spec.ts`

Repository rules:
- do not create `us-XXX` folders under app `test/` directories
- nax acceptance material belongs under `.nax/features/<feature>/`
- each package's generated acceptance file is `apps/<app>/.nax/features/<feature>/.nax-acceptance.test.ts`; how to run it for one story (api: vitest with `vitest.nax.config.ts`, web: `bun test`) is in that app's `.nax/mono/apps/<app>/context.md`
- `test/helpers/test-environment.ts` recognizes only `NAX_SANDBOXED=1`. Host-dependent suites (Postgres/Docker, real sockets and process inspection) skip explicitly inside a nax session sandbox; pure and injected tests still run. Skips are not verification: run DB and host checks outside the sandbox before merging. Outside the sandbox, missing test Postgres still fails loudly and DB-mode Vitest can use Testcontainers. A second checkout uses a private test container or separate test database
- app-specific test guidance belongs in `.nax/mono/apps/<app>/context.md`

## i18n

API and web both support English and Chinese, but they are separate systems.

Rules:
- API strings must use API i18n files under `apps/api/src/i18n/{en,zh}`
- web strings must use web i18n files under `apps/web/i18n/locales/{en,zh}.json`
- do not assume keys are shared across API and web

## App-Specific Contexts

Read the matching app context before making app-local changes:
- `.nax/mono/apps/api/context.md`
- `.nax/mono/apps/cli/context.md`
- `.nax/mono/apps/runner/context.md`
- `.nax/mono/apps/web/context.md`

If a new app is added to this monorepo, create its context file under `.nax/mono/apps/<new-app>/context.md`.
