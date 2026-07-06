# Koda — Codebase Gap Analysis: Missing Features & Improvements

**Date:** 2026-07-06
**Repo state:** `master` @ `3b9698af` (post Prisma-layer-violation cleanup)
**Method:** 4 parallel read-only analysis passes (API, Web, CLI, cross-cutting) over the full monorepo.

---

## Summary

The codebase is in good shape overall — clean of TODO/stub markers, well-tested (~328 spec files), and the 5-phase memory/code-intel subsystem is fully shipped and wired into `app.module.ts`. The real gaps fall into three buckets:

1. **Genuinely broken or half-built items** — GitLab provider stub, fire-and-forget webhooks, CLI env-var override bug, no token revocation, no CORS/Helmet.
2. **API surfaces invisible to both the web UI and CLI** — memory writes, timeline, code-intel, agent lifecycle, ops admin.
3. **Table-stakes tracker features that don't exist yet** — notifications, due dates, attachments, search, bulk ops.

> Note: `docs/20260620-prisma-data-layer-violations.md` is now **stale** — all 5 violation categories were verified fixed at `3b9698af`. It should be archived or annotated as resolved.

---

## 1. Highest-impact defects (fix first)

| # | Defect | Evidence |
|---|--------|----------|
| 1 | **No CORS / Helmet on the API.** `main.ts` never calls `.useServerSecurityConfig()` (the `@nathapp/nestjs-app` hook that enables CORS + `@fastify/helmet`). No security headers, effectively open CORS; `@fastify/helmet` isn't even a dependency. | `apps/api/src/main.ts:37-46` |
| 2 | **GitLab VCS provider is a hard stub.** Throws `ValidationAppException` immediately; only `github.provider.ts` exists, despite GitLab being advertised throughout (`detect-provider.util.ts`, `git-url.util.ts`). | `apps/api/src/vcs/factory.ts:101-103` |
| 3 | **Outbound webhooks are fire-and-forget.** No persistence, retry, dead-letter, or delivery record — at-most-once with silent failure. The outbox module already has claim-based concurrency + backoff + DLQ; route webhooks through it. | `apps/api/src/webhook/webhook-dispatcher.service.ts:19-23` |
| 4 | **Outbox backoff is dead code on the hot path.** `processPending()`'s catch calls `markFailed()`, which requeues instantly for the next 5s cron tick; `retry()`'s `BACKOFF_MS` exponential logic is never used → transient failures tight-loop. | `apps/api/src/outbox/outbox.service.ts` (~L57 vs ~L78-86), `outbox-processor.ts` |
| 5 | **CLI env-var overrides silently don't work.** `KODA_API_KEY`/`KODA_API_URL` are honored by `utils/auth.ts` `resolveAuth()`, but `config.ts` `resolveContext()` (used by 14 of 17 command modules, incl. `ticket`) never reads `process.env`. Two divergent auth-resolution code paths. | `apps/cli/src/config.ts`, `apps/cli/src/utils/auth.ts` |
| 6 | **No token revocation or logout.** Refresh tokens are stateless 30-day JWTs with no revocation store; `revoked: false` hardcoded in both auth providers; no `POST /auth/logout`. Root `.env`/`.env.example` ship `JWT_EXPIRES_IN=7d` while the code default is a safer `15m`. | `apps/api/src/auth/auth.service.ts:75-88`, `jwt-auth.provider.ts:27-28`, `agent-auth.provider.ts:31-32` |
| 7 | **No LanceDB write serialization.** Table open/create with no mutex; concurrent ingestion from multiple agents risks races on the embedded file-based store. | `apps/api/src/rag/rag.service.ts` (~L267-338) |

---

## 2. Missing features, ranked by value

### API (core tracker features)

- **Notifications** — zero infrastructure for assignment/mention/transition alerts; humans must poll. Biggest single product gap for a human+agent collaboration tool.
- **Due dates / SLA** — `Ticket` model has no `dueDate`/SLA fields; no overdue queries. (`prisma/schema.prisma:126-164`)
- **Ticket/comment keyword search** — FTS exists only inside the RAG subsystem, not across tickets.
- **Attachments** — tickets/comments are text-only; no upload model or endpoints.
- **Bulk operations** — no batch update/close/label/assign; agents loop one-by-one, non-atomically.
- **API versioning** — no `/v1` or header versioning; retrofitting will be painful since the generated CLI client is tightly coupled to the contract.
- **Multi-DB claim is not real** — `schema.prisma:9` hardcodes `provider = "sqlite"`; Postgres/MySQL needs schema edits + migration rewrites. Parametrize it or fix the docs.

### CLI (undermines the "agent-native" pitch)

- **Agent lifecycle commands entirely missing** — no `agent create/list/update/rotate-key/delete`, even though the generated client functions already exist in `apps/cli/src/generated/services.gen.ts`. Agents cannot be provisioned from the CLI at all.
- **Memory write commands missing** — only `memory timeline` is wired; `extract`/`decisions`/`create` have generated-client support but no command.
- **Errors are never JSON under `--json`** — `utils/error.ts:41-70` always prints colorized text to stderr; only exit codes (0/1/2/3/4) are machine-reliable.
- **Profile management is dead code** — `config profile list/add/remove` implemented and tested in `commands/config.ts:44-77` but never registered in `index.ts`.
- No `--watch`/poll mode, no bulk ops, no shell completion, plaintext credential store (`conf` without `encryptionKey`).
- Coverage matrix: tickets/comments/labels/kb/vcs/webhooks/admin/context/code-intel are **full**; agents/memory are the gaps; project↔agent role assignment missing.

### Web UI (large API surfaces with zero UI)

Modules with **no UI at all**: memory browser, project **timeline/activity feed**, code-intel symbol/call-graph views, outbox dead-letter admin, SLO/monitoring dashboard, generic webhooks CRUD, RAG graphify import + retrieval eval. For a product pitched on "humans oversee agents," a human cannot see what agents learned or did over time.

Existing-page gaps:

- **No pagination anywhere** — pages fetch `TicketPage` but ignore `total`/`page` (same in agents/labels/projects pages).
- **No real-time updates** — no WebSocket/SSE/polling; board goes stale until manual reload.
- Board: no drag-and-drop, no filter/search/sort (`TicketBoard.vue` plain array filter).
- No optimistic UI; `CommentThread.vue` mutations have no try/catch (silent failure possible).
- **Refresh token fetched but discarded** in `composables/useAuth.ts`; no session-expiry UX beyond a bounce to `/login`.
- **No role-based UI hiding** — current user's role never checked client-side; all destructive buttons shown regardless of permission.
- Accessibility: only ~3 explicit `aria-*`/`role`/`alt` attrs across custom components (radix-vue primitives provide a baseline).
- Confirmed good: i18n en/zh fully in sync (354/354 keys), dark mode complete, consistent Loading/Error states, clean `useApi.ts` error pattern.

---

## 3. Cross-cutting improvements

### CI/CD

- Playwright e2e suite is fully runnable (`playwright.config.ts` self-contained) but **never invoked in CI**.
- **No coverage gate** — `test:cov` exists but CI runs plain `test`; no `coverageThreshold`, no upload.
- **No OpenAPI drift check** — CI regenerates the client but never `git diff --exit-code openapi.json apps/cli/src/generated`.
- **Changesets present but unwired** — no `changesets/action` in workflows; releases are manual tag-triggered.
- Strengths worth keeping: `policy-gates`, retrieval `evaluate`, and `smoke` CI jobs.

### Docs drift

- README ~2 months stale: shows `packages/cli` (actual: `apps/cli`), marks CLI/Web/Docker/RAG/webhooks phases "🔄 Upcoming" though all shipped, says "CONTRIBUTING.md (coming soon)" though it exists.
- `docs/architecture.md` leaks a `/home/williamkhoo/...` absolute path (~L104).
- `docs/20260620-prisma-data-layer-violations.md` fully stale (all fixed) — archive.
- Only one ADR (`ADR-001`) despite many major features; decisions scattered across `docs/specs/`.
- Swagger is dev-only and no hosted API docs; **no end-to-end agent-integration guide** despite that being the core pitch.

### Observability / deployment

- Custom Prisma-backed SLO dashboard only — no Prometheus `/metrics`, no OpenTelemetry, no tracing, no log aggregation.
- Health check is a bare `{status:'ok'}` — no DB/LanceDB probes, no readiness/liveness split.
- Docker Compose only (no k8s — fine, but state it as a non-goal). Root `docker-compose.yml` has no migrate step (only `deployments/example` does).
- Volume backup implicitly covers LanceDB (same `koda_data` volume) but this isn't documented; no restore-verification procedure for the vector store.

### Repo hygiene

- `TEST_SUMMARY.md` tracked at root (stale nax RED-phase artifact; `.gitignore` only covers `TEST_SUMMARY_*.md`); second copy under `apps/api/test/integration/koda-domain-writer/`.
- `.nax-verifier-verdict.json` tracked despite matching `.gitignore` (committed before the rule).
- `apps/api/src/state/` is an **empty dead module** (only an empty `dto/` folder, not imported in `app.module.ts`) — delete.
- Oversized services worth splitting: `rag/rag.service.ts` (841 L), `vcs/vcs-webhook.service.ts` (652 L), `policy/policy-gate.service.ts` (597 L).

### Security posture confirmed good (no action)

`.env` untracked (placeholders only), agent API keys HMAC-hashed (`Agent.apiKeyHash`), bcrypt cost 12 + password complexity, AES-256-GCM with random IV/auth-tag for VCS tokens (key rotation unaddressed), timing-safe CI-webhook signature comparison, class-validator + global validation pipes.

---

## 4. Suggested priority order

1. **Security/reliability defects** — CORS/Helmet, token revocation + logout, webhook→outbox unification, outbox backoff fix, LanceDB mutex, GitLab provider (or de-advertise).
2. **CLI agent-native promise** — env-var fix (unify `resolveContext`/`resolveAuth`), agent lifecycle commands, JSON errors under `--json`, register `config profile`.
3. **Product features** — notifications, pagination + real-time board, due dates, ticket search.
4. **Oversight visibility** — timeline/memory/code-intel web views (the differentiator for "humans oversee agents").
5. **CI hardening + docs sweep** — Playwright in CI, coverage gate, OpenAPI drift check, wire Changesets; fix README, archive stale violation doc, correct multi-DB claim.
