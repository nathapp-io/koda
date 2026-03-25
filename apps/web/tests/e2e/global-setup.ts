import { execSync } from 'child_process';

const API_PORT = process.env['E2E_API_PORT'] ?? '3102';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '3103';

/**
 * Clean up stale processes ONLY if they are not the ones Playwright just started.
 */
export default async function globalSetup() {
  console.log('\n🎭 E2E Global Setup — checking ports ' + API_PORT + '/' + WEB_PORT);

  // In most Playwright versions, globalSetup runs BEFORE webServer starts.
  // But if it runs after or in parallel, we need to be careful.
  // For now, let's just clear ports and let webServer handle the start.
  
  for (const port of [API_PORT, WEB_PORT]) {
    try {
      const output = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' });
      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        // Don't kill our own parent or current process
        if (pid === String(process.pid) || pid === String(process.ppid)) continue;
        
        console.log(`  Clearing stale PID ${pid} on port ${port}`);
        try { execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    } catch {}
  }

  console.log('  Ready for Playwright webServer startup.');
}
