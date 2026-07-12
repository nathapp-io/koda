# W1 — Read-only Observability Pages (design)

Date: 2026-07-12
Status: approved (brainstorm), pending nax spec.

## Goal

Ship four lean, read-only web pages over Koda's existing observability data —
timeline, memory, code-intel, and SLO metrics — so humans get UI parity with
data the API already tracks. Frontend-first, with two small backend `GET`
additions to unblock the memory and code-intel pages.

Non-goals (deferred to a later "W1.5"): call-graph navigation, memory
supersession-chain drill-down, SLO trend charts, timeline→ticket deep links,
pagination beyond cursor "load more", realtime/WebSocket, any mutations.

## Backend additions

Two new read endpoints, added to the existing controllers (no new controllers):

1. `GET /projects/:slug/memory` (in `memory.controller.ts`)
   - Query: `kind?`, `status?` (default `active`), `limit?`, `cursor?`
   - Returns `MemoryItem[]` + next cursor.
   - Auth: authenticated project member.
2. `GET /code-intel/symbols` (in `code-intel.controller.ts`)
   - Query: `projectSlug`, `q?` (name contains), `file?`, `limit?`, `cursor?`
   - Returns lightweight symbol rows (id, name, kind, file, signature) + cursor.
   - Auth: project member.

Both need a matching service list method and `bun run generate` to refresh
`openapi.json` + the generated CLI client. No new CLI commands.

Pagination uses `limit` + id `cursor`, matching the existing timeline endpoint.

## Frontend pages

All follow the existing `<script setup>` + `useApi().$api.get` pattern, with
loading / empty / error states via `extractApiError` + toast (as in `kb.vue`).

| Page       | Route                          | Content |
|------------|--------------------------------|---------|
| Timeline   | `pages/[project]/timeline.vue` | event table; filters: eventType, actor, date from/to; cursor "load more" |
| Memory     | `pages/[project]/memory.vue`   | item table (subject·predicate·object, kind, confidence, status); filters: kind, status; "load more" |
| Code-intel | `pages/[project]/code-intel.vue` | search box (name/file) → results table → click row expands detail panel: signature, docComment, callers/callees listed as text (not clickable) |
| SLO        | `pages/admin/slos.vue`         | metric cards + date-window picker; admin-only; 403 → friendly "admin only" state |

## Navigation + i18n

- `layouts/default.vue`: add Timeline / Memory / Code-intel links to the
  project nav section; add a top-level SLO link shown only to admins.
- Breadcrumb entries following the existing lines 22–42 pattern.
- Web i18n keys in `apps/web/i18n/locales/{en,zh}.json` (`nav.*` + page strings).
- API i18n only if the new endpoints emit user-facing validation messages.

## Testing

- API: unit/integration specs for the 2 new endpoints — filter, pagination,
  empty, auth/403.
- Web: component specs per page mocking `$api` (loading / empty / error /
  filter), following existing `*.spec.ts` patterns.
- No new Playwright e2e (CI e2e out of scope for W1).

## Sizing — ~5 stories

1. `GET /projects/:slug/memory` + service list method.
2. `GET /code-intel/symbols` + service search method.
3. Timeline + Memory pages.
4. Code-intel + SLO pages.
5. Nav + i18n + breadcrumbs.

The nax plan step will atomic-split these into ACs.
