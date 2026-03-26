import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const API_PORT = process.env['E2E_API_PORT'] ?? '3102';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '3103';
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

// Absolute path — avoids prisma/prisma/ nesting when cwd differs between commands
const E2E_DB = path.resolve(__dirname, '../api/prisma/koda-e2e.db');

// Propagate resolved URLs to test worker processes (used by api-client.ts fixture)
process.env['E2E_API_URL'] = API_URL;
process.env['E2E_WEB_URL'] = WEB_URL;

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
      // API
      command: `bash -c "rm -f '${E2E_DB}' '${E2E_DB}-shm' '${E2E_DB}-wal' && bunx prisma migrate deploy && bun prisma/seed-e2e.ts && bunx nest start"`,
      url: `${API_URL}/api/health`,
      cwd: path.resolve(__dirname, '../api'),
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: `file:${E2E_DB}`,
        API_PORT: String(API_PORT),
      },
    },
    {
      // Web
      command: `bash -lc "bunx nuxt dev --port ${WEB_PORT} 2>&1 | grep -Ev 'Two component files resolving to the same name|/components/ui/.*/index.ts|/components/ui/.*/[A-Za-z]+\\.vue|MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module because module syntax was detected|To eliminate this warning, add "type": "module"'"`,
      url: WEB_URL,
      cwd: path.resolve(__dirname),
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NUXT_API_INTERNAL_URL: API_URL,
        E2E_RUN: '1',
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
