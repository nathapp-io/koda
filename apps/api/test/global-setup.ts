/**
 * Jest globalSetup — runs ONCE before the whole test run.
 *
 * Pushes the Prisma schema to the Postgres test database once, when
 * `KODA_DB_TESTS=1` outside the nax sandbox. Unit runs
 * (`bun run test`) never touch a database. Per-file isolation is handled
 * in-process by the fast `resetDb()` helper (test/helpers/reset-db.ts).
 *
 * In DB mode `.env.test` OVERRIDES inherited variables: a parent process (nax is a
 * Bun program and auto-loads the repo `.env`) can pass down a dev DATABASE_URL, and
 * the schema push below force-resets whatever that URL points at. An inherited
 * DATABASE_URL is therefore never used: the database comes from `resolveTestDatabase`
 * (KODA_TEST_DATABASE_URL, else the compose database named in `.env.test` when it is
 * up, else a Testcontainers Postgres) and is checked by `assertSafeTestDatabaseUrl`
 * before Prisma runs. The chosen URL is exported as DATABASE_URL for the specs.
 */
import { config, parse } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { assertSafeTestDatabaseUrl } from './helpers/test-database-url';
import { rememberTestDatabase, resolveTestDatabase } from './helpers/test-database';
import { acquireProcessDbRunLock, releaseRememberedDbRunLock, rememberDbRunLock } from './helpers/db-run-lock';
import { prepareSchemaOnce } from './helpers/schema-once';
import { PARTIAL_UNIQUE_INDEXES } from './helpers/partial-indexes';
import { createTestPrismaClient } from './helpers/test-prisma';
import { canRunDbTests } from './helpers/test-environment';

const ENV_TEST_PATH = resolve(__dirname, '../.env.test');

export default async function globalSetup(): Promise<void> {
  // Only `bun run test:integration` (and nax's test:scoped / acceptance) set
  // KODA_DB_TESTS=1. Unit runs (`bun run test`) must never need a database.
  // The nax sandbox withholds host Postgres/Docker; skipped suites need no provisioning.
  const dbMode = canRunDbTests();
  config({ path: ENV_TEST_PATH, quiet: true, override: dbMode });
  if (!dbMode) return;

  // The compose URL is read from the file itself, never from process.env, so an inherited
  // DATABASE_URL cannot stand in for it even if `.env.test` stops defining one.
  const composeUrl = parse(readFileSync(ENV_TEST_PATH))['DATABASE_URL'];
  const database = await resolveTestDatabase(process.env, composeUrl);
  rememberTestDatabase(database);
  // Fix round 1 (F1): one DB-mode run at a time per test database. `prepareSchema` force-resets the schema and every
  // suite truncates, so a second run started at the same time destroys this one (a register that commits and is
  // truncated before its own re-read answers 401, and suites fail in `beforeAll` with nothing structured to report).
  // The lock is taken before the reset and released by globalTeardown. Acquisition fails closed: when another run holds
  // the database (or the lock session cannot be opened) this setup throws instead of resetting a database it cannot
  // lock. `KODA_DB_RUN_LOCK=off` is the only way to run unserialised, for a database nobody else uses.
  try {
    if (process.env['KODA_DB_RUN_LOCK'] !== 'off') {
      rememberDbRunLock(await acquireProcessDbRunLock(database.databaseUrl, {
        log: (message) => process.stderr.write(`${message}\n`),
      }));
    }
    // Once per process, not once per Vitest project: the second reset would wipe the rows the first project's files are
    // already using, which is what made early suites answer 401 intermittently (fix round 1, F1).
    await prepareSchemaOnce(database.databaseUrl, () => prepareSchema(database.databaseUrl));
  } catch (error) {
    // globalTeardown does not run when globalSetup throws: release what this setup took, stop a container it started.
    await releaseRememberedDbRunLock();
    await database.stop();
    throw error;
  }
  if (database.source === 'testcontainers') {
    process.stdout.write('KODA_DB_TESTS=1: using a throwaway Testcontainers Postgres\n');
  }
}

async function prepareSchema(databaseUrl: string): Promise<void> {
  assertSafeTestDatabaseUrl(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;

  execSync('bunx prisma db push --force-reset', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // `db push` cannot express partial indexes; replay the ones migrations ship (plan D2 of slice 1).
  const prisma = createTestPrismaClient(databaseUrl);
  try {
    for (const statement of PARTIAL_UNIQUE_INDEXES) await prisma.$executeRawUnsafe(statement);
  } finally {
    await prisma.$disconnect();
  }
}
