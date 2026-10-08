import { PrismaClient } from '../../src/generated/prisma/client';
import { createPgAdapter } from '../../src/prisma/pg-adapter';

/** DATABASE_URL as exported by jest globalSetup for DB-mode runs. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: DB tests run with KODA_DB_TESTS=1 (globalSetup exports it)');
  return url;
}

/** A PrismaClient on the test database; Prisma 7 needs an adapter for every client. */
export function createTestPrismaClient(databaseUrl: string = testDatabaseUrl()): PrismaClient {
  return new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
}
