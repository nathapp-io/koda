import { execSync } from 'child_process';
import path from 'path';

/**
 * Global setup — runs once before all E2E tests.
 * Resets + migrates the e2e SQLite DB, then seeds the admin user.
 *
 * CRITICAL: Playwright starts the API/Nuxt servers BEFORE this runs (via webServer).
 * Those servers connect to the DB before migrations run — Prisma sees a stale schema.
 * After migrations + seed, we must kill ALL servers on E2E ports (including any stale
 * leftovers on 3100 from previous runs) so Playwright restarts them with the
 * correctly-migrated DB.
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

  // Kill ALL processes on E2E ports — current run ports AND any stale 3100/3103
  // from previous runs.  nest start forks a child (node dist/main) that survives
  // parent death, so we use pkill -f on the full command + port-based kill.
  for (const port of [3100, 3102, 3103]) {
    try {
      // First try port-based kill (covers the actual server child process)
      const pids = execSync(`lsof -ti :${port} 2>/dev/null`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (pids) {
        for (const pid of pids.split('\n').filter(Boolean)) {
          try { execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
        }
        console.log(`✅ Killed processes on port ${port}: ${pids}`);
      }
    } catch { /* port not in use — skip */ }

    // Also kill any orphaned nest start / nuxt processes for this project
    for (const cmd of [`node.*nest start.*310${port === 3103 ? '' : '2'}`, `nuxt.*310${port}`]) {
      try {
        execSync(`pkill -f "${cmd}" 2>/dev/null`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  }

  // Give the OS a moment to release ports
  await new Promise((r) => setTimeout(r, 2000));
  console.log('✅ All servers killed — Playwright will restart with migrated DB');
}
