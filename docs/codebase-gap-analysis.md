# Koda Codebase Gap Analysis

**Date:** 2026-06-19  
**Scope:** Full monorepo (`apps/api`, `apps/web`, `apps/cli`)  
**Analyst:** Automated codebase audit

---

## Executive Summary

The Koda codebase is well-structured with solid core modules, comprehensive integration tests for key flows, and consistent patterns across the monorepo. However, several gaps were identified across test coverage, environment documentation, schema/migration alignment, i18n, and CLI command coverage.

**Key findings at a glance:**

| Severity | Count | Category |
|----------|-------|----------|
| Critical | 1 | Schema models with no migration |
| High | 3 | Zero-test API modules; CLI stub not replaced; env docs gap |
| Medium | 5 | Missing env vars in `.env.example`; web i18n gap; CLI/openapi drift; missing Dockerfile HEALTHCHECK; web component test coverage |
| Low | 3 | Silent catch blocks; CLI commands not covering all API resources; no client-side CLI commands for context/memory/code-intel |

---

## 1. Test Coverage Gaps

### API (`apps/api/src`)

Total: **222 source files**, **70 spec files** — roughly **32% file-level coverage**.

**Modules with zero test files:**

| Module | Source Files | Spec Files | Critical Missing |
|--------|-------------|-----------|-----------------|
| `context/` | 6 | 0 | `context.controller.ts`, `context-builder.service.ts` (core RAG query path) |
| `policy/` | 4 | 0 | `policy-gate.service.ts` (21 KB — most complex service with no tests) |
| `events/` | 6 | 0 | All 3 event services (`agent-event`, `ticket-event`, `decision-event`) |

**Modules with partial test coverage (notable gaps):**

- `memory/` — 6 specs / 15 source files. Missing:
  - `apps/api/src/memory/extraction.service.ts`
  - `apps/api/src/memory/memory.controller.ts`
  - `apps/api/src/memory/prisma-canonical-state.repository.ts`
  - `apps/api/src/memory/prisma-memory-item.repository.ts`
  - `apps/api/src/memory/prisma-timeline.repository.ts`
  - `apps/api/src/memory/timeline.controller.ts`

- `vcs/` — 7 specs / 23 source files. Missing:
  - `apps/api/src/vcs/vcs-connection.service.ts`
  - `apps/api/src/vcs/vcs-link-extractor.service.ts`
  - `apps/api/src/vcs/vcs-polling.service.ts`
  - `apps/api/src/vcs/vcs-pr-sync.service.ts`
  - `apps/api/src/vcs/vcs-sync.service.ts`
  - `apps/api/src/vcs/vcs.controller.ts`
  - `apps/api/src/vcs/vcs-webhook.controller.ts`

- `code-intel/` — 3 specs / 10 source files. Missing:
  - `apps/api/src/code-intel/ast-index.service.ts`
  - `apps/api/src/code-intel/code-graph.service.ts`
  - `apps/api/src/code-intel/code-intel.controller.ts`
  - `apps/api/src/code-intel/impact-analysis.service.ts`

- `rag/` — 7 specs / 23 source files. Missing:
  - `apps/api/src/rag/graph-store.service.ts`
  - `apps/api/src/rag/hybrid-retriever.service.ts`
  - `apps/api/src/rag/rag.controller.ts`

- Other notable gaps:
  - `apps/api/src/webhook/webhook.service.ts` — no spec
  - `apps/api/src/auth/guards/combined-auth.guard.ts` — no spec
  - `apps/api/src/projects/projects.controller.ts` — no spec
  - `apps/api/src/health/health.controller.ts` — no spec

### Web (`apps/web`)

Total: ~**114 source files** (`.vue` + `.ts`), **81 spec files** in `tests/`.

All page-level Vue files have corresponding tests. However, many non-UI-library components lack tests:

- `apps/web/components/BackButton.vue`
- `apps/web/components/KbAddDocumentDialog.vue`
- `apps/web/components/CreateAgentDialog.vue`
- `apps/web/components/ErrorState.vue`
- `apps/web/components/KbVerdictBanner.vue`
- `apps/web/components/KbResultCard.vue`
- `apps/web/components/DeleteAgentDialog.vue`
- `apps/web/components/EmptyState.vue`
- `apps/web/components/LoadingState.vue`

(UI primitive wrappers in `components/ui/` are acceptable to leave untested.)

### CLI (`apps/cli/src`)

24 spec files / 30 source files — reasonably covered for existing commands.

---

## 2. API / OpenAPI Spec Drift

**Overall:** 61 paths / 80 operations in `openapi.json`. All NestJS controllers have `@ApiTags` decorators — no swagger annotation gaps found.

**CLI generated client drift (Medium):**

- `openapi.json` last modified: **Jun 15 01:14**
- `apps/cli/src/generated/services.gen.ts` last modified: **Jun 14 22:41**
- The generated client is **~2.5 hours older** than the spec, meaning any spec changes after Jun 14 22:41 are not reflected in the CLI client.

**Action:** Run `bun run generate` to regenerate.

---

## 3. Missing Environment Variable Documentation

**19 environment variables used in the codebase are absent from `.env.example`.**

### VCS variables (not documented):

| Variable | Source | Notes |
|----------|--------|-------|
| `VCS_ENCRYPTION_KEY` | `apps/api/src/config/vcs.config.ts:3` | Required for encrypted token storage — should be prominently documented |
| `VCS_DEFAULT_POLLING_INTERVAL_MS` | `apps/api/src/config/vcs.config.ts:6` | Optional, default 600000ms |
| `GITHUB_API_URL` | `apps/api/src/config/vcs.config.ts:8` | Optional, for GitHub Enterprise |

### RAG / embedding variables (not documented):

| Variable | Source | Default |
|----------|--------|---------|
| `EMBEDDING_PROVIDER` | `apps/api/src/config/rag.config.ts:4` | `ollama` |
| `EMBEDDING_MODEL` | `apps/api/src/config/rag.config.ts:5` | `nomic-embed-text` |
| `OLLAMA_BASE_URL` | `apps/api/src/config/rag.config.ts:6` | `http://localhost:11434` |
| `OPENAI_API_KEY` | `apps/api/src/config/rag.config.ts:7` | — |
| `LANCEDB_PATH` | `apps/api/src/config/rag.config.ts:8` | `./lancedb` |
| `FTS_INDEX_MODE` | `apps/api/src/config/rag.config.ts:10` | `simple` |
| `FTS_OPTIMIZE_STRATEGY` | `apps/api/src/config/rag.config.ts:21` | `counter` |
| `FTS_OPTIMIZE_THRESHOLD` | `apps/api/src/config/rag.config.ts:22` | `10` |
| `FTS_OPTIMIZE_INTERVAL_MS` | `apps/api/src/config/rag.config.ts:23` | `300000` |
| `SIMILARITY_HIGH` | `apps/api/src/config/rag.config.ts:17` | `0.85` |
| `SIMILARITY_MEDIUM` | `apps/api/src/config/rag.config.ts:18` | `0.70` |
| `SIMILARITY_LOW` | `apps/api/src/config/rag.config.ts:19` | `0.50` |

### CLI variables (not in any `.env.example`):

| Variable | Source |
|----------|--------|
| `KODA_API_URL` | `apps/cli/src/config.ts` |
| `KODA_API_KEY` | `apps/cli/src/config.ts` |
| `KODA_PROJECT_SLUG` | `apps/cli/src/config.ts` |

### API server (minor):

| Variable | Source | Notes |
|----------|--------|-------|
| `API_HOST` | `apps/api/src/main.ts:39` | Defaults to `0.0.0.0`, rarely overridden |

---

## 4. TODOs / Unimplemented Stubs

**No production TODOs or FIXMEs** were found in non-test source files — all TODO/FIXME markers are in spec files (as mock stubs, which is expected).

**One active temporary stub (High):**

- `apps/cli/src/vcs-client.stub.ts` — File header says:
  > *"These are temporary stubs until the OpenAPI client is regenerated. Do NOT use in actual code — these are only for test imports."*
  
  All exported functions throw `new Error('Not implemented - stub only')`. This stub was created as a placeholder for CLI VCS commands pending OpenAPI client regeneration. As of Jun 14, the client has been regenerated, but this stub file still exists and may still be imported by tests. Verify that CLI VCS tests no longer import from `vcs-client.stub.ts` and remove it if unused.

---

## 5. Schema / Migration Gaps

**Critical: 3 Prisma models have no migration.**

The following models appear in `apps/api/prisma/schema.prisma` but were never created in any migration SQL file, and have **zero Prisma client usages** (`prisma.entityNode`, `prisma.entityLink`, `prisma.symbol`) in the codebase:

| Model | Schema location | Migration exists? | Prisma usage? |
|-------|----------------|------------------|---------------|
| `EntityNode` | `schema.prisma:377` | No | No |
| `EntityLink` | `schema.prisma:393` | No | No |
| `Symbol` | `schema.prisma:444` | No | No |

**Impact:** `prisma migrate deploy` on a fresh database will attempt to create these tables (they appear in the current schema) but no migration SQL has been produced for them, which will cause `prisma migrate status` to report drift. For a fresh SQLite install, `prisma db push` would work, but the migration history is inconsistent.

**GraphNode / GraphLink** (the sibling models) are correctly in migration `20260505073717_add_graph_nodes_links`. `EntityNode`, `EntityLink`, and `Symbol` appear to be placeholder models added to `schema.prisma` in anticipation of the code-intel / graphify feature but never had their migration generated via `prisma migrate dev`.

**Action:** Either run `prisma migrate dev --name add_entity_graph_symbol_tables` to generate the missing migration, or remove the models from `schema.prisma` if not yet ready for implementation.

---

## 6. Feature Implementation Status

Based on `.nax/features/*/prd.json` and `status.json` files:

| Feature | Status | Notes |
|---------|--------|-------|
| `memory-phase4-graph-code-intelligence` | **Completed** (2026-05-07, 6/6 ACs passed) | Done |
| `memory-phase5-multi-agent-hardening` | **Completed** (2026-05-08, 5/5 ACs passed) | Done |
| `graphify-kb` | **No status.json** — PRD created 2026-04-13 | Implementation partial: `graphifyEnabled`/`graphifyLastImportedAt` are in schema and controllers; graphify import endpoint present in OpenAPI; `graph-store.service.ts` exists but has no test coverage |
| `vcs-implementation-gap` | **No status.json** | VCS module is implemented; spec likely tracks remaining holes |
| `agents-management-page` | **No status.json** | Implementation appears complete: `pages/agents.vue` + all 5 dialog components present |
| `fts-tantivy` | **No status.json** | Tantivy FTS is implemented in `rag.service.ts` (LanceDB native FTS, FTS optimize strategies, `FTS_OPTIMIZE_STRATEGY` config); appears implemented but no status.json to confirm |
| `rag-auto-pickup` | **No status.json** | `GET /api/agents/{slug}/pickup` exists in spec and controller; `koda agent pickup` CLI command present |
| `project-cli-config` | **No status.json** | `resolveContext` merge logic and walk-up utility appear present in `apps/cli/src/config.ts` |
| `memory-phase1-canonical-episodic` through `memory-phase3-semantic-memory` | **No status.json** | Memory modules exist and are partially tested |
| `vcs-phase1` through `vcs-phase4` | **No status.json each** | VCS module is substantially implemented; individual phase completion is unclear without status files |

---

## 7. i18n Coverage Gaps

### API i18n (`apps/api/src/i18n/en/` vs `apps/api/src/i18n/zh/`)

**All 15 JSON files have identical key sets between `en/` and `zh/`.** No gaps found.

### Web i18n (`apps/web/i18n/locales/en.json` vs `apps/web/i18n/locales/zh.json`)

**3 keys are present in `en.json` but missing from `zh.json`:**

| Key | English value |
|-----|--------------|
| `agents.toast.deleteFailed` | `"Failed to delete agent"` |
| `agents.toast.deleted` | `"Agent deleted successfully"` |
| `agents.toast.rotateKeyFailed` | `"Failed to rotate API key"` |

These correspond to toast notifications in the agents management UI. Users with Chinese locale will see no text for these toasts.

---

## 8. Docker / Deployment Gaps

### Missing HEALTHCHECK in Dockerfiles (Medium)

Both `apps/api/Dockerfile` and `apps/web/Dockerfile` have no `HEALTHCHECK` instruction:

- `apps/api/Dockerfile:118` — has `CMD` but no `HEALTHCHECK`
- `apps/web/Dockerfile:95` — has `CMD` but no `HEALTHCHECK`

The healthchecks are defined in `docker-compose.yml` (compose-level `healthcheck:` block for the `api` service only), but standalone container deployments (e.g., Kubernetes, ECS task definitions) won't inherit these.

### Missing healthcheck for `web` service in `docker-compose.yml` (Low)

The `api` service has:
```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3100/api/health"]
```

The `web` service has **no `healthcheck:` block** in `docker-compose.yml`. The `web` depends on `api` via `condition: service_healthy`, but the `web` service itself has no health endpoint defined in the compose config, meaning downstream services that might depend on `web` cannot use `condition: service_healthy`.

### Missing env vars in `docker-compose.yml` for RAG (Low)

The production `docker-compose.yml` defines `OLLAMA_BASE_URL` and `LANCEDB_PATH`, but does not include `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, or `OPENAI_API_KEY`. Users switching from Ollama to OpenAI embeddings must add these manually with no documentation prompt.

### Dev compose port mismatch (Low)

`docker-compose.dev.yml` maps:
- `api`: host `${API_PORT:-3100}` → container `3101` (container `API_PORT` is set to `3101`)
- `web`: host `${WEB_PORT:-3101}` → container `3101`

This means `web` and `api` share the same default host port (`3101`), which causes a binding conflict if both are started simultaneously. The API port in dev should default to 3100 on the host.

---

## 9. CLI Client Drift

**Generated client is slightly stale:**

- `openapi.json` timestamp: Jun 15 01:14
- `apps/cli/src/generated/services.gen.ts` timestamp: Jun 14 22:41
- `apps/cli/src/generated/schemas.gen.ts` timestamp: Jun 14 22:41

The generated client is ~2.5 hours older than the current spec. Any API changes merged after Jun 14 22:41 are not reflected.

**API resource groups with no CLI commands:**

| API Tag | Endpoints | CLI command? |
|---------|-----------|-------------|
| `admin` | `GET /api/admin/outbox`, `POST /api/admin/outbox/{id}/retry`, `GET /api/admin/slos` | No |
| `ci-webhooks` | `POST /api/projects/{slug}/ci-webhook` | No |
| `code-intel` | 4 endpoints (index, symbols) | No |
| `context` | `GET /api/context/{projectId}`, `POST /api/context/{projectId}/query` | No |
| `health` | `GET /api/health` | No |
| `memory` | `GET /api/projects/{slug}/timeline`, `POST /api/memory/extract`, `POST /api/memory/decisions`, `POST /api/memory` | No |
| `webhooks` | `POST/GET /api/projects/{slug}/webhooks`, `DELETE /api/webhooks/{id}` | No |

Note: `health`, `admin`, and `ci-webhooks` are likely intentionally CLI-omitted (internal/ops concerns). `context` and `memory` may be agent-only APIs. `webhooks` is user-configurable and could benefit from CLI support.

---

## 10. Error Handling Gaps

No fully silent or unlogged catch blocks were found in production controller/service code. The following patterns exist but are intentional by design:

| Location | Pattern | Justification in code |
|----------|---------|----------------------|
| `apps/api/src/rag/rag.module.ts:71` | `.catch(() => {})` (LexicalIndex warmup outer guard) | Non-fatal warmup; lazy build handles it |
| `apps/api/src/rag/rag.module.ts:63` | `catch { /* non-fatal */ }` (per-project warmup inner) | Non-fatal; lazy build fallback |
| `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:74` | `.catch(() => { /* suppress webhook errors */ })` | Webhook dispatch must not fail transitions |
| `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:113` | `.catch(() => { /* suppress RAG indexing errors */ })` | RAG indexing must not block ticket close |
| `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:200` | `.catch(() => { /* suppress VCS errors */ })` | VCS errors must not block transitions |

**These are all intentional and documented with inline comments.** However, the three catches in `ticket-transitions.service.ts` are completely silent — if RAG indexing or webhook dispatch fail repeatedly, there is no log entry, making silent production failures invisible. Consider adding at least a `this.logger.warn(...)` in each suppressed catch.

---

## Priority Summary

| Priority | Severity | Item | Location |
|----------|----------|------|----------|
| 1 | **Critical** | `EntityNode`, `EntityLink`, `Symbol` models in schema with no migration and no code usage — migration history is inconsistent | `apps/api/prisma/schema.prisma:377,393,444` |
| 2 | **High** | `context/`, `policy/`, `events/` modules have zero test coverage — `policy-gate.service.ts` is 21 KB untested | `apps/api/src/context/`, `policy/`, `events/` |
| 3 | **High** | `vcs-client.stub.ts` is a temporary stub with "Not implemented" throws that should have been replaced | `apps/cli/src/vcs-client.stub.ts` |
| 4 | **High** | 19 environment variables used in code are absent from `.env.example` — blocks new developer onboarding | `.env.example`, `apps/api/src/config/rag.config.ts`, `vcs.config.ts`, `apps/cli/src/config.ts` |
| 5 | **Medium** | CLI generated client is stale relative to `openapi.json` (2.5 hours drift) | `apps/cli/src/generated/`, `openapi.json` |
| 6 | **Medium** | 3 web i18n keys missing from `zh.json` — toast messages blank for Chinese users | `apps/web/i18n/locales/zh.json` |
| 7 | **Medium** | No `HEALTHCHECK` in `apps/api/Dockerfile` or `apps/web/Dockerfile` — standalone deployments lack health signals | `apps/api/Dockerfile:118`, `apps/web/Dockerfile:95` |
| 8 | **Medium** | `apps/web` service has no `healthcheck:` in `docker-compose.yml` | `docker-compose.yml` |
| 9 | **Medium** | Dev compose port conflict: API and web both default to port 3101 on host | `docker-compose.dev.yml` |
| 10 | **Medium** | `memory/`, `vcs/`, `code-intel/`, `rag/` modules have substantial source files without spec coverage | See §1 |
| 11 | **Low** | 3 intentional silent `.catch(() => {})` blocks in `ticket-transitions.service.ts` — no log on repeated failure | `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:74,113,200` |
| 12 | **Low** | CLI has no commands for `webhooks`, `context`, `memory`, `code-intel` API resources | `apps/cli/src/commands/` |
| 13 | **Low** | Multiple feature PRDs lack `status.json` files — implementation status unclear for `graphify-kb`, `fts-tantivy`, `vcs-phase1-4`, `rag-auto-pickup`, `project-cli-config` | `.nax/features/*/` |
