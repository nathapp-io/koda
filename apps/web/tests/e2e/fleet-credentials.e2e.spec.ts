import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { call } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { E2E_RUNNER_CAPABILITIES, ScriptedRunner } from './fixtures/scripted-runner';

/**
 * Fleet S3 §8 E2E: a scripted runner reports an OAuth credential expiring in 3 days and a sandboxed profile it
 * cannot serve. The admin board shows the expiring cell and the profile misfit; the dashboard raises `expiring`.
 * Assertions key on this run's runner id, provider and profile names, so other specs' runners do not matter.
 */
test.describe('Fleet credential board (scripted runner)', () => {
  const suffix = Date.now().toString().slice(-6);
  const provider = `e2e-oauth-${suffix}`;
  const profile = `e2e-boxed-${suffix}`;
  let token = '';
  let runner: ScriptedRunner;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    const expires = new Date(Date.now() + 3 * 86_400_000).toISOString();
    runner = await ScriptedRunner.enroll(token, `e2e-credentials-runner-${suffix}`, {
      capabilities: {
        ...E2E_RUNNER_CAPABILITIES,
        sandbox: { available: false, probedAt: '2026-10-01T00:00:00.000Z' },
        profiles: { ...E2E_RUNNER_CAPABILITIES.profiles, [profile]: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
        credentials: [...E2E_RUNNER_CAPABILITIES.credentials, { providerId: provider, available: true, stored: { kind: 'oauth', expires, expired: false }, ambient: false }],
      },
    });
    await runner.heartbeat();
  });

  test('the grid shows the expiring credential and the profiles tab the sandbox misfit', async ({ page }) => {
    test.setTimeout(90_000);
    const snap = await call<{ attention: Array<{ subjectId: string; conditions?: Array<{ providerId?: string; why?: string }> }> }>('GET', '/fleet/dashboard', token);
    expect(snap.attention.find((a) => a.subjectId === runner.id)?.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: provider, why: 'expiring' })]));

    await webLogin(page);
    await page.goto('/admin/fleet/credentials');
    await waitForHydration(page);
    const cell = page.locator(`[data-testid="fleet-credentials-cell"][data-provider="${provider}"][data-runner="${runner.id}"]`);
    await expect(cell).toHaveAttribute('data-state', 'expiring', { timeout: 15_000 });
    await expect(cell).toContainText('Expiring');

    await page.getByTestId('fleet-credentials-tab-profiles').click();
    const profileCell = page.locator(`[data-testid="fleet-credentials-profile-cell"][data-profile="${profile}"][data-runner="${runner.id}"]`);
    await expect(profileCell).toHaveAttribute('data-misfit', 'sandbox');

    await page.goto('/admin/fleet');
    await waitForHydration(page);
    await page.getByTestId('fleet-dashboard-credentials-link').click();
    await expect(page).toHaveURL(/\/admin\/fleet\/credentials$/);
  });
});
