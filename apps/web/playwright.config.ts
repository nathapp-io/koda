import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Koda E2E Playwright Config
 *
 * Requires:
 *  - API running on http://localhost:3100 (DATABASE_URL pointing at koda-e2e.db)
 *  - Web running on http://localhost:3101
 *
 * Quick start:
 *   cd apps/api && DATABASE_URL=file:./prisma/koda-e2e.db bun run start &
 *   cd apps/web && bun run dev &
 *   cd apps/web && bun run test:e2e
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,       // SQLite writes — keep sequential to avoid contention
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,                 // Single worker — fresh DB per run, shared state
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],

  use: {
    baseURL: process.env['E2E_WEB_URL'] ?? 'http://localhost:3101',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  globalSetup: path.resolve(__dirname, 'tests/e2e/global-setup.ts'),
  globalTeardown: path.resolve(__dirname, 'tests/e2e/global-teardown.ts'),

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
