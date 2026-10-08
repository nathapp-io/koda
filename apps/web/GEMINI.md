# Gemini CLI Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-web`

**Language:** TypeScript

**Key dependencies:** @nuxtjs/color-mode, @nuxtjs/i18n, @nuxtjs/tailwindcss, @unovis/vue, @vee-validate/zod, lucide-vue-next, nuxt, radix-vue, shadcn-nuxt, vue

**Commands:** test: `npx turbo test` | lint: `bunx turbo lint` | typecheck: `bunx turbo type-check`

---
# Koda Web Context

This is the app-specific source-of-truth context for `apps/web`.

## Role In The Monorepo

`apps/web` is the human-facing Nuxt 3 client for Koda.

It should:
- provide the main interactive UI for projects, tickets, agents, labels, and KB workflows
- rely on the API for business logic and persistence
- keep SSR, auth, and i18n behavior coherent across pages
- use Nuxt-native composables and proxying for API integration

It should not:
- duplicate backend workflow logic in components
- introduce a generated web API client unless the architecture decision changes

## Stack

- Nuxt 3 SSR
- Tailwind CSS
- Shadcn-nuxt components in `components/ui/`
- `@nuxtjs/i18n`
- `@nuxtjs/color-mode`
- `vee-validate` + `zod`
- Jest and Playwright

## Architecture

Key files:
- `apps/web/nuxt.config.ts`: modules, route proxying, runtime config, i18n
- `apps/web/composables/useApi.ts`: API wrapper and JSON-envelope unwrapping
- `apps/web/composables/useAuth.ts`: cookie-based auth session handling
- `middleware/auth.global.ts`: route protection and auth hydration
- `pages/`: route entrypoints
- `components/`: reusable UI and workflow components

Current route areas:
- `/login`
- `/register`
- `/projects`
- `/agents`
- `/:project`
- `/:project/agents`
- `/:project/kb`
- `/:project/labels`
- `/:project/tickets/:ref`
- `/:project/fleet/jobs/:id/logs` (fleet run-log viewer, S2a: entries pages, live `fleet_log` events, filters in the URL)
- `/:project/fleet/analytics` and `/admin/fleet/analytics` (fleet cost and quality analytics, S2b: window and group in the URL, one panel per query, no polling)

## API Access Pattern

Current-state note based on code:
- the web app intentionally uses hand-written Nuxt composables for API access
- there is no `apps/web/generated/` directory by design
- the generated web client was dropped because Nuxt provides a better fit for SSR, cookie auth, and proxied API access in this app

Networking pattern:
- browser code uses relative `/api` paths
- Nuxt proxies `/api/**` to the configured API host
- SSR uses `apiInternalUrl` from runtime config to reach the API safely
- auth token is stored in the `koda_token` cookie

## UI Structure

Main folders:
- `pages/` for route-level screens
- `components/` for shared application components
- `components/ui/` for local shadcn-derived primitives
- `composables/` for API, auth, and toast behavior
- `layouts/` for page shells
- `tests/` for unit/component/page coverage

Run logs and other runner- or agent-written text render through `{{ }}` interpolation only, never `v-html`: a log line is untrusted text.

## i18n Rules

Web i18n uses locale JSON files under `apps/web/i18n/locales/`.

Rules:
- all user-facing UI text should use i18n keys
- update both `en.json` and `zh.json`
- do not assume API and web keys are shared

## Testing Rules

- component/page logic should have Jest coverage where practical
- end-to-end journeys belong in Playwright
- keep SSR and auth-sensitive behavior in mind when changing routing or composables

Useful scripts:
- `bun run test`
- `bun run test:e2e`
- `bun run type-check`
- `bun run build`

## Fleet analytics (S2b)

- Pure logic lives in `lib/fleet-analytics-{types,format,range,chart}.ts`; composables `useFleetAnalytics`,
  `useAnalyticsPanel`, `useRefetchOnVisible`; components in `components/fleet/analytics/` plus
  `components/fleet/JobAnalytics.vue` (the job page section).
- Money arrives as 4-place strings: show it with `usd()` and never sum or re-round it in the browser (A7).
- Charts are `@unovis/vue` in `*.client.vue` wrappers only; Jest cannot mount them, so pages are tested with chart
  stubs. Tooltip HTML goes through `crosshairHtml`/`rateHtml`, which escape every label (keys come from bundles).
- Colors are `--chart-1`..`--chart-8` and `--chart-other` (globals.css, light and dark); `assignSlots` keeps a key's
  color across refetches.

## Fleet overview (S2b (c))

- `/admin/fleet` (global admin) and `/:project/fleet/overview` (members) both render `FleetDashboardOverview` from
  `components/fleet/dashboard/`; data comes from `useFleetDashboard(scope)` (10 s poll while visible, 1 s clock, a
  failed poll keeps the last snapshot, a 403 stops polling). No SSE.
- The API sends attention items as structured fields, never prose: word them in `lib/fleet-dashboard.ts`
  (`attentionMessage` -> i18n keys + params, `renderText`). A new API enum value needs its key under
  `fleet.dashboard` and its pin in `tests/i18n/fleet-locale-parity.spec.ts`.
- Ages are measured on the server clock (`serverNow`: `generatedAt` + client time since arrival), never by comparing
  the browser clock with server time.
- The project scope never shows credential chips, versions or runner links (B5); the API already nulls them.
- `/admin/fleet/credentials` (S3) renders `components/fleet/credentials/` from `useFleetCredentialBoard` (load on
  mount + Refresh, no polling). Board logic is pure in `lib/fleet-credential-board.ts`; a new cell state needs its key
  under `fleet.credentials.state` and its pin in `tests/i18n/fleet-locale-parity.spec.ts`.

## Fleet story graph (S2b (j))

- The job page renders `components/fleet/story-graph/FleetJobPipeline.vue`: heading, Graph | List toggle, the RUN
  stage strip (`PipelineStrip`), and either `StoryGraph` or the list (`FleetJobStories`). It re-renders from the
  job DTO the page reloads on `fleet_job` live events; it has no stream or timer of its own.
- All logic is pure in `lib/fleet-story-graph.ts` (`layoutStoryGraph`, `edgePaths`, `neighbourhood`,
  `pipelineStages`) and `lib/fleet-story-view.ts` (view persistence, `koda.fleet.storyView`). Keep class names in
  the `.vue` files: Tailwind does not scan `lib/`.
- Edges are measured from DOM boxes after mount (`ResizeObserver`), so Jest mount tests and SSR see nodes only;
  assert edges in E2E (`tests/e2e/fleet-story-graph.e2e.spec.ts`).
- Raw nax values (story statuses, `postRun` stage strings) show through `codeLabel` or as raw text; a new known
  stage state needs its key under `fleet.jobs.detail.pipeline.state` and its pin in
  `tests/i18n/fleet-locale-parity.spec.ts`.

## Fleet on tickets (C9)

- The ticket page renders `components/TicketFleetRuns.vue` under `TicketHeader`: it loads
  `GET /projects/:slug/tickets/:ref/fleet-jobs` itself and follows its own live events (this ticket, its jobs,
  any `QUEUED` job, resync). It is hidden when empty and never toasts a failed load. Unlink emits `changed`, and the
  page reloads its links (the fleet PR link goes with the job).
- Fleet PR links are ordinary `pr` ticket links with `source = 'fleet'` and a `jobId`; `TicketProperties` marks them
  "via fleet". The ticket page reloads links on every ticket live event, because the server announces new fleet
  PR links as `TICKET_UPDATED`.
- Pure logic lives in `lib/fleet-ticket-links.ts` (ref rules, the D461 feature slug, `?tickets=` parsing, picker
  matching, row reason and PR state). The dispatch form's tickets field is `components/fleet/TicketPicker.vue`.
- `FleetJobDto.tickets` is filled on single-job responses (detail, dispatch, cancel, requeue) and null on lists.

## UX redesign (in progress)

A multi-slice UX redesign of this app is planned and tracked in `docs/ux/redesign/MASTER-PLAN.md`. Read it before
changing layout, navigation, tokens or the ticket board, and update its Status table and Decisions log in the same PR.

- `layouts/default.vue` is pinned by `tests/layouts/*`: keep nav links inline in the template and keep the source order
  (SLOs before the project block; Timeline and Settings after KB). Project links are shown first with CSS `order-first`.
- `components/CommandPalette.vue` is the Cmd/Ctrl+K palette; new top-level destinations should be added there too.
- Colors come from the HSL tokens in `assets/css/globals.css` (including `status-*` and `priority-*`), never raw hex in components.
- Ticket chip styling (status/priority dots, type tints, card stripe) lives in `lib/ticket-chips.ts`;
  import it instead of copying chip class maps. `components/FilterBar.vue` is the shared filter-row
  grid. Pattern docs: `docs/ux/component-patterns.md`, `docs/ux/design-tokens.md`.

## Notifications (S4a)

- Header `components/NotificationBell.vue` (every signed-in page) reads `useNotifications()` (tab-shared
  `useState`), refreshed by `useUserEvents()`: one EventSource to `/api/me/events` per tab (shared hub,
  `server/api/me/events.get.ts`) plus a 60 s visible-tab poll backstop. Pages `/notifications` and
  `/settings/notifications`; `components/TicketWatchButton.vue` on ticket detail.
- Notification copy comes from `notifications.kinds.<kind>` with the row's `params`; an unknown kind falls back to the
  API `title`. A new kind needs both locales (pinned by `tests/i18n/notifications-locale-parity.spec.ts`).
- Every page holds a live stream open: E2E must never wait for `networkidle`; use `waitForHydration`.
- E2E sets `THROTTLE_LIMIT=1000` for the API (`playwright.config.ts`): every spec shares one client IP and the bell adds
  two reads per page load, which pushes a full run past the production 100/min default.
