# Whole-Repo Code Review: koda (api + web + cli)

**Date:** 2026-09-25
**Scope:** `apps/api`, `apps/web`, `apps/cli`, CI/release workflows. HEAD `6f4420f`.
**Prior review:** `20260914-review-whole-repo.md`. No code has changed since then. Every open item in that review is **still open** (see the status table). This document only lists findings that are **new**.
**Method:**
- Five parallel read-only reviewers, one per area: API core/auth, API tickets/outbox/webhooks, API VCS/code-intel, API RAG/memory, and web + CLI + CI.
- Each finding was traced through its callers, guards and decorators.
- The `@nathapp/nestjs-*@3.3.0` tarballs were inspected to confirm how the guards and throttler behave.
- Findings marked ✔ were re-checked by hand during consolidation.
- Findings marked *PLAUSIBLE* could not be fully confirmed without running the app. There is no `node_modules` in the checkout.

---

## Summary

| Severity | New findings |
|:--|:--|
| HIGH | 13 |
| MEDIUM | 28 |
| LOW | ~25 |

The biggest themes:

1. **Auth controls that look present but are inert:**
   - Refresh tokens survive logout.
   - The throttler guard is never registered.
   - The web app's httpOnly cookie names are undefined.
2. **Tenant isolation by CUID.** Tickets, comments and labels resolve a non-`KEY-N` ref by id alone, so a request under project A's URL can act on project B's ticket.
3. **Features that silently never work because unit tests mock the boundary:**
   - The merged-PR auto-transition fails on a foreign key.
   - The memory and entity-graph outbox consumers receive the wrong payload shape.
   - `graphify_import` queries a table that does not exist.
   - Web SSR auth drops cookies.
4. **Duplicated or drifting logic:**
   - KB documents are indexed twice (VectorStore + HybridRetriever writing to the same LanceDB table).
   - The web UI keeps its own state machine, which has drifted from the API's.
   - The CLI `assign` and `mine` commands are broken.

---

## 🔴 HIGH

### H1. Refresh tokens are not revoked on logout ✔
- **Where:** `apps/api/src/auth/koda-jwt-refresh-strategy.provider.ts:32`, `auth.service.ts:78-94`
- **Defect:** The strategy computes `revoked`, but the library's `JwtRefreshGuard` never reads it. `AuthService.refresh` then signs new tokens using the user's *current* `tokenVersion`.
- **Scenario:** The user logs out. Anyone holding the old refresh token calls `POST /auth/refresh` and gets a fresh 7-day session.
- **Fix:** In `refresh()`, throw `AuthException` when `principal.revoked` is set. Add an e2e test: logout → refresh → 401.

### H2. No rate limiting is active ✔
- **Where:** `app.module.ts:69-73`, `main.ts:34`
- **Defect:** `ThrottlerModule.forRootAsync` exports `DefaultThrottlerGuard` but never registers it as `APP_GUARD`. `useAppGlobalGuards` only installs the auth and permission guards. As a result, every `@Throttle` is inert: login brute force is unlimited, and so is registration. This also invalidates SEC-3's premise.
- **Fix:**
  - Register the guard.
  - Configure `trustProxy`, because all web traffic arrives from the Nuxt server's IP.
  - Move the class-level 5/min `@Throttle` off `AuthController`. Otherwise it also covers `/auth/me`, which runs on every SSR page load.

### H3. CI webhook HMAC secret is readable by any authenticated principal ✔
- **Where:** `projects/dto/project-response.dto.ts:101`, `projects.controller.ts:56-71`
- **Defect:** `GET /projects` and `GET /projects/:slug` return `ciWebhookToken`. Anyone who self-registers, and any agent key, can then sign `pipeline_failed` payloads and create tickets in any project.
- **Fix:** Drop the field from the DTO. Expose it only through an admin-only endpoint.

### H4. Any agent or VIEWER can change any agent's status
- **Where:** `projects.controller.ts:161-181`, `project-access.service.ts:18`
- **Defect:** `PATCH /projects/:slug/agents/:agentSlug` has no `@RequiredPermission`, and the membership check returns early for agents and accepts VIEWER.
- **Scenario:** Agent A sets agent B to `OFFLINE`, which the auth guard then rejects, so B is locked out.
- **Fix:** Require ADMIN (global or project).

### H5. Tickets resolved by CUID are not project-scoped; transitions work on soft-deleted tickets ✔
- **Where:** `tickets/tickets.service.ts:194`, `prisma-tickets.repository.ts:267-290`
- **Defect:** When the ref is not in `KEY-N` form, the ticket is looked up by `id` alone and `projectId` is never compared. `findTicketByRefRaw`, which every transition uses, also skips `deletedAt`. The same pattern appears in `comments.service.ts:28-31` and `prisma-label.repository.ts:85-94`.
- **Scenario:**
  - `POST /projects/A/tickets/<cuid-of-B-ticket>/verify` transitions B's ticket.
  - It fires A's webhooks and can open a PR in A's repo.
  - GET, PATCH, DELETE, comments and labels also cross projects.
  - Deleted tickets can still be closed or started.
- **Fix:**
  - Use `where: { id, projectId, deletedAt: null }` everywhere.
  - Check that the `KEY` prefix of a `KEY-N` ref equals `project.key` (today `OTHER-5` resolves to this project's #5).

### H6. Merged-PR auto-transition always fails (FK violation) ✔
- **Where:** `vcs/prisma-vcs.repository.ts:299-307`
- **Defect:** The FIX_REPORT comment is written with `authorAgentId: 'system'`, which has an FK to `Agent.id`, and no such agent exists. The transaction rolls back, `vcs-pr-sync.service.ts:318-329` swallows the error, and `prState=merged` is still stored, so the transition is never retried.
- **Why tests pass:** Every test mocks `vcsRepo`.
- **Fix:**
  - Use `authorAgentId: null` or seed a system agent.
  - Make the status update conditional (`updateMany where status=IN_PROGRESS`).
  - Add a real-DB integration test.

### H7. KB documents are indexed twice into the same LanceDB table ✔
- **Where:** `rag/rag.controller.ts:88-101`
- **Defect:** `addDocument` runs `Promise.all` over `ragService.indexDocument` (VectorStore) and `hybridRetrieverService.indexDocument`. Both open `project_${id}` at the same `lancedbPath`, with different ids and separate locks.
- **Scenario:**
  - **Duplicates:** Every document appears twice in search.
  - **First-write race (prior BUG-4):** On a project's first document, both do check-then-`createTable`, and the loser 500s.
  - **In-memory mode:** HybridRetriever keeps its own store, so it never sees closed tickets or graphify nodes, and deletes do not reach it.
- **Fix:** Give HybridRetriever a single write path. It should read through a table manager owned by VectorStore, with one connection and one `runExclusive`.

### H8. Web: `ACCESS_COOKIE` / `REFRESH_COOKIE` are never declared ✔
- **Where:** `apps/web/server/utils/api.ts:36,45,56,57,74,98`
- **Defect:** Grep finds no definition anywhere in `apps/web`. The Nuxt server auth routes (login, register, refresh, logout, me) depend on these names. Depending on how Nitro resolves them, this is a build error, a runtime ReferenceError, or a cookie named `undefined`. The API only reads `koda_token` and `koda_refresh`.
- **Why CI missed it:** CI never builds the web app (R1).
- **Fix:** Declare the constants. Add `nuxt build` to CI.

### H9. Web SSR drops the browser cookie, so deep links always bounce to `/`
- **Where:** `composables/useApi.ts:115`, `composables/useAuth.ts:69`, `middleware/auth.global.ts:9`
- **Defect:** Server-side `$fetch` does not forward the request cookies, and `useApi` also overwrites caller headers.
- **Scenario:**
  - SSR `fetchUser()` → null → redirect to `/login`.
  - The client then sees the cookie → redirect to `/`.
  - SSR `useAsyncData` gets 401s.
- **Fix:** Use `useRequestFetch()` or `useRequestHeaders(['cookie'])`, and merge headers instead of replacing them.

### H10. CLI sends the user's global API key to a repo-controlled URL ✔
- **Where:** `apps/cli/src/config.ts:131-144`
- **Defect:** `apiUrl` is read from the project-local `.koda/config.json`, but `apiKey` falls through to the global key.
- **Scenario:** A cloned repo ships `{"apiUrl":"https://evil"}`. The next `koda ticket …` sends the user's Bearer key there.
- **Fix:** Allow only `projectSlug` and `profile` in project config. Alternatively, bind stored keys to the origin they were issued for.

### H11. CLI `ticket assign` unassigns the ticket (supersedes BUG-10)
- **Where:** `cli/src/commands/ticket.ts:395` → `tickets.service.ts:303-314`
- **Defect:** The command sends no body, so both assignee fields are set to null, while the CLI prints "✓ Ticket assigned successfully".
- **Fix:** Send the caller's id (from `/agents/me`). Fix together with BUG-2: add a DTO and a permission check.

### H12. Memory guardrail bypass: agents can forge other agents' decisions
- **Where:** `memory/memory.controller.ts:46-78, 109-129`
- **Defect:** `recordDecision` blocks attributing a decision to someone else. `POST /memory` (with `kind: DECISION`, `subject: agent:<victim>`) and `POST /memory/extract` (a raw event with no DTO, no membership check, and `ownerId` taken from `event.actorId`) both bypass that check.
- **Scenario:** The forged decision supersedes the victim's active decision and shows up in `/context`.
- **Related:** `MEMORY_WRITE_ROLES` is compared against the *global* role (`MEMBER`/`ADMIN`), so project DEVELOPERs can never write memory.
- **Fix:**
  - Force `ownerId = principal.id` for non-admins.
  - Reject DECISION on the generic route.
  - Put a DTO and authorization on `/extract`, or remove it.

### H13. Outbox payload shape does not match the memory and entity-graph consumers
- **Where:**
  - Producers: `tickets.service.ts:60-65`, `koda-domain-writer.service.ts:103-146`
  - Consumers: `memory-outbox.subscriber.ts:41-48`, `entity-graph-outbox.subscriber.ts:20-34`
- **Defect:** Producers enqueue `{ticketId, projectId, actorId, data}`. Consumers switch on `action` (`status_changed`, `assigned`, `incident_linked`) and read `id` and `timestamp`, none of which are sent. Transitions and assign emit no ticket event at all.
- **Result:** Memory extraction and graph updates from ticket activity never run.
- **Fix:** Agree on one event schema that includes `id`, `action` and `timestamp`, and emit events from transitions and assign.

---

## 🟡 MEDIUM

### API: tickets, outbox, webhooks

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M1 | `tickets.controller.ts:265,298,317,350`; `ticket-transitions.service.ts:256,426` | Required transition comments can be skipped with an empty body. `dto.body ?? ''` → the comment is created only `if (commentBody)`, so reject and verify-fix approve succeed with no REVIEW comment. | Reject a blank body when `commentType` is set. |
| M2 | `tickets.service.ts:234-239` | `PATCH :ref {status}` needs only UPDATE (TRIAGER has it), bypasses the TRANSITION permission, and writes no activity or webhook. | Remove `status` from `UpdateTicketDto`, or route it through transitions. |
| M3 | `ticket-transitions.service.ts:338-437` | Check-then-act race: status is validated outside the transaction and the update is unconditional, so concurrent verify and reject both commit. | `updateMany({where:{id,status:from}})`; return 409 when the count is 0. |
| M4 | `outbox-fan-out-registry.ts:22,53,61`; `outbox-processor.ts:15` | `lastDispatchFailureCount` is singleton state reset by each `dispatch()`. The 5s cron has no overlap guard, so one run's failure is wiped by another run and the event is marked `completed`. | Return the failure count from `dispatch()`; add a re-entrancy guard. |
| M5 | `webhook/webhook.dto.ts:4`; `webhook-delivery.handler.ts:31-41` | SSRF (admin-only): `@IsUrl()` accepts internal IPs and metadata hosts, redirects are followed, and `lastError` works as a port-scan oracle. | Require https, reject private IPs after DNS resolution, use `redirect:'manual'`. |
| M6 | `tickets.service.ts:104-121`; `prisma-ci-webhook.repository.ts:38-47` | Ticket number is `max+1` with no retry on P2002, so concurrent creates fail (likely 500 on Postgres). *PLAUSIBLE on the status code.* | Retry, or use a per-project counter with `increment`. |

### API: auth, projects, agents

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M7 | `project-access.service.ts` + callers | Membership is enforced on links, vcs, memory, context and code-intel, but **not** on tickets, comments, labels or `GET /projects`. No API creates `ProjectMember` rows. | Pick one tenancy model and apply it everywhere. |
| M8 | `agents.service.ts:145-148`; `prisma-agent.repository.ts:54` | A duplicate slug gives P2002 → 500. The global pipe has no `whitelist`, so `...scalarFields` persists arbitrary body fields (`status`, `id`). DTOs are duplicated in the service and in `dto/`. | Pick fields explicitly, validate the slug, map P2002 → 409, delete the duplicate DTOs. |

### API: VCS, code-intel

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M9 | `vcs-connection.service.ts:77,141,240-256` | The webhook secret is generated server-side but never returned, and `dto.webhookSecret` is ignored on update, so webhook mode cannot be configured. | Return the secret once, or accept a caller-supplied one; add a rotate endpoint. |
| M10 | `github.provider.ts:97-122,290-309`; `vcs-polling.service.ts:67-70` | No pagination: only the first 30 issues and commits are fetched. Polling reuses a stale `lastSyncedAt` captured by the interval closure. | Use `per_page=100`, follow `Link`, re-read the connection each poll. |
| M11 | `prisma-vcs.repository.ts:144-155` | Duplicate detection filters `deletedAt: null`, so deleted imported tickets are re-imported on every sync. `externalVcsId` is also not repo-qualified. | Include deleted rows; store `owner/repo#N`. |
| M12 | `vcs-webhook.service.ts:357,472,501,527` | Late or replayed `opened`/`ready_for_review` events regress `prState` from `merged`. | Treat `merged` as terminal; dedup on `X-GitHub-Delivery` (also closes SEC-1). |
| M13 | `ast-index.service.ts:86-90`; `prisma-code-intel.repository.ts:84-95` | `Symbol.id` has no projectId, so two projects on the same repo overwrite each other's symbols. | Put projectId in the key; never update `projectId`. |

### API: RAG, memory, entity-graph

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M14 | `prisma-rag.repository.ts:178-182` ✔ | Raw SQL against a `code_document` table that does not exist. Every `graphify_import` event fails, retries until dead-letter, and re-runs the other handlers each time. The entity score is always 0. | Query `GraphNode` via Prisma. |
| M15 | `tickets.service.ts:259-284` | Soft-deleting a ticket never removes its KB document, and re-closing appends another copy. | `deleteBySource` on delete; make indexing an upsert. |
| M16 | `rag.controller.ts:70,81-87`; `hybrid-retriever.service.ts:149,369,511` | VIEWERs can write to the KB. Unvalidated `metadata.createdAtOverride` → NaN recency → NaN scores for every candidate, which breaks ranking. | Require a write role; validate or remove the override; guard non-finite values. |
| M17 | `hybrid-retriever.service.ts:248-260,328` | Hits that come only from FTS are dropped unless they are in the first 500 rows scanned. | Add `nativeFtsRows` to `recordMap`. |
| M18 | `hybrid-retriever.service.ts:385-406,450` | Absolute tier thresholds are applied to per-query min-max-normalized scores: one weak hit is labelled `high` and good hits in a strong set are labelled `none`. | Tier on raw similarity. |
| M19 | `incremental-graph-diff.service.ts:69-94`; `prisma-rag.repository.ts:112-128` | Prisma graph commits before the LanceDB re-index with no compensation, so a failure leaves vectors permanently stale. Batches are separate transactions, and duplicate links hit P2002 after earlier batches have committed. | Use one transaction, dedupe links, and do LanceDB first or keep a pending-reindex marker. |
| M20 | `prisma-canonical-state.repository.ts:69-82`; `prisma-timeline.repository.ts:31-49` | `/context` and the timeline load the entire event history (no `take`), then sort and slice in JS. | Push down `take` plus a cursor. |
| M21 | `memory-governance.service.ts:44-233` | Offset pagination over `status:'active'` while mutating rows out of it skips items. Dedup only sees within-page duplicates. | Keyset pagination, or SQL `groupBy`. |

### Web, CLI, CI

| # | Where | Defect → failure | Fix |
|:--|:--|:--|:--|
| M22 | `web/server/api/auth/refresh.post.ts:9`; `server/utils/api.ts:74`; `useAuth.ts:81` | Refresh is never called, and if it were, it would send the access cookie rather than the refresh cookie. Users are logged out every 15 minutes. | Send the refresh cookie as Bearer; refresh on 401 and retry. |
| M23 | `web/nuxt.config.ts:71-75` | *PLAUSIBLE:* the `/api/**` routeRules proxy likely shadows `server/api/auth/*`, so the httpOnly cookie is never set. The proxy target is also baked in at build time (`Dockerfile:53-56`), so runtime `NUXT_API_INTERNAL_URL` is ignored. | Proxy through a server handler that reads `useRuntimeConfig()`; exclude `/api/auth/**`. |
| M24 | `tickets/[ref].vue:122-124`; `MarkdownEditor.vue:22-23` | The markdown renderer fails open: its `catch` returns the raw text into `v-html`. | Return escaped text or an empty string. |
| M25 | `components/TicketActionPanel.vue:78-100` | The web state machine has drifted from the API's: Reject is shown on IN_PROGRESS (always 400) and missing on VERIFIED. | Have the API expose the allowed transitions. |
| M26 | `[ref].vue:531`; `TicketBoard.vue:16`; `cli ticket.ts:171,264` | The UI and CLI read `ticket.assignee.name`, but the DTO only has the `assignedTo*Id` fields, so the assignee always shows as "Unassigned". | Add `assignee` to the DTO. |
| M27 | `cli ticket.ts:207` | `ticket mine` sends the literal `assignedTo: 'self'`, which the API never resolves, so the list is always empty. `--assigned-to <slug>` expects a user id. | Resolve `self` in the API. |
| M28 | `cli ticket.ts:511-522`; `tickets.controller.ts:302` | `verify-fix --pass` cannot send `approve=true` (missing `@ApiQuery`), so it records a failed-fix transition, then calls close. | Add `@ApiQuery`, regenerate, pass `approve`. |
| — | `.github/workflows/ci.yml` | No web build job, and web lint skips `.vue`. This is how H8 shipped. | Add a web build to CI; lint `.vue`. |

---

## 🟢 LOW (abbreviated)

### API
- **Pagination input:** `page=-1` or `limit=-5` → 500 or a reversed `take`; there is no max on `limit` (`tickets.controller.ts:172`). Also `rag.controller.ts:117` `limit=abc` → NaN.
- **Outbox is not transactional:** events are enqueued fire-and-forget after commit (`tickets.service.ts:125,251,281`, `ticket-transitions.service.ts:464`).
- **Admin outbox retry and stale requeue:**
  - Retry does not reset `attempts`, and it re-sends completed events.
  - An unknown id returns 500.
  - Stale requeue never increments `attempts`, so a hanging event loops forever.
- **`close()` bypasses the transition table:** IN_PROGRESS → CLOSED needs no review (`ticket-transitions.service.ts:343-356`).
- **Webhook routes before the signature check:**
  - CI and VCS webhooks return 404 vs 401 before verifying the signature, which enumerates slugs.
  - The CI DTO is validated before the signature check.
  - `line` is missing `@IsInt`.
  - The VCS webhook ignores `isActive` and `syncMode`.
- **Latent role trust:** `KodaDomainWriter` trusts a caller-supplied role for user actors (no production caller yet).
- **Webhook and policy code:**
  - `DELETE projects/:slug/webhooks/:id` ignores `:slug`.
  - One malformed `webhook.events` JSON aborts the whole dispatch.
  - `PolicyGateService` is wired up but never called.
- **Agents, projects and auth:**
  - Agent create and role replacement are not atomic.
  - `pickup` ignores soft-delete, and any principal can trigger it for any agent.
  - Project DTOs reference missing i18n keys (`projects.slugInvalid`, `projects.keyInvalid`, `common.validation.isIn`).
  - A duplicate project slug returns 400, not 409.
  - Soft-deleted projects can be PATCHed.
  - Nothing enforces `JWT_SECRET !== JWT_REFRESH_SECRET`.
  - *PLAUSIBLE:* a bootstrap-admin race on Postgres.
- **VCS:**
  - `extractLinks` after auto-PR creation always calls `/pulls/0`.
  - The poll `catch` awaits a DB write with no guard, so an unhandled rejection can crash the process.
  - `syncMode` is not `@IsEnum` on create.
  - The SLO dashboard loads an unbounded number of rows.
  - Deleted or renamed code symbols are never removed (`deleteByFile` is unused).
- **RAG and context:**
  - `table.optimize()` is fire-and-forget without `.catch`.
  - `LexicalIndexWarmup` loads 50k full rows per project into an index that is never queried.
  - `GetContextQueryDto` has no validators.
  - `evaluate-retrieval.ts` re-seeds duplicates on every run.

### Web
- **Sanitizer allows `class`:** a ticket description can overlay the page with Tailwind classes (*PLAUSIBLE*).
- **Route params:** `slug`/`ref` go into API paths without `encodeURIComponent`.
- **Duplicate toast:** a comment toast fires twice.
- **Missing i18n keys (both locales):**
  - `agents.empty`
  - `agents.toast.created` / `agents.toast.createFailed`
  - `agents.validation.*` (the keys actually live under `agents.form.validation.*`)
  - `auth.validation.nameRequired`

### CLI
- **Global conf mistaken for project config:** `findProjectConfig` walks up to `~/.koda/config.json`. Empty-string `apiUrl` fallbacks use `??`.
- **Secrets as argv:** `--api-key`, `--token` and `--password` end up in history and `ps`.
- **Exit codes:**
  - Ctrl+C exits 0.
  - A missing `--force` is inconsistent (exit 1 vs 3).
  - The auth hint prints invalid syntax.
- **Numeric options:** unvalidated values send NaN.

### CI and release
- **Path filters:** they skip `turbo.json` and `.nax/**`.
- **Bun version:** `packageManager: bun@1.0.0` vs CI 1.3.11.
- **Docker build:** `TURBO_TOKEN` is passed as a build-arg while the Dockerfiles expect a BuildKit secret.
- **Re-publish:** a `workflow_dispatch` re-publish does not check out the tag.
- **No gate:** release is not gated on CI.

---

## Status of 2026-09-14 findings

All of them are **still open** at `6f4420f`:

| ID | Status | Note |
|:--|:--|:--|
| SEC-1 | Open | No delivery-id or timestamp handling on the CI webhook or VCS `pull_request`. See M12 for a concrete consequence. |
| BUG-1 | Open | `auth.controller.ts:85`, `auth.service.ts:98` |
| BUG-2 | Open | Also see H11: the CLI sends an empty body, which unassigns. |
| SEC-2 | Open | `conf@13` uses the default 0o666 minus umask. |
| BUG-3 | Open | |
| BUG-4 | Open | Worse than reported; see H7. |
| SEC-3 | Open | Moot until H2 is fixed. |
| BUG-5, BUG-7, BUG-8 | Open | |
| ENH-1, ENH-2, ENH-3 | Open | |
| BUG-10 | Open | Superseded by H11. |
| BUG-11 | Open | |
| BUG-12 | Open | More exploitable given H2. |
| BUG-13 | Open | |
| BUG-14 | Open | Broader than reported: GitLab is unreachable end to end. The DTO enum is `github`-only, every call site builds `github.com` URLs, and `parseRepoUrl` is GitHub-only. |
| BUG-15 | Open | |

The 09-14 review said WEB-02 (logout/refresh wiring) was fixed. It is **not** effectively fixed: see H8, H9 and M22.

---

## Suggested fix order

1. **H1, H2, H3:** small, isolated auth fixes with high impact.
2. **H5 + BUG-2 + H11:** one shared `resolveTicket(project, ref)` helper that checks `projectId`, `deletedAt` and the key prefix, used by tickets, comments, labels and transitions. Add the assign DTO and permission.
3. **H8, H9, M22 + a CI web build:** makes the web session actually work.
4. **H4, H12, H10:** remaining privilege and credential issues.
5. **H6, H13, M14:** broken background features. Add at least one real-DB integration test per feature so mocks can't hide them again.
6. **H7 / BUG-4:** unify the RAG write path.
7. MEDIUM items, grouped by module.
