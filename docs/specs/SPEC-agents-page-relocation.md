# SPEC: Agents Page Relocation

**Issue:** #62
**Branch:** `feat/agents-management-page`

## Summary

The agents management page is incorrectly nested under `pages/[project]/agents.vue`, making it accessible only within a project context. Agents are a system-level entity managed by admins; the page must be a standalone top-level route at `/agents`. This spec covers moving the page, fixing the API endpoint, updating the layout navigation, and correcting breadcrumb logic.

## Motivation

- `GET /projects/${slug}/agents` does not exist — the page 404s on load
- Agents belong to the system, not to a project — nesting under `[project]` is semantically wrong
- The "Agents" nav link in `layouts/default.vue` is only shown when inside a project context, hiding it on the dashboard

## Design

**Route change:** `pages/[project]/agents.vue` → `pages/agents.vue` (Nuxt file-based routing maps this to `/agents`)

**API fix:** The `useAsyncData` call changes from `$api.get('/projects/${slug}/agents')` to `$api.get('/agents')` — all agents are fetched globally. The `slug` dependency is removed entirely.

**Layout changes in `layouts/default.vue`:**
- Remove `<NuxtLink to="/${projectSlug}/agents">` from the `v-if="projectSlug"` block
- Add `<NuxtLink to="/agents">` in the always-visible section (alongside Dashboard)
- Add breadcrumb case for `/agents` path (currently missing, would fall through to no-breadcrumb)

**i18n:** No new keys needed. Existing `nav.agents`, `agents.title`, etc. remain unchanged.

## Stories

### US-001: Move page + fix API endpoint

**Context Files:**
- `apps/web/pages/[project]/agents.vue` — file to move and refactor
- `apps/web/composables/useApi.ts` — API call patterns
- `apps/web/i18n/locales/en.json` — existing i18n keys to reuse

**Dependencies:** none

### US-002: Update layout navigation and breadcrumb

**Context Files:**
- `apps/web/layouts/default.vue` — nav links + breadcrumb logic to update
- `apps/web/pages/agents.vue` — new route (from US-001, for path reference)

**Dependencies:** US-001

## Acceptance Criteria

### US-001
- `apps/web/pages/[project]/agents.vue` is deleted and `apps/web/pages/agents.vue` exists in its place
- `useAsyncData` key is `'agents'` (no slug dependency)
- `useAsyncData` fetches from `$api.get('/agents')` with no project param
- `route.params.project` is not referenced anywhere in the new `pages/agents.vue`
- `changeStatus` calls `$api.patch('/agents/${agent.slug}', { status: newStatus })` using `agent.slug` (not project slug)

### US-002
- `layouts/default.vue` renders the Agents `<NuxtLink to="/agents">` outside the `v-if="projectSlug"` block — visible at all times in the sidebar
- `layouts/default.vue` does NOT render a `[projectSlug]/agents` link inside the `v-if="projectSlug"` block
- `breadcrumbItems` computed returns `[{ label: 'Koda', to: '/' }, { label: t('nav.agents') }]` when `route.path === '/agents'`
