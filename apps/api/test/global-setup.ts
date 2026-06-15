/**
 * Jest globalSetup — runs ONCE before the whole test run.
 *
 * Pushes the Prisma schema to the shared SQLite test database a single time,
 * instead of every integration/e2e file spawning its own
 * `bunx prisma db push --force-reset` in `beforeAll` (which costs seconds per
 * file). Per-file isolation is then handled in-process by the fast
 * `resetDb()` helper (test/helpers/reset-db.ts).
 *
 * Gated on DATABASE_URL exactly like the test files themselves: when no test
 * database is configured the DB-backed suites skip, so there is nothing to set
 * up here either.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';

export default async function globalSetup(): Promise<void> {
  // Mirror test-setup.ts so DATABASE_URL is resolved the same way the workers
  // resolve it, regardless of how Jest was invoked.
  config({ path: resolve(__dirname, '../.env.test'), quiet: true });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;

  execSync('bunx prisma db push --force-reset --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
