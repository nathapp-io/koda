/**
 * Fast per-file database reset for Postgres integration/e2e suites.
 *
 * The schema is created ONCE by the Jest globalSetup (test/global-setup.ts).
 * Test files call `resetDb()` in `beforeAll`, which truncates every
 * application table in one statement and restarts identity sequences,
 * leaving the schema and `_prisma_migrations` intact.
 */
import { PrismaClient } from '@prisma/client';

interface PgTable {
  tablename: string;
}

/**
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
    const tables = await prisma.$queryRawUnsafe<PgTable[]>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename <> '_prisma_migrations'`
    );
    if (tables.length === 0) return;

    const list = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}
