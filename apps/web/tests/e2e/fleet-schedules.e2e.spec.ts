import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { deleteSchedules, fireSchedule, getSchedule } from './fixtures/fleet-schedules-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1b slice 3b (spec §3.5, plan D225): a schedule created in the web fires (through the test-only hook, D213),
 * a scripted runner completes its job with every story passed, and the schedule shows itself disabled with
 * `completed`. Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

test.describe('Fleet schedules (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);
  const feature = `sch-${suffix}`;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-schedule-runner-${suffix}`);
    await deleteSchedules(token, SLUG);
  });

  // A schedule left enabled would keep a template around for later runs of the suite.
  test.afterAll(async () => {
    if (!token) return;
    await deleteSchedules(token, SLUG);
  });

  test('create in the web, fire, the run completes, the schedule disables itself as completed', async ({ page }) => {
    test.setTimeout(120_000);
    await webLogin(page);

    // 1. Create: a yearly cron in UTC, so the real 60 s ticker never fires it on its own (D225).
    await page.goto(`/${SLUG}/fleet/schedules`);
    await waitForHydration(page);
    await page.getByTestId('fleet-schedule-create').click();
    await page.getByTestId('fleet-schedule-name').fill(`nightly ${suffix}`);
    await page.getByTestId('fleet-schedule-repo').selectOption({ label: 'acme/e2e-app' });
    await page.getByTestId('fleet-schedule-feature').fill(feature);
    await page.getByTestId('fleet-schedule-cron').fill('0 3 1 1 *');
    await page.getByTestId('fleet-schedule-timezone').fill('UTC');
    await page.getByTestId('fleet-schedule-max-cost').fill('3');
    await page.getByTestId('fleet-schedule-placement').selectOption('pin');
    await page.getByTestId('fleet-schedule-pin').selectOption(runner.id);
    await page.getByTestId('fleet-schedule-submit').click();

    const row = page.locator('[data-testid^="fleet-schedule-row-"]').filter({ hasText: feature });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('fleet-schedule-status')).toHaveAttribute('data-status', 'enabled');
    const scheduleId = ((await row.getAttribute('data-testid')) ?? '').replace('fleet-schedule-row-', '');
    expect(scheduleId).not.toBe('');

    // 2. Open the schedule. Since S1.5 1b (D246) the tab shares one project EventSource, opened by
    // the header badge on the list page, so no fresh /events response fires on this navigation:
    // the detail page just subscribes to the already-open stream on mount.
    await row.getByTestId('fleet-schedule-link').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/schedules/${scheduleId}$`));
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-schedule-history-empty')).toBeVisible();

    // 3. Fire it: one RUN pinned to the scripted runner.
    await runner.heartbeat();
    const fired = await fireSchedule(token, scheduleId);
    expect(fired.result.dispatched).toBe(1);
    const jobId = (await getSchedule(token, SLUG, scheduleId)).lastJobId ?? '';
    expect(jobId).not.toBe('');

    // 4. The runner works the job; the history row follows it live.
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
    const run = page.getByTestId(`fleet-schedule-run-${jobId}`);
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'RUNNING', { timeout: 10_000 });

    // 5. Every story passes and nax's finish opens a PR: COMPLETED.
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${jobId}`);
    await runner.report(lease, [
      {
        type: 'snapshot',
        payload: {
          progress: { total: 2, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 0 },
          finishResult: 'opened', resultBranch: `feat/${feature}`,
          resultPrUrl: 'https://github.com/acme/e2e-app/pull/11', costSpentUsd: '0.9000',
        },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);

    // 6. The detail page shows the finished run and the schedule disabled as completed (S1b §3.3 rule 1).
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'COMPLETED', { timeout: 10_000 });
    await expect(run.getByTestId('fleet-schedule-run-stories')).toContainText('2/2');
    await expect(page.getByTestId('fleet-schedule-status')).toHaveAttribute('data-status', 'completed', { timeout: 10_000 });
    await expect(page.getByTestId('fleet-schedule-total-cost')).toHaveText('$0.90');
    expect((await getSchedule(token, SLUG, scheduleId)).disabledReason).toBe('completed');

    // 7. The job page links back to the schedule.
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-schedule-link')).toHaveAttribute('href', `/${SLUG}/fleet/schedules/${scheduleId}`);
  });
});
