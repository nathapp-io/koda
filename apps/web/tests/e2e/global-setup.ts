import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3100';
const E2E_DB = path.resolve(__dirname, '../../../../apps/api/prisma/koda-e2e.db');

/**
 * Global setup — runs once before all E2E tests.
 * 1. Resets the e2e SQLite database (fresh migration)
 * 2. Seeds admin user + base test project via Prisma
 * 3. Verifies API is reachable
 */
export default async function globalSetup() {
  console.log('\n🎭 E2E Global Setup — resetting test database...');

  const apiDir = path.resolve(__dirname, '../../../../apps/api');

  // Reset and migrate the e2e database
  execSync('bunx prisma migrate reset --force --skip-seed', {
    cwd: apiDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:./prisma/koda-e2e.db`,
    },
    stdio: 'inherit',
  });

  console.log('✅ Migrations applied to koda-e2e.db');

  // Seed test data
  execSync('bun run seed:e2e', {
    cwd: apiDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:./prisma/koda-e2e.db`,
    },
    stdio: 'inherit',
  });

  console.log('✅ Test data seeded');

  // Verify API is reachable
  const maxRetries = 10;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${API_URL}/api/health`);
      if (res.ok) {
        console.log(`✅ API reachable at ${API_URL}`);
        break;
      }
    } catch {
      if (i === maxRetries - 1) {
        throw new Error(
          `❌ API not reachable at ${API_URL} after ${maxRetries} attempts.\n` +
          `Ensure the API is running with DATABASE_URL=file:./prisma/koda-e2e.db`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
