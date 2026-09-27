/**
 * Jest globalSetup — runs ONCE before the whole test run.
 *
 * Pushes the Prisma schema to the Postgres test database once, when
 * `KODA_DB_TESTS=1`. Only `bun run test:integration` sets that flag; unit runs
 * (`bun run test`) never touch a database. Per-file isolation is handled
 * in-process by the fast `resetDb()` helper (test/helpers/reset-db.ts).
 *
 * In DB mode `.env.test` OVERRIDES inherited variables: a parent process (nax is a
 * Bun program and auto-loads the repo `.env`) can pass down a dev DATABASE_URL, and
 * the schema push below force-resets whatever that URL points at. The URL is then
 * checked by `assertSafeTestDatabaseUrl` before Prisma runs.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { assertSafeTestDatabaseUrl } from './helpers/test-database-url';

export default async function globalSetup(): Promise<void> {
  // Only `bun run test:integration` (and nax's test:scoped / acceptance) set
  // KODA_DB_TESTS=1. Unit runs (`bun run test`) must never need a database.
  const dbMode = process.env.KODA_DB_TESTS === '1';
  config({ path: resolve(__dirname, '../.env.test'), quiet: true, override: dbMode });
  if (!dbMode) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('KODA_DB_TESTS=1 but DATABASE_URL is not set');
  }
  assertSafeTestDatabaseUrl(databaseUrl);

  execSync('bunx prisma db push --force-reset --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
