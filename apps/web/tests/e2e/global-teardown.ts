/**
 * Global teardown — runs once after all E2E tests. The Postgres e2e database
 * is reset by the next run's `prisma migrate reset`, so there is nothing to
 * delete. Kept so playwright.config.ts globalTeardown stays stable.
 */
export default async function globalTeardown(): Promise<void> {
  return;
}
