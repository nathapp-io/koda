/**
 * Jest globalTeardown. Releases the DB-mode run lock `globalSetup` took, then stops the Testcontainers Postgres when
 * globalSetup started one; an explicit or compose test database is left running and is reset by the next run's
 * globalSetup (`prisma db push --force-reset`).
 */
import { releaseRememberedDbRunLock } from './helpers/db-run-lock';
import { rememberedTestDatabase } from './helpers/test-database';

export default async function globalTeardown(): Promise<void> {
  try {
    await rememberedTestDatabase()?.stop();
  } finally {
    // Fix round 1 (F1): free the database for the next run whatever happened above.
    await releaseRememberedDbRunLock();
  }
}
