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

## UX redesign (in progress)

A multi-slice UX redesign of this app is planned and tracked in `docs/ux/redesign/MASTER-PLAN.md`. Read it before
changing layout, navigation, tokens or the ticket board, and update its Status table and Decisions log in the same PR.

- `layouts/default.vue` is pinned by `tests/layouts/*`: keep nav links inline in the template and keep the source order
  (SLOs before the project block; Timeline and Settings after KB). Project links are shown first with CSS `order-first`.
- `components/CommandPalette.vue` is the Cmd/Ctrl+K palette; new top-level destinations should be added there too.
- Colors come from the HSL tokens in `assets/css/globals.css` (including `status-*` and `priority-*`), never raw hex in components.
