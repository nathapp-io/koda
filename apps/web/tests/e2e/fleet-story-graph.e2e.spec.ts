import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';
import type { Lease } from './fixtures/scripted-runner';

/**
 * Fleet S2b (j) slice 2 (spec §3 E2E, D447): a pinned RUN job reports a five-story PRD (diamond US-001 -> US-002,
 * US-003 -> US-004, plus the isolated root US-005) with US-002 in progress and acceptance running. The job page draws
 * the graph and the strip; a second snapshot moves the run on and the page follows without a navigation.
 * Every locator is scoped to this job's page, so other specs' data cannot change it.
 */
const SLUG = 'fleet-e2e';

const story = (id: string, status: string, dependsOn: string[] = [], attempts = 0) =>
  ({ id, title: `Story ${id}`, status, attempts, dependsOn });

test.describe('Fleet story graph (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);
  const feature = `graph-${suffix}`;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-graph-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  test('graph, strip, focus highlight, toggle, and a live status change', async ({ page }) => {
    test.setTimeout(120_000);
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease: Lease = await runner.acceptAssign(jobId);

    try {
      await runner.report(lease, [
        { type: 'state', payload: { to: 'RUNNING' } },
        {
          type: 'snapshot',
          payload: {
            heartbeatAt: new Date().toISOString(), currentStoryId: 'US-002', currentPhase: 'implement',
            stories: [
              story('US-001', 'passed', [], 1),
              story('US-002', 'in-progress', ['US-001'], 1),
              story('US-003', 'pending', ['US-001']),
              story('US-004', 'pending', ['US-002', 'US-003']),
              story('US-005', 'pending'),
            ],
            postRun: { acceptance: 'running' },
          },
        },
      ]);

      await webLogin(page);
      await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
      await waitForHydration(page);

      const node = (id: string) => page.locator(`[data-testid="fleet-story-node"][data-story="${id}"]`);
      await expect(page.getByTestId('fleet-story-graph')).toBeVisible({ timeout: 15_000 });
      for (const [id, column] of [['US-001', '0'], ['US-005', '0'], ['US-002', '1'], ['US-003', '1'], ['US-004', '2']]) {
        await expect(node(id)).toHaveAttribute('data-column', column);
      }
      await expect(node('US-002')).toHaveAttribute('data-current', 'true');
      await expect(node('US-002')).toHaveAttribute('aria-current', 'step');
      await expect(node('US-004')).toHaveAttribute('aria-label', /Depends on US-002, US-003/);

      // D431: edges are measured after mount; four dependencies, four paths.
      await expect(page.getByTestId('fleet-story-edge')).toHaveCount(4);

      const stage = (key: string) => page.locator(`[data-testid="fleet-pipeline-stage"][data-stage="${key}"]`);
      await expect(stage('stories')).toHaveAttribute('data-state', 'running');
      await expect(stage('acceptance')).toHaveAttribute('data-state', 'running');
      await expect(stage('regression')).toHaveAttribute('data-state', 'pending');
      await expect(stage('finish')).toHaveAttribute('data-state', 'pending');

      // Focus highlights the node's own edges only.
      await node('US-004').focus();
      await expect(page.locator('[data-testid="fleet-story-edge"][data-active="true"]')).toHaveCount(2);
      await expect(node('US-005')).toHaveAttribute('data-emphasis', 'dim');
      await node('US-004').blur();

      // Toggle to List and back.
      await page.getByTestId('fleet-story-view-list').click();
      await expect(page.getByTestId('fleet-story-graph')).toHaveCount(0);
      await expect(page.locator('[data-testid="fleet-job-story"][data-story="US-004"]')).toContainText('Depends on US-002, US-003');
      await page.getByTestId('fleet-story-view-graph').click();
      await expect(page.getByTestId('fleet-story-graph')).toBeVisible();

      // Live: the next snapshot moves the run on; the page updates in place.
      await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      await runner.report(lease, [
        {
          type: 'snapshot',
          payload: {
            heartbeatAt: new Date().toISOString(), currentStoryId: 'US-003', currentPhase: 'implement',
            stories: [
              story('US-001', 'passed', [], 1),
              story('US-002', 'passed', ['US-001'], 1),
              story('US-003', 'in-progress', ['US-001'], 1),
              story('US-004', 'pending', ['US-002', 'US-003']),
              story('US-005', 'pending'),
            ],
            postRun: { acceptance: 'passed' },
          },
        },
      ]);
      await expect(node('US-002')).toHaveAttribute('data-status', 'passed', { timeout: 15_000 });
      await expect(node('US-003')).toHaveAttribute('data-current', 'true');
      await expect(node('US-002')).toHaveAttribute('data-current', 'false');
      await expect(stage('acceptance')).toHaveAttribute('data-state', 'passed');
      await expect(page.getByTestId('fleet-story-edge')).toHaveCount(4);
      expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    } finally {
      await runner.report(lease, [
        { type: 'state', payload: { to: 'UPLOADING' } },
        { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
      ]).catch(() => undefined);
    }
  });
});
