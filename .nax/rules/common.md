# Common Rules — All Apps

## Tooling
- Use Bun workspace commands (`bun install`, `bun run`), not `npm`/`yarn`
- Exception: `npx jest` is allowed for targeted Jest runs
- Prefer repository scripts over ad-hoc one-off command variants

## Git
- Never push to remote; human reviews and pushes
- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`)

## Delivery
- Prefer TDD: add/update tests with behavior changes
- Stuck rule: if the same failure repeats 2+ iterations, stop and reassess
- Think in edge cases: null/undefined, race conditions, and error states

## i18n
- No hardcoded user-facing strings
- Add translations to both `en` and `zh`
- English is source-of-truth, then Chinese
- Validation errors must use i18n keys (not inline literals)

## OpenAPI & Generated Code
- Run `bun run generate` after API contract changes that affect clients
- Never hand-edit files under `*/generated/`
- `openapi.json` at repo root is committed and must stay current

## Tests
- No `us-XXX` test files or folders under app `test/` directories
- Follow naming conventions: unit `*.spec.ts`, integration `*.integration.spec.ts`, e2e `*.e2e.spec.ts`
- No hardcoded absolute machine paths in tests; use portable path resolution
- Use `__dirname` + `path.join()` for cross-machine file references in tests

## Type Safety
- TypeScript strict mode applies across apps
- No `any` in production code (`any` in tests is allowed)
- Do not suppress typing with `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`
- Avoid non-null assertions (`!`); handle null/undefined explicitly

## Error Handling
- Use structured error codes, not message-string matching
- Never swallow errors; handle, rethrow, or log intentionally
- Validate at system boundaries (user input, API responses, file content)

## Quick Reference
- Wrong: `if (err.message.includes('Unique constraint')) { ... }`
- Correct: `if (err.code === 'P2002') { ... }`
- Wrong: absolute test path `/Users/...` or `/home/...`
- Correct: resolve paths from `__dirname`
