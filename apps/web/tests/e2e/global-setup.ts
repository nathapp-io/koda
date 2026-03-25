/**
 * Global setup — runs once before all E2E tests.
 *
 * Ports are dynamically assigned by playwright.config.ts (OS picks free ports),
 * so no port cleanup is needed here. The webServer command deletes + re-creates
 * the E2E database on every run for a guaranteed clean slate.
 */
export default async function globalSetup() {
  const apiUrl = process.env['E2E_API_URL'] ?? '(unknown)';
  const webUrl = process.env['E2E_WEB_URL'] ?? '(unknown)';
  console.log(`\n🎭 E2E Global Setup`);
  console.log(`   API : ${apiUrl}`);
  console.log(`   Web : ${webUrl}`);
}
