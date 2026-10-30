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
 *
 * Permissions P3b US-007 moved the surfaces these journeys drive onto the approval engine: the job page's Review
 * callout and the job page's own rows read `GET /approvals?jobId=`, and the inbox they open is `/[project]/approvals`
 * (`approval-request-*` testids). The fixtures still read the fleet view for the ask's id and status, which is the same
 * `ApprovalRequest` row (`toFleetApproval` answers `request.id`), so a settled ask is asserted through the engine's
 * status on the page.
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };
/** The engine settles an approved ask as `executed` (its `approved` step is skipped); either reads as settled. */
const SETTLED = /^(approved|executed)$/;

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

    // The jobs list marks the job; the job page calls it out, previews the command from the engine detail and
    // Review opens the engine inbox row.
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    await expect(page.getByTestId(`fleet-job-needs-approval-${jobId}`)).toBeVisible();
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-approval-callout')).toContainText('1');
    await expect(page.getByTestId(`fleet-job-approval-${approval.id}`)).toContainText(ask.command);
    await page.getByTestId('fleet-job-approval-review').click();
    await page.waitForURL(new RegExp(`/${SLUG}/approvals\\?id=${approval.id}$`));
    await waitForHydration(page);

    // The engine's bash panel shows the masked command, the masked note and the countdown; Allow once decides it.
    const row = page.getByTestId(`approval-request-row-${approval.id}`);
    const panel = row.getByTestId('approval-request-bash-panel');
    await expect(panel.getByTestId('approval-request-bash-command')).toHaveText(ask.command);
    await expect(panel.getByTestId('approval-request-bash-masked')).toBeVisible();
    await expect(panel.getByTestId('approval-request-bash-countdown')).toBeVisible();
    await panel.getByTestId('approval-request-bash-allow').click();

    // The decide response carries no engine details, so the outcome shows the settled status and no buttons yet.
    await expect(row.getByTestId('approval-request-outcome-status')).toBeVisible();
    await expect(panel.getByTestId('approval-request-bash-allow')).toHaveCount(0);

    // The runner receives exactly the human's answer and acks it; the row then reads delivered. The outcome
    // rides the engine's details, which the fleet-side subscriber writes a beat after the decision, so the read
    // is retried rather than assumed present on the first reload.
    const answer = await runner.takeCommand('APPROVAL_ANSWER', jobId, { result: 'ok' });
    expect(answer.payload).toEqual({ approvalId: approval.id, naxAskId: ask.naxAskId, choice: 'allow' });
    await expect.poll(async () => {
      await page.reload();
      await waitForHydration(page);
      return row.getByTestId('approval-request-outcome-delivery').getAttribute('data-delivery').catch(() => null);
    }, { timeout: 20_000, intervals: [2_000] }).toBe('delivered');

    // The job completes; its page lists the ask as settled and the timeline shows it was requested.
    await finish(lease, feature, 21);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    const jobRow = page.getByTestId(`fleet-job-approval-${approval.id}`);
    await expect(jobRow).toContainText(ask.command);
    await expect(jobRow).toHaveAttribute('data-status', SETTLED);
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
    await page.goto(`/${SLUG}/approvals?id=${approval.id}`);
    await waitForHydration(page);
    const row = page.getByTestId(`approval-request-row-${approval.id}`);
    await expect(row.getByTestId('approval-request-bash-deny')).toBeVisible();
    // At 0 the panel stops offering a decision (D292). The engine may already have re-read the row as settled,
    // so either end state is accepted here.
    await expect(row.getByTestId('approval-request-bash-deny')).toHaveCount(0, { timeout: 45_000 });
    await expect(row.getByTestId('approval-request-bash-countdown').or(row.getByTestId('approval-request-outcome-status'))).toBeVisible();

    // The sweeper (FLEET_APPROVAL_SWEEP_MS, 2 s in e2e) expires it; the reloaded row reads Expired.
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId))[0]?.status, { timeout: 45_000, ...POLL }).toBe('expired');
    await page.reload();
    await waitForHydration(page);
    await expect(row).toHaveAttribute('data-status', 'expired');
    await expect(row.getByTestId('approval-request-outcome-status')).toContainText('Expired');
    expect((await runner.commandsFor(jobId)).filter((c) => c.type === 'APPROVAL_ANSWER')).toEqual([]);

    await finish(lease, feature, 22);
  });
});
