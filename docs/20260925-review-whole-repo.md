# Whole-Repo Code Review: koda (api + web + cli)

**Date:** 2026-09-25
**Scope:** `apps/api`, `apps/web`, `apps/cli`, CI/release workflows. HEAD `6f4420f8`.
**Prior review:** `20260914-review-whole-repo.md`. No code has changed since then. Every open item in that review is **still open** (see the status table). This document only lists findings that are **new**.
**Method:**
- Five parallel read-only reviewers, one per area: API core/auth, API tickets/outbox/webhooks, API VCS/code-intel, API RAG/memory, and web + CLI + CI.
- Each finding was traced through its callers, guards and decorators.
- The `@nathapp/nestjs-*@3.3.0` tarballs were inspected to confirm how the guards and throttler behave.
- Findings marked ✔ in the original pass were re-checked by hand during consolidation.

**Verification pass (2026-09-25, code `6f4420f8`):**
- Five independent read-only verifiers re-checked every finding below and the prior-review status table against source (current HEAD `b2c238fb` adds only this document). `node_modules` is present, so installed-package behavior (`@nathapp/nestjs-app`, `@nathapp/nestjs-throttler`, `@nathapp/nestjs-prisma`, `@nestjs/schedule`, `conf@13.1.0`, `validator`) was read from package code instead of inferred.
- All cited source paths passed coverage checks (`no_recorded_issue`; only `apps/api/Dockerfile` and `apps/web/Dockerfile` are `parse_partial`, at ranges outside the cited build sections). Files whose index metadata was stale were read directly.
- Verdicts below are **CONFIRMED**, **PARTIAL** (real defect; scope/lines corrected), **REFUTED**, or **UNVERIFIABLE** (needs runtime). Results: 13/13 HIGH confirmed; 26/28 MEDIUM confirmed, M12 and M15 partial; M6 and M23 upgraded from *PLAUSIBLE* to confirmed; LOW items confirmed except the `PolicyGateService` bullet (partial); prior-review rows all still open, with the BUG-10 label corrected.
- The proof for every item is inline. The notable corrections are also listed under **Verification corrections applied**.

**Fixes in flight:** PR [#127](https://github.com/nathapp-io/koda/pull/127) (`fix/review-2026-09-14-bugs`, head `fdd03059`, open/unmerged) closes most 2026-09-14 findings and touches H7, H8, H11, M7, M8 and M12 below. Nothing is fixed on `main` until it merges; see **Fixes in flight: PR #127** for the verified mapping.

---

## Verification update: 2026-09-25, HEAD `bdd91483`

The PR #127 content was landed on `main` as commit `bdd91483` ("fix(security): close all review findings from 2026-09-14"). Every HIGH finding was re-checked against source at that HEAD. Result: **10 of 13 HIGH remain open; H8 and H11 are fixed; H7 is partially fixed** (per the prediction in *Fixes in flight* above).

| Finding | Status at `bdd91483` | Evidence |
|:--|:--|:--|
| H1 | Open | `auth.service.ts:82-95` — `refresh()` still never reads `principal.revoked`; re-signs with current `tokenVersion`. |
| H2 | Open | No `APP_GUARD` anywhere in `apps/api/src`; `main.ts:34` still `useAppGlobalGuards()` with no arguments. |
| H3 | Open | `project-response.dto.ts:101` still maps `ciWebhookToken`. |
| H4 | Open | `projects.controller.ts:161` — `PATCH :slug/agents/:agentSlug` still has no `@RequiredPermission`; `project-access.service.ts` unchanged. |
| H5 | Open | `tickets.service.ts` still does bare `findTicketById(ref)`; `findTicketByRefRaw` id-branch (`prisma-tickets.repository.ts:302-305`) filters neither `projectId` nor `deletedAt`. |
| H6 | Open | `prisma-vcs.repository.ts:306` still writes `authorAgentId: 'system'`. |
| H7 | Partial | `rag.controller.ts` still double-indexes via `Promise.all`; per-table locks landed (BUG-4) but duplicates and the cross-service first-write race remain. |
| H8 | **Fixed** | `ACCESS_COOKIE`/`REFRESH_COOKIE` declared at `apps/web/server/utils/api.ts:22-23`. Caveat: the names (`koda_access_token`/`koda_refresh_token`) still disagree with the API's `koda_token`/`koda_refresh` (`auth.module.ts:15-16`), so the end-to-end session remains broken (with H9/M22/M23, all untouched). |
| H9 | Open | `useApi.ts:104-117` still locale-only headers + bare `$fetch`; no `useRequestFetch`/`useRequestHeaders`. |
| H10 | Open | `config.ts` — project `apiUrl` still outranks the profile, and `apiKey` still falls back through `projectConfig?.apiKey` to the global key. |
| H11 | **Fixed** | `cli/src/commands/ticket.ts:309-357` resolves the target to an agent CUID, sends a real `requestBody`, and prints the actual outcome. |
| H12 | Open | `/extract` still takes a raw event with `ownerId` from `event.actorId` (`memory.controller.ts:72`); the generic route accepts caller `ownerId` (`:125`). |
| H13 | Open | Producer still sends `{ticketId, projectId, actorId, data}` (`tickets.service.ts:64`); the memory consumer still reads `action`/`id`/`timestamp`. |

**Remaining HIGH work:** H1, H2, H3, H4, H5, H6, H9, H10, H12, H13, plus H7's residual write-path unification. The *Suggested fix order* below still applies, minus H8/H11.

---

## Remediation update: 2026-09-25, branch `feat/koda-pr5-background` (head `36bb2fb0`)

Three of the remaining HIGH findings are fixed on this branch (unmerged; `main` is unchanged, as with PR #127 before it). Gate at `36bb2fb0`: `apps/api` lint, type-check and unit tests (159 suites / 2162 tests) are green, the root Turbo build succeeds, and the four new integration suites (`test/integration/vcs/vcs-merged-pr`, `test/integration/memory/outbox-envelope`, `test/integration/memory/outbox-fanout-extraction`, `test/integration/rag/lance-table-manager`; 27 tests) all pass. The full integration suite was not re-run — the vcs/rag/ast-index suites carry pre-existing failures unrelated to this branch.

| Finding | Status on branch | Commits | Evidence |
|:--|:--|:--|:--|
| H6 | **Fixed** | `6b456cf7` | `prisma-vcs.repository.ts:306` writes `authorAgentId: null` (no more `Agent` FK violation), and `vcs-pr-sync.service.ts:91-93` treats `merged`/`closed` as terminal so an out-of-order or stale sync can no longer regress `prState`. Covered by the real-DB `vcs-merged-pr` integration spec. |
| H13 | **Fixed** | `1f0a8882` + `b3112309` + `36bb2fb0` | Outbox producers enqueue the full canonical event envelope — `id`, `type`, `action`, `timestamp`, `ticketId`/`agentId`, `projectId`, `actorId`, `actorType`, `data` (`events/outbox-envelope.util.ts`); transitions and assign emit ticket events; the fan-out wiring to the memory/entity-graph consumers is repaired. Covered by the `outbox-envelope` and `outbox-fanout-extraction` integration specs. |
| H7 (residual) | **Fixed** | `b3112309` + `36bb2fb0` | Both RAG services delegate table open/create and all writes to one shared `LanceTableManager` (single connection, single per-table write mutex, sentinel-row create fallback); `addRecord` replaces rows with the same `source_id` first, so re-indexing is idempotent instead of duplicating. `36bb2fb0` additionally fires `optimizeStrategy.onFirstAccess` deterministically across hook-less first access. Covered by the `lance-table-manager` integration spec. |

**Deferred follow-ups (out of scope for this branch):**

- **M12 webhook-path `prState` regression** — explicitly out of scope. The terminal guard covers the sync path; the inbound webhook handlers still write `prState` unconditionally, so late/out-of-order webhook deliveries with fresh delivery ids can still regress the state.
- **Non-atomic VCS repo writes (ambient client)** — the repository's `db` getter returns the ambient `prisma.client`, not a tx-scoped client, so even `applyMergedPrTransition`'s `txManager.run` wraps writes that do not actually join the transaction.
- **Uppercase `TICKET_*` actions match no extraction rule** — `tickets.service.ts:134,260,290` emits `TICKET_CREATED`/`TICKET_UPDATED`/`TICKET_DELETED`, but `extraction.service.ts` gates only on `status_changed` and `assigned`, so those events reach the consumer and extract nothing.
- **`source_id`-only replace scope** — the manager's idempotent replace keys solely on `source_id`; whether re-index replaces should be scoped further (e.g. per project/table) is left open.

---

## Verification corrections applied

| Item | Correction |
|:--|:--|
| H5 | CUID lookup is `tickets.service.ts:195` (not 194). `deletedAt` is enforced on GET/PATCH/DELETE, comments and labels; only the transition path skips it. |
| H6 | `vcs-pr-sync.service.ts:318-329` does not exist (file is 201 lines). Error swallow: `:174-186`; unconditional `prState` write: `:96-97`; comment insert: `prisma-vcs.repository.ts:300-307`. |
| H13 | Overstated: the `EntityStore` `ticket_event` consumer still indexes tickets (`rag.module.ts:95-101`, `entity-store.ts:123-141`); only the memory and entity-graph consumers fail. |
| M1 | `reject` requires a `GENERAL` comment, not `REVIEW`; the body-skip applies to `verify-fix` (REVIEW) and each route's configured type. |
| M2 | Scope is exactly the comment-less `CREATED→IN_PROGRESS` and `VERIFIED→IN_PROGRESS` transitions; for users only global ADMIN has `UPDATE Ticket` (the TRIAGER grant is an agent role). |
| M3 | Race is `ticket-transitions.service.ts:408-437`; the cited `:338-356` is `close()`. |
| M10 | Understated: with `sort=created&direction=asc` and a stale/null `since`, the same oldest ≤30 issues are re-fetched every poll; later issues can be starved indefinitely. |
| M12 | All cited lines were wrong. Regression sites: `vcs-webhook.service.ts:287` (`opened`), `:368` (`closed`), `:400` (`ready_for_review`), `:429` (`reopened`), `:455` (`converted_to_draft`). |
| M14 | "Entity score always 0" applies to the code-module/graphify contribution only; `ticket_event` entities are still indexed. The model to query is `GraphNode`. |
| M15 | "Re-closing appends another copy" is not reachable (CLOSED has no outbound transition; `close()` rejects CLOSED). Duplicates come from non-idempotent indexing and concurrent closes. |
| M23 | Upgraded from *PLAUSIBLE* to CONFIRMED via the compiled Nitro middleware order. `runtimeConfig` is runtime-overridable; only the route-rule proxy target is build-time. |
| M26 | Direct reads are `[ref].vue:532`, `ticket.ts:172` and `:269` (not 531/171/264). |
| M27 | The literal `'self'` is at `ticket.ts:208` (not 207). |
| PolicyGate (LOW) | Partial: invoked by `scripts/policy-gates-runner.ts:145-146` from `ci.yml`; never called at runtime. |
| BUG-10 (prior) | REFUTED as written: the CLI does not self-assign; it sends no body and unassigns (H11 is the accurate finding). |
| BUG-3 (prior) | Schema ranges corrected to `schema.prisma:80-112` (Project) and `:127-165` (Ticket); the cited `:184-260` covers models without `deletedAt`. |

---

## Fixes in flight: PR #127 (unmerged)

**PR:** [#127](https://github.com/nathapp-io/koda/pull/127) · `fix/review-2026-09-14-bugs` · head `fdd03059` (base `6f4420f8`) · open, not merged. Verified against the PR diff; `main` is unchanged until it lands.

| Finding | PR #127 | Evidence (branch) |
|:--|:--|:--|
| H7 | **Partial** | `hybrid-retriever.service.ts` gains `tableCreationLocks`, `writeLocks` and `runExclusive`, fixing prior BUG-4. `rag.controller.ts:88-101` still calls both indexers and the two services keep separate locks/connections, so duplicate rows and the cross-service first-write race remain. |
| H8 | **Fixed (build)** | `ACCESS_COOKIE`/`REFRESH_COOKIE` declared at `apps/web/server/utils/api.ts:19-21`, restoring the web build. H9/M22/M23 are untouched, so end-to-end auth is still non-functional. |
| H11 | **Fixed** | CLI `assign` resolves `--to/--agent` slug → agent CUID, adds `--user` and `--unassign`, and prints the real outcome. With no target it still unassigns, but no longer claims success. |
| M7 | **Partial** | `POST :ref/assign` now requires UPDATE Ticket + project membership. Tickets/comments/labels/`GET /projects` and `ProjectMember` creation are untouched. |
| M8 | **Partial / inert** | `@Throttle(10/min)` added to `AgentsController`; H2 is unfixed, so it has no effect. P2002→500, missing `whitelist` and duplicate DTOs untouched. |
| M12 | **Partial** | Delivery-id replay protection now wraps both inbound webhook paths (SEC-1 fix), but `merged` is still not terminal, so late/out-of-order events with fresh delivery ids still regress `prState`. |

Everything else here is untouched: H1–H6, H9, H10, H12, H13; M1–M6, M9–M11, M13–M28 (except M7/M12); the CI row; and all remaining LOW bullets. The branch's own review doc (`docs/20260914-review-fixes-branch.md`) reports BUG-16/17/18 — the final head already fixes all three (only P2002 maps to 409, DB errors rethrow; ADMIN assignees are exempt from the membership check; the in-memory replay map is age-pruned).

---

## Summary

| Severity | New findings | Verification result |
|:--|:--|:--|
| HIGH | 13 | 13 CONFIRMED (H5/H6/H13 with line/scope corrections) |
| MEDIUM | 28 | 26 CONFIRMED, 2 PARTIAL (M12, M15); M6 and M23 upgraded from *PLAUSIBLE* |
| LOW | ~25 | Confirmed except the `PolicyGateService` bullet (partial); bootstrap-admin race UNVERIFIABLE |

The biggest themes:

1. **Auth controls that look present but are inert:**
   - Refresh tokens survive logout (H1).
   - The throttler guard is never registered (H2).
   - The web app's httpOnly cookie names are undefined (H8).
2. **Tenant isolation by CUID.** Tickets, comments and labels resolve a non-`KEY-N` ref by id alone, so a request under project A's URL can act on project B's ticket (H5).
3. **Features that silently never work because unit tests mock the boundary:**
   - The merged-PR auto-transition fails on a foreign key (H6).
   - The memory and entity-graph outbox consumers receive the wrong payload shape (H13; `EntityStore` ticket indexing is unaffected).
   - `graphify_import` queries a table that does not exist (M14).
   - Web SSR auth drops cookies (H9, M23).
4. **Duplicated or drifting logic:**
   - KB documents are indexed twice (VectorStore + HybridRetriever writing to the same LanceDB table) (H7).
   - The web UI keeps its own state machine, which has drifted from the API's (M25).
   - The CLI `assign` and `mine` commands are broken (H11, M27).

---

## 🔴 HIGH

### H1. Refresh tokens are not revoked on logout ✔
- **Where:** `apps/api/src/auth/koda-jwt-refresh-strategy.provider.ts:32`, `auth.service.ts:78-94`
- **Defect:** The strategy computes `revoked`, but the library's `JwtRefreshGuard` never reads it. `AuthService.refresh` then signs new tokens using the user's *current* `tokenVersion`.
- **Scenario:** The user logs out. Anyone holding the old refresh token calls `POST /auth/refresh` and gets a fresh 7-day session.
- **Fix:** In `refresh()`, throw `AuthException` when `principal.revoked` is set. Add an e2e test: logout → refresh → 401.
- **Verified: CONFIRMED.** `koda-jwt-refresh-strategy.provider.ts:29-32` computes `revoked = !user || user.tokenVersion > tokenVersion`; `auth.service.ts:78-84` never reads it. The installed guard ignores it — `apps/api/node_modules/@nathapp/nestjs-auth/dist/guard/jwt-refresh.guard.js:20-25` only rejects on `err || !user`. The access path does enforce it (`.../strategy/jwt-strategy-provider.js:38-42`); the refresh path returns `validate()` straight to passport. `prisma-auth.repository.ts:79-86` only increments `tokenVersion` on logout, and `refresh()` re-signs with the current version, so a replay yields a full new pair. Cited lines exact.

### H2. No rate limiting is active ✔
- **Where:** `app.module.ts:69-73`, `main.ts:34`
- **Defect:** `ThrottlerModule.forRootAsync` exports `DefaultThrottlerGuard` but never registers it as `APP_GUARD`. `useAppGlobalGuards` only installs the auth and permission guards. As a result, every `@Throttle` is inert: login brute force is unlimited, and so is registration. This also leaves SEC-3's premise moot until the guard is registered.
- **Fix:**
  - Register the guard.
  - Configure `trustProxy`, because all web traffic arrives from the Nuxt server's IP.
  - Move the class-level 5/min `@Throttle` off `AuthController`. Otherwise it also covers `/auth/me`, which runs on every SSR page load.
- **Verified: CONFIRMED.** `app.module.ts:69-73` registers only config; `main.ts:30-34` calls `useAppGlobalGuards()` with no arguments; `@nathapp/nestjs-app/dist/app/nathapp.js:264-271` installs only the JWT + permission guards; `@nathapp/nestjs-throttler/dist/module.js:71-76` provides/exports `DefaultThrottlerGuard` without registering it (`grep APP_GUARD apps/api/src` → 0). The only `@Throttle` in the tree is `auth.controller.ts:22`. Correction: H2 leaves SEC-3's premise **moot until fixed** rather than invalid. `trustProxy` is also unconfigured.

### H3. CI webhook HMAC secret is readable by any authenticated principal ✔
- **Where:** `projects/dto/project-response.dto.ts:101`, `projects.controller.ts:56-71`
- **Defect:** `GET /projects` and `GET /projects/:slug` return `ciWebhookToken`. Anyone who self-registers, and any agent key, can then sign `pipeline_failed` payloads and create tickets in any project.
- **Fix:** Drop the field from the DTO. Expose it only through an admin-only endpoint.
- **Verified: CONFIRMED.** `project-response.dto.ts:100-102` maps `ciWebhookToken`; both GETs (`projects.controller.ts:56-71`) carry no `@RequiredPermission` or membership check, and `PermissionAuthGuard` allows routes without permission metadata. The token is the HMAC secret used by `ci-webhook.controller.ts:30-45` / `ci-webhook.service.ts:12-19`. Nuance: the field is nullable and only settable via `PATCH /projects/:slug` (`update-project.dto.ts:87`), so projects that never configured a token leak `null`.

### H4. Any agent or VIEWER can change any agent's status
- **Where:** `projects.controller.ts:161-181`, `project-access.service.ts:18`
- **Defect:** `PATCH /projects/:slug/agents/:agentSlug` has no `@RequiredPermission`, and the membership check returns early for agents and accepts VIEWER.
- **Scenario:** Agent A sets agent B to `OFFLINE`, which the auth guard then rejects, so B is locked out.
- **Fix:** Require ADMIN (global or project).
- **Verified: CONFIRMED.** `projects.controller.ts:161-179` has no permission decorator; `project-access.service.ts:17-24` returns early for agent principals and allows `ADMIN|DEVELOPER|AGENT|VIEWER`; `combined-auth.guard.ts:86-90` rejects OFFLINE agents at auth time. Nuances: the target must be an agent active on that project (`findByProject` derives agents from assigned tickets); the VIEWER path requires a `ProjectMember` row, and none are created (M7), so in practice the user path is a global ADMIN or a manually seeded row; non-member non-ADMIN users are rejected. `agentsService.update` invalidates the agent cache, so the lockout is immediate.

### H5. Tickets resolved by CUID are not project-scoped; transitions work on soft-deleted tickets ✔
- **Where:** `tickets/tickets.service.ts:195`, `prisma-tickets.repository.ts:267-290`
- **Defect:** When the ref is not in `KEY-N` form, the ticket is looked up by `id` alone and `projectId` is never compared. `findTicketByRefRaw`, which every transition uses, also skips `deletedAt`. The same pattern appears in `comments.service.ts:28-31` and `prisma-label.repository.ts:85-94`.
- **Scenario:**
  - `POST /projects/A/tickets/<cuid-of-B-ticket>/verify` transitions B's ticket.
  - It fires A's webhooks and can open a PR in A's repo.
  - GET, PATCH, DELETE, comments and labels also cross projects.
  - Deleted tickets can still be closed or started.
- **Fix:**
  - Use `where: { id, projectId, deletedAt: null }` everywhere.
  - Check that the `KEY` prefix of a `KEY-N` ref equals `project.key` (today `OTHER-5` resolves to this project's #5).
- **Verified: CONFIRMED.** Id-only branch at `tickets.service.ts:194-196` / `prisma-tickets.repository.ts:286-289`; `findTicketByRefRaw` filters neither `projectId` nor `deletedAt` (`:267-290`); transitions check only `!ticket` (`ticket-transitions.service.ts:240-241,308-309,338-341,413-416`) and use the URL project for webhooks/PRs (`:464-466`). Corrections: the id lookup is line **195**; GET/PATCH/DELETE, comments (`comments.service.ts:33`) and labels (`labels.service.ts:105-108,162-165`) *do* enforce `deletedAt` — only the transition path skips it. Cross-project mutations still require the caller's TRANSITION permission on project A. The `KEY-N` regex captures the number only (`prisma-tickets.repository.ts:275-282`), so `OTHER-5` resolves locally.

### H6. Merged-PR auto-transition always fails (FK violation) ✔
- **Where:** `vcs/prisma-vcs.repository.ts:300-307`
- **Defect:** The FIX_REPORT comment is written with `authorAgentId: 'system'`, which has an FK to `Agent.id`, and no such agent exists. The transaction rolls back, `vcs-pr-sync.service.ts` swallows the error, and `prState=merged` is still stored, so polling never retries the transition.
- **Why tests pass:** Every test mocks `vcsRepo`.
- **Fix:**
  - Use `authorAgentId: null` or seed a system agent.
  - Make the status update conditional (`updateMany where status=IN_PROGRESS`).
  - Add a real-DB integration test.
- **Verified: CONFIRMED.** `prisma-vcs.repository.ts:300-307` writes `authorAgentId: 'system'`; FK declared at `schema.prisma:173,179` and enforced in migration `20260321085845_fix_field_names/migration.sql:24`. `txManager.run` (default isolation) rolls back on throw (`@nathapp/nestjs-prisma` dist). `vcs-pr-sync.service.ts:174-186` swallows, `:96-97` stores `prState` unconditionally, and polling skips links already `merged/closed` (`prisma-vcs.repository.ts:233`). No system agent exists in `seed.ts`/`seed-e2e.ts` or any migration. Every VCS spec binds a mock repository, including `test/integration/vcs/*`. Corrections: the cited `vcs-pr-sync.service.ts:318-329` does not exist (file is 201 lines) — swallow is `:174-186`; webhook redelivery does retry the transition (and fails again), only polling never does.

### H7. KB documents are indexed twice into the same LanceDB table ✔
- **Where:** `rag/rag.controller.ts:88-101`
- **Defect:** `addDocument` runs `Promise.all` over `ragService.indexDocument` (VectorStore) and `hybridRetrieverService.indexDocument`. Both open `project_${id}` at the same `lancedbPath`, with different ids and separate locks.
- **Scenario:**
  - **Duplicates:** Every document appears twice in search.
  - **First-write race (prior BUG-4):** On a project's first document, both do check-then-`createTable`, and the loser 500s.
  - **In-memory mode:** HybridRetriever keeps its own store, so it never sees closed tickets or graphify nodes, and deletes do not reach it.
- **Fix:** Give HybridRetriever a single write path. It should read through a table manager owned by VectorStore, with one connection and one `runExclusive`.
- **Verified: CONFIRMED.** `rag.controller.ts:88-101` calls both services; VectorStore uses `lancedbPath`/`project_<id>`/random id + `table.add` under `runExclusive` (`vector-store.service.ts:94,229,346,356`); Hybrid uses the same path/table, random id, bare `table.add` with no lock (`hybrid-retriever.service.ts:90,155,165,180,185`). `InMemoryTable.delete` is a no-op in Hybrid (`:61`), so VectorStore deletes never reach it. The "loser 500s" sub-claim is structural: LanceDB was not executed during verification, so the exact failure mode is runtime-dependent. **Fix in flight (PR #127):** HybridRetriever now has per-project creation/write locks and `runExclusive`, fixing prior BUG-4, but `rag.controller.ts:88-101` still double-indexes and the two services keep separate locks/connections, so duplicates and the cross-service first-write race remain.

### H8. Web: `ACCESS_COOKIE` / `REFRESH_COOKIE` are never declared ✔
- **Where:** `apps/web/server/utils/api.ts:36,45,56,57,74,98`
- **Defect:** Grep finds no definition anywhere in `apps/web`. The Nuxt server auth routes (login, register, refresh, logout, me) depend on these names. Depending on how Nitro resolves them, this is a build error, a runtime ReferenceError, or a cookie named `undefined`. The API only reads `koda_token` and `koda_refresh`.
- **Why CI missed it:** CI never builds the web app (R1).
- **Fix:** Declare the constants. Add `nuxt build` to CI.
- **Verified: CONFIRMED.** No declaration exists in `apps/web` source (only `server/utils/api.ts` uses/exports them). The `.nuxt/types/nitro-imports.d.ts` globals are artifacts referencing the same module, and the stale `apps/web/.output/.../nitro.mjs:7017-7018` still contains `koda_access_token`/`koda_refresh_token` — which also disagree with the API's `koda_token`/`koda_refresh` (`auth.module.ts:15-16`). Failure-mode correction: a bare `export { X }` with no local binding is a hard ESM/compile error; the `undefined`-cookie outcome is the least likely. Cited lines exact. **Fix in flight (PR #127):** constants declared at `apps/web/server/utils/api.ts:19-21` (`koda_access_token`/`koda_refresh_token`), restoring the build; H9/M22/M23 are untouched, so end-to-end auth is still non-functional.

### H9. Web SSR drops the browser cookie, so deep links always bounce to `/`
- **Where:** `composables/useApi.ts:115`, `composables/useAuth.ts:68`, `middleware/auth.global.ts:10`
- **Defect:** Server-side `$fetch` does not forward the request cookies, and `useApi` also overwrites caller headers.
- **Scenario:**
  - SSR `fetchUser()` → null → redirect to `/login`.
  - The client then sees the cookie → redirect to `/`.
  - SSR `useAsyncData` gets 401s.
- **Fix:** Use `useRequestFetch()` or `useRequestHeaders(['cookie'])`, and merge headers instead of replacing them.
- **Verified: CONFIRMED.** `useApi.ts:102-115` builds headers from locale only and calls `$fetch(url, { ...options, headers: getHeaders() })`, discarding any caller/serialized headers; no `useRequestFetch`/`useRequestHeaders` exists in web source. SSR callers: `[ref].vue:58-61`, `auth.global.ts:9-11` → `useAuth.ts:66-73`. Corrections: the `fetchUser` call is `useAuth.ts:68` and the middleware call is `auth.global.ts:10` (cited 69/9, off by one).

### H10. CLI sends the user's global API key to a repo-controlled URL ✔
- **Where:** `apps/cli/src/config.ts:131-144`
- **Defect:** `apiUrl` is read from the project-local `.koda/config.json`, but `apiKey` falls through to the global key.
- **Scenario:** A cloned repo ships `{"apiUrl":"https://evil"}`. The next `koda ticket …` sends the user's Bearer key there.
- **Fix:** Allow only `projectSlug` and `profile` in project config. Alternatively, bind stored keys to the origin they were issued for.
- **Verified: CONFIRMED.** `config.ts:131-144`: project `apiUrl` outranks profile/global (`:134`), while `apiKey` falls through to the global key (`:141-143`); line 141 also accepts a repo-supplied `apiKey`. `init.ts:70-86` prints "must not contain API tokens" but nothing validates an existing/cloned file, and `resolveContext` consumes both fields.

### H11. CLI `ticket assign` unassigns the ticket (supersedes BUG-10)
- **Where:** `cli/src/commands/ticket.ts:395` → `tickets.service.ts:303-314`
- **Defect:** The command sends no body, so both assignee fields are set to null, while the CLI prints "✓ Ticket assigned successfully".
- **Fix:** Send the caller's id (from `/agents/me`). Fix together with BUG-2: add a DTO and a permission check.
- **Verified: CONFIRMED.** `ticket.ts:395` calls the generated `ticketsControllerAssign({ slug, ref })` with no body and prints success at `:401`; Fastify maps an absent body to `{}` (`raw-body.hook.ts:63`); `tickets.service.ts:303-312` initializes both assignee fields to `null` and only sets them when `userId`/`agentId` is present. Aside: the prior review's BUG-10 label ("still self-assigns") is wrong — the behavior is unassign; H11 is the accurate description. **Fix in flight (PR #127):** CLI `assign` now resolves `--to/--agent` to an agent CUID, adds `--user` and `--unassign`, and prints the actual outcome; with no target it still unassigns, but no longer claims success.

### H12. Memory guardrail bypass: agents can forge other agents' decisions
- **Where:** `memory/memory.controller.ts:46-78, 109-129`
- **Defect:** `recordDecision` blocks attributing a decision to someone else. `POST /memory` (with `kind: DECISION`, `subject: agent:<victim>`) and `POST /memory/extract` (a raw event with no DTO, no membership check, and `ownerId` taken from `event.actorId`) both bypass that check.
- **Scenario:** The forged decision supersedes the victim's active decision and shows up in `/context`.
- **Related:** `MEMORY_WRITE_ROLES` is compared against the *global* role (`MEMBER`/`ADMIN`), so project DEVELOPERs can never write memory.
- **Fix:**
  - Force `ownerId = principal.id` for non-admins.
  - Reject DECISION on the generic route.
  - Put a DTO and authorization on `/extract`, or remove it.
- **Verified: CONFIRMED.** `memory.controller.ts:14` role list = `ADMIN|DEVELOPER|AGENT`; non-admin humans are global `MEMBER`, so they never qualify. `recordDecision` guards attribution (`:90-94`) but the generic route accepts caller `ownerId` (`:116-126`) with `CreateMemoryDto` allowing DECISION and arbitrary `subject` (`dto/create-memory.dto.ts:3-21,50-53`). `upsert` supersedes the existing active row keyed `KIND:subject:predicate` (`prisma-memory-item.repository.ts:121-139`). `/extract` (`:60-73`) takes `ownerId` from `event.actorId` and skips the membership check entirely. Nuance: superseding the victim's decision requires a matching predicate; without it the forged decision is still created and attributed.

### H13. Outbox payload shape does not match the memory and entity-graph consumers ✔
- **Where:**
  - Producers: `tickets.service.ts:60-65`, `koda-domain-writer.service.ts:103-146`
  - Consumers: `memory-outbox.subscriber.ts:41-48`, `entity-graph-outbox.subscriber.ts:20-34`
- **Defect:** Producers enqueue `{ticketId, projectId, actorId, data}`. Consumers switch on `action` (`status_changed`, `assigned`, `incident_linked`) and read `id` and `timestamp`, none of which are sent. Transitions and assign emit no ticket event at all.
- **Result:** Memory extraction and graph updates from ticket activity never run.
- **Fix:** Agree on one event schema that includes `id`, `action` and `timestamp`, and emit events from transitions and assign.
- **Verified: CONFIRMED, with one overstatement.** Producers match the cited lines (`tickets.service.ts:60-65`; `koda-domain-writer.service.ts:107-112`); `memory-outbox.subscriber.ts:42-47` reads `action/id/timestamp`, `extraction.service.ts:87-153` gates on `action` and would return `[]`; `entity-graph-outbox.subscriber.ts:20-34` → `entity-graph.service.ts:197` `switch(action)` falls to `default`. Correction: a third `ticket_event` consumer works — `EntityStore` (`rag.module.ts:95-101`, `entity-store.ts:123-141`) indexes from `ticketId`/`projectId` without reading `action/id/timestamp`. So ticket KB indexing runs; memory extraction and entity-graph updates do not. `writeAgentAction` (`koda-domain-writer.service.ts:137-147`) has the same missing keys.

---

## 🟡 MEDIUM

### API: tickets, outbox, webhooks

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M1 | `tickets.controller.ts:265,298,317,350`; `ticket-transitions.service.ts:247,256,426` | Required transition comments can be skipped with an empty body. `dto.body ?? ''` → the comment is created only `if (commentType && commentBody)`, so verify-fix approve succeeds with no REVIEW comment. | Reject a blank body when `commentType` is set. |
| M2 | `tickets.service.ts:234-239` | `PATCH :ref {status}` needs only UPDATE (TRIAGER has it), bypasses the TRANSITION permission, and writes no activity or webhook. | Remove `status` from `UpdateTicketDto`, or route it through transitions. |
| M3 | `ticket-transitions.service.ts:408-437` | Check-then-act race: status is validated outside the transaction and the update is unconditional, so concurrent verify and reject both commit. | `updateMany({where:{id,status:from}})`; return 409 when the count is 0. |
| M4 | `outbox-fan-out-registry.ts:22,53,61`; `outbox-processor.ts:15` | `lastDispatchFailureCount` is singleton state reset by each `dispatch()`. The 5s cron has no overlap guard, so one run's failure is wiped by another run and the event is marked `completed`. | Return the failure count from `dispatch()`; add a re-entrancy guard. |
| M5 | `webhook/webhook.dto.ts:4`; `webhook-delivery.handler.ts:31-41` | SSRF (admin-only): `@IsUrl()` accepts internal IPs and metadata hosts, redirects are followed, and `lastError` works as a port-scan oracle. | Require https, reject private IPs after DNS resolution, use `redirect:'manual'`. |
| M6 | `tickets.service.ts:104-121`; `prisma-ci-webhook.repository.ts:38-47` | Ticket number is `max+1` with no retry on P2002, so concurrent creates fail (500 on Postgres). | Retry, or use a per-project counter with `increment`. |

**Verification:** M1–M6 CONFIRMED. M6 upgraded from *PLAUSIBLE*: P2002 falls through to the global `UnknownExceptionHandler` → 500 (installed code), while SQLite serializes via `txManager.run`, so the failure is Postgres/MySQL. Corrections: M1 `reject` requires a `GENERAL` comment, and `fix`/`verify-fix`/`reject` still write activity rows — only the comment is lost; M2 the bypass is limited to the two comment-less start transitions (`CREATED/VERIFIED→IN_PROGRESS`), and only global ADMIN has user `UPDATE Ticket`; M3 the race is at `:408-437` (cited `:338-356` is `close()`), SQLite serializes; M4 corruption requires overlapping 5s cron runs (`waitForCompletion` is never set); M5 `validator` accepts IP literals and dotted internal names but rejects bare `localhost` (require_tld), and the `lastError` oracle is admin-only.

### API: auth, projects, agents

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M7 | `project-access.service.ts` + callers | Membership is enforced on links, vcs, memory, context and code-intel, but **not** on tickets, comments, labels or `GET /projects`. No API creates `ProjectMember` rows. | Pick one tenancy model and apply it everywhere. |
| M8 | `agents.service.ts:145-148`; `prisma-agent.repository.ts:54` | A duplicate slug gives P2002 → 500. The global pipe has no `whitelist`, so `...scalarFields` persists arbitrary body fields (`status`, `id`). DTOs are duplicated in the service and in `dto/`. | Pick fields explicitly, validate the slug, map P2002 → 409, delete the duplicate DTOs. |

**Verification:** Both CONFIRMED. M7 understates one consequence: because no `ProjectMember` rows are ever written, the modules that *do* check membership reject every non-global-ADMIN user — they are effectively admin-only. M8 details: `I18nValidationPipe` forwards options unchanged so `whitelist` stays false; the service `UpdateAgentDto` accepts any `status` while `agents/dto/update-agent.dto.ts:10-13` restricts to `ACTIVE|PAUSED|OFFLINE`; `agents/dto/create-agent.dto.ts` has zero importers. **Fix in flight (PR #127):** `POST :ref/assign` now enforces UPDATE Ticket + membership, and `@Throttle(10/min)` was added to `AgentsController` — but H2 is unfixed so the throttle is inert; the other membership surfaces, P2002 mapping, `whitelist` and duplicate DTOs are untouched.

### API: VCS, code-intel

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M9 | `vcs-connection.service.ts:77,141,240-256` | The webhook secret is generated server-side but never returned, and `dto.webhookSecret` is ignored on update, so webhook mode cannot be configured. | Return the secret once, or accept a caller-supplied one; add a rotate endpoint. |
| M10 | `github.provider.ts:98-108,290-298`; `vcs-polling.service.ts:68-70,123,145` | No pagination: only the first 30 issues and commits are fetched. Polling reuses a stale `lastSyncedAt` captured by the interval closure. | Use `per_page=100`, follow `Link`, re-read the connection each poll. |
| M11 | `prisma-vcs.repository.ts:144-155` | Duplicate detection filters `deletedAt: null`, so deleted imported tickets are re-imported on every sync. `externalVcsId` is also not repo-qualified. | Include deleted rows; store `owner/repo#N`. |
| M12 | `vcs-webhook.service.ts:287,368,400,429,455` | Late or replayed `opened`/`ready_for_review` events regress `prState` from `merged`. | Treat `merged` as terminal; dedup on `X-GitHub-Delivery` (also closes SEC-1). |
| M13 | `ast-index.service.ts:86-90`; `prisma-code-intel.repository.ts:84-95` | `Symbol.id` has no projectId, so two projects on the same repo overwrite each other's symbols. | Put projectId in the key; never update `projectId`. |

**Verification:** M9, M10, M11, M13 CONFIRMED. **M12 PARTIAL — defect real, all originally cited lines were wrong** (`:357,472,501,527` are not regression sites); actual sites are in the table above, and `reopened`/`converted_to_draft`/`closed` also overwrite state unconditionally. M10 understated: `created asc` + stale/null `since` re-fetches the same oldest ≤30 issues, starving later ones; the 30-item cap is GitHub's default (not runtime-fetched). M11: the JSDoc at `:144-148` says it includes soft-deleted rows, but the code filters `deletedAt: null`; numbering still counts deleted rows. **Fix in flight (PR #127):** delivery-id replay protection now wraps both inbound webhook paths (SEC-1), but `merged` is still not terminal, so late/out-of-order events with fresh delivery ids still regress `prState`.

### API: RAG, memory, entity-graph

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M14 | `prisma-rag.repository.ts:178-182` | Raw SQL against a `code_document` table that does not exist. Every `graphify_import` event fails, retries until dead-letter, and re-runs the other handlers each time. The entity score is always 0. | Query `GraphNode` via Prisma. |
| M15 | `tickets.service.ts:259-284` | Soft-deleting a ticket never removes its KB document, and re-closing appends another copy. | `deleteBySource` on delete; make indexing an upsert. |
| M16 | `rag.controller.ts:70,81-87`; `hybrid-retriever.service.ts:149,369,511` | VIEWERs can write to the KB. Unvalidated `metadata.createdAtOverride` → NaN recency → NaN scores for every candidate, which breaks ranking. | Require a write role; validate or remove the override; guard non-finite values. |
| M17 | `hybrid-retriever.service.ts:248-260,328` | Hits that come only from FTS are dropped unless they are in the first 500 rows scanned. | Add `nativeFtsRows` to `recordMap`. |
| M18 | `hybrid-retriever.service.ts:385-406,450` | Absolute tier thresholds are applied to per-query min-max-normalized scores: one weak hit is labelled `high` and good hits in a strong set are labelled `none`. | Tier on raw similarity. |
| M19 | `incremental-graph-diff.service.ts:69-94`; `prisma-rag.repository.ts:112-128` | Prisma graph commits before the LanceDB re-index with no compensation, so a failure leaves vectors permanently stale. Batches are separate transactions, and duplicate links hit P2002 after earlier batches have committed. | Use one transaction, dedupe links, and do LanceDB first or keep a pending-reindex marker. |
| M20 | `prisma-canonical-state.repository.ts:69-82`; `prisma-timeline.repository.ts:31-49` | `/context` and the timeline load the entire event history (no `take`), then sort and slice in JS. | Push down `take` plus a cursor. |
| M21 | `memory-governance.service.ts:44-233` | Offset pagination over `status:'active'` while mutating rows out of it skips items. Dedup only sees within-page duplicates. | Keyset pagination, or SQL `groupBy`. |

**Verification:** M14 and M16–M21 CONFIRMED; **M15 PARTIAL.** M14 corrections: no `code_document` table exists anywhere (real model: `GraphNode`); "entity score always 0" applies to the code-module/graphify contribution only — `ticket_event` entities are still indexed. M15: the soft-delete leak is real, but "re-closing appends another copy" is unreachable (`CLOSED` has no outbound rule; `close()` rejects CLOSED); duplicate vectors come from non-idempotent indexing and concurrent closes, and an admin can remove a doc via `DELETE /projects/:slug/kb/documents/:sourceId`. M16: NaN poisons queries whose candidate pool contains the doc; VectorStore ignores the override. M19: duplicates in the same batch abort that batch atomically; partial commits apply across batches/retries. M21: `downrankStaleLowConfidence` is unaffected; the skip applies to `expireMemories`, `deduplicate`, `applySupersession`.

### Web, CLI, CI

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M22 | `web/server/api/auth/refresh.post.ts:9`; `server/utils/api.ts:74`; `useAuth.ts:81` | Refresh is never called, and if it were, it would send the access cookie rather than the refresh cookie. Users are logged out every 15 minutes. | Send the refresh cookie as Bearer; refresh on 401 and retry. |
| M23 | `web/nuxt.config.ts:71-75` | The `/api/**` routeRules proxy shadows `server/api/auth/*`, so the httpOnly cookie is never set. The proxy target is also baked in at build time (`Dockerfile:53-56`), so runtime `NUXT_API_INTERNAL_URL` is ignored. | Proxy through a server handler that reads `useRuntimeConfig()`; exclude `/api/auth/**`. |
| M24 | `tickets/[ref].vue:122-124`; `MarkdownEditor.vue:22-23` | The markdown renderer fails open: its `catch` returns the raw text into `v-html`. | Return escaped text or an empty string. |
| M25 | `components/TicketActionPanel.vue:78-100` | The web state machine has drifted from the API's: Reject is shown on IN_PROGRESS (always 400) and missing on VERIFIED. | Have the API expose the allowed transitions. |
| M26 | `[ref].vue:532`; `TicketBoard.vue:16`; `cli ticket.ts:172,269` | The UI and CLI read `ticket.assignee.name`, but the DTO only has the `assignedTo*Id` fields, so the assignee always shows as "Unassigned". | Add `assignee` to the DTO. |
| M27 | `cli ticket.ts:208` | `ticket mine` sends the literal `assignedTo: 'self'`, which the API never resolves, so the list is always empty. `--assigned-to <slug>` expects a user id. | Resolve `self` in the API. |
| M28 | `cli ticket.ts:511-522`; `tickets.controller.ts:302` | `verify-fix --pass` cannot send `approve=true` (missing `@ApiQuery`), so it records a failed-fix transition, then calls close. | Add `@ApiQuery`, regenerate, pass `approve`. |
| — | `.github/workflows/ci.yml` | No web build job, and web lint skips `.vue`. This is how H8 shipped. | Add a web build to CI; lint `.vue`. |

**Verification:** All CONFIRMED; M23 upgraded from *PLAUSIBLE* using the compiled Nitro artifact, which registers `routeRules` before the filesystem router (`createRouteRulesHandler` proxies `/api/**` without calling `next`). M23 nuance: `runtimeConfig` *is* runtime-overridable via `NUXT_*`; only the route-rule proxy target is frozen at build (`docker-compose.yml` supplies the same value at runtime). M22 consequence understated: with H8+M23, login cannot establish a session at all, so "logged out every 15 minutes" is moot. M24 is structural — the catch only fires if `marked`/DOMPurify throws (not demonstrated), and the sanitizer's `class` allowance keeps overlay content possible on the sanitized path. M25 extra drift: `close` is offered on VERIFIED/IN_PROGRESS/VERIFY_FIX and bypasses the workflow. M26 direct reads: `[ref].vue:532`, `cli ticket.ts:172` + `:269` (plus `:221`). M27: literal at line 208; the API filter also ignores `assignedToAgentId`, so agent assignees cannot be filtered either. M28 final status still reaches CLOSED, but a fail-semantics REVIEW comment, an IN_PROGRESS activity and extra webhooks are recorded. CI: web `type-check` does run in the checks matrix; the gaps are build and `.vue` lint.

---

## 🟢 LOW (abbreviated)

### API
- **Pagination input:** `page=-1` or `limit=-5` → 500 or a reversed `take`; there is no max on `limit` (`tickets.controller.ts:172`). Also `rag.controller.ts:117` `limit=abc` → NaN. **CONFIRMED** (structural; exact driver outcome runtime-dependent).
- **Outbox is not transactional:** events are enqueued fire-and-forget after commit (`tickets.service.ts:125,251,281`, `ticket-transitions.service.ts:464`). **CONFIRMED.**
- **Admin outbox retry and stale requeue:** **CONFIRMED** (all three sub-claims; admin-only routes).
  - Retry does not reset `attempts`, and it re-sends completed events (`prisma-outbox.repository.ts:145-154`).
  - An unknown id returns 500 (P2025 → unknown handler).
  - Stale requeue never increments `attempts`, so a hanging event loops forever (`:168-176` vs `outbox.service.ts:11`).
- **`close()` bypasses the transition table:** IN_PROGRESS → CLOSED needs no review (`ticket-transitions.service.ts:343-356`). **CONFIRMED.**
- **Webhook routes before the signature check:** **CONFIRMED** (all four sub-claims).
  - CI and VCS webhooks return 404 vs 401 before verifying the signature, which enumerates slugs.
  - The CI DTO is validated before the signature check.
  - `line` is missing `@IsInt` (`ci-webhook.dto.ts:37-40`).
  - The VCS webhook ignores `isActive` and `syncMode`.
- **Latent role trust:** `KodaDomainWriter` trusts a caller-supplied role for user actors (no production caller yet). **CONFIRMED.**
- **Webhook and policy code:**
  - `DELETE projects/:slug/webhooks/:id` ignores `:slug` (`webhook.controller.ts:61-69`). **CONFIRMED.**
  - One malformed `webhook.events` JSON aborts the whole dispatch (`webhook-dispatcher.service.ts:16-19`; requires DB tampering — writes always `JSON.stringify`). **CONFIRMED.**
  - `PolicyGateService` is wired up but never called. **PARTIAL:** it *is* invoked by `scripts/policy-gates-runner.ts:145-146`, run from `ci.yml`; it is never called on a runtime request path.
- **Agents, projects and auth:**
  - Agent create and role replacement are not atomic; a failed role write can leave a working key with no roles (`agents.service.ts:148-154`, `prisma-agent.repository.ts:92-99`). **CONFIRMED.**
  - `pickup` ignores soft-delete, and any principal can trigger it for any agent. **CONFIRMED, corrected:** the ignored soft-delete is the *project* (`prisma-agent.repository.ts:110-112`); ticket queries do filter `deletedAt`. It also writes an `AgentEvent`.
  - Project DTOs reference missing i18n keys (`projects.slugInvalid`, `projects.keyInvalid`, `common.validation.isIn`). **CONFIRMED** (en+zh).
  - A duplicate project slug returns 400, not 409 (`projects.service.ts:42-46`). **CONFIRMED.**
  - Soft-deleted projects can be PATCHed (`projects.service.ts:83-89`; ADMIN-only route). **CONFIRMED.**
  - Nothing enforces `JWT_SECRET !== JWT_REFRESH_SECRET` (`env.validation.ts:14-17`). **CONFIRMED.**
  - *PLAUSIBLE:* a bootstrap-admin race on Postgres. **UNVERIFIABLE statically:** the `$transaction` has default isolation and no unique constraint limits ADMIN; SQLite likely serializes, Postgres READ COMMITTED can race.
- **VCS:**
  - `extractLinks` after auto-PR creation always calls `/pulls/0` (`ticket-transitions.service.ts:207-213`, `vcs-link-extractor.service.ts:48-57`). **CONFIRMED.**
  - The poll `catch` awaits a DB write with no guard, so an unhandled rejection can crash the process (`vcs-polling.service.ts:68-70,174-182`; no global handler). **CONFIRMED.**
  - `syncMode` is not `@IsEnum` on create (`create-vcs-connection.dto.ts:30-32`). **CONFIRMED.**
  - The SLO dashboard loads an unbounded number of rows (`prisma-monitoring.repository.ts:45-49`). **CONFIRMED.**
  - Deleted or renamed code symbols are never removed (`deleteByFile` is unused: `symbol-store.ts:132-134`). **CONFIRMED.**
- **RAG and context:**
  - `table.optimize()` is fire-and-forget without `.catch` (all three optimize strategies). **CONFIRMED.**
  - `LexicalIndexWarmup` loads 50k full rows per project into an index that is never queried (`rag.module.ts:57-60`; `LexicalIndex.search` has 0 callers). **CONFIRMED.**
  - `GetContextQueryDto` has no validators (`context.controller.ts:18-26`). **CONFIRMED.**
  - `evaluate-retrieval.ts` re-seeds duplicates on every run (`scripts/evaluate-retrieval.ts:108-118`). **CONFIRMED.**

### Web
- **Sanitizer allows `class`:** a ticket description can overlay the page with Tailwind classes. **CONFIRMED** (attribute allowance); overlay exploit still *PLAUSIBLE* (not demonstrated).
- **Route params:** `slug`/`ref` go into API paths without `encodeURIComponent`. **CONFIRMED.**
- **Duplicate toast:** a comment toast fires twice (`CommentThread.vue:68-69` + `[ref].vue:172-174`). **CONFIRMED.**
- **Missing i18n keys (both locales):** **CONFIRMED** (all four families).
  - `agents.empty`
  - `agents.toast.created` / `agents.toast.createFailed`
  - `agents.validation.*` (the keys actually live under `agents.form.validation.*`)
  - `auth.validation.nameRequired`

### CLI
- **Global conf mistaken for project config:** `findProjectConfig` walks up to `~/.koda/config.json`. Empty-string `apiUrl` fallbacks use `??`. **CONFIRMED** (both).
- **Secrets as argv:** `--api-key`, `--token` and `--password` end up in history and `ps`. **CONFIRMED.**
- **Exit codes:** **CONFIRMED** (all three).
  - Ctrl+C exits 0.
  - A missing `--force` is inconsistent (exit 1 vs 3).
  - The auth hint prints invalid syntax (`koda config set apiKey <key>` vs `koda config set --api-key <key>`).
- **Numeric options:** unvalidated values send NaN. **CONFIRMED.**

### CI and release
- **Path filters:** they skip `turbo.json` and `.nax/**`. **CONFIRMED.**
- **Bun version:** `packageManager: bun@1.0.0` vs CI 1.3.11. **CONFIRMED.**
- **Docker build:** `TURBO_TOKEN` is passed as a build-arg while the Dockerfiles expect a BuildKit secret. **CONFIRMED** (mismatch; exact build failure mode not build-verified).
- **Re-publish:** a `workflow_dispatch` re-publish does not check out the tag. **CONFIRMED.**
- **No gate:** release is not gated on CI. **CONFIRMED.**

---

## Status of 2026-09-14 findings

All of them are **still open on `main` at `6f4420f8`** (verified against source). PR #127 fixes most of them but is **unmerged**, so the fixes are not in `main` yet:

| ID | Status on `main` | PR #127 (unmerged) | Note |
|:--|:--|:--|:--|
| SEC-1 | Open | Fixed | `WebhookDelivery` + `WebhookReplayGuard` on CI and VCS; only P2002 maps to 409, DB errors rethrow. CI contract now requires `X-CI-Delivery`. |
| BUG-1 | Open | Fixed | `IPrincipal` typing; no `as any`. |
| BUG-2 | Open | Fixed | `AssignTicketDto`; UPDATE Ticket + membership; 404/403 instead of Prisma 500. |
| SEC-2 | Open | Fixed | CLI config chmod `0600` on write and defensively on read. |
| BUG-3 | Open | Fixed | `@@index([deletedAt])` on Project and Ticket (migration `20260914010000`). |
| BUG-4 | Open | Fixed | HybridRetriever creation/write locks. |
| SEC-3 | Open | Partial — inert | `@Throttle(10/min)` on agents, but H2 leaves the throttler guard unregistered. |
| BUG-5 | Open | Fixed | Extractors return `string \| null`. |
| BUG-7 | Open | Fixed | `withContext` helper replaces the duplicated bootstrap blocks. |
| BUG-8 | Open | Fixed | Register fallback is `'User'`. |
| ENH-1, ENH-2, ENH-3 | Open | Fixed | Dead component removed; locale-aware timeline dates; `firstError` skips blanks. |
| BUG-10 | Open | Fixed | CLI assign resolves agent slug → id. |
| BUG-11 | Open | Fixed | 10k-entry cap on the dedup map. |
| BUG-12 | Open | Fixed | Dummy bcrypt compare on unknown email. |
| BUG-13 | Open | Fixed | PR link created only after PR creation succeeds. |
| BUG-14 | Open | Partial | `githubApiUrl` consumed by the provider; GitLab subgroup regex fixed. The create DTO enum is still `github`-only, so GitLab is still unreachable end to end. |
| BUG-15 | Open | Fixed | STATUS_CHANGE `ref` is `KEY-N`. |

The 09-14 review said WEB-02 (logout/refresh wiring) was fixed. It is **not** effectively fixed: the httpOnly cookie wiring exists at the source level, but H8 (undefined constants), M23 (proxy shadows the auth routes) and H9 (SSR drops cookies) prevent a session from being established, and M22 means refresh is never invoked and would send the wrong cookie. PR #127 declares the cookie constants (H8), restoring the build, but leaves H9/M22/M23 untouched, so WEB-02 remains unfixed end to end.

---

## Suggested fix order

PR #127 already covers H8 (build restore), H11, and parts of H7/M7/M8/M12, plus most 2026-09-14 items, once it merges. The ordering below covers what remains on `main`:

1. **H1, H2, H3:** small, isolated auth fixes with high impact.
2. **H5 + BUG-2 + H11:** one shared `resolveTicket(project, ref)` helper that checks `projectId`, `deletedAt` and the key prefix, used by tickets, comments, labels and transitions. Add the assign DTO and permission.
3. **H8, H9, M22 + a CI web build:** makes the web session actually work.
4. **H4, H12, H10:** remaining privilege and credential issues.
5. **H6, H13, M14:** broken background features. Add at least one real-DB integration test per feature so mocks can't hide them again.
6. **H7 / BUG-4:** unify the RAG write path.
7. MEDIUM items, grouped by module.
