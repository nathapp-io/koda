import { execSync } from 'child_process';
import path from 'path';

/**
 * Global setup — runs once before all E2E tests.
 * Resets + migrates the e2e SQLite DB, then seeds the admin user.
 * The API and web servers are started by Playwright's webServer config
 * in playwright.config.ts — no manual startup needed here.
 */
export default async function globalSetup() {
  console.log('\n🎭 E2E Global Setup — resetting test database...');

  const apiDir = path.resolve(__dirname, '../../../../apps/api');
  const e2eEnv = { ...process.env, DATABASE_URL: 'file:./prisma/koda-e2e.db' };

  // Reset and migrate
  execSync('bunx prisma migrate reset --force --skip-seed', {
    cwd: apiDir,
    env: e2eEnv,
    stdio: 'inherit',
  });
  console.log('✅ Migrations applied to koda-e2e.db');

  // Seed admin user
  execSync('bun run seed:e2e', {
    cwd: apiDir,
    env: e2eEnv,
    stdio: 'inherit',
  });
  console.log('✅ Test data seeded — admin@koda-e2e.test ready');
}
