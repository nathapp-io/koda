import { execSync } from 'child_process';
import { createConnection } from 'net';
import path from 'path';

/**
 * Global setup — runs once before all E2E tests.
 * Resets + migrates the e2e SQLite DB, then seeds the admin user.
 *
 * CRITICAL: Playwright's webServer starts the API/Nuxt servers BEFORE this runs.
 * The API connects to the DB before migrations run, leaving Prisma with a stale
 * connection. After migrations we must kill the API so Playwright restarts it
 * with the correctly-migrated DB.
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

  // Kill the API server (started by Playwright's webServer before globalSetup).
  // Playwright will restart it automatically when tests begin, now with the
  // correctly-migrated DB.  We also kill Nuxt to ensure a clean proxy state.
  const apiPort = process.env['E2E_API_PORT'] ?? '3100';
  const webPort = process.env['E2E_WEB_PORT'] ?? '3103';
  for (const port of [apiPort, webPort]) {
    try {
      const socket = createConnection({ port: Number(port), host: 'localhost' });
      socket.setTimeout(500);
      socket.on('connect', () => {
        const pid = execSync(
          `lsof -ti :${port} 2>/dev/null | head -1`,
          { encoding: 'utf8' }
        ).trim();
        if (pid) {
          try { execSync(`kill ${pid}`, { stdio: 'ignore' }); }
          catch { /* ignore */ }
          console.log(`✅ Killed stale server on port ${port} (PID ${pid})`);
        }
        socket.destroy();
      });
      socket.on('error', () => socket.destroy());
    } catch { /* port not in use — skip */ }
  }

  // Give the OS a moment to release the ports
  await new Promise((r) => setTimeout(r, 1000));
  console.log('✅ Stale servers killed — Playwright will restart them with migrated DB');
}
