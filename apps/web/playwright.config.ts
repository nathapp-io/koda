import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Find a free TCP port by asking the OS to bind on :0, then releasing it.
 * Called at config-evaluation time so ports are known before any server starts.
 */
function getFreePort(): number {
  const result = execSync(
    `node -e "const net=require('net');const s=net.createServer();s.listen(0,()=>{process.stdout.write(String(s.address().port));s.close()})"`,
    { encoding: 'utf8', timeout: 5000 },
  );
  return parseInt(result.trim(), 10);
}

const API_PORT = getFreePort();
const WEB_PORT = getFreePort();
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

// Absolute path — avoids prisma/prisma/ nesting when cwd differs between commands
const E2E_DB = path.resolve(__dirname, '../api/prisma/koda-e2e.db');

// Propagate resolved URLs to test worker processes (used by api-client.ts fixture)
process.env['E2E_API_URL'] = API_URL;
process.env['E2E_WEB_URL'] = WEB_URL;

/**
 * Koda E2E Playwright Config — portless mode
 *
 * Ports are assigned by the OS at config-evaluation time (no hardcoded ports).
 * Just run:
 *   cd apps/web && bun run test:e2e
 *
 * The API starts with an isolated E2E database (separate from dev DB).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: [
    {
      // API — NestJS with isolated E2E database.
      // DB is deleted + re-migrated + re-seeded on every run for a clean slate.
      command: `bash -c "rm -f '${E2E_DB}' '${E2E_DB}-shm' '${E2E_DB}-wal' && bunx prisma migrate deploy && bun prisma/seed-e2e.ts && bunx nest start"`,
      url: `${API_URL}/api/health`,
      cwd: path.resolve(__dirname, '../api'),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: `file:${E2E_DB}`,
        API_PORT: String(API_PORT),
      },
    },
    {
      // Web — Nuxt dev server.
      // bun run dev uses package.json dev script which respects PORT env var.
      command: 'bun run dev',
      url: WEB_URL,
      cwd: path.resolve(__dirname),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(WEB_PORT),
        NUXT_API_INTERNAL_URL: API_URL,
      },
    },
  ],

  globalSetup: path.resolve(__dirname, 'tests/e2e/global-setup.ts'),
  globalTeardown: path.resolve(__dirname, 'tests/e2e/global-teardown.ts'),

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
