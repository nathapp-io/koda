# Codex Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-web`

**Language:** TypeScript

**Key dependencies:** @nuxtjs/color-mode, @nuxtjs/i18n, @nuxtjs/tailwindcss, @vee-validate/zod, lucide-vue-next, nuxt, radix-vue, shadcn-nuxt, vue, vue-router

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
