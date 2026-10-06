/**
 * Jest globalTeardown. Stops the Testcontainers Postgres when globalSetup started one; an
 * explicit or compose test database is left running and is reset by the next run's
 * globalSetup (`prisma db push --force-reset`).
 */
import { rememberedTestDatabase } from './helpers/test-database';

export default async function globalTeardown(): Promise<void> {
  await rememberedTestDatabase()?.stop();
}
