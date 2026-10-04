import { defineConfig, devices } from '@playwright/test';
import os from 'os';
import path from 'path';

const API_PORT = process.env['E2E_API_PORT'] ?? '3102';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '3103';
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

// Postgres from docker-compose.test.yml (`bun run test:db:up` in apps/api).
// `prisma migrate reset` creates the koda_e2e database if missing.
const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://koda:koda@localhost:5433/koda_e2e';

// Propagate resolved URLs to test worker processes (used by api-client.ts fixture)
process.env['E2E_API_URL'] = API_URL;
process.env['E2E_WEB_URL'] = WEB_URL;

// E2E_WEB_MODE=build (CI): serve the production build instead of `nuxt dev`.
// Build first: `bunx turbo run build --filter=@nathapp/koda-web`.
const WEB_BUILD_MODE = process.env['E2E_WEB_MODE'] === 'build';
const WEB_DEV_COMMAND = `bash -lc "bunx nuxt dev --port ${WEB_PORT} 2>&1 | grep -Ev 'Two component files resolving to the same name|/components/ui/.*/index.ts|/components/ui/.*/[A-Za-z]+\\.vue|MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module because module syntax was detected|To eliminate this warning, add "type": "module"'"`;
const WEB_BUILD_COMMAND = `bash -c "test -f .output/server/index.mjs || { echo 'E2E_WEB_MODE=build needs a web build first' >&2; exit 1; }; node .output/server/index.mjs"`;

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
      command: `bash -c "bunx prisma migrate reset --force --skip-seed --skip-generate && bun prisma/seed-e2e.ts && bunx nest start"`,
      url: `${API_URL}/api/health`,
      cwd: path.resolve(__dirname, '../api'),
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        API_PORT: String(API_PORT),
        VCS_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        // Deterministic offline embeddings so the KB specs run without Ollama.
        EMBEDDING_PROVIDER: process.env['EMBEDDING_PROVIDER'] ?? 'fake',
        // Keep e2e vectors out of the dev ./lancedb (CI sets this too).
        RAG_IN_MEMORY_ONLY: process.env['RAG_IN_MEMORY_ONLY'] ?? 'true',
        // #144: raise the auth login throttle from 5/min to 50/min so the
        // cumulative logins across the whole e2e suite (all spec files share
        // a single client IP) stay under the limit even with CI retries that
        // restart workers and clear the per-worker session cache.
        AUTH_LOGIN_THROTTLE_LIMIT: process.env['AUTH_LOGIN_THROTTLE_LIMIT'] ?? '50',
        // Fleet slice 4c: the scripted runner's idle sync returns within 1 s instead of
        // long-polling 25 s, and job bundles land outside the repo.
        FLEET_SYNC_WAIT_MS: '1000',
        FLEET_ARTIFACT_DIR: path.join(os.tmpdir(), `koda-e2e-fleet-artifacts-${API_PORT}`),
        // S1b 3b D213: the schedules e2e fires a schedule through the test-only hook (never on in production).
        FLEET_TEST_HOOKS: 'true',
        // S1.5 2b: the bash e2e waits for the 15 s approval expiry sweep; do not depend on NODE_ENV defaults.
        FLEET_SWEEP_ENABLED: 'true',
      },
    },
    {
      // Web
      command: WEB_BUILD_MODE ? WEB_BUILD_COMMAND : WEB_DEV_COMMAND,
      url: WEB_URL,
      cwd: path.resolve(__dirname),
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NUXT_API_INTERNAL_URL: API_URL,
        E2E_RUN: '1',
        PORT: String(WEB_PORT),
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
