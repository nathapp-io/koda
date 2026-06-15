/**
 * Fast per-file database reset for SQLite integration/e2e suites.
 *
 * The schema is created ONCE by the Jest globalSetup (test/global-setup.ts),
 * so individual test files no longer need to spawn
 * `bunx prisma db push --force-reset` (seconds per file). Instead they call
 * `resetDb()` in `beforeAll`, which truncates every table in-process
 * (milliseconds) while leaving the schema intact.
 *
 * SQLite-specific: the test suites run against the SQLite test database.
 */
import { PrismaClient } from '@prisma/client';

interface SqliteTable {
  name: string;
}

/**
 * Delete all rows from every application table in the test database.
 *
 * @param databaseUrl Connection string. Defaults to DATABASE_URL; a no-op when
 *   unset, matching how the DB-backed suites skip without a configured DB.
 */
export async function resetDb(
  databaseUrl: string | undefined = process.env.DATABASE_URL
): Promise<void> {
  if (!databaseUrl) return;

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  try {
    const tables = await prisma.$queryRawUnsafe<SqliteTable[]>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_prisma_%'`
    );

    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
    for (const { name } of tables) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${name}"`);
    }

    // Reset AUTOINCREMENT counters when the bookkeeping table exists, so IDs
    // start fresh per file just as --force-reset previously gave us.
    const sequence = await prisma.$queryRawUnsafe<SqliteTable[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`
    );
    if (sequence.length > 0) {
      await prisma.$executeRawUnsafe('DELETE FROM sqlite_sequence');
    }

    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
  } finally {
    await prisma.$disconnect();
  }
}
