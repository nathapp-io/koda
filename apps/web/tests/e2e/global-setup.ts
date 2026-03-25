import { execSync } from 'child_process';

const API_PORT = process.env['E2E_API_PORT'] ?? '3102';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '3103';

/**
 * Kill any process occupying the E2E ports before Playwright starts.
 * This ensures reuseExistingServer:false works correctly — no stale servers
 * can block the port and cause Playwright to skip server startup entirely.
 */
export default async function globalSetup() {
  console.log('\n🎭 E2E Global Setup — clearing ports ' + API_PORT + '/' + WEB_PORT);

  for (const port of [API_PORT, WEB_PORT]) {
    try {
      const output = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' });
      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        console.log(`  Killing PID ${pid} on port ${port}`);
        try { execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    } catch {
      // No process on port — OK
    }
  }

  // Also kill any stray Nest/Nuxt dev servers that might not be on the port
  try { execSync('pkill -9 -f "nest start" 2>/dev/null', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -9 -f "nuxt dev" 2>/dev/null', { stdio: 'ignore' }); } catch {}

  console.log('  Ports clear. Playwright will start fresh servers with migrated+seeded DB.');
}
