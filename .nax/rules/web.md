---
paths:
  - "apps/web/*"
---

# Web Rules — apps/web

## Components & UI
- Add Shadcn components via CLI (`bunx shadcn-vue@latest add <name>`)
- Keep custom components in PascalCase
- Prefer Shadcn primitives over raw native form controls
- Keep `components/ui/` aligned with Shadcn structure (editable, but not manually invented from scratch)

## Forms
- Use `vee-validate` + `zod` for form validation
- Do not use raw `v-model` forms without schema-backed validation
- Zod validation messages should use i18n keys (not hardcoded English)

## API Access
- Use `useApi()` for API calls; do not use raw `$fetch`, `useFetch`, or axios in components
- Use `$api.get/post/patch/delete` with paths relative to API base
- Use `useAuth()` for auth/session handling
- Use `useAppToast()` and `extractApiError()` for notifications/error presentation
- Web does not use generated OpenAPI client in current architecture
- Keep API calls and envelope unwrapping inside composables/utilities, not scattered per page

## Styling
- Use semantic Shadcn/Tailwind tokens (`text-muted-foreground`, `bg-background`, `border-border`)
- Avoid hardcoded palette classes like `text-gray-500`
- Keep dark-mode behavior aligned with shared CSS variables
- Prefer `space-y-*` for vertical stacks and `gap-*` for flex/grid spacing

## i18n
- Use `const { t } = useI18n()` and key-based rendering in templates
- No hardcoded UI strings
- Update both `i18n/locales/en.json` and `i18n/locales/zh.json`
- Locale cookie: `koda_locale`; fallback: `en`
- Keep locale keys grouped by feature areas (for example `common`, `auth`, `tickets`, `agents`, `labels`, `toast`)

## Middleware & Routing
- `auth.global.ts` handles route protection
- Guest-only routes (`/login`, `/register`) redirect authenticated users to `/`

## Generated Files
- `generated/` is regenerated from repo workflows; do not edit manually

## Testing
- Unit/component tests: Jest
- E2E tests: Playwright
- Use `bun run test` and `bun run test:e2e`

## Implementation Anti-Patterns
- Do not duplicate page logic across pages/components; extract composables
- Prefer shared types/utilities over redefining local duplicates
- Do not define ad-hoc inline styling helper logic per component when reusable styles/composables exist

## Quick Reference
- Wrong: `<Button>Cancel</Button>`
- Correct: `<Button>{{ t('common.cancel') }}</Button>`
- Wrong: direct `toast.error(err.message)` from API catch blocks
- Correct: `toast.error(extractApiError(err))`
