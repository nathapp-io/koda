# Track 3 Review Remediation — Design

**Date:** 2026-09-27
**Base:** `main` @ `c5a955af` (after Track 1, PRs #133-#142)
**Source:** whole-repo review `docs/20260925-review-whole-repo.md` (MEDIUM + LOW sections), fleet platform design doc §9.4 ("Track 3")
**Status:** Approved design (sectioned, in chat); spec-reviewed 09-27 and corrected against `c5a955af`. No slice planned yet.

## Goal

Close every review MEDIUM still open at `c5a955af`, plus the LOWs that live in the same modules, as six
independently mergeable slices (seven PRs; slice 2 ships as 2a + 2b) ordered security-first.

## Open-finding inventory (verified at `c5a955af`)

Closed before this track and not revisited: M1-M4, M6, M14, M20, M22, M23, M27, CI web build / `.vue` lint,
admin outbox retry LOW, pagination-bounds LOW (tickets/memory), CLI `findProjectConfig` walk-up, bun
`packageManager` version, `auth.validation.nameRequired`, malformed `webhook.events` LOW (dispatcher skips it
since #134).

| Area | Open | Slice |
|:--|:--|:--|
| Tenancy / principals | M7 (partial), M8, M16 (access), agent/project/auth LOWs, latent role trust | 1 |
| Webhooks | M5 (2a); inbound signature-order LOWs, webhook delete scope, VCS webhook `isActive`/`syncMode` (2b) | 2a, 2b |
| Ticket workflow | `close()` bypass LOW, M24, M25 (partial), M26, M28, sanitizer `class` LOW | 3 |
| VCS / code-intel | M9-M13, BUG-14, VCS LOWs | 4 |
| RAG / memory | M15, M16 (retriever), M17-M19, M21, RAG LOWs, LanceDB filter-guard dedup | 5 |
| Web / CLI / CI | web + CLI LOWs, `ui/input` attrs, CI path filter | 6 |

## Decisions (user rulings, 2026-09-27)

- **Scope:** all open MEDIUMs plus same-module LOWs. Release-pipeline LOWs (`TURBO_TOKEN` build-arg,
  re-publish tag checkout, release not gated on CI) are **out of scope** under the 09-27 "no deployed koda"
  ruling. `PolicyGate` having no runtime caller is out of scope (wiring it is a feature, not a fix).
- **M7 tenancy = visibility gate only.** Every project-scoped route requires project membership for users
  (global ADMIN bypasses; agents stay global). Permissions stay on the global role. Fleet S1 revisits agents.
- **`close()` = admin override with a reason.** Global ADMIN or project ADMIN only, GENERAL comment required.
- **M25: the API returns `allowedActions`**; the web renders from it.
- **M5: block private ranges, with an env allowlist** (`WEBHOOK_ALLOWED_HOSTS`).
- **BUG-14 in scope, polling + outbound only.** GitLab inbound webhooks are out of scope.

## Constraints

- API stays single-instance. Postgres only. String-typed enum / JSON-as-String columns stay.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses, `registerAs` config,
  repository → service → controller, outbox `record()` inside `txManager.run`.
- TDD for every slice. DB-backed behavior gets integration tests on real Postgres (`KODA_DB_TESTS=1`).
- The production API runs on **Bun** (`start:prod-runtime`), dev on Node. Runtime-sensitive code (slice 2
  outbound HTTP) is proven on Bun.
- Contract changes regenerate `openapi.json` and the CLI client in the same PR.
- All ten CI checks are required on `main`; each slice PR must be green, including `e2e` and `evaluate`.

## Delivery

Seven PRs, landed in order. One implementation plan per slice, written after the previous slice merges.

| # | Slice | Closes |
|:--|:--|:--|
| 1 | Tenancy & principals | M7, M8, M16 (access); agent/project/auth LOWs |
| 2a | Outbound webhook SSRF guard | M5 |
| 2b | Inbound webhook hardening | inbound CI/VCS webhook LOWs; webhook delete scope |
| 3 | Ticket workflow | M24, M25, M26, M28; `close()` LOW; sanitizer LOW |
| 4 | VCS & code-intel | M9, M10, M11, M12, M13, BUG-14; VCS LOWs |
| 5 | RAG & memory | M15, M16 (retriever), M17, M18, M19, M21; RAG LOWs; filter-guard dedup |
| 6 | Web & CLI hygiene | web/CLI LOWs; CI path-filter LOW |

---

## Slice 1 — Tenancy & principals

### Membership gate (M7)

Rule unchanged from `ProjectAccessService.assertProjectMembership`: a user needs a `ProjectMember` row
unless global ADMIN; agents pass; failure is 403. Route status at `c5a955af`:

| Routes | Today | Slice 1 |
|:--|:--|:--|
| links, vcs, memory, timeline, context, retrieval, code-intel, live, members | gated | unchanged |
| `POST tickets/:ref/assign` | gated in controller (`tickets.controller.ts:244`) | check moves into the service; controller call **removed** (no double check) |
| all other `projects/:slug/tickets*` incl. transitions | ungated | gated in `TicketsService` / `TicketTransitionsService` |
| `projects/:slug/tickets/:ref/comments` | ungated | gated by slug |
| `PATCH/DELETE comments/:id` | no project resolution at all | **new** comment → ticket → project resolution, then the check; non-members get **404** (no comment-id oracle) |
| `projects/:slug/labels*`, `projects/:slug/tickets/:ref/labels*` | ungated | gated |
| `projects/:slug/kb*` | gated by a private copy (`rag.controller.ts` `checkProjectMembership`) | copy replaced by `ProjectAccessService.assertProjectMembership` |
| `GET projects/:slug/codeintel/impact`, `GET :slug/agents` | gated | unchanged |
| `GET /projects` | lists all | member projects only (global ADMIN and agents: all), new repository query joining `ProjectMember` |
| `GET projects/:slug`, `PATCH :slug/agents/:agentSlug` | ungated | gated |
| `ci-webhook-token`, `PATCH :slug`, `DELETE :slug`, `projects/:slug/webhooks*` | permission-gated (ADMIN) | unchanged |

The plan starts by re-enumerating every `@Controller` route with a `:slug` or project-owned id and records
each in the table-driven test below, so nothing in this table is trusted blindly.

### KB writes (M16, access half)

KB write routes (`addDocument` and the other mutating routes in `rag.controller.ts`) require DEVELOPER or
above; `VIEWER` is removed from their `allowedRoles`. VIEWER keeps read and search.

### Agents (M8)

- Create builds the Prisma data from named fields only (no `...scalarFields` spread at
  `agents.service.ts:145-151`); unknown body fields such as `status` or `id` are dropped. `update()` already
  whitelists and is unchanged apart from the DTO swap.
- The service-local DTOs are replaced by `agents/dto/*` (update keeps the `ACTIVE|PAUSED|OFFLINE` enum);
  the unused `create-agent.dto.ts` is merged into the one DTO that remains.
- Slug validated with `^[a-z0-9-]+$`. Duplicate slug (P2002) → **409**.
- **LOW:** agent row, roles and capabilities are written in one `txManager.run`.
- **LOW `pickup`:** refuses (404) when the agent's project is soft-deleted; callable only by the agent
  itself or a global ADMIN (403 otherwise).

### Projects and auth LOWs

- Duplicate project slug → **409** (was 400).
- `PATCH` on a soft-deleted project → 404.
- Missing i18n keys added (en + zh): `projects.slugInvalid`, `projects.keyInvalid`, `common.validation.isIn`.
- `env.validation` (Joi) refuses to start when `JWT_REFRESH_SECRET === JWT_SECRET`.
- `KodaDomainWriter` ignores a caller-supplied role for user actors and derives it from the principal
  (no production caller yet; unit test only).

### Tests

- A table-driven e2e/integration spec enumerating every project-scoped route: a non-member DEVELOPER gets
  403/404, a member gets the success status. New routes added later without the gate fail it.
- Unit tests for the agent field whitelist, P2002 → 409, atomic create, `pickup` rules, the Joi refinement.

---

## Slice 2 — Webhooks (two PRs: 2a outbound, 2b inbound)

The outbound guard is greenfield (new HTTP client path, Bun spike); the inbound fixes are small edits to
existing controllers. They ship separately so neither blocks the other; 2a lands first.

### 2a — Outbound delivery (M5)

New `webhook/outbound-url-guard.ts`: a pure address classifier plus a DNS-resolver seam.

- **Create/update time (early feedback, not the boundary):** `https` required; URLs with userinfo or
  non-http(s) schemes rejected; IP-literal hosts in blocked ranges → 400; hostnames resolved and checked.
- **Delivery time (the boundary):** `WebhookDeliveryHandler` stops using global `fetch` and uses
  `node:https` / `node:http` `request` with a custom `lookup` that validates **every resolved address at
  connect time** (defeats DNS rebinding). Redirects are never followed; any 3xx is a failure.
- **Blocked ranges:** 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4 and above,
  `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96` mapped forms of the above.
- **`WEBHOOK_ALLOWED_HOSTS`:** comma-separated hostnames and/or CIDRs, Joi-validated, default empty.
  A match bypasses the private-range block and allows plain `http`.
- **No port-scan oracle:** the error recorded on the outbox row is one of `blocked_destination`,
  `connect_failed`, `timeout`, `redirect_refused`, `http_4xx`, `http_5xx`. Raw socket errors go to the
  server log only.
- **Plan task 1 is a Bun spike:** prove Bun's `node:https` honours a custom `lookup`. If it does not, the
  fallback is resolve → validate → connect to the pinned IP with `servername` and `Host` set.

### 2b — Inbound CI and VCS webhooks (LOWs)

- **No slug enumeration:** unknown slug, missing secret, missing connection and bad signature all return
  the same 401 with the same body. This removes the CI controller's early `NotFoundAppException` branch
  (`ci-webhook.controller.ts`, after `resolveProject`) and the VCS controller's 404-throwing
  `projectsService.findBySlug`; both collapse into one lookup that yields "no secret" on any miss.
  Replay dedup still runs after verification.
- **Signature before DTO validation:** the `@Body()` DTO parameter is removed. The controller verifies
  `rawBody`, then parses and validates with class-validator (`plainToInstance` + `validate`), 400 on
  failure. An unauthenticated caller never sees validation errors.
- `CiWebhookPayloadDto.line` gets `@IsInt() @Min(1)`.
- The VCS webhook returns 200 `{ ignored: true, reason }` unless the connection `isActive` is true **and**
  `syncMode === 'webhook'` (values are `off | polling | webhook`). 200 avoids GitHub retry storms.
- `DELETE projects/:slug/webhooks/:id` looks the webhook up by project id; another project's id → 404.
  The slug-less `DELETE webhooks/:id` (global ADMIN only) stays as the deliberate cross-project admin route.

### Tests

- 2a unit: address classifier (v4, v6, mapped, allowlist host and CIDR), error-class mapping.
- 2a integration with a local HTTP server: a hostname resolving to 127.0.0.1 is refused unless allow-listed;
  a 302 is refused; a success delivers.
- 2b controller specs: every inbound failure mode yields the identical 401; validation runs only after a valid
  signature; ignored deliveries return 200.

---

## Slice 3 — Ticket workflow

### `close()` as an admin override

- `POST :ref/close` takes a required `{ body }`; the reason is written as a GENERAL comment in the same
  transaction as the status change (and emits `COMMENT_ADDED` like any comment).
- Allowed callers: global ADMIN or project ADMIN, via the existing non-throwing
  `ProjectAccessService.canManageMembers` (same semantics; renamed `isProjectAdmin` with its one caller
  updated, no duplicate added). Others → 403; agents always 403.
- `close()` (`ticket-transitions.service.ts:367-425`) has no comment or admin handling today, only the
  blanket `@RequiredPermission([TRANSITION, 'Ticket'])`; both are new code in the existing transaction.
- Source states unchanged: IN_PROGRESS, VERIFIED, VERIFY_FIX. The M3 conditional write stays.
- **Breaking:** CLI `ticket close` gains a required `--reason`; the web Close action opens the comment
  dialog. The normal path to CLOSED remains verify-fix approve.

### `allowedActions` (M25)

- New pure `allowedActions(status, principal, isProjectAdmin)` next to `TRANSITION_RULES`, returning
  endpoint-level actions `verify | start | fix | verify-fix | reject | close`, derived from the table,
  filtered by the TRANSITION permission; `close` only for admins.
- `GET :ref` returns `allowedActions`; list/board responses do not.
- `TicketActionPanel` renders only from `allowedActions`; its hard-coded status blocks are removed.
- `TRANSITION_RULES` already contains IN_PROGRESS → VERIFIED (GENERAL comment, `ticket-transitions.ts:20-23`).
  No route supplies a comment for it (`PATCH :ref {status}` passes no comment type, so it always fails
  validation). It is **not** an `allowedActions` entry; the rule is left in the table and noted as unreachable.
- Table-driven test: for every status × role, `allowedActions` agrees with `validateTransition`.

### `assignee` (M26)

`TicketResponseDto.assignee: { kind: 'user' | 'agent'; id: string; name: string } | null`, populated by the
repository with a name-only `select` on User/Agent, on list and detail. The web (`[ref].vue`, `TicketBoard.vue`)
and CLI (`ticket.ts`) already read `ticket.assignee.name` (always undefined today); only their types change,
plus a check that the shape they read matches.

### `approve` (M28)

`@ApiQuery({ name: 'approve', type: Boolean, required: false })` on `verify-fix`; regenerate the CLI client;
`verify-fix --pass` sends `approve=true` and the follow-up `close()` call is removed.

### Markdown (M24 + sanitizer LOW)

- Both render `catch` paths (`[ref].vue`, `MarkdownEditor.vue`) return HTML-escaped text in a `<p>` via one
  helper in `lib/markdown.ts`.
- `class` leaves `ALLOWED_ATTR`; a DOMPurify `uponSanitizeAttribute` hook keeps `class` only on `<code>` with
  values matching `^language-[\w-]+$`.

### Tests

Unit: `allowedActions` table test, close authz + reason + single transaction, assignee mapping, render
error escapes, sanitizer strips `fixed inset-0` and keeps `language-ts`. E2E (extend the ticket flow spec):
buttons match the API's actions; Close prompts for a reason and shows only for the project admin; the
assignee name renders.

---

## Slice 4 — VCS & code-intel

### M9 webhook secret

- Create returns the generated secret **once** as `webhookSecret`; later reads keep only
  `webhookSecretConfigured`.
- New `POST /projects/:slug/vcs/webhook-secret/rotate` (project ADMIN or global ADMIN) returns the new
  secret once.
- `webhookSecret` removed from `UpdateVcsConnectionDto` (it was ignored).
- Web project settings VCS section shows the secret once with a copy button; CLI `vcs` prints it.

### M10 pagination and stale polling

- GitHub `fetchIssues`: `per_page=100`, follow `Link: rel="next"`, cap 10 pages per poll (warning in the
  sync log when capped).
- `lastSyncedAt` = max `updated_at` seen (not "now"), so a capped poll resumes where it stopped.
- The interval callback re-reads the connection by id each tick and unschedules itself when the connection
  is gone, inactive, or no longer `polling`.
- **LOW:** the poll `catch` wraps its sync-log write in its own try/catch (no unhandled rejection).

### M11 re-imports

- Duplicate detection includes soft-deleted tickets.
- `externalVcsId` stored as `owner/repo#N` (as the schema comment already states). Migration backfills
  numeric values from the project's single `VcsConnection`; rows without a connection are left unchanged.

### M12 `merged` is terminal

Enforced once in `updateTicketLinkWithPrState` (`prisma-vcs.repository.ts`, today an unconditional alias) as
a conditional write (`updateMany where prState <> 'merged'`). Every `prState` write site must go through it:
the `opened`, `closed`, `ready_for_review`, `reopened`, `converted_to_draft` and `merged` handlers in
`vcs-webhook.service.ts`, and `vcs-pr-sync.service.ts`. The plan greps for every `prState` write and a test
fails if any bypasses the repository method.

### M13 symbol ids

- `fullId = ${projectId}:${repoId}:${file}::${localId}`; upsert on `projectId_symbolId`; `projectId` never
  updated.
- Migration **deletes existing code-symbol rows** (derived data, rebuilt on the next index) instead of
  rewriting ids embedded in caller/callee arrays. Called out in the PR.

### VCS LOWs

- `extractLinks` after auto-PR creation passes the created PR's number (no `/pulls/0`).
- `CreateVcsConnectionDto.syncMode` gets `@IsEnum(VcsSyncModeType)`.
- SLO dashboard `findQueryMetrics`: last 24 h window, `take` 10 000.
- `symbolStore.deleteByFile` is called for deleted/renamed files on commit re-index.

### BUG-14 GitLab (polling + outbound only)

- `GITLAB` added to the DTO enum `VcsProviderType` (`create-vcs-connection.dto.ts`). The `provider` column is
  a plain `String`, so no migration.
- New `VCS_GITLAB_API_URL` config (default `https://gitlab.com/api/v4`) beside `githubApiUrl`; the
  `repoUrl` parser is host-agnostic (self-hosted GitLab).
- GitLab provider: `per_page=100` + `X-Next-Page` pagination with the same page cap.
- Create/update of a GitLab connection with `syncMode=webhook` → 400 with a clear message.
- Tests: mocked-HTTP unit tests; a manual check against a real gitlab.com project recorded in the PR.

### Tests

Unit: secret once/rotate authz, pagination + cap + `lastSyncedAt`, re-read/unschedule, deleted-row dedup,
merged-terminal conditional write across every handler, symbol id shape. Integration (Postgres): both
migrations (backfill; symbol wipe).

---

## Slice 5 — RAG & memory

### M15 KB lifecycle

- A `ticket_event` outbox handler that acts **only** on `TICKET_DELETED` (every `ticket_event` subscriber
  receives all actions) calls `deleteBySource` (at-least-once, idempotent).
- `indexDocument` becomes an upsert: delete-by-source then add, inside the per-table `exclusive` lock.
  This also makes `evaluate-retrieval.ts` seeding idempotent (LOW).

### LanceDB filter guard dedup

Not a live injection: `deleteBySource` already rejects quotes and control characters inline
(`vector-store.service.ts:460-478`), and `deleteAllBySourceType` uses a fixed allowlist. The inline check
duplicates `isSafeFilterValue` (`lance-table-manager.ts:37`); `deleteBySource` imports the shared helper
instead, and a test pins that a quote in `sourceId` is rejected.

### M16 retriever half

`createdAtOverride` accepted only when `Number.isFinite(Date.parse(value))` (else ignored with a warning);
`calcRawRecencyScore` and `normalizeMinMax` treat non-finite inputs as 0.

### M17 FTS-only hits

`nativeFtsRows` (and fallback FTS rows) are added to `recordMap`.

### M18 tiers

Tiers use the raw cosine similarity of the vector hit against the existing `SIMILARITY_*` thresholds.
FTS-only hits are capped at `low`. Ranking is unchanged.

### M19 graph ↔ vector consistency

Cross-store atomicity is impossible, so the write is made retry-safe:

1. Delete LanceDB vectors for removed and updated nodes (idempotent).
2. One Prisma transaction: node upserts, links deduped in memory + `createMany({ skipDuplicates })`, and
   `GraphNode.vectorStale = true` on changed nodes (new column `Boolean @default(false)`; existing rows
   backfill to false).
3. Index stale nodes into LanceDB, clearing the flag per node.

Every run first re-indexes leftover `vectorStale` nodes, so a crash or LanceDB failure heals on the next
import or outbox retry.

### M21 governance paging

`expireMemories`, `deduplicate` and `applySupersession` page by `id > lastId` keyset over
`status: 'active'`. Cross-page dedup uses a SQL `groupBy` on the dedup key.

### RAG LOWs

- `.catch(log)` on the three fire-and-forget `optimize()` calls.
- **Delete `LexicalIndex`**: its `search` has no callers. Remove the class, `LexicalIndexWarmup` and its
  startup load (50k rows per project) and outbox handler registration in `rag.module.ts`, and the optional
  `lexicalIndex` calls in `vector-store.service.ts` (`addDocument`, `removeDocument`, `clearProject`),
  followed by an orphan pass.
- `GetContextQueryDto` gets validators and goes through `parseQuery`.
- `GET /kb/documents?limit=` validated (`@IsInt @Min(1) @Max(500)`).

### Tests and the eval gate

Unit tests per defect (NaN input, FTS-only hit past row 500, raw-cosine tiering, crash between steps 2 and 3
heals, paging under mutation, filter escaping). The CI `evaluate` job must stay green; the PR records
`precision@5_avg` before and after. A drop is investigated, never fixed by lowering the threshold.

---

## Slice 6 — Web & CLI hygiene

### Web

- `apiPath` tagged-template helper applies `encodeURIComponent` to every interpolated value; all `$api`
  call sites move to it; a unit test fails on raw `${slug}` / `${ref}` inside `$api(` strings. Sites that
  already call `encodeURIComponent` (`useProjectMembers`, `useAdminUsers`, `useProjectEvents`,
  `[project]/code-intel.vue`) drop it when moving, so nothing is double-encoded.
- Duplicate comment toast removed (only `CommentThread` toasts).
- Missing `agents.*` i18n keys: `agents.empty` and `agents.toast.created` / `createFailed` added (en + zh);
  `agents.validation.*` call sites repointed to the existing `agents.form.validation.*`.
- `ui/input/Input.vue`: `defineOptions({ inheritAttrs: false })`.

### CLI

- Secrets out of argv without breaking scripts: `--api-key` and `vcs --token` accept `-` (read stdin),
  prompt with hidden input when given without a value on a TTY, and read `KODA_API_KEY` / new
  `KODA_VCS_TOKEN`. A literal value still works but warns on stderr.
- Ctrl+C exits 130. A missing `--force` exits 1 everywhere.
- Auth hint text uses the real syntax.
- Numeric options go through one `parsePositiveInt` (exit 1 with a message; no NaN sent).
- `apiUrl` resolution uses `||` for flag and profile values.

### CI

The push path filter and the `changes` job's path list add `turbo.json` and `.nax/**`. Confirm the
docs-only skip path on this PR.

### Tests

Unit: `apiPath` encoding, `parsePositiveInt`, secret-source precedence, SIGINT exit code, `Input` attrs.

---

## Out of scope

- Release pipeline LOWs (no deployed koda).
- `PolicyGate` runtime wiring.
- GitLab inbound webhooks.
- Project-role-based permissions and agent project membership (fleet S1).
- M21-adjacent `downrankStaleLowConfidence` (unaffected by the paging defect).
