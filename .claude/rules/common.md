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
- **Validation error messages must use i18n keys** — not hardcoded strings in zod schemas or decorators

## OpenAPI & Code Generation
- Run `bun run generate` after ANY API endpoint change before touching CLI or web code
- Never manually edit files inside `*/generated/`
- `openapi.json` at monorepo root is committed — source of truth for client generation

## Test Anti-Patterns
- **No `us-XXX` test files** — never in `src/` or `test/`
- No `us-XXX` folders in `test/` directories
- Test files must follow the naming conventions in each app's context.md (unit: `*.spec.ts`, integration: `*.integration.spec.ts`, E2E: `*.e2e.spec.ts`)
- **No hardcoded absolute paths in test files** — never use paths like `/Users/...` or `/home/...`. Use `__dirname` + `path.join()` for file references so tests run on any machine (VPS, Mac01, CI):
  ```ts
  // ❌ Wrong — breaks on any machine except the author's dev environment
  const labelsPagePath = '/Users/subrinaai/Desktop/workspace/.../labels.vue'

  // ✅ Correct — portable across all environments
  const webDir = join(__dirname, '../..')
  const labelsPagePath = join(webDir, 'pages/[project]/labels.vue')
  ```

## TypeScript
- Strict mode enabled across all apps
- No `any` in production code — use proper types
- `any` in test files is allowed

## Type Safety Anti-Patterns
- **Never suppress `any` with `eslint-disable`** — use `unknown` or create a proper type
- **No `@ts-ignore` or `@ts-expect-error`** — fix the root cause, don't suppress it
- **No non-null assertions (`!`)** — handle null/undefined explicitly
- **Typed extraction over `any`** — use typed request context extraction instead of `req: any`

## Error Handling
- **Use error codes over string matching** — never check `error.message.includes('...')`
  ```ts
  // ❌ Wrong
  if (err.message.includes('Unique constraint')) { ... }

  // ✅ Correct
  if (err.ret === '2000') { ... }  
  
  // ✅ Correct
  if (err.code === 'P2002') { ... }  
  ```
- **Never swallow errors** — always handle, re-throw, or log
- **Validate at system boundaries** — never trust external data (user input, API responses, file content)
