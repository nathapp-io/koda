import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { call, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';

/**
 * Fleet S2b slice 2 (spec §6 E2E, D400): a scripted runner uploads a bundle for a RUN that ends COMPLETED. Ingest
 * corrects it to ESCALATED from its finish-audit, raises its cost to the ledger and records the breakdown; the job
 * page, the Analytics page and the admin ingest table show it. Only this spec uploads cost ledgers, and every
 * assertion keys on this run's unique feature name or job id, so other specs and retries cannot change them.
 * API polls stay at one request per 2 s (the global throttle is 100 a minute; /fleet/runner/* is exempt).
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

test.describe('Fleet analytics (scripted runner bundle)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);
  const feature = `analytics-${suffix}`;
  const runId = `run-e2e-${suffix}`;
  const prUrl = `https://github.com/acme/e2e-app/pull/${suffix}`;

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-analytics-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  /** A nax-out tree in the formats the slice 1a parsers read (cost ledger v8, metrics, review audit, finish audit). */
  function bundle(at: number): Record<string, string> {
    const iso = new Date(at).toISOString();
    const cost = (callId: string, stage: string, sessionRole: string, model: string, costUsd: number): string => JSON.stringify({
      ts: at, runId, projectKey: 'e2e', schemaVersion: 8, agentName: 'native', model, modelTier: 'fast', profile: 'koda-job-e2e',
      stage, sessionRole, featureName: feature, storyId: 'US-001', callId, scopeId: 's',
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      estimatedCostUsd: costUsd, exactCostUsd: costUsd, costUsd, confidence: 'exact', pricingSource: 'catalog', durationMs: 100,
    });
    return {
      'nax-out/status.json': JSON.stringify({ run: { id: runId, status: 'completed' } }),
      [`nax-out/cost/${runId}.jsonl`]: `${[
        cost('c1', 'run', 'implementer', 'm-e2e-a', 0.12),
        cost('c2', 'review', 'reviewer', 'm-e2e-b', 0.0134),
        cost('c3', 'run', 'test-writer', 'm-e2e-a', 0.00004),
      ].join('\n')}\n`,
      'nax-out/metrics.json': JSON.stringify([{
        runId, feature, totalCost: 0.13344,
        stories: [{
          storyId: 'US-001', attempts: 2, success: true, firstPassSuccess: false, cost: 0.13344, durationMs: 1000,
          startedAt: iso, completedAt: iso,
          tokens: { inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }],
      }]),
      [`nax-out/review-audit/${feature}/1-semantic.json`]: JSON.stringify({
        timestamp: iso, runId, storyId: 'US-001', reviewer: 'semantic', recordId: `rec-${suffix}`, passed: false, failOpen: false,
        result: { passed: false, findings: [{ severity: 'error' }] }, advisoryFindings: [],
      }),
      [`nax-out/finish-audit/${feature}/${runId}.result.json`]: JSON.stringify({
        feature, status: 'escalated', escalationReason: 'quality review omitted WALK', branch: `feat/${feature}`,
        headSha: 'abc1234', url: prUrl, rounds: [],
      }),
    };
  }

  test('an escalated finish shows as ESCALATED with its breakdown on the job, Analytics and admin pages', async ({ page }) => {
    test.setTimeout(150_000);
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadTarBundle(lease, bundle(Date.now() - 60_000));
    await runner.report(lease, [{ type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } }]);
    // D400: the upload's kick ran before the job was terminal; kick again now rather than wait for the 30 s sweeper.
    await call('POST', `/fleet/ingest/jobs/${jobId}/rerun`, token);
    await expect.poll(
      async () => (await call<{ ingest: { status: string } | null }>('GET', `/projects/${SLUG}/fleet/jobs/${jobId}/analytics`, token)).ingest?.status,
      { timeout: 45_000, ...POLL },
    ).toBe('done');

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'ESCALATED');
    await expect(page.getByTestId('fleet-job-pr')).toHaveAttribute('href', prUrl);
    await expect(page.getByTestId('fleet-job-analytics')).toBeVisible();
    await expect(page.getByTestId('fleet-job-analytics-corrected')).toBeVisible();
    await expect(page.locator('[data-testid="fleet-job-analytics-stage-row"][data-key="run"]')).toContainText('$0.1200');
    await expect(page.locator('[data-testid="fleet-job-analytics-stage-row"][data-key="review"]')).toContainText('$0.0134');
    await expect(page.getByTestId('fleet-job-analytics-story')).toContainText('US-001');

    await page.goto(`/${SLUG}/fleet/analytics?group=feature`);
    await waitForHydration(page);
    await expect(page.locator(`[data-testid="fleet-analytics-legend-row"][data-key="${feature}"]`)).toContainText('$0.1334', { timeout: 15_000 });
    await expect(page.getByTestId('fleet-analytics-spend-chart').locator('svg').first()).toBeVisible();
    await expect(page.getByTestId('fleet-analytics-costly-stories-table-row').filter({ hasText: feature })).toContainText('$0.1334');

    await page.goto('/admin/fleet/analytics');
    await waitForHydration(page);
    await expect(page.locator(`[data-testid="fleet-ingest-row"][data-job="${jobId}"]`)).toHaveAttribute('data-status', 'done');
  });
});
