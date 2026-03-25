import { execSync } from 'child_process';
import path from 'path';

/**
 * Global setup — runs once before all E2E tests.
 *
 * NOTE: The API startup command in playwright.config.ts now runs
 * `bunx prisma migrate deploy && bun run seed:e2e` BEFORE starting the server.
 * This means the DB is seeded BEFORE the health check passes and tests run.
 *
 * This globalSetup is now a no-op placeholder retained for Playwright compatibility.
 * The heavy lifting is done by the webServer command script.
 */
export default async function globalSetup() {
  // DB init is handled by the webServer startup script.
  // This function is intentionally minimal.
  console.log('\n🎭 E2E Global Setup — DB init handled by webServer startup script.');
}
