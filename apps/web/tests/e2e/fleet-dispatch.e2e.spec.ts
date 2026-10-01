import { test, expect, type Page } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1 spec §12 E2E (D128): dispatch from the web, the job detail page follows the
 * job live to COMPLETED, and the bundle downloads. The runner is scripted over the real
 * sync protocol; project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

async function expectState(page: Page, state: string): Promise<void> {
  await expect(page.getByTestId('fleet-job-state').first()).toHaveAttribute('data-state', state, { timeout: 10_000 });
}

test.describe('Fleet dispatch (scripted runner)', () => {
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);
  const feature = `e2e-${suffix}`;

  test.beforeAll(async () => {
    const { token } = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    runner = await ScriptedRunner.enroll(token, `e2e-runner-${suffix}`);
  });

  test('dispatch, live progress to COMPLETED, bundle download', async ({ page }) => {
    // About 15 sequential steps against `nuxt dev`, each waiting on a sync or a live update.
    test.setTimeout(90_000);
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/dispatch`);
    await waitForHydration(page);

    // Native selects (4b D137): selectOption, never a portal click.
    await page.getByTestId('dispatch-repo').selectOption({ label: 'acme/e2e-app' });
    await page.getByTestId('dispatch-feature').fill(feature);
    await page.getByTestId('dispatch-max-cost').fill('3');
    await page.getByTestId('placement-pin').click();
    // By value: the label gains an "(offline)" suffix if the runner has gone quiet.
    await page.getByTestId('dispatch-pin').selectOption(runner.id);
    await runner.heartbeat();
    await page.getByTestId('dispatch-submit').click();

    await expect(page.getByTestId('placement-assigned')).toContainText(runner.name);

    // Open the job and wait for its live stream before the runner reports anything.
    const streamOpen = page.waitForResponse(
      (res) => res.url().includes(`/api/projects/${SLUG}/events`) && res.status() === 200,
      { timeout: 10_000 },
    );
    await page.getByTestId('placement-open-job').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
    await streamOpen;
    const jobId = page.url().split('/').pop() ?? '';
    await expectState(page, 'ASSIGNED');
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    const lease: Lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      {
        type: 'snapshot',
        payload: {
          naxRunId: `run-${suffix}`, currentStoryId: 'US-001', currentPhase: 'implement',
          progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 },
          costSpentUsd: '0.4200', heartbeatAt: new Date().toISOString(),
        },
      },
    ]);
    await expectState(page, 'RUNNING');
    await expect(page.getByTestId('fleet-job-story')).toHaveText('US-001');
    await expect(page.getByTestId('fleet-job-cost')).toContainText('$0.42');

    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${jobId}`);
    await runner.report(lease, [
      {
        type: 'snapshot',
        payload: {
          finishResult: 'opened', resultBranch: `feat/${feature}`,
          resultPrUrl: 'https://github.com/acme/e2e-app/pull/7', costSpentUsd: '0.9000',
        },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
    await expectState(page, 'COMPLETED');
    await expect(page.getByTestId('fleet-job-finish')).toHaveText('opened');
    await expect(page.getByTestId('fleet-job-pr')).toHaveAttribute('href', 'https://github.com/acme/e2e-app/pull/7');
    await expect(page.getByTestId('fleet-job-event').filter({ hasText: 'US-001' }).first()).toBeVisible();

    // Every update above arrived over SSE: the page never reloaded.
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    const download = page.waitForEvent('download');
    await page.getByTestId('fleet-job-bundle').click();
    expect((await download).suggestedFilename()).toBe(`koda-job-${jobId}.tar.gz`);

    // The jobs list shows the finished job.
    await page.goto(`/${SLUG}/fleet`);
    await expect(page.getByTestId(`fleet-job-row-${jobId}`).getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'COMPLETED');
  });
});
