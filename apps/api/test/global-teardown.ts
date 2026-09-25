/**
 * Jest globalTeardown. The Postgres test database is reset by the next run's
 * globalSetup (`prisma db push --force-reset`), so there is nothing to delete.
 * Kept as an explicit no-op so the jest config stays stable.
 */
export default async function globalTeardown(): Promise<void> {
  return;
}
