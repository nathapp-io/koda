/**
 * Global setup — runs once before all E2E tests.
 *
 * Ports are dynamically assigned by playwright.config.ts (OS picks free ports),
 * so no port cleanup is needed here. The webServer command deletes + re-creates
 * the E2E database on every run for a guaranteed clean slate.
 */
export default async function globalSetup() {
  const apiUrl = process.env['E2E_API_URL'];
  const webUrl = process.env['E2E_WEB_URL'];

  if (!apiUrl || !webUrl) {
    throw new Error('Missing E2E_API_URL or E2E_WEB_URL in Playwright worker environment');
  }

  const [apiHealth, webHealth] = await Promise.all([
    fetch(`${apiUrl}/api/health`).catch(() => null),
    fetch(webUrl).catch(() => null),
  ]);

  if (!apiHealth || !apiHealth.ok) {
    throw new Error(`E2E API health check failed at ${apiUrl}/api/health`);
  }

  if (!webHealth || !webHealth.ok) {
    throw new Error(`E2E web health check failed at ${webUrl}`);
  }

  console.log(`\n🎭 E2E Global Setup`);
  console.log(`   API : ${apiUrl}`);
  console.log(`   Web : ${webUrl}`);
}
