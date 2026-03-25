import { execSync } from 'child_process';

const API_PORT = process.env['E2E_API_PORT'] ?? '3102';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '3103';

/**
 * Clean up stale processes before Playwright starts its webServers.
 * In recent Playwright, webServers are started BEFORE globalSetup.
 * If we kill them here, the tests will fail with ERR_CONNECTION_REFUSED.
 */
export default async function globalSetup() {
  console.log('\n🎭 E2E Global Setup — verifying ports ' + API_PORT + '/' + WEB_PORT);
  
  // Do NOT kill. Just log who is on the port for debugging.
  for (const port of [API_PORT, WEB_PORT]) {
    try {
      const output = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' });
      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim();
        console.log(`  Port ${port} is active: PID ${pid} (${cmd})`);
      }
    } catch {}
  }
}
