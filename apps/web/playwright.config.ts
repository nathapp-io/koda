import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const API_PORT = process.env['E2E_API_PORT'] ?? '3100';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '3101';
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Koda E2E Playwright Config
 *
 * Playwright auto-starts both servers. Just run:
 *   cd apps/web && bun run test:e2e
 *
 * The API starts with DATABASE_URL=file:./prisma/koda-e2e.db (isolated from dev DB).
 * Use a different port to avoid conflicts with a running dev server:
 *   E2E_API_PORT=3102 E2E_WEB_PORT=3103 bun run test:e2e
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,       // SQLite writes — keep sequential to avoid contention
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,                 // Single worker — fresh DB per run, shared state
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: [
    {
      // API — starts on E2E_API_PORT (default 3100) with isolated e2e database
      command: `DATABASE_URL=file:./prisma/koda-e2e.db API_PORT=${API_PORT} bun run dev`,
      url: `${API_URL}/api/health`,
      cwd: path.resolve(__dirname, '../api'),
      reuseExistingServer: !process.env['CI'],
      timeout: 90_000,
      env: {
        DATABASE_URL: 'file:./prisma/koda-e2e.db',
        API_PORT: String(API_PORT),
      },
    },
    {
      // Web — Nuxt dev server
      command: `bun run dev -- --port ${WEB_PORT}`,
      url: WEB_URL,
      cwd: path.resolve(__dirname),
      reuseExistingServer: !process.env['CI'],
      timeout: 90_000,
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
