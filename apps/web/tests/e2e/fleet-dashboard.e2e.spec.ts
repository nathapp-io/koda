import { test, expect } from '@playwright/test';
import { createProject, deleteProject, login, E2E_ADMIN } from './fixtures/api-client';
import { call, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { generateUniqueProjectKey, waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';
import type { Lease } from './fixtures/scripted-runner';

/**
 * Fleet S2b (c) slice 2 (spec §5 E2E, D426): a scripted runner keeps syncing (stays online) while it holds a RUNNING
 * job whose nax heartbeat is 15 minutes old, and a second job waits QUEUED with a selector label no runner has. The
 * admin overview shows both attention items; the project overview of a fresh project shows neither job. Every
 * assertion keys on this run's job ids, so other specs' data and retries cannot change it.
 * API polls stay at one request per 2 s (the global throttle is 100 a minute; /fleet/runner/* is exempt).
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

interface Snapshot {
  attention: Array<{ key: string; severity: string }>;
}

test.describe('Fleet dashboard (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);
  const otherSlug = `dash-other-${suffix}`;
  const silentFeature = `dash-silent-${suffix}`;
  const queuedFeature = `dash-queued-${suffix}`;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-dashboard-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
    await createProject(token, { name: `Dashboard other ${suffix}`, slug: otherSlug, key: generateUniqueProjectKey('DO') });
  });

  test.afterAll(async () => {
    await deleteProject(token, otherSlug).catch(() => undefined);
  });

  test('a silent running job and an unplaceable queued job show on the admin overview, and not on another project', async ({ page }) => {
    test.setTimeout(120_000);
    await runner.heartbeat();
    const silentId = await dispatchRun(token, SLUG, { repoId, feature: silentFeature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease: Lease = await runner.acceptAssign(silentId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      {
        type: 'snapshot',
        payload: { heartbeatAt: new Date(Date.now() - 15 * 60_000).toISOString(), currentStoryId: 'US-001', currentPhase: 'run' },
      },
    ]);
    const queued = await call<{ job: { id: string } }>('POST', `/projects/${SLUG}/fleet/jobs`, token, {
      command: 'RUN', repoId, feature: queuedFeature, maxCostUsd: 1, selectorLabels: ['e2e-dashboard-nowhere'],
    });
    const queuedId = queued.job.id;
    // D426: an offline runner's jobs are reported on the runner item instead, so keep this runner syncing.
    const keepAlive = setInterval(() => { void runner.heartbeat().catch(() => undefined); }, 5_000);

    try {
      const ours = (snap: Snapshot): string[] =>
        snap.attention.map((a) => a.key).filter((k) => k.endsWith(`:${silentId}`) || k.endsWith(`:${queuedId}`)).sort();
      await expect.poll(async () => ours(await call<Snapshot>('GET', '/fleet/dashboard', token)), { timeout: 45_000, ...POLL })
        .toEqual([`job_silent:${silentId}`, `job_unplaceable:${queuedId}`].sort());

      await webLogin(page);
      await page.goto('/admin/fleet');
      await waitForHydration(page);
      const silent = page.locator(`[data-testid="fleet-dashboard-attention-item"][data-key="job_silent:${silentId}"]`);
      await expect(silent).toHaveAttribute('data-severity', 'error', { timeout: 15_000 });
      await expect(silent).toContainText(silentFeature);
      await expect(silent).toContainText('No heartbeat for');
      await expect(page.locator(`[data-testid="fleet-dashboard-attention-item"][data-key="job_unplaceable:${queuedId}"]`)).toContainText(queuedFeature);
      await expect(page.locator(`[data-testid="fleet-dashboard-active-row"][data-job="${silentId}"]`)).toContainText('US-001');
      await expect(page.locator(`[data-testid="fleet-dashboard-runner"][data-runner="${runner.id}"]`)).toHaveAttribute('data-online', 'true');

      await page.goto(`/${SLUG}/fleet/overview`);
      await waitForHydration(page);
      await expect(page.locator(`[data-testid="fleet-dashboard-attention-item"][data-key="job_silent:${silentId}"]`)).toBeVisible({ timeout: 15_000 });

      await page.goto(`/${otherSlug}/fleet/overview`);
      await waitForHydration(page);
      await expect(page.getByTestId('fleet-dashboard-tiles')).toBeVisible({ timeout: 15_000 });
      const html = await page.getByTestId('fleet-dashboard').innerHTML();
      for (const leak of [silentId, queuedId, silentFeature, queuedFeature]) expect(html).not.toContain(leak);
    } finally {
      clearInterval(keepAlive);
      await call('POST', `/projects/${SLUG}/fleet/jobs/${queuedId}/cancel`, token).catch(() => undefined);
      await runner.report(lease, [
        { type: 'state', payload: { to: 'UPLOADING' } },
        { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
      ]).catch(() => undefined);
    }
  });
});
