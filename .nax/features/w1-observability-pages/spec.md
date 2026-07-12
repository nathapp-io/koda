# SPEC: W1 — Read-only Observability Pages

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Ship four lean, read-only web pages over Koda's existing observability data —
project timeline, memory, code-intel symbols, and SLO metrics — giving humans UI
parity with data the API already tracks. Two of the four pages need a new backend
read endpoint (memory list, code-intel symbol search); the timeline and SLO pages
consume endpoints that already exist. No mutations, no graph navigation, no charts,
no realtime.

## Motivation

Koda's API records rich observability data (memory items, AST symbols, project
timeline events, SLO metrics) but the web app exposes almost none of it — humans
must use the CLI or query the DB directly. The gap analysis
(`docs/superpowers/specs/2026-07-12-w1-observability-pages-design.md`) ranks these
four read views as the highest-value, lowest-risk web work: the data and (for two
of four) the endpoints already exist. This spec delivers the "W1" read-only slice;
graph navigation, supersession drill-down, SLO trend charts, timeline→ticket deep
links, and realtime are explicitly deferred to a later "W1.5".

## Design

This is a **partial extension**: two new API read endpoints extend existing
controllers/modules in `apps/api`, and four new Nuxt pages plus nav/i18n extend
`apps/web`. No new packages. Monorepo — every story declares a `Workdir`.

### Integration

**Memory read endpoint (`apps/api`).**
- New project-scoped controller `apps/api/src/memory/memory-read.controller.ts`,
  `@Controller('projects/:slug/memory')`, mirroring the existing
  `apps/api/src/memory/timeline.controller.ts` (same folder, same
  `@Controller('projects/:slug/…')` shape, same `resolveProject(slug)` via
  `ProjectsService.findProjectIdBySlug`).
- Reuses the **already-existing** read path — no new service/repo logic:
  `MemoryGovernanceService.getProjectMemory(query: ProjectMemoryQuery): Promise<{ items: MemoryItem[]; total: number }>`
  (`apps/api/src/memory/memory-governance.service.ts`), backed by
  `PrismaMemoryItemRepository.findByProjectMemory` (page/`limit` pagination, `limit`
  clamped to 50; default `status='active'` with non-expired TTL; `kind` filter;
  `orderBy` confidence|updatedAt|createdAt).
- `ProjectMemoryQuery` (`apps/api/src/memory/memory-item-repository.ts`):
  `{ projectId; kind?; subject?; status?; page?; limit?; orderBy? }`.
- Auth: **fail-closed project membership** via
  `ProjectsService.assertProjectMembership(projectId, principal)` (throws
  `ForbiddenAppException`). This is a **deliberate divergence** from
  `TimelineController`, which only resolves the slug without a membership check —
  memory items are more sensitive than the timeline, so this endpoint gates on
  membership like `CodeIntelController` does.
- Register the controller in `apps/api/src/memory/memory.module.ts`.
- Response: `JsonResponse.Ok({ items, total })`.

**Code-intel symbol search endpoint (`apps/api`).**
- New `@Get('symbols')` on the existing
  `apps/api/src/code-intel/code-intel.controller.ts` (distinct from the existing
  `@Get('symbols/:symbolId')`). Query: `projectSlug` (required), `q?` (name
  contains), `file?` (file contains), `page?`, `limit?`.
- Reuses the controller's existing `resolveProject(slug)` and
  `checkProjectMembership(projectId, principal)` private helpers (fail-closed).
- Search is added along the existing retrieval chain
  `AstIndexService → SymbolStore → PrismaCodeIntelRepository` (mirroring how
  `AstIndexService.getSymbol` delegates to `SymbolStore.findBySymbolId`, which
  reads `this.codeIntelRepository`): new `PrismaCodeIntelRepository.searchSymbols`
  (precedent: `findSymbolsByFallback` / `findSymbolsByFiles`
  in `apps/api/src/code-intel/prisma-code-intel.repository.ts`, which already use
  `symbol.findMany` with `name`/`file` predicates — new method adds
  `name: { contains: q }` + `file: { contains: file }` + `take`/`skip` + a `count`),
  wrapped by new `SymbolStore.searchSymbols`, exposed by new
  `AstIndexService.searchSymbols(projectId, opts)`.
- Returns lightweight rows (`id, name, kind, file, signature`) + `total` via
  `JsonResponse.Ok({ items, total })`.

**Swagger (both new endpoints).** Per `api-controllers.md`, the new controller
and route carry `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, and `@ApiResponse`
(200/403/404), mirroring `TimelineController` / `CodeIntelController`; any new
response/query DTO fields carry `@ApiProperty()`.

**OpenAPI / generated client.** Both endpoints change the API contract, so
`bun run generate` (repo root) must be run to refresh the committed `openapi.json`
and the generated CLI client (per `common.md`). This is a generated-artifact step
verified by the build gate, not an acceptance criterion, and no new CLI commands
are added. Recorded as a verification note on US-001 and US-002.

**Web pages (`apps/web`).**
- All four follow the existing page pattern in `apps/web/pages/[project]/kb.vue`:
  `<script setup>`, `useApi().$api.get`, `route.params.project`, `useI18n()`,
  `useAppToast()`, and `extractApiError()` for error presentation (per `web.md`).
- Data access strictly through `$api.get` with string paths — no `$fetch`, no
  generated client (web does not use it).
- Nav links added to `apps/web/layouts/default.vue`: Timeline/Memory/Code-intel in
  the project-nav section; SLO as a top-level link (shown to all authenticated
  users, matching the existing unconditional `/agents` link — the web has no admin
  role signal; access is enforced server-side, see US-006 grounding note).
- i18n keys added to **both** `apps/web/i18n/locales/en.json` and `zh.json`
  (`nav.*` + per-page strings); English is source-of-truth (per `common.md`).
- Component specs mock the `$api` boundary (per `web.md` testing + api-testing
  pagination-aware mock guidance); no Playwright e2e in W1.

### Failure Handling

- API: invalid/soft-deleted slug → 404 (`NotFoundAppException` from
  `findProjectIdBySlug`); non-member principal → 403 (`ForbiddenAppException` from
  `assertProjectMembership`); invalid `page`/`limit`/date query values are
  coerced/clamped (page≥1, limit≤50) rather than 500.
- Web: every page renders explicit loading, empty, and error states. Errors are
  surfaced via `useAppToast()` with `extractApiError(err)`; a 403 on the SLO page
  renders a friendly "admin only" state rather than a raw error.

## Stories

Six stories (per-page isolation keeps each web story under the AC ceiling and
respects producer/consumer ordering). Every story is single-package.

| ID | Story | Workdir | Depends on |
|----|-------|---------|-----------|
| US-001 | Memory read endpoint (`GET /projects/:slug/memory`) | `apps/api` | — |
| US-002 | Code-intel symbol search endpoint (`GET /code-intel/symbols`) | `apps/api` | — |
| US-003 | Timeline page | `apps/web` | — (endpoint exists) |
| US-004 | Memory page | `apps/web` | US-001 |
| US-005 | Code-intel page | `apps/web` | US-002 |
| US-006 | SLO dashboard page | `apps/web` | — (endpoint exists) |

**Context Files (reads) / Creates**

- **US-001** — Reads: `apps/api/src/memory/timeline.controller.ts`,
  `apps/api/src/memory/memory-governance.service.ts`,
  `apps/api/src/memory/memory.module.ts`,
  `apps/api/src/memory/memory-item-repository.ts`,
  `apps/api/src/projects/projects.service.ts`. Creates:
  `apps/api/src/memory/memory-read.controller.ts`,
  `apps/api/src/memory/memory-read.controller.spec.ts`.
- **US-002** — Reads: `apps/api/src/code-intel/code-intel.controller.ts`,
  `apps/api/src/code-intel/ast-index.service.ts`,
  `apps/api/src/code-intel/symbol-store.ts`,
  `apps/api/src/code-intel/prisma-code-intel.repository.ts`,
  `apps/api/src/projects/projects.service.ts`. Creates:
  `apps/api/src/code-intel/dto/search-symbols.dto.ts` and its spec (search
  method specs co-located with the existing repository/store/service spec files).
- **US-003** — Reads: `apps/web/pages/[project]/kb.vue`,
  `apps/web/composables/useApi.ts`, `apps/web/layouts/default.vue`,
  `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`. Creates:
  `apps/web/pages/[project]/timeline.vue`,
  `apps/web/tests/pages/timeline.spec.ts`.
- **US-004** — Reads: `apps/web/pages/[project]/kb.vue`,
  `apps/web/composables/useApi.ts`, `apps/web/layouts/default.vue`,
  `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`. Creates:
  `apps/web/pages/[project]/memory.vue`,
  `apps/web/tests/pages/memory.spec.ts`.
- **US-005** — Reads: `apps/web/pages/[project]/kb.vue`,
  `apps/web/composables/useApi.ts`, `apps/web/layouts/default.vue`,
  `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`. Creates:
  `apps/web/pages/[project]/code-intel.vue`,
  `apps/web/tests/pages/code-intel.spec.ts`.
- **US-006** — Reads: `apps/web/pages/[project]/kb.vue`,
  `apps/web/composables/useApi.ts`, `apps/web/layouts/default.vue`,
  `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`. Creates:
  `apps/web/pages/admin/slos.vue`, `apps/web/tests/pages/slos.spec.ts`.

### Seams

No cross-story **code-symbol** seams. US-004/US-005 depend on US-001/US-002 only
across the **HTTP boundary** (the web pages call `$api.get('<path>')` with string
paths, not imported symbols), and their component specs stub the `$api` boundary.
The dependency is expressed as story ordering (Depends-on), verified per-side:
the endpoint stories prove the route behaves (integration ACs), the page stories
prove the client calls the right path with the right params (component ACs).

## Acceptance Criteria

### US-001 — Memory read endpoint (`apps/api`)

1. `[integration]` GET `/projects/:slug/memory` for a project that has active
   memory items returns HTTP 200 and a body whose `data.items` contains those
   items and whose `data.total` equals the total active count.
2. `[integration]` GET `/projects/:slug/memory?kind=DECISION` returns only items
   whose `kind` equals `DECISION`.
3. `[integration]` GET `/projects/:slug/memory` without a `status` param returns
   only items with `status` `active` and a null-or-future `ttlAt`; passing
   `status=superseded` returns only items whose `status` is `superseded`.
4. `[integration]` GET `/projects/:slug/memory?page=2&limit=10` returns the second
   page of at most 10 items, and a request with `limit=1000` returns at most 50
   items (clamp).
5. `[integration]` GET `/projects/:slug/memory` with a slug that does not resolve
   (unknown or soft-deleted project) returns HTTP 404.
6. `[integration]` GET `/projects/:slug/memory` performed by a principal who is not
   a member of the project returns HTTP 403.
7. `[unit]` `MemoryModule` compiles via `Test.createTestingModule({ imports: [MemoryModule] })`
   with external collaborators mocked, and the new memory-read controller plus its
   dependencies (`MemoryGovernanceService`, `ProjectsService`) resolve from DI.

> Verification note: after this story, run `bun run generate` (repo root) so the
> committed `openapi.json` reflects the new route; the build gate confirms it.

### US-002 — Code-intel symbol search endpoint (`apps/api`)

1. `[integration]` GET `/code-intel/symbols?projectSlug=<slug>&q=<name>` returns
   HTTP 200 with `data.items` containing only symbols whose `name` contains the
   `q` value, each item exposing `id`, `name`, `kind`, `file`, and `signature`,
   and `data.total` equal to the match count.
2. `[integration]` GET `/code-intel/symbols?projectSlug=<slug>&file=<frag>` returns
   only symbols whose `file` contains `<frag>`.
3. `[integration]` GET `/code-intel/symbols?projectSlug=<slug>&q=<name>&page=2&limit=20`
   returns the second page of at most 20 items, and `limit` above the max is
   clamped to the max.
4. `[integration]` GET `/code-intel/symbols?projectSlug=<slug>` with neither `q`
   nor `file` returns the first page of the project's symbols in a deterministic
   order.
5. `[integration]` GET `/code-intel/symbols` with a `projectSlug` that does not
   resolve returns HTTP 404.
6. `[integration]` GET `/code-intel/symbols` performed by a non-member principal
   returns HTTP 403.
7. `[unit]` calling the new repository `searchSymbols(projectId, { q, file, page, limit })`
   against a mocked Prisma client issues a `symbol.findMany` whose `where` filters
   by `projectId` and (when provided) `name`-contains and `file`-contains, applies
   `take`/`skip` derived from `page`/`limit`, and returns `{ items, total }`.
8. `[unit]` `CodeIntelModule` compiles with the search service/repository
   dependencies resolvable from DI.

> Verification note: after this story, run `bun run generate` (repo root) to
> refresh `openapi.json`; the build gate confirms it.

### US-003 — Timeline page (`apps/web`)

1. `[unit]` mounting the Timeline page with `$api.get` stubbed to resolve a list
   of timeline events renders one row per event showing its `eventType`,
   `actorId`, and `action`.
2. `[unit]` on mount the Timeline page calls `$api.get` with the path
   `/projects/<slug>/timeline`, where `<slug>` is taken from the route's `project`
   param.
3. `[unit]` while the `$api.get` promise is pending, the page shows a loading
   indicator and does not render the event table.
4. `[unit]` when the response contains zero events, the page renders an
   empty-state message instead of the table.
5. `[unit]` when `$api.get` rejects, the page passes the error through
   `extractApiError` and shows the result via the app toast, and renders no rows.
6. `[unit]` choosing an event-type filter re-invokes `$api.get` with the
   `eventTypes` query param set to the chosen value.
7. `[unit]` setting the from/to date filters re-invokes `$api.get` with `from`
   and `to` query params carrying the chosen dates.
8. `[unit]` activating "load more" re-invokes `$api.get` with the `cursor`
   returned by the previous response and appends the newly returned events to the
   existing list.
9. `[unit]` the default layout, when the route has a `project` slug, renders a
   navigation link whose target is `/<slug>/timeline` and whose label resolves
   from the i18n key `nav.timeline`.

> Convention note: `nav.timeline` and all page strings are added to both
> `en.json` and `zh.json` (English source-of-truth).

### US-004 — Memory page (`apps/web`)

1. `[unit]` mounting the Memory page with `$api.get` stubbed to resolve
   `{ items, total }` renders one row per item showing its `subject`,
   `predicate`, `object`, `kind`, `confidence`, and `status`.
2. `[unit]` on mount the Memory page calls `$api.get` with the path
   `/projects/<slug>/memory`, `<slug>` from the route's `project` param.
3. `[unit]` while the request is pending, the page shows a loading indicator and
   not the item table.
4. `[unit]` when `items` is empty, the page renders an empty-state message.
5. `[unit]` when `$api.get` rejects, the page surfaces `extractApiError(err)` via
   the app toast and renders no rows.
6. `[unit]` choosing a `kind` filter re-invokes `$api.get` with the `kind` query
   param set to the chosen value.
7. `[unit]` choosing a `status` filter re-invokes `$api.get` with the `status`
   query param set to the chosen value.
8. `[unit]` activating "load more" re-invokes `$api.get` with the next `page`
   value and appends the returned items to the existing list.
9. `[unit]` the default layout renders a project-nav link whose target is
   `/<slug>/memory` and whose label resolves from the i18n key `nav.memory`.

> Convention note: `nav.memory` and page strings added to both `en.json`/`zh.json`.

### US-005 — Code-intel page (`apps/web`)

1. `[unit]` submitting the search box with a query invokes `$api.get` with the
   path `/code-intel/symbols` and query params `projectSlug=<slug>` and `q=<query>`.
2. `[unit]` when the search resolves with symbols, the page renders one result row
   per symbol showing its `name`, `kind`, and `file`.
3. `[unit]` while the search request is pending, the page shows a loading
   indicator and not the results table.
4. `[unit]` when the search resolves with zero symbols, the page renders an
   empty/"no matches" state.
5. `[unit]` when `$api.get` rejects, the page surfaces `extractApiError(err)` via
   the app toast.
6. `[unit]` clicking a result row expands a detail panel that renders that
   symbol's `signature`, `docComment`, and its `callers` and `callees` as text
   lists (not interactive links).
7. `[unit]` the default layout renders a project-nav link whose target is
   `/<slug>/code-intel` and whose label resolves from the i18n key `nav.codeIntel`.

> Convention note: `nav.codeIntel` and page strings added to both
> `en.json`/`zh.json`.

### US-006 — SLO dashboard page (`apps/web`)

1. `[unit]` mounting the SLO page with `$api.get` stubbed to resolve SLO metrics
   renders a metric card per returned metric showing its label and value.
2. `[unit]` on mount the SLO page calls `$api.get` with the path `/admin/slos`.
3. `[unit]` changing the date-window controls re-invokes `$api.get` with `from`
   and `to` query params carrying the selected window.
4. `[unit]` while the request is pending, the page shows a loading indicator and
   not the metric cards.
5. `[unit]` when `$api.get` rejects with a 403 (`ApiError` code for forbidden),
   the page renders a friendly "admin only" state rather than a generic error
   toast.
6. `[unit]` when `$api.get` rejects with a non-403 error, the page surfaces
   `extractApiError(err)` via the app toast.
7. `[unit]` the default layout renders a top-level navigation link to
   `/admin/slos` whose label resolves from the i18n key `nav.slos` for any
   authenticated user (matching the existing unconditional `/agents` link).

> Convention note: `nav.slos` and page strings added to both `en.json`/`zh.json`.
>
> Grounding note: the SLO nav link is **not** client-side gated on admin role
> because `useAuth()`'s `AuthUser` (`{ id, email, name }`) carries no role and
> `/auth/me` returns none — the web has no admin signal. Access control stays
> server-side: `GET /admin/slos` enforces `@RequiredPermission('ADMIN')` and the
> page renders the "admin only" state on the resulting 403 (AC5). This is a
> deliberate divergence from the design doc's "shown only to admins" wording.
