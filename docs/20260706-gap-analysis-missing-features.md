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

> **Update 2026-07-06:** Defects #1, #4, #5, and #7 are fixed on branch `fix/highest-impact-defects-20260706` (see status column). Defect #6 is now fully fixed on branch `fix/token-revocation-logout-20260706` (PR [#118](https://github.com/nathapp-io/koda/pull/118), not yet merged). #2 and #3 remain open.
>
> **Update 2026-07-12:** Defect #2 (GitLab provider) is now fixed on branch `fix/gitlab-provider-lancedb-mutex-hygiene`. Defect #7's original fix only serialized table *creation*; that branch additionally serializes table *writes* (`add`/`delete`/`optimize`), closing the remaining race window. #3 (webhook fire-and-forget) remains open.

| # | Defect | Evidence | Status |
|---|--------|----------|--------|
| 1 | **No CORS / Helmet on the API.** `main.ts` never calls `.useServerSecurityConfig()` (the `@nathapp/nestjs-app` hook that enables CORS + `@fastify/helmet`). No security headers, effectively open CORS; `@fastify/helmet` isn't even a dependency. | `apps/api/src/main.ts:37-46` | ✅ Fixed — `ServerSecurityConfig` wired into `ConfigModule`, `useServerSecurityConfig()` called in `main.ts`, `@fastify/helmet` added as a dependency. |
| 2 | **GitLab VCS provider is a hard stub.** Throws `ValidationAppException` immediately; only `github.provider.ts` exists, despite GitLab being advertised throughout (`detect-provider.util.ts`, `git-url.util.ts`). | `apps/api/src/vcs/factory.ts:101-103` | ✅ Fixed — new `GitLabProvider` implements `IVcsProvider` against GitLab API v4 (issues, merge requests, branch creation, commits, file fetch), wired into `createVcsProvider`. Also fixed a latent bug in the shared default `HttpClient`: POST requests never set `Content-Type: application/json`, so `fetch` sent bodies as `text/plain` and GitLab (and GitHub) would silently fail to parse branch/PR-creation payloads. |
| 3 | **Outbound webhooks are fire-and-forget.** No persistence, retry, dead-letter, or delivery record — at-most-once with silent failure. The outbox module already has claim-based concurrency + backoff + DLQ; route webhooks through it. | `apps/api/src/webhook/webhook-dispatcher.service.ts:19-23` | Open |
| 4 | **Outbox backoff is dead code on the hot path.** `processPending()`'s catch calls `markFailed()`, which requeues instantly for the next 5s cron tick; `retry()`'s `BACKOFF_MS` exponential logic is never used → transient failures tight-loop. | `apps/api/src/outbox/outbox.service.ts` (~L57 vs ~L78-86), `outbox-processor.ts` | ✅ Fixed — added a `nextAttemptAt` column; `findPending` now skips events still in backoff and `markFailed` computes `nextAttemptAt` via the existing exponential formula. `OutboxService.retry()` is left in place (still unused in production) since removing it was out of scope for this fix. |
| 5 | **CLI env-var overrides silently don't work.** `KODA_API_KEY`/`KODA_API_URL` are honored by `utils/auth.ts` `resolveAuth()`, but `config.ts` `resolveContext()` (used by 14 of 17 command modules, incl. `ticket`) never reads `process.env`. Two divergent auth-resolution code paths. | `apps/cli/src/config.ts`, `apps/cli/src/utils/auth.ts` | ✅ Fixed — `resolveContext()` now reads `KODA_API_KEY`/`KODA_API_URL`/`KODA_PROJECT_SLUG` with the same flag-then-env precedence as `resolveAuth()`. |
| 6 | **No token revocation or logout.** Refresh tokens are stateless 30-day JWTs with no revocation store; `revoked: false` hardcoded in both auth providers; no `POST /auth/logout`. Root `.env`/`.env.example` ship `JWT_EXPIRES_IN=7d` while the code default is a safer `15m`. | `apps/api/src/auth/auth.service.ts:75-88`, `jwt-auth.provider.ts:27-28`, `agent-auth.provider.ts:31-32` | ✅ Fixed — added `User.tokenVersion`, embedded in access/refresh JWT payloads; `JwtAuthProvider` and a new `KodaJwtRefreshStrategyProvider` check it to mark tokens revoked; added `POST /auth/logout` (bumps `tokenVersion`, revoking all outstanding sessions for the user) and a `koda auth logout` CLI command. Revokes all sessions at once, not per-device (no sessions table). `.env.example` also corrected to `JWT_EXPIRES_IN=15m`. |
| 7 | **No LanceDB write serialization.** Table open/create with no mutex; concurrent ingestion from multiple agents risks races on the embedded file-based store. | `apps/api/src/rag/rag.service.ts` (~L267-338) | ✅ Fixed — per-tableName in-flight promise lock serializes concurrent `getOrCreateTable` calls (table *creation*). **2026-07-12:** table *writes* (`table.add` in `indexDocument`, `table.delete` in `deleteBySource`/`deleteAllBySourceType`, `table.optimize`) are now also serialized per project via a `runExclusive` write lock, since LanceDB has no built-in concurrent-writer protection — the earlier fix only covered the create-table race, not concurrent add/delete on an already-open table. |

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

- ~~**Agent lifecycle commands entirely missing** — no `agent create/list/update/rotate-key/delete`, even though the generated client functions already exist in `apps/cli/src/generated/services.gen.ts`. Agents cannot be provisioned from the CLI at all.~~ ✅ Fixed 2026-07-12 — `agent list/create/update/rotate-key/delete` added, wired to the existing generated client functions.
- ~~**Memory write commands missing** — only `memory timeline` is wired; `extract`/`decisions`/`create` have generated-client support but no command.~~ ✅ Fixed 2026-07-12 — `memory decisions`/`memory create` added. `extract` was deliberately left uncovered: it's only ever invoked internally (outbox fan-out → `extractionService.extractFromEvent()` directly), never over HTTP, so no CLI consumer needs it. Doing this surfaced that `recordDecision`/`createMemory` had no documented request body (inline types, not DTOs) — added `RecordDecisionDto`/`CreateMemoryDto` and regenerated `openapi.json`/the CLI client so a body could be sent at all. That in turn surfaced two real authz gaps the new CLI commands would otherwise have made exploitable: `createMemory` returned `{error: 'ACCESS_DENIED'}` inside a 200 envelope instead of throwing (CLI read it as success), and `recordDecision` had no role check at all plus a spoofable caller-supplied `actorId` — both fixed (throws `ForbiddenAppException`; only admins may attribute a decision to someone else).
- ~~**Errors are never JSON under `--json`** — `utils/error.ts:41-70` always prints colorized text to stderr; only exit codes (0/1/2/3/4) are machine-reliable.~~ ✅ Fixed 2026-07-12 — `handleApiError` now emits a single `{"error": {code, message, status, hint}}` JSON object to stderr (still stderr, not stdout — keeps stdout reserved for successful `--json` command output) instead of colorized text, whenever the invoked command's own `--json` flag was set. Exit codes unchanged. Since `handleApiError` has ~160 call sites and none pass their local `options.json` through, wiring is via a new `apps/cli/src/utils/json-mode.ts` module set once per invocation from a `preAction` hook in `index.ts` reading the matched command's own `--json` option — no changes needed at any of the 160 call sites. Scope note: a handful of `index.ts`-local commands (`login`, `config show/set`) still use ad hoc `console.error`/`process.exit` and don't even have a `--json` flag to opt into this — left out of scope since the gap-analysis pointer was specifically to `utils/error.ts`.
- ~~**Profile management is dead code** — `config profile list/add/remove` implemented and tested in `commands/config.ts:44-77` but never registered in `index.ts`.~~ ✅ Fixed 2026-07-12 — registered in `index.ts`; verified via a smoke test of the built CLI (no automated regression test — `index.ts` calls `program.parse()` at module load, making it import-unsafe to unit test without a refactor).
- No `--watch`/poll mode, no bulk ops, no shell completion, plaintext credential store (`conf` without `encryptionKey`). Still open.
- Coverage matrix update: agent/memory write commands and config profile are no longer gaps; remaining CLI gaps are `--json` errors, watch mode, bulk ops, shell completion, and credential encryption. Also noted in review but out of scope here: `GET /agents` (`agent list`) has no server-side permission check even though other agent-admin routes do — `apps/web/pages/agents.vue` already relies on it being unrestricted, so tightening it is a separate, higher-blast-radius change.

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

- ~~`TEST_SUMMARY.md` tracked at root (stale nax RED-phase artifact; `.gitignore` only covers `TEST_SUMMARY_*.md`); second copy under `apps/api/test/integration/koda-domain-writer/`.~~ ✅ Fixed 2026-07-12 — both copies untracked, `.gitignore` widened to also match the bare `TEST_SUMMARY.md` filename.
- ~~`.nax-verifier-verdict.json` tracked despite matching `.gitignore` (committed before the rule).~~ ✅ Fixed 2026-07-12 — untracked.
- ~~`apps/api/src/state/` is an **empty dead module** (only an empty `dto/` folder, not imported in `app.module.ts`) — delete.~~ ✅ Fixed 2026-07-12 — removed (it was untracked/local-only, not committed).
- Oversized services worth splitting: `rag/rag.service.ts` (859 L as of 2026-07-12, grew from 841 L), `vcs/vcs-webhook.service.ts` (652 L), `policy/policy-gate.service.ts` (597 L). Still open.

### Security posture confirmed good (no action)

`.env` untracked (placeholders only), agent API keys HMAC-hashed (`Agent.apiKeyHash`), bcrypt cost 12 + password complexity, AES-256-GCM with random IV/auth-tag for VCS tokens (key rotation unaddressed), timing-safe CI-webhook signature comparison, class-validator + global validation pipes.

### Dependency vulnerabilities (`bun audit`)

**2026-07-12:** `bun audit` reported 113 vulnerabilities (2 critical, 45 high, 58 moderate, 8 low). Fixed the direct dependencies with a safe, non-breaking patch available: `axios` (CLI, ^1.7.0→^1.18.1, closes 9 CVEs), `@nestjs/common`/`core`/`platform-fastify`/`swagger`/`testing`/`cli` (API, bumped in lockstep to latest 11.x), `joi` (API, ^18.0.2→^18.2.3), `@nestjs/schedule` (API, ^4.0.0→^6.1.3, closes the residual `@nestjs/core` advisory too). 113 → 84 remain, none of them koda-controlled direct deps with an in-range fix left on the table (independently verified). **Still open, needs dedicated follow-up (not bundled into the audit sweep — each needs its own testing):**
- `nuxt` (web) stuck at `^3.21.2` — bumping to `^3.21.8` (needed to fix 8 nuxt CVEs, incl. one high-severity route-rule middleware bypass) breaks `nuxt typecheck`: a `watch()` callback's parameter type regresses to `Ref<T>` instead of the unwrapped `T` in `apps/web/pages/[project]/settings.vue` (~L72-77).
- ~~`@nestjs/core`'s injection advisory (GHSA-36xv-jgw5-4q75, <=11.1.17) persists via a nested copy bundled as a *real* (non-peer) dependency of `@nestjs/schedule@4.1.2`~~ ✅ Fixed 2026-07-12 — bumped `@nestjs/schedule` `^4.0.0`→`^6.1.3`. Correction to the note above: 5.x/6.x *do* support NestJS 11 (`peerDependencies: "^10.0.0 || ^11.0.0"`) and drop the nested `@nestjs/core` dependency entirely — the earlier "peer ranges don't support 11" claim only checked 4.1.2 and was wrong. Usage (`@Cron`, `ScheduleModule.forRoot()`, `SchedulerRegistry`) is the package's stable public API, unchanged across majors. Verified via full test suite + a live boot smoke test with the 5s outbox cron firing cleanly.
- 2 critical findings (`handlebars`, `shell-quote`) are dev/build-tool-only (pulled by `@hey-api/openapi-ts` codegen and `ts-jest`, not any runtime path) — no production exposure, but still flagged by `bun audit` and worth clearing eventually.
- Remaining ~80 are dominated by nuxt/vite build-toolchain internals, `@nuxt/devtools`, eslint's dependency tree, and prisma CLI — dev-only, each needs an individually-tested major bump.

---

## 4. Suggested priority order

1. **Security/reliability defects** — CORS/Helmet ✅, token revocation + logout ✅, webhook→outbox unification (still open), outbox backoff fix ✅, LanceDB mutex ✅, GitLab provider ✅.
2. **CLI agent-native promise** — env-var fix ✅, agent lifecycle commands ✅, register `config profile` ✅, JSON errors under `--json` ✅. Still open: watch mode / bulk ops / shell completion / credential encryption.
3. **Product features** — notifications, pagination + real-time board, due dates, ticket search.
4. **Oversight visibility** — timeline/memory/code-intel web views (the differentiator for "humans oversee agents").
5. **CI hardening + docs sweep** — Playwright in CI, coverage gate, OpenAPI drift check, wire Changesets; fix README, archive stale violation doc, correct multi-DB claim.
