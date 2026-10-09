import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { bashAsk, jobApprovals } from './fixtures/fleet-approvals-api';
import { dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1.5 slice 2b (plan D305, spec §7 E2E (2) and (3)): a relay-capable scripted runner raises bash asks for an
 * escalate job. (2) A human allows one from the inbox and the runner receives the answer; (3) an unanswered ask expires.
 * API polls stay at one request per 2 s: the global throttle is 100 requests a minute (only /fleet/runner/* is exempt).
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

test.describe('Fleet bash approvals (scripted relay runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-relay-runner-${suffix}`, { relay: true });
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  async function startEscalateJob(feature: string, approvalTimeoutSec: number): Promise<{ jobId: string; lease: Lease }> {
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id, bashMode: 'escalate', approvalTimeoutSec });
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    return { jobId, lease };
  }

  async function finish(lease: Lease, feature: string, pr: number): Promise<void> {
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${lease.jobId}`);
    await runner.report(lease, [
      { type: 'snapshot', payload: { finishResult: 'opened', resultBranch: `feat/${feature}`, resultPrUrl: `https://github.com/acme/e2e-app/pull/${pr}`, costSpentUsd: '0.1000' } },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
  }

  test('(2) an escalate ask is allowed in the web, delivered to the runner, and the job completes', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `bash-allow-${suffix}`;
    const { jobId, lease } = await startEscalateJob(feature, 600);
    const ask = bashAsk({ featureName: feature });
    await runner.report(lease, [{ type: 'approval_request', payload: ask }]);
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId)).filter((a) => a.status === 'pending').length, { timeout: 20_000, ...POLL }).toBe(1);
    const [approval] = await jobApprovals(token, SLUG, jobId);

    // The jobs list marks the job; the job page calls it out and Review opens the inbox row.
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    await expect(page.getByTestId(`fleet-job-needs-approval-${jobId}`)).toBeVisible();
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-approval-callout')).toContainText('1');
    await page.getByTestId('fleet-job-approval-review').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/approvals\\?id=${approval.id}$`));
    await waitForHydration(page);

    // The row shows the masked command, the masked note and the countdown; Allow once decides it.
    const row = page.getByTestId(`fleet-approval-row-${approval.id}`);
    await expect(row.getByTestId('fleet-approval-bash-command')).toHaveText(ask.command);
    await expect(row.getByTestId('fleet-approval-bash-masked')).toBeVisible();
    await expect(row.getByTestId('fleet-approval-countdown')).toBeVisible();
    await row.getByTestId('fleet-approval-bash-allow').click();
    await expect(row.getByTestId('fleet-approval-outcome-decision')).toContainText('Allowed once');
    await expect(row.getByTestId('fleet-approval-outcome-delivery')).toHaveAttribute('data-delivery', 'waiting');

    // The runner receives exactly the human's answer and acks it; the reloaded row reads delivered.
    const answer = await runner.takeCommand('APPROVAL_ANSWER', jobId, { result: 'ok' });
    expect(answer.payload).toEqual({ approvalId: approval.id, naxAskId: ask.naxAskId, choice: 'allow' });
    await page.reload();
    await waitForHydration(page);
    await expect(row.getByTestId('fleet-approval-outcome-delivery')).toHaveAttribute('data-delivery', 'delivered', { timeout: 10_000 });

    // The job completes; its page lists the ask as approved and the timeline shows it was requested.
    await finish(lease, feature, 21);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId(`fleet-job-approval-${approval.id}`)).toHaveAttribute('data-status', 'approved');
    await expect(page.getByTestId('fleet-job-approval-callout')).toHaveCount(0);
    await expect(page.getByTestId('fleet-job-timeline')).toContainText(`Approval requested: ${ask.command}`);
  });

  test('(3) an unanswered ask times out: buttons disappear at 0, the row expires, no answer reaches the runner', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `bash-expire-${suffix}`;
    const { jobId, lease } = await startEscalateJob(feature, 60);
    // expiresAt = min(nax deadline, requestedAt + 60 s): the 35 s deadline wins, leaving time to load the page first.
    const ask = bashAsk({ featureName: feature, deadlineAt: new Date(Date.now() + 35_000).toISOString() });
    await runner.report(lease, [{ type: 'approval_request', payload: ask }]);
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId)).length, { timeout: 10_000, ...POLL }).toBe(1);
    const [approval] = await jobApprovals(token, SLUG, jobId);

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/approvals?id=${approval.id}`);
    await waitForHydration(page);
    const row = page.getByTestId(`fleet-approval-row-${approval.id}`);
    await expect(row.getByTestId('fleet-approval-bash-deny')).toBeVisible();
    // At 0 the panel stops offering a decision (D292). The expiry sweep may already have replaced the panel with the
    // outcome (its live notice re-fetches the row), so either end state is accepted here.
    await expect(row.getByTestId('fleet-approval-bash-deny')).toHaveCount(0, { timeout: 45_000 });
    await expect(row.getByTestId('fleet-approval-bash-countdown').or(row.getByTestId('fleet-approval-outcome-decision'))).toBeVisible();

    // The sweeper (FLEET_APPROVAL_SWEEP_MS, 2 s in e2e) marks it expired; the reloaded row reads Expired, Timed out.
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId))[0]?.status, { timeout: 45_000, ...POLL }).toBe('expired');
    await page.reload();
    await waitForHydration(page);
    await expect(row).toHaveAttribute('data-status', 'expired');
    await expect(row.getByTestId('fleet-approval-outcome-decision')).toContainText('Timed out');
    expect((await runner.commandsFor(jobId)).filter((c) => c.type === 'APPROVAL_ANSWER')).toEqual([]);

    await finish(lease, feature, 22);
  });
});
