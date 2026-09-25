# HIGH Findings Remediation — Design

**Date:** 2026-09-25
**Source:** `docs/20260925-review-whole-repo.md` (verification update at HEAD `bdd91483`)
**Status:** Approved design, awaiting implementation plan

## Goal

Close the 10 HIGH findings still open on `main`, plus H7's residual, and the MEDIUM findings that block or undercut a HIGH (M1, M2, M3, M22, M23, and the CI web-build row). Restore the background features that silently never worked (merged-PR auto-transition, memory extraction, entity-graph updates) so that mocks can no longer hide their absence.

## Agreed scope and constraints

- **Strategy:** foundations + patches — build a shared foundation where the finding is a *class* of bug (`resolveTicket`, outbox envelope, single RAG write path); targeted patches for isolated findings.
- **Out of scope:** all other MEDIUMs and LOWs. They get a later effort.
- **Testing:** every fix gets unit tests; findings the review flagged as mock-blind (H5, H6, H13, M3, H7) additionally get real-DB integration tests under the existing `test/integration/` layout.
- **Delivery:** five independently mergeable PRs, one per work stream, in the order below.
- **Success criteria:** re-running the verification against the new HEAD yields 0 open HIGH findings; the previously dead background features demonstrably run against a real DB; `nuxt build` passes in CI.

## PR 1 — Auth hardening (H1, H2, H3, H4)

### H1 — Refresh tokens revoked on logout

`refresh()` in `apps/api/src/auth/auth.service.ts` throws `AuthException` when `principal.revoked` is set. The refresh strategy already computes and returns this (`koda-jwt-refresh-strategy.provider.ts:32-39`); only the service-side check is missing. E2e test: logout → `POST /auth/refresh` with the old token → 401.

### H2 — Register the throttler guard

- Register `DefaultThrottlerGuard` as `APP_GUARD` in `app.module.ts` (today `ThrottlerModule.forRootAsync` exports it but nothing installs it, so every `@Throttle` is inert).
- Configure `trustProxy` on the Fastify adapter in `main.ts` — all traffic arrives via the Nuxt proxy, so without it every client shares one IP bucket.
- Move the class-level 5/min `@Throttle` off `AuthController` onto the individual login/register/logout routes, so `/auth/me` (called on every SSR page load) is not throttled.
- The existing 10/min throttle on `AgentsController` (PR #127 / `bdd91483`) becomes live as a side effect.

### H3 — CI webhook secret no longer readable

- Remove `ciWebhookToken` from `ProjectResponseDto` (`projects/dto/project-response.dto.ts`), so `GET /projects` and `GET /projects/:slug` stop returning it.
- Add `GET /projects/:slug/ci-webhook-token` with `@RequiredPermission('ADMIN')` (pattern already used at `projects.controller.ts:44,74,92`) for admins who legitimately need the value.

### H4 — Agent status change requires ADMIN

- Add `@RequiredPermission('ADMIN')` to `PATCH /projects/:slug/agents/:agentSlug` (`projects.controller.ts:161`).
- Tighten the route's access check so agent principals can update **only their own** agent record (graceful `OFFLINE` shutdown must keep working); all other combinations require project or global ADMIN.
- Remove the blanket agent early-return in `project-access.service.ts` on this path.

## PR 2 — Ticket tenancy (H5, M1, M2, M3, H12)

### Foundation: `resolveTicket(project, ref)`

One lookup helper used by every surface that resolves a ticket by ref (tickets service, comments service, labels repository, transitions via `findTicketByRefRaw`):

- `KEY-N` form: the `KEY` prefix must equal `project.key` (today `OTHER-5` resolves to this project's #5), then lookup by `(projectId, number)`.
- Otherwise: `where: { id, projectId, deletedAt: null }` — closing both the cross-project CUID hole (H5) and the deleted-ticket transition path in one place.
- Misses return a uniform 404 so no information leaks about other projects' tickets.

### M1 — Required transition comments cannot be blank

When a transition route declares a `commentType`, a missing or whitespace-only body is a validation error. Today `dto.body ?? ''` silently skips comment creation.

### M2 — `PATCH` no longer writes `status` directly

If the update payload contains a status change it is routed through the transitions service (enforcing TRANSITION permission, activity rows, webhooks). The two comment-less start transitions (`CREATED/VERIFIED → IN_PROGRESS`) remain legal through the front door, so the CLI keeps working.

### M3 — Transition race eliminated

Status updates inside the transaction use `updateMany({ where: { id, status: from } })` (race site: `ticket-transitions.service.ts:408-437`) and return **409** when 0 rows match.

### H12 — Memory guardrails

- Generic `POST /memory`: force `ownerId = principal.id` for non-admins; reject `kind: DECISION` (decisions only via the guarded `recordDecision` route).
- `POST /memory/extract`: add a DTO, the project-membership check, and role restriction; stop trusting `event.actorId` for `ownerId`.
- `MEMORY_WRITE_ROLES` checks the *project* role when project context exists, so project DEVELOPERs can write memory.

### Tests

Real-DB integration tests: cross-project ticket access → 404; deleted-ticket transition → 404; `OTHER-5` prefix mismatch → 404; stale-status transition → 409; forged-memory attempts rejected.

## PR 3 — Web session end-to-end (H9, cookie names, M22, M23, CI web build)

Four coordinated changes; any one alone still leaves login broken:

1. **H9:** `apps/web/composables/useApi.ts` uses `useRequestFetch()` on the server (forwards browser cookies) and *merges* caller headers instead of overwriting them.
2. **Cookie names:** web constants renamed to `koda_token` / `koda_refresh` to match the API (`auth.module.ts:15-16`). The API is the contract holder.
3. **M23:** the `/api/**` `routeRules` proxy — which runs before the filesystem router and shadows `server/api/auth/*` — is replaced by a Nitro server handler that proxies `/api/**` *except* `/api/auth/**`, reading its target from `runtimeConfig`. This also makes `NUXT_API_INTERNAL_URL` genuinely runtime-overridable (fixes the Dockerfile baked target).
4. **M22:** the refresh server route forwards the *refresh* cookie as Bearer; the client fetch wrapper retries once through `/api/auth/refresh` on a 401 before giving up.

Plus the CI gap that let H8 ship: `nuxt build` added to the CI checks matrix and `.vue` files included in lint.

Verification: CI web build green; Playwright smoke — login → reload → still authenticated.

## PR 4 — CLI config trust (H10)

Project-local `.koda/config.json` is restricted to `projectSlug` and `profile`:

- `init.ts` writes only those two keys.
- `resolveContext` (`apps/cli/src/config.ts`) ignores `apiUrl`/`apiKey` found in a project config with a loud warning; those values resolve only from flags, environment, and the global user config (which the user controls).
- `findProjectConfig` stops treating `~/.koda/config.json` as a project config (also fixes the global-conf-walkup LOW).

## PR 5 — Background features (H6, H13, H7 residual)

### H6 — Merged-PR auto-transition

- Write the FIX_REPORT comment with `authorAgentId: null` (column is nullable, `schema.prisma:177` — no migration, no seeded system agent).
- Make the PR-status update conditional: `updateMany({ where: { id, prNumber, status: IN_PROGRESS } })` so late/replayed events cannot clobber `merged`.
- Real-DB integration test: merged-PR webhook → transition commits (the path every current mock-based spec misses).

### H13 — Outbox event envelope

- Producers enqueue the **full event object** returned by `ticketEventService.create` — `{ id, action, timestamp, ticketId, projectId, actorId, actorType, data }` — instead of `{ ticketId, projectId, actorId, data }` (`tickets.service.ts:64`), which drops exactly the fields the memory and entity-graph consumers switch on.
- Consumers stay as-is; they already expect this shape.
- Emit ticket events from the transition routes and assign (today they enqueue nothing), so memory extraction and graph updates see `status_changed` / `assigned`.
- `writeAgentAction` (`koda-domain-writer.service.ts`) gets the same envelope.
- No schema migration: the outbox drains on the 5-second cron, so the shape change is deployment-safe.

### H7 residual — single RAG write path

Extract a `LanceDbTableManager` (one `lancedb.connect` per path, one `runExclusive` registry per table), provided by the RAG module; `VectorStore` and `HybridRetriever` both perform open/create/add/delete through it. This kills the duplicate rows, the cross-service first-write race, and the deletes-never-reach-Hybrid leak, without merging the two services' retrieval logic.

Integration test against a temp LanceDB directory: one indexed document → exactly one row; delete → zero rows.

## Sequencing

PR 1 → PR 2 → PR 3 → PR 4 → PR 5. Ordered by security impact; no cross-PR dependencies.

## Explicitly out of scope

- M4–M21, M24–M28 and all LOW findings (later effort).
- BUG-14's GitLab end-to-end gap (tracked on the 09-14 list).
- Any restructuring beyond the three named foundations (no Prisma tenant-scoping middleware, no event-bus redesign, no merged RAG service).
