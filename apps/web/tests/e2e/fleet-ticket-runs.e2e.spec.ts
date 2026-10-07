import { test, expect } from '@playwright/test';
import { createTicket, login, E2E_ADMIN } from './fixtures/api-client';
import { call, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';

/**
 * Fleet C9 slice 2 (spec §6 E2E, D461): Dispatch from a ticket prefills the ticket and the feature; a second ticket
 * is added in the picker; the RUN moves both tickets to IN_PROGRESS; the finished job shows in the ticket's Fleet
 * runs card with its PR, which is also a "via fleet" PR link. A second job fails live on an open ticket page with
 * its reason and a failure comment, and Unlink removes it. Every locator is scoped to this spec's own tickets/jobs.
 */
const SLUG = 'fleet-e2e';

test.describe('Fleet runs on tickets (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-tickets-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  test('Dispatch from a ticket, two tickets start, the finished job and its PR show on the ticket', async ({ page }) => {
    test.setTimeout(120_000);
    const a = await createTicket(token, SLUG, { title: `Login fails ${suffix}`, type: 'BUG' });
    const b = await createTicket(token, SLUG, { title: `Session expiry ${suffix}`, type: 'BUG' });

    await webLogin(page);
    await page.goto(`/${SLUG}/tickets/${a.ref}`);
    await waitForHydration(page);
    await page.getByTestId('ticket-fleet-dispatch').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/dispatch\\?`));
    await waitForHydration(page);

    await expect(page.getByTestId('dispatch-prefilled')).toBeVisible();
    await expect(page.getByTestId('dispatch-command')).toHaveValue('PLAN');
    await expect(page.getByTestId('dispatch-feature')).toHaveValue(`${a.ref.toLowerCase()}-login-fails-${suffix}`);
    await expect(page.getByTestId('dispatch-tickets-item')).toHaveCount(1);
    await expect(page.getByTestId('dispatch-tickets-item').first()).toHaveAttribute('data-ref', a.ref);

    // Typed in lower case: the picker normalizes it (D450).
    await page.getByTestId('dispatch-tickets-input').fill(b.ref.toLowerCase());
    await page.getByTestId('dispatch-tickets-input').press('Enter');
    await expect(page.getByTestId('dispatch-tickets-item')).toHaveCount(2);

    // A RUN pinned to the scripted runner, so the dispatch moves both tickets (D452).
    await page.getByTestId('dispatch-command').selectOption('RUN');
    await page.getByTestId('dispatch-repo').selectOption({ label: 'acme/e2e-app' });
    await page.getByTestId('dispatch-max-cost').fill('3');
    await page.getByTestId('placement-pin').click();
    await page.getByTestId('dispatch-pin').selectOption(runner.id);
    await runner.heartbeat();
    await page.getByTestId('dispatch-submit').click();
    await expect(page.getByTestId('placement-assigned')).toContainText(runner.name);

    await page.getByTestId('placement-open-job').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
    await waitForHydration(page);
    const jobId = page.url().split('/').pop() ?? '';
    await expect(page.getByTestId('fleet-job-ticket')).toHaveCount(2);
    for (const t of [a, b]) {
      const ticket = await call<{ status: string }>('GET', `/projects/${SLUG}/tickets/${t.ref}`, token);
      expect(ticket.status).toBe('IN_PROGRESS');
    }

    const prUrl = 'https://github.com/acme/e2e-app/pull/41';
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'state', payload: { to: 'UPLOADING' } },
      {
        type: 'snapshot',
        payload: { finishResult: 'opened', resultBranch: `feat/tickets-${suffix}`, resultSha: 'abcdef1234567', resultPrUrl: prUrl, costSpentUsd: '0.5000' },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);

    await page.goto(`/${SLUG}/tickets/${a.ref}`);
    await waitForHydration(page);
    const run = page.locator(`[data-testid="ticket-fleet-run"][data-job="${jobId}"]`);
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'COMPLETED', { timeout: 15_000 });
    await expect(run.getByTestId('ticket-fleet-run-branch')).toHaveText(`feat/tickets-${suffix} (abcdef1)`);
    await expect(run.getByTestId('ticket-fleet-run-pr-state')).toHaveAttribute('data-state', 'open');
    await expect(run.getByTestId('ticket-fleet-run-cost')).toHaveText('$0.50');
    await expect(page.getByTestId('ticket-link-via-fleet')).toHaveCount(1);
  });

  test('a job fails live on an open ticket page with its reason and comment; Unlink removes it', async ({ page }) => {
    test.setTimeout(90_000);
    const t = await createTicket(token, SLUG, { title: `Flaky export ${suffix}`, type: 'BUG' });
    await runner.heartbeat();
    const result = await call<{ job: { id: string } }>('POST', `/projects/${SLUG}/fleet/jobs`, token, {
      command: 'RUN', repoId, feature: `fail-${suffix}`, maxCostUsd: 3, pinnedRunnerId: runner.id, ticketRefs: [t.ref],
    });
    const jobId = result.job.id;

    await webLogin(page);
    await page.goto(`/${SLUG}/tickets/${t.ref}`);
    await waitForHydration(page);
    const run = page.locator(`[data-testid="ticket-fleet-run"][data-job="${jobId}"]`);
    await expect(run).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      // Spec §5.4: a runner reports FAILED from UPLOADING only.
      { type: 'state', payload: { to: 'UPLOADING' } },
      { type: 'state', payload: { to: 'FAILED', reason: `acceptance failed ${suffix}`, exitCode: 1 } },
    ]);

    // Live (P3): the card follows the job's fleet_job events without a navigation.
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'FAILED', { timeout: 15_000 });
    await expect(run.getByTestId('ticket-fleet-run-reason')).toHaveText(`acceptance failed ${suffix}`);
    await expect(page.getByText(`ended FAILED: acceptance failed ${suffix}`).first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    await run.getByTestId('ticket-fleet-run-unlink').click();
    await page.getByTestId('ticket-fleet-run-unlink-confirm').click();
    await expect(page.getByTestId('ticket-fleet-runs')).toHaveCount(0, { timeout: 10_000 });
    expect(await call<unknown[]>('GET', `/projects/${SLUG}/tickets/${t.ref}/fleet-jobs`, token)).toEqual([]);
  });
});
