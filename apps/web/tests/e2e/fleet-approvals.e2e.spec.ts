import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { createProjectPolicy, jobState, pendingBudgetApprovals } from './fixtures/fleet-approvals-api';
import { deleteOwnPolicies, dispatchRun, monthSpendUsd, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1.5 slice 1b (plan D254, spec §7 (1)): a budget hard stop raises an override; raise and resume from the
 * inbox re-queues the job the pause cancelled before it started, and that job runs again.
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 * The database is re-created per Playwright run but the calendar-month window is shared by the whole
 * fleet suite: the policy and the raised limit are therefore stated as headroom above the window's
 * existing spend, which is exactly D254's $0.50 / $2 on a clean window (see monthSpendUsd).
 */
const SLUG = 'fleet-e2e';

/** Two decimals, so float dust from summing policy spend never reaches an amount input. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

test.describe('Fleet approvals (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-approval-runner-${suffix}`);
    await deleteOwnPolicies(token, SLUG);
  });

  // Deleting the policy also closes any approval left pending (policy_deleted), so later specs start clean.
  test.afterAll(async () => {
    if (!token) return;
    await deleteOwnPolicies(token, SLUG);
  });

  test('hard stop -> raise and resume with re-queue -> the cancelled job runs again', async ({ page }) => {
    test.setTimeout(150_000);

    // 1. A $0.50 project policy; job A runs on the scripted runner, job B waits QUEUED behind it.
    // The policy rides $0.50 above the month's existing spend ($0 on a clean database, where the
    // numbers are exactly plan D254's), so earlier fleet specs' spend in the same calendar window
    // does not make the fresh policy born over-limit.
    const priorSpend = await monthSpendUsd(token, SLUG);
    await createProjectPolicy(token, SLUG, round2(priorSpend + 0.5));
    const repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
    await runner.heartbeat();
    const jobA = await dispatchRun(token, SLUG, { repoId, feature: `appr-a-${suffix}`, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const leaseA: Lease = await runner.acceptAssign(jobA);
    // Every sync after acceptAssign reports freeSlots 0, so B is never assigned before the stop.
    const jobB = await dispatchRun(token, SLUG, { repoId, feature: `appr-b-${suffix}`, maxCostUsd: 3, pinnedRunnerId: runner.id });

    // 2. A reports $0.60: over the limit. The hard stop pauses the project, cancels B and raises the override.
    await runner.report(leaseA, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'snapshot', payload: { costSpentUsd: '0.6000', heartbeatAt: new Date().toISOString() } },
    ]);
    await expect.poll(async () => (await pendingBudgetApprovals(token, SLUG)).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => jobState(token, SLUG, jobB), { timeout: 20_000 }).toBe('CANCELLED');
    const [approval] = await pendingBudgetApprovals(token, SLUG);

    // 3. The banner on the jobs list leads to the override; the header badge counts it.
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    const badge = page.getByTestId('fleet-approval-badge');
    await expect(badge).toBeVisible();
    const before = Number(await badge.getAttribute('data-count'));
    expect(before).toBeGreaterThanOrEqual(1);
    await page.getByTestId('fleet-budget-banner-review').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/approvals\\?id=${approval.id}$`));
    await waitForHydration(page);

    // 4. The row is open with B offered and ticked; raise to $2 above the window's opening spend
    // ($2 on a clean database), always above the spend at decide time.
    const row = page.getByTestId(`fleet-approval-row-${approval.id}`);
    await expect(row.getByTestId('fleet-approval-budget-panel')).toBeVisible();
    await expect(row.getByTestId(`fleet-approval-candidate-${jobB}`)).toBeChecked();
    await row.getByTestId('fleet-approval-amount').fill((round2(priorSpend) + 2).toFixed(2));
    await row.getByTestId('fleet-approval-raise').click();

    // 5. The outcome shows B re-queued; the badge drops by one (at 0 it is not rendered at all).
    await expect(row.getByTestId(`fleet-approval-requeue-result-${jobB}`)).toHaveAttribute('data-ok', 'true');
    if (before === 1) {
      await expect(badge).toHaveCount(0, { timeout: 10_000 });
    } else {
      await expect(badge).toHaveAttribute('data-count', String(before - 1), { timeout: 10_000 });
    }
    expect(await jobState(token, SLUG, jobB)).toBe('QUEUED');

    // 6. A finishes; B is assigned again and runs.
    await runner.report(leaseA, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(leaseA, `bundle of ${jobA}`);
    await runner.report(leaseA, [
      { type: 'snapshot', payload: { finishResult: 'opened', resultBranch: `feat/appr-a-${suffix}`, resultPrUrl: 'https://github.com/acme/e2e-app/pull/11', costSpentUsd: '0.6000' } },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
    const leaseB: Lease = await runner.acceptAssign(jobB);
    await runner.report(leaseB, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    await page.goto(`/${SLUG}/fleet/jobs/${jobB}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'RUNNING');

    // 7. Finish B so nothing stays active for the specs that follow.
    await runner.report(leaseB, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(leaseB, `bundle of ${jobB}`);
    await runner.report(leaseB, [
      { type: 'snapshot', payload: { finishResult: 'opened', resultBranch: `feat/appr-b-${suffix}`, resultPrUrl: 'https://github.com/acme/e2e-app/pull/12', costSpentUsd: '0.1000' } },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
  });
});
