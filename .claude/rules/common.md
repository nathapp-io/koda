# Common Rules — All Apps

## Package Manager
- **Bun** is the package manager — use `bun install`, `bun run`, never `npm` or `yarn`
- Exception: `npx jest` for running specific test files (Jest doesn't have a bun equivalent)

## Git
- **Never push to remote** — the human reviews and pushes
- Commit messages follow conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

## Development
- **TDD first** — write or update tests before implementation when the story calls for it
- **Stuck rule** — if the same test fails 2+ iterations, stop, summarise failed attempts, reassess approach
- **Senior Engineer mindset** — check edge cases, null/undefined, race conditions, and error states

## i18n
- All user-facing strings must use i18n keys — no hardcoded strings
- When adding new features, add translations to **both** `en` and `zh`
- English is the source of truth — add English first, then Chinese

## OpenAPI & Code Generation
- Run `bun run generate` after ANY API endpoint change before touching CLI or web code
- Never manually edit files inside `*/generated/`
- `openapi.json` at monorepo root is committed — source of truth for client generation

## TypeScript
- Strict mode enabled across all apps
- No `any` in production code — use proper types
- `any` in test files is allowed

## NestJS
- Before writing any NestJS code, read and follow the `nathapp-nestjs-patterns` skill
- This skill is the **authoritative source** — do NOT use generic NestJS alternatives when a Nathapp pattern exists
