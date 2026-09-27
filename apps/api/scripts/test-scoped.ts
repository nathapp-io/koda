/**
 * Scoped Jest run for nax (`quality.commands.testScoped` in .nax/mono/apps/api/config.json).
 *
 * Integration and e2e specs only run when `KODA_DB_TESTS=1` (otherwise they are
 * `describe.skip`, and `--passWithNoTests` turns that into a silent green). This
 * wrapper sets the flag when any targeted spec is DB-gated, so a story that writes
 * `test/integration/**` actually runs it. The flag makes jest globalSetup push the
 * schema to the test Postgres (`bun run test:db:up`, port 5433); with no database
 * the run fails instead of skipping. Unit-only targets stay database-free.
 *
 * A target that is not an existing path (a jest name pattern, a renamed file) also
 * turns DB mode on: jest may still match integration specs through it, and without
 * the flag they would skip silently. globalSetup only ever resets a local `*_test`
 * database (test/helpers/test-database-url.ts).
 *
 * Usage: bun scripts/test-scoped.ts <file|dir|pattern>...
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// DB-gated specs live under test/integration or test/e2e, or are named *.integration /
// *.e2e specs. Anchored so a parent directory such as `koda-e2e-fix/` does not match.
const DB_GATED = [/(^|\/)test\/(integration|e2e)\//, /\.(integration|e2e)\.spec\.ts$/];
const SPEC_FILE = /\.spec\.ts$/;
const BASE_ARGS = ['--forceExit', '--passWithNoTests'] as const;
const UNIT_ONLY_ARGS = ['--testPathIgnorePatterns=integration', '--testPathIgnorePatterns=e2e'] as const;

export interface ScopedRun {
  args: string[];
  env: Record<string, string>;
}

export function needsDatabase(specPaths: readonly string[]): boolean {
  return specPaths.some((specPath) => DB_GATED.some((pattern) => pattern.test(specPath.replace(/\\/g, '/'))));
}

function listSpecs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSpecs(full);
    return entry.isFile() && SPEC_FILE.test(entry.name) ? [full] : [];
  });
}

/** Directory targets become the spec files under them; anything else is kept as given. */
export function expandTargets(targets: readonly string[]): string[] {
  return targets.flatMap((target) =>
    fs.existsSync(target) && fs.statSync(target).isDirectory() ? listSpecs(target) : [target],
  );
}

export function hasUnresolvedTarget(targets: readonly string[]): boolean {
  return targets.some((target) => !fs.existsSync(target));
}

export function buildScopedRun(
  targets: readonly string[],
  expanded: readonly string[],
  unresolved = false,
): ScopedRun {
  if (targets.length === 0) {
    return { args: ['jest', ...BASE_ARGS, ...UNIT_ONLY_ARGS], env: {} };
  }
  return {
    args: ['jest', ...targets, ...BASE_ARGS],
    env: unresolved || needsDatabase(expanded) ? { KODA_DB_TESTS: '1' } : {},
  };
}

function main(): void {
  const targets = process.argv.slice(2);
  const run = buildScopedRun(targets, expandTargets(targets), hasUnresolvedTarget(targets));
  if (run.env.KODA_DB_TESTS) {
    process.stderr.write('test-scoped: DB-gated or unresolved targets, running with KODA_DB_TESTS=1\n');
  }
  const result = spawnSync('bunx', run.args, {
    stdio: 'inherit',
    env: { ...process.env, ...run.env },
  });
  if (result.error) {
    process.stderr.write(`test-scoped: failed to start jest: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}
