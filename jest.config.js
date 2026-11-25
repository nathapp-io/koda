/**
 * Root jest entry point for the monorepo's jest packages.
 *
 * `apps/web` and `apps/cli` keep their own jest configuration in their `package.json` (`preset: ts-jest`),
 * so running jest inside a package needs nothing from this file. What this file covers is the one run that
 * starts at the repository root: the scoped quality gate resolves the monorepo orchestrator's cwd to the
 * root and then executes a package's scoped test command there, with absolute test paths
 * (`bunx jest '/abs/path/apps/web/tests/x.spec.ts' --forceExit`). Without a root config jest falls back to
 * its defaults — babel-jest, no `~/…` alias — and every TypeScript spec fails to parse
 * (`SyntaxError: … Unexpected token, expected "from"` on the first `import type`).
 *
 * Declaring the packages as jest projects keeps the root run inside each package's own configuration, so the
 * ts-jest transform, the `~/…` alias and the test-ignore patterns are the package's own, exactly as they are
 * for `bun run test`. `apps/api` (vitest) and `apps/runner` (`bun test`) have no jest configuration and are
 * deliberately absent.
 */
module.exports = {
  projects: ['<rootDir>/apps/web', '<rootDir>/apps/cli'],
}
