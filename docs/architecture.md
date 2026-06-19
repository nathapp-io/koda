# Koda Architecture

## Overview

Koda is a Bun-managed Turborepo monorepo for developer ticket tracking. The system is split into three deployable applications and two shared workspace packages:

- `apps/api`: NestJS 11 + Fastify REST API and system-of-record
- `apps/web`: Nuxt 3 SSR web app for human users
- `apps/cli`: Commander.js CLI for agents and terminal workflows
- `packages/eslint-config`: shared lint presets
- `packages/typescript-config`: shared TypeScript presets

The API owns domain rules, persistence, auth, state transitions, and OpenAPI. The web app and CLI are clients of that API and should stay thin.

## Monorepo Layout

```text
koda/
├── apps/
│   ├── api/
│   ├── cli/
│   └── web/
├── packages/
│   ├── eslint-config/
│   └── typescript-config/
├── docs/
├── .nax/
│   ├── context.md
│   └── mono/apps/{api,cli,web}/context.md
├── openapi.json
├── package.json
├── turbo.json
└── tsconfig.base.json
```

## Runtime Architecture

### API

`apps/api` is the core backend.

Key responsibilities:
- authentication for humans and agents
- project, ticket, comment, label, agent, and ticket-link CRUD
- ticket workflow enforcement
- webhook dispatch and CI webhook intake
- knowledge-base storage and retrieval
- OpenAPI export for downstream clients
- i18n-backed API responses

Bootstrap details from code:
- `AppFactory.createFastifyApp()` creates the server
- global auth is wired with `CombinedAuthGuard`
- global prefix/pipes/filters/guards are registered during bootstrap
- Swagger UI is enabled in development
- a Fastify `preParsing` hook normalizes empty JSON bodies to `{}`

Top-level module composition in [`apps/api/src/app.module.ts`](/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/app.module.ts):
- `ConfigModule` loads app/auth/database/rag config with validation
- `I18nCoreModule` serves `en` and `zh` JSON translations
- `PrismaModule` provides the shared Prisma client
- `ThrottlerModule` adds rate limiting
- feature modules: `Auth`, `Agents`, `Projects`, `Tickets`, `Comments`, `Labels`, `TicketLinks`, `Health`, `Rag`, `Webhook`, `CiWebhook`

### Web

`apps/web` is a Nuxt 3 SSR application.

Key responsibilities:
- human login and registration
- project and ticket browsing
- board and detail workflows
- agent, KB, and label management UI
- SSR-safe proxying of browser requests to the API
- client-side i18n and UI state

Architecture details:
- file-based routing under `pages/`
- shared UI in `components/`
- API access via `useApi()`
- auth/session handling via `useAuth()`
- global auth gate in `middleware/auth.global.ts`
- `routeRules` proxy `/api/**` through Nuxt to the API host

Important architecture note:
- the web generated client was intentionally dropped
- `apps/web/generated` does not exist by design
- the web app talks to the API through Nuxt-native composables like [`useApi.ts`](/home/williamkhoo/Desktop/projects/nathapp/koda/apps/web/composables/useApi.ts)
- this is the preferred approach because Nuxt handles API access, SSR, cookies, and proxying better in this app

### CLI

`apps/cli` is a thin terminal client intended for agents and scriptable workflows.

Key responsibilities:
- expose project/ticket/comment/agent/label/KB commands
- resolve auth and project context from flags, env, global config, and local `.koda/config.json`
- format output for humans and machine consumers
- call only API-backed operations

Architecture details:
- `src/index.ts` registers all commands and global process handling
- command modules under `src/commands/`
- auth/context discovery in [`apps/cli/src/config.ts`](/home/williamkhoo/Desktop/projects/nathapp/koda/apps/cli/src/config.ts)
- generated API client under `apps/cli/src/generated/`
- output/error helpers under `src/utils/`

## Domain Model

Prisma schema lives in [`apps/api/prisma/schema.prisma`](/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/prisma/schema.prisma).

Core entities:
- `User`: human accounts authenticated by email/password
- `Agent`: automation identities authenticated by API key hash
- `Project`: top-level container for tickets and integrations
- `Ticket`: primary work item with project-scoped ticket number
- `Comment`: discussion and workflow-required comments
- `Label` and `TicketLabel`: tagging system
- `TicketActivity`: audit trail for ticket changes
- `TicketLink`: external links such as GitHub/GitLab references
- `Webhook`: outbound integration subscriptions
- `AgentRoleEntry` and `AgentCapabilityEntry`: normalized agent metadata

Key data-model rules reflected in code/docs:
- Prisma enums are not used because SQLite is the default provider; TypeScript enums/constants live in `apps/api/src/common/enums.ts`
- ticket numbers are project-scoped and allocated in an API transaction
- soft deletes are used for projects and tickets
- ticket references are human-readable as `<PROJECT_KEY>-<number>`

## Request and Data Flow

### Human Web Flow

1. Browser requests a Nuxt page.
2. Nuxt middleware checks auth state.
3. Client or SSR code calls `/api/...` on the same origin.
4. Nuxt proxies the request to the API service.
5. API enforces auth, business rules, and persistence.
6. Responses return in `JsonResponse` envelopes and are unwrapped in the web layer.

### CLI / Agent Flow

1. Command parses flags in `apps/cli/src/index.ts`.
2. CLI resolves context from flags, local project config, profiles, and global config.
3. CLI configures the generated OpenAPI client.
4. CLI calls the API.
5. CLI unwraps the `JsonResponse` envelope and prints JSON or formatted output.

## Module Relationships Inside API

Core modules:
- `AuthModule` and `CombinedAuthGuard` provide shared security across controllers
- `TicketsModule` imports `RagModule` and `WebhookModule`
- `RagModule` selects an optimization strategy at runtime based on config
- `WebhookModule` contains both CRUD and dispatch logic
- `CiWebhookModule` handles inbound CI events that can update ticket state

Memory and context modules (ADR-001):
- `OutboxModule` — durable outbox; fan-out handlers for ticket_event / agent_event / graphify_import / code_commit
- `KodaDomainWriterModule` — single canonical write gateway for agent-initiated ticket, agent, and decision events
- `EventsModule` — TicketEvent / AgentEvent / DecisionEvent services and repositories
- `MemoryModule` — semantic memory items, governance, extraction, timeline
- `EntityGraphModule` — entity nodes/links; IncrementalGraphDiffService
- `CodeIntelModule` — AstIndexService, ImpactAnalysisService, CodeCommitOutboxHandler; Symbol index
- `ContextModule` — ContextBuilderService (shared agent context assembly); ContextController
- `PolicyModule` — PolicyGateService with 6 gates (Isolation, Provenance, TruthConsistency, Write, GraphifyEnabled, TokenBudget)
- `MonitoringModule` — SloDashboardService; MemoryQueryMetric

This keeps business rules centralized in the API while still allowing feature modules to collaborate.

## Auth Architecture

Two principal types exist:
- humans: JWT-based auth
- agents: API key auth via deterministic HMAC hash lookup

Request handling pattern:
- `CombinedAuthGuard` tries JWT first and can fall back to agent API key auth
- public routes opt out explicitly
- API controllers/services can distinguish actor type for audit and ownership behavior

## Ticket Workflow Architecture

The ticket lifecycle is enforced in the API rather than in the UI or CLI.

Main statuses:
- `CREATED`
- `VERIFIED`
- `IN_PROGRESS`
- `VERIFY_FIX`
- `CLOSED`
- `REJECTED`

Transition validation lives under `apps/api/src/tickets/state-machine/` so all clients share the same workflow rules.

## Knowledge Base / RAG

The RAG subsystem lives in `apps/api/src/rag/`.

Responsibilities:
- ingest project knowledge documents
- create embeddings through a provider abstraction
- search for relevant context
- optimize search storage through pluggable strategies

Strategy selection is config-driven:
- `counter`
- `cron`
- `manual`

As of Phase 2, RAG is extended by `HybridRetrieverService` which fuses vector, lexical, entity,
and recency signals with intent-weighted scoring. Direct use of `RagService.searchKnowledgeBase()`
is deprecated for agent context assembly in favour of `ContextBuilderService.getProjectContext()`.

## Memory Architecture

Koda implements a layered memory system defined in ADR-001 and detailed in `docs/adr/ADR-001-layered-memory-architecture.md`.

### Canonical stores (source of truth)

All of the following are Prisma-managed tables with `projectId` FK and `onDelete: Cascade`:

| Table | Purpose |
|-------|---------|
| `TicketEvent` | Canonical record of every ticket state change |
| `AgentEvent` | Canonical record of agent actions within a project |
| `DecisionEvent` | Canonical record of agent approval/rejection decisions |
| `OutboxEvent` | Durable outbox for fan-out to derived stores |

### Derived stores (non-authoritative)

| Table / Store | Purpose |
|---------------|---------|
| `MemoryItem` | Semantic memory items extracted from events |
| `EntityNode` / `EntityLink` | Entity graph nodes and typed relationships |
| `GraphNode` / `GraphLink` | Graphify-imported knowledge graph |
| `Symbol` | AST-indexed code symbols for code-intel |
| LanceDB (external) | Vector embeddings for hybrid retrieval |

Derived stores can be rebuilt from canonical stores without loss of authoritative truth.

### Write path

```
Client request
  → Controller (validates slug → projectId)
  → TicketsService / CommentsService / KodaDomainWriter
  → Prisma (canonical write — must succeed)
  → TicketEventService.create()     (non-fatal)
  → OutboxService.enqueue()         (non-fatal)
```

The outbox processor (`OutboxProcessor`) runs on a schedule and fans out to:
- `MemoryExtractionHandler` → `MemoryItem` upsert
- `EntityGraphOutboxHandler` → entity graph update
- `CodeCommitOutboxHandler` → `Symbol` index update

### Context assembly

`ContextBuilderService` (`src/context/`) provides the single shared context contract for all
agents. It composes:
1. Canonical state (tickets, agents, project metadata)
2. Semantic memory (`MemoryItem`)
3. Hybrid retrieval (`HybridRetrieverService` — vector + lexical + entity + recency fusion)
4. Entity graph paths (`EntityGraphService`)
5. Code-intel impact analysis (`ImpactAnalysisService`)

`PolicyGateService` enforces six gates before context is returned: Isolation, Provenance,
TruthConsistency, Write, GraphifyEnabled, TokenBudget.

### Phase roadmap

See `docs/specs/SPEC-0XX-memory-roadmap-overview.md` and the individual `SPEC-00N` files for
the phased delivery plan (Phases 0–5).

## Integration Surfaces

Outbound integrations:
- webhook dispatch from the API when subscribed events occur

Inbound integrations:
- CI webhook receiver for external pipelines/tools to report back into Koda
- ticket links for external provider URLs

## Build, Test, and Generation Pipeline

Root orchestration is defined in [`package.json`](/home/williamkhoo/Desktop/projects/nathapp/koda/package.json) and [`turbo.json`](/home/williamkhoo/Desktop/projects/nathapp/koda/turbo.json).

Important commands:
- `bun run build`: turbo build for all workspaces
- `bun run dev`: turbo dev for all apps
- `bun run test`: turbo test
- `bun run lint`: turbo lint
- `bun run type-check`: turbo type-check
- `bun run api:export-spec`: build API, then export `openapi.json`
- `bun run generate`: export spec, then regenerate the CLI client

Important architecture note:
- `bun run generate` intentionally regenerates only `openapi.json` and `apps/cli/src/generated/`
- web client generation was deliberately removed because the web app uses Nuxt-native composables instead of a generated client

## Context File Architecture

For Codex/NAX context authoring, this repo uses monorepo-scoped source files:
- root shared instructions live in `.nax/context.md`
- app-specific instructions live in `.nax/mono/apps/<app>/context.md`

Those `context.md` files are the source-of-truth equivalents for generated `AGENTS.md` files. In this repo, app-level context should not be placed directly inside `apps/*`; it belongs under `.nax/mono/apps/*/context.md`.

## Practical Guidance For Future Changes

- put business rules in the API, not the web or CLI
- regenerate `openapi.json` and the CLI client after API contract changes
- do not edit generated client files manually
- keep web and API i18n in sync, but treat them as separate systems
- update `.nax/context.md` and `.nax/mono/apps/*/context.md` when architecture or workflow rules materially change
