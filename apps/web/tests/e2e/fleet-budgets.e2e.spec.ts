import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { deleteOwnPolicies, dispatchRun, listPolicies, monthSpendUsd, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1b slice 2b (plan D189): budgets in the web. A project policy is created in the UI, a scripted
 * runner spends past it, the banner appears on the jobs list, and a resume with a raised limit clears it.
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

/** Two decimals, so float dust from summing policy spend never reaches an amount input. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

test.describe('Fleet budgets (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);
  const feature = `bud-${suffix}`;

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-budget-runner-${suffix}`);
    await deleteOwnPolicies(token, SLUG);
  });

  // A paused project policy left behind would block the dispatch e2e that runs after this file.
  test.afterAll(async () => {
    if (!token) return;
    await deleteOwnPolicies(token, SLUG);
  });

  test('a limit passed by a running job pauses the project: banner, then resume with a raised limit', async ({ page }) => {
    test.setTimeout(120_000);
    await webLogin(page);

    // 1. Create a $0.50 monthly project policy in the UI. The amount rides $0.50 above the window's
    // existing spend ($0 on a clean database, where the numbers are exactly the slice 2b plan's), so
    // fleet specs that ran earlier in the same run (they share the calendar-month window) cannot
    // make the fresh policy born over-limit.
    const priorSpend = await monthSpendUsd(token, SLUG);
    await page.goto(`/${SLUG}/fleet/budgets`);
    await waitForHydration(page);
    await page.getByTestId('fleet-budget-create').click();
    await page.getByTestId('fleet-budget-scope-type').selectOption('project');
    await page.getByTestId('fleet-budget-amount').fill((round2(priorSpend) + 0.5).toFixed(2));
    await page.getByTestId('fleet-budget-submit').click();
    const rows = page.getByTestId('fleet-budgets-own').locator('[data-testid^="fleet-budget-row-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-status', 'ok');

    // 2. A scripted runner starts a job and reports $0.60 spent: over the limit.
    const repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease: Lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'snapshot', payload: { costSpentUsd: '0.6000', heartbeatAt: new Date().toISOString() } },
    ]);

    // 3. The evaluator runs about a second after the sync: wait on the API, not on a sleep.
    await expect
      .poll(async () => (await listPolicies(token, SLUG)).some((p) => p.scopeType === 'project' && p.paused), { timeout: 20_000 })
      .toBe(true);

    // 4. The jobs list shows the banner.
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    const banner = page.getByTestId('fleet-budget-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId('fleet-budget-banner-line')).toHaveAttribute('data-status', 'paused');
    await expect(banner).toContainText(`$${(round2(priorSpend) + 0.6).toFixed(2)} of $${(round2(priorSpend) + 0.5).toFixed(2)}`);

    // 5. Follow the banner link and resume with a raised limit.
    await banner.getByTestId('fleet-budget-banner-link').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/budgets$`));
    await waitForHydration(page);
    await expect(rows.first()).toHaveAttribute('data-status', 'paused');
    await rows.first().getByTestId('fleet-budget-resume').click();
    await page.getByTestId('fleet-budget-resume-amount').fill((round2(priorSpend) + 2).toFixed(2));
    await page.getByTestId('fleet-budget-resume-submit').click();
    await expect(rows.first()).toHaveAttribute('data-status', 'ok');

    // 6. The banner is gone. Wait for the banner's own list request first: a count of 0 before the
    // load would pass for the wrong reason.
    const listLoaded = page.waitForResponse(
      (res) => res.url().includes(`/projects/${SLUG}/fleet/budgets`) && res.request().method() === 'GET' && res.status() === 200,
    );
    await page.goto(`/${SLUG}/fleet`);
    await listLoaded;
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-budget-banner')).toHaveCount(0);

    // 7. Finish the job so nothing stays active (same sequence as the dispatch e2e).
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${jobId}`);
    await runner.report(lease, [
      {
        type: 'snapshot',
        payload: {
          finishResult: 'opened', resultBranch: `feat/${feature}`,
          resultPrUrl: 'https://github.com/acme/e2e-app/pull/9', costSpentUsd: '0.6000',
        },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
  });

  test('a global admin adds and deletes a fleet-wide policy', async ({ page }) => {
    await webLogin(page);
    await page.goto('/admin/fleet/budgets');
    await waitForHydration(page);

    const rows = page.locator('[data-testid^="fleet-budget-row-"]');
    const before = await rows.count();

    await page.getByTestId('fleet-budget-create').click();
    // Pick Runner (mounts the target select), then back to Global (unmounts it, vee-validate unsets
    // scopeId): the form must still submit (D182 note).
    await page.getByTestId('fleet-budget-scope-type').selectOption('runner');
    await expect(page.getByTestId('fleet-budget-scope-id')).toBeVisible();
    await page.getByTestId('fleet-budget-scope-type').selectOption('global');
    await expect(page.getByTestId('fleet-budget-scope-id')).toHaveCount(0);
    await page.getByTestId('fleet-budget-window').selectOption('lifetime');
    await page.getByTestId('fleet-budget-amount').fill('1000');
    await page.getByTestId('fleet-budget-submit').click();

    await expect(rows).toHaveCount(before + 1);
    const created = rows.filter({ hasText: 'Whole fleet' }).filter({ hasText: 'Lifetime' });
    await expect(created).toHaveCount(1);

    page.once('dialog', (dialog) => { void dialog.accept(); });
    await created.getByTestId('fleet-budget-delete').click();
    await expect(rows).toHaveCount(before);
  });
});
