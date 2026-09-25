/**
 * Jest globalSetup — runs ONCE before the whole test run.
 *
 * Pushes the Prisma schema to the Postgres test database once, when
 * `KODA_DB_TESTS=1`. Only `bun run test:integration` sets that flag; unit runs
 * (`bun run test`) never touch a database. Per-file isolation is handled
 * in-process by the fast `resetDb()` helper (test/helpers/reset-db.ts).
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';

export default async function globalSetup(): Promise<void> {
  config({ path: resolve(__dirname, '../.env.test'), quiet: true });

  // Only `bun run test:integration` sets KODA_DB_TESTS=1. Unit runs
  // (`bun run test`) must never need a database.
  if (process.env.KODA_DB_TESTS !== '1') return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('KODA_DB_TESTS=1 but DATABASE_URL is not set');
  }

  execSync('bunx prisma db push --force-reset --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
