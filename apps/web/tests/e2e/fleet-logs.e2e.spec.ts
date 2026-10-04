import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { call, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S2a slice 2 (spec §8 E2E (1) and (2)): a protocol v3 scripted runner streams logs over the upload route.
 * (1) The viewer follows a RUNNING job live, filters server-side, and scrolling up stops following.
 * (2) The run stream is cut before `final`; the bundle carries the full run log and the fallback fills it.
 * API polls stay at one request per 2 s (the global throttle is 100 a minute; /fleet/runner/* is exempt).
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

interface LogStreamRow { stream: string; complete: boolean; source: string }
interface LogList { attempts: Array<{ leaseEpoch: number; streams: LogStreamRow[] }> }

/** One nax LogEntry line (the run JSONL), newline included. */
const entry = (level: string, storyId: string, message: string): string =>
  `${JSON.stringify({ timestamp: '2026-10-04T10:00:00.000Z', level, stage: 'execution', storyId, message })}\n`;

test.describe('Fleet logs viewer (scripted v3 runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-logs-runner-${suffix}`, { logs: true });
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  async function startJob(feature: string): Promise<{ jobId: string; lease: Lease }> {
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    return { jobId, lease };
  }

  async function complete(lease: Lease): Promise<void> {
    await runner.report(lease, [{ type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } }]);
  }

  const listLogs = (jobId: string): Promise<LogList> => call<LogList>('GET', `/projects/${SLUG}/fleet/jobs/${jobId}/logs`, token);

  test('(1) a running job streams into the viewer live; story and level filters apply; scrolling up stops following', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `logs-live-${suffix}`;
    const { jobId, lease } = await startJob(feature);
    // Enough rows to scroll: 150 debug lines, then one line per story at info and warn.
    const filler = Array.from({ length: 150 }, (_, i) => entry('debug', 'US-001', `filler ${i}`)).join('');
    const first = `${filler}${entry('info', 'US-001', 'story one started')}${entry('warn', 'US-002', 'story two flaky')}`;
    const ack = await runner.putLog(lease, 'run', 0, first);
    expect(ack).toEqual({ outcome: 'appended', size: Buffer.byteLength(first) });

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await page.getByTestId('fleet-job-logs-link').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/${jobId}/logs$`));
    await waitForHydration(page);
    const rows = page.getByTestId('fleet-log-row');
    await expect(page.getByTestId('fleet-log-following')).toBeVisible();
    await expect(rows.last()).toContainText('story two flaky');

    // A line written while the viewer is open arrives through fleet_log + a forward fetch, with no reload.
    const later = entry('error', 'US-002', 'story two failed');
    await runner.putLog(lease, 'run', Buffer.byteLength(first), later);
    await expect(rows.last()).toContainText('story two failed', { timeout: 15_000 });

    // Scrolling away from the bottom stops following; Jump to latest brings it back.
    await page.getByTestId('fleet-log-scroller').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(page.getByTestId('fleet-log-jump')).toBeVisible();
    await expect(page.getByTestId('fleet-log-following')).toHaveCount(0);
    await page.getByTestId('fleet-log-jump').click();
    await expect(page.getByTestId('fleet-log-following')).toBeVisible();

    // Story filter (applied on Enter), then a minimum level: both live in the URL and filter server-side.
    await page.getByTestId('fleet-log-filter-story').fill('US-002');
    await page.getByTestId('fleet-log-filter-story').press('Enter');
    await page.waitForURL(/story=US-002/);
    await expect(rows).toHaveCount(2);
    await page.getByTestId('fleet-log-filter-level').selectOption('error');
    await page.waitForURL(/level=error/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('story two failed');
    await expect(rows.first().getByTestId('fleet-log-level')).toHaveText('ERROR');

    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.putLog(lease, 'run', Buffer.byteLength(first) + Buffer.byteLength(later), '', true);
    await complete(lease);
  });

  test('(2) the run stream is cut before final; the bundle fills it and the viewer says so', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `logs-fallback-${suffix}`;
    const { jobId, lease } = await startJob(feature);
    const stdout = 'build ok\ntests ok\n';
    const runLines = [entry('info', 'US-001', 'one'), entry('info', 'US-001', 'two'), entry('info', 'US-001', 'three'), entry('info', 'US-001', 'four from the bundle')];
    await runner.putLog(lease, 'stdout', 0, stdout, true);
    await runner.putLog(lease, 'run', 0, runLines.slice(0, 2).join(''));    // no final: the upload "died" here

    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadTarBundle(lease, {
      'nax.stdout': stdout,
      'nax.stderr': '',
      [`nax-out/features/${feature}/runs/run-1.jsonl`]: runLines.join(''),
    });
    await complete(lease);
    // The fallback runs after the bundle response (spec §2.5): wait until the run stream reads complete from the bundle.
    await expect.poll(async () => (await listLogs(jobId)).attempts[0]?.streams.find((s) => s.stream === 'run'), { timeout: 20_000, ...POLL })
      .toMatchObject({ complete: true, source: 'bundle' });

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}/logs`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-log-notice-bundle')).toBeVisible();
    await expect(page.getByTestId('fleet-log-row')).toHaveCount(4);
    await expect(page.getByTestId('fleet-log-row').last()).toContainText('four from the bundle');
    await expect(page.getByTestId('fleet-log-following')).toHaveCount(0);

    // stdout was complete from the stream: no bundle notice, its own text, and a download link.
    await page.getByTestId('fleet-log-tab-stdout').click();
    await page.waitForURL(/stream=stdout/);
    await expect(page.getByTestId('fleet-log-notice-bundle')).toHaveCount(0);
    await expect(page.getByTestId('fleet-log-row')).toHaveCount(2);
    await expect(page.getByTestId('fleet-log-download')).toHaveAttribute('href', `/api/projects/${SLUG}/fleet/jobs/${jobId}/logs/stdout/raw?download=1&leaseEpoch=${lease.leaseEpoch}`);

    // The job page links the attempt's full log from the timeline.
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-timeline-logs')).toHaveCount(1);
  });
});
