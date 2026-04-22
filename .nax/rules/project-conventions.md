# Project Conventions

This rules file is intentionally brief.

Primary architecture/context source is [`/home/williamkhoo/Desktop/projects/nathapp/koda/.nax/context.md`](/home/williamkhoo/Desktop/projects/nathapp/koda/.nax/context.md). Keep detailed stack, folder map, and ownership docs there.

## Monorepo Shape
- Apps: `apps/api`, `apps/cli`, `apps/web`
- Shared config: `packages/*`
- Project guidance source: `.nax/context.md` + `.nax/mono/apps/<app>/context.md`

## Architecture Rules
- API is the system of record for business logic, auth, transitions, and persistence
- CLI and Web stay thin clients over API behavior
- Do not duplicate backend business rules in CLI/Web
- API contract changes should flow through `openapi.json` before downstream client updates

## OpenAPI & Generation
- Flow: API export -> `openapi.json` -> CLI generated client
- Run `bun run generate` after contract changes affecting CLI
- Never edit generated client files manually
- `apps/web/generated/` is not part of current architecture
- Preferred sequence:
  - `bun run api:export-spec`
  - `bun run generate`

## Core Commands
- `bun run build`
- `bun run dev`
- `bun run test`
- `bun run lint`
- `bun run type-check`
- `bun run generate`
- Database/API helpers:
  - `bun run db:generate`
  - `bun run db:migrate`
  - `bun run api:export-spec`

## Engineering Rules
- Keep business logic in API unless there is a strong reason not to
- Update tests with behavior changes
- Treat soft-delete, auth, and workflow constraints as API-owned invariants
- Do not edit generated `AGENTS.md` manually; update source context and regenerate
- Keep lint/type-check green before handing off completed work

## Test Organization
- Unit: `src/**/*.spec.ts`
- Integration: `test/integration/**/*.integration.spec.ts`
- E2E: `test/e2e/**/*.e2e.spec.ts`
- NAX acceptance assets belong in `.nax/features/<feature>/`

## i18n Separation
- API i18n: `apps/api/src/i18n/{en,zh}`
- Web i18n: `apps/web/i18n/locales/{en,zh}.json`
- Do not assume API and web keys are shared

## App Context Files
- `.nax/mono/apps/api/context.md`
- `.nax/mono/apps/cli/context.md`
- `.nax/mono/apps/web/context.md`

## Review Checklist
- Is business logic added in API instead of CLI/Web?
- Are generated artifacts regenerated instead of manually patched?
- Are test naming/location conventions respected?
- Are API and web i18n keys updated in their own systems?
- Is `openapi.json` in sync with current API contract when relevant?
