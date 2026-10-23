import { test, expect, type Page } from '@playwright/test';
import { login, E2E_ADMIN, createUser, addProjectMember } from './fixtures/api-client';
import { call, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S5a B4-R2: the thread web journey against a protocol-v4 ScriptedRunner.
 * Create → send → live reply without a reload → Stop → a read-only second member.
 *
 * The e2e API runs with FLEET_THREADS_ENABLED=true (playwright.config.ts). Project `fleet-e2e`
 * and repo acme/e2e-app come from prisma/seed-e2e.ts. The scripted runner reports
 * `threadBackends: { native: [threadModel], acp: [] }` at protocol 4 and is patched to
 * `threadCapacity: 1` (admin-set, required before placement offers it a THREAD job).
 * `threadModel` is unique per run so no other scripted runner of the suite matches the THREAD job.
 */
const SLUG = 'fleet-e2e';
const suffix = Date.now().toString().slice(-6);
const threadModel = `e2e-model-${suffix}`;

interface ThreadDetail { id: string; activeJob: { id: string } | null }
interface ThreadMessage { id: string; role: string; content: string; status: string }

const threadDetail = (token: string, threadId: string): Promise<ThreadDetail> =>
  call<ThreadDetail>('GET', `/projects/${SLUG}/threads/${threadId}`, token);

const threadMessages = (token: string, threadId: string): Promise<{ items: ThreadMessage[] }> =>
  call<{ items: ThreadMessage[] }>('GET', `/projects/${SLUG}/threads/${threadId}/messages?afterSeq=0&limit=200`, token);

/** One JSON line of the thread log stream, newline included. */
const threadLine = (obj: Record<string, unknown>): string => `${JSON.stringify(obj)}\n`;

/** Polls until the send has created a live THREAD job and persisted the user message. */
async function waitForTurn(token: string, threadId: string): Promise<{ jobId: string; messageId: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const detail = await threadDetail(token, threadId);
    if (detail.activeJob) {
      const { items } = await threadMessages(token, threadId);
      const user = items.find((m) => m.role === 'user' && m.content === 'hello');
      if (user) return { jobId: detail.activeJob.id, messageId: user.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No live THREAD job / user message for thread ${threadId} within 20 s`);
}

/** A fresh scripted v4 runner with its own model, so a journey's THREAD job cannot be placed on another journey's runner. */
async function enrollThreadRunner(token: string, label: string, threadWrite: boolean): Promise<{ runner: ScriptedRunner; model: string }> {
  const model = `e2e-${label}-${suffix}`;
  const runner = await ScriptedRunner.enroll(token, `e2e-thread-${label}-${suffix}`, { threads: true, threadModel: model, threadWrite });
  await call<void>('PATCH', `/fleet/runners/${runner.id}`, token, { threadCapacity: 1 });
  return { runner, model };
}

/** Creates a thread through /threads/new on the seeded repo and returns its id, the page left on the thread. */
async function createThread(page: Page, repoId: string, feature: string, model: string): Promise<string> {
  await webLogin(page);
  await page.goto(`/${SLUG}/threads/new`);
  await waitForHydration(page);
  await page.getByTestId('thread-new-repo').selectOption(repoId);
  await page.getByTestId('thread-new-feature').fill(feature);
  await page.getByTestId('thread-new-title').fill(`Journey ${feature}`);
  await page.getByTestId('thread-new-cap').fill('5');
  await page.getByTestId('thread-new-model').selectOption(model);
  await page.locator('form[data-testid="thread-create-form"] button[type="submit"]').click();
  await page.waitForURL(new RegExp(`/${SLUG}/threads/(?!new$)[A-Za-z0-9_-]+$`), { timeout: 20_000 });
  await waitForHydration(page);
  return page.url().split('/').pop() ?? '';
}

/** Appends JSON lines to the THREAD job's log stream, tracking the offset the server holds. */
class ThreadLog {
  private offset = 0;
  constructor(private readonly runner: ScriptedRunner, private readonly lease: Lease) {}

  async append(...lines: Array<Record<string, unknown>>): Promise<void> {
    const text = lines.map(threadLine).join('');
    await this.runner.putLog(this.lease, 'thread', this.offset, text);
    this.offset += Buffer.byteLength(text);
  }
}

/** Sends "hello", takes the THREAD job, starts its session and streams one turn (`complete` also ends the turn). */
async function startSession(
  page: Page, token: string, threadId: string, runner: ScriptedRunner,
  opts: { complete: boolean; stale?: boolean },
): Promise<{ lease: Lease; log: ThreadLog }> {
  await page.getByTestId('thread-composer-input').fill('hello');
  await page.getByTestId('thread-composer-input').press('Enter');
  const { jobId, messageId } = await waitForTurn(token, threadId);
  const lease = await runner.acceptAssign(jobId);
  await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
  const log = new ThreadLog(runner, lease);
  await log.append({ type: 'session_started', resumed: false, ...(opts.stale ? { stale: true } : {}) });
  await log.append(
    { type: 'input_consumed', messageId },
    { type: 'turn_start', turnId: 't1' },
    { type: 'text_delta', turnId: 't1', round: 0, text: 'Hello from the runner' },
  );
  if (opts.complete) {
    await log.append({
      type: 'turn_end', turnId: 't1', status: 'completed', output: 'Hello from the runner',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0,
    });
  }
  return { lease, log };
}

/** A runner ends a job: RUNNING -> UPLOADING -> terminal (the runner-reported transitions of spec §5.4). */
const finishJob = (runner: ScriptedRunner, lease: Lease, to: 'COMPLETED' | 'FAILED', reason?: string): Promise<void> =>
  runner.report(lease, [
    { type: 'state', payload: { to: 'UPLOADING' } },
    { type: 'state', payload: { to, ...(reason ? { reason } : {}) } },
  ]);

/** The runner closes the session after the creator's End session: takes THREAD_CLOSE, logs it, completes the job. */
async function closeSession(page: Page, runner: ScriptedRunner, lease: Lease, log: ThreadLog): Promise<void> {
  await page.getByTestId('thread-end-session').click();
  await runner.takeCommand('THREAD_CLOSE', lease.jobId, { result: 'ok' });
  await log.append({ type: 'session_closed', reason: 'closed' });
  await finishJob(runner, lease, 'COMPLETED');
}

interface HandoffDetail { handoff: { plan: { jobId: string } | null; run: { jobId: string } | null }; activeJob: { id: string } | null }

/** Polls until the thread reports a job id for `pick`, then returns it. */
async function waitForJobId(token: string, threadId: string, pick: (d: HandoffDetail) => string | null): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const id = pick(await call<HandoffDetail>('GET', `/projects/${SLUG}/threads/${threadId}`, token));
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No job id for thread ${threadId} within 20 s`);
}

const WORKFLOW_RESULT = JSON.stringify({
  schemaVersion: 1,
  runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03',
  verdict: { workflowPassed: true, outcome: 'draft', reasons: ['CI failed: test'], openItems: [] },
});

test.describe('Fleet S5a B4-R2: thread web journey (scripted v4 runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-thread-runner-${suffix}`, { threads: true, threadModel });
    // threadCapacity is admin-set (placement needs it > 0 before it will place THREAD jobs).
    await call<void>('PATCH', `/fleet/runners/${runner.id}`, token, { threadCapacity: 1 });
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  test('create, send, live reply, Stop, read-only member', async ({ page, browser }) => {
    test.setTimeout(180_000);

    // Admin opens /<project>/threads/new and creates a thread on the seeded repo with the thread model.
    await webLogin(page);
    await page.goto(`/${SLUG}/threads/new`);
    await waitForHydration(page);
    const feature = `e2e-thread-${suffix}`;
    await page.getByTestId('thread-new-repo').selectOption(repoId);
    await page.getByTestId('thread-new-feature').fill(feature);
    await page.getByTestId('thread-new-title').fill('Thread e2e journey');
    await page.getByTestId('thread-new-cap').fill('5');
    await page.getByTestId('thread-new-model').selectOption(threadModel);
    await page.locator('form[data-testid="thread-create-form"] button[type="submit"]').click();
    // The thread id is the final path segment; never match the still-open /threads/new form page.
    await page.waitForURL(new RegExp(`/${SLUG}/threads/(?!new$)[A-Za-z0-9_-]+$`), { timeout: 20_000 });
    const threadId = page.url().split('/').pop() ?? '';

    // Send "hello" from the thread page; the send queues the THREAD job and a pending user message.
    await page.getByTestId('thread-composer-input').fill('hello');
    await page.getByTestId('thread-composer-input').press('Enter');

    // The runner takes the THREAD job's ASSIGN, reports RUNNING, and streams the turn.
    const { jobId, messageId } = await waitForTurn(token, threadId);
    const lease: Lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    const start = threadLine({ type: 'session_started', resumed: false });
    await runner.putLog(lease, 'thread', 0, start);
    const turn = threadLine({ type: 'input_consumed', messageId })
      + threadLine({ type: 'turn_start', turnId: 't1' })
      + threadLine({ type: 'text_delta', turnId: 't1', round: 0, text: 'Hello from the runner' });
    await runner.putLog(lease, 'thread', Buffer.byteLength(start), turn);

    // The reply appears live (no reload) and the Stop control shows while the turn runs.
    await expect(page.getByTestId('thread-message').filter({ hasText: 'Hello from the runner' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('thread-stop')).toBeVisible();

    // Stop delivers a THREAD_STOP_TURN command to the runner (takeCommand acks it).
    await page.getByTestId('thread-stop').click();
    await runner.takeCommand('THREAD_STOP_TURN', jobId, { result: 'ok' });
    await runner.putLog(lease, 'thread', Buffer.byteLength(start) + Buffer.byteLength(turn),
      threadLine({ type: 'turn_end', turnId: 't1', status: 'cancelled', output: '', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 }));

    // A second member added as a VIEWER reads the same thread, without acting controls.
    const viewerEmail = `thread-viewer-${suffix}@koda-e2e.test`;
    await createUser(token, { email: viewerEmail, name: 'Thread Viewer', password: 'E2ePassword1!' });
    await addProjectMember(token, SLUG, viewerEmail, 'viewer');
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await webLogin(viewerPage, viewerEmail, 'E2ePassword1!');
    await viewerPage.goto(`/${SLUG}/threads/${threadId}`);
    await waitForHydration(viewerPage);
    await expect(viewerPage.getByTestId('thread-message').filter({ hasText: 'Hello from the runner' })).toBeVisible({ timeout: 20_000 });
    await expect(viewerPage.getByTestId('thread-composer')).toContainText('only the creator can send messages');
    await expect(viewerPage.getByTestId('thread-composer-input')).toHaveCount(0);
    await viewerContext.close();
  });

  test('crash mid-turn: the page leaves streaming without a reload (#266)', async ({ page }) => {
    test.setTimeout(120_000);
    const { runner: crashRunner, model } = await enrollThreadRunner(token, 'crash', false);
    const threadId = await createThread(page, repoId, `e2e-crash-${suffix}`, model);
    const { lease } = await startSession(page, token, threadId, crashRunner, { complete: false });
    await expect(page.getByTestId('thread-streaming')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('thread-stop')).toBeVisible();

    await finishJob(crashRunner, lease, 'FAILED', 'crashed');

    await expect(page.getByTestId('thread-streaming')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('thread-terminal')).toBeVisible();
    await expect(page.getByTestId('thread-stop')).toHaveCount(0);
  });

  test('idle close: the session label and End session update without a reload (#266)', async ({ page }) => {
    test.setTimeout(120_000);
    const { runner: idleRunner, model } = await enrollThreadRunner(token, 'idle', false);
    const threadId = await createThread(page, repoId, `e2e-idle-${suffix}`, model);
    const { lease, log } = await startSession(page, token, threadId, idleRunner, { complete: true });
    await expect(page.getByTestId('thread-header')).toContainText('Live', { timeout: 20_000 });
    await expect(page.getByTestId('thread-end-session')).toBeVisible();

    await log.append({ type: 'session_closed', reason: 'idle' });
    await finishJob(idleRunner, lease, 'COMPLETED');

    await expect(page.getByTestId('thread-header')).not.toContainText('Live', { timeout: 20_000 });
    await expect(page.getByTestId('thread-end-session')).toHaveCount(0);
  });

  test('handoff: Publish, Plan and Run update the timeline live', async ({ page }) => {
    test.setTimeout(240_000);
    const feature = `e2e-handoff-${suffix}`;
    const specPath = `.nax/features/${feature}/spec.md`;
    const sha = 'ab12cd34'.repeat(5);
    const { runner: writeRunner, model } = await enrollThreadRunner(token, 'handoff', true);
    const threadId = await createThread(page, repoId, feature, model);
    const { lease, log } = await startSession(page, token, threadId, writeRunner, { complete: true });

    // A write_doc line enables Publish; its dialog lists the path.
    await log.append({ type: 'write_doc', path: specPath, bytes: 120 });
    await expect(page.getByTestId('thread-action-publish')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('thread-action-publish').click();
    await expect(page.getByTestId('thread-publish-path')).toHaveText(specPath);
    await page.getByTestId('thread-publish-confirm').click();
    await writeRunner.takeCommand('THREAD_PUBLISH', lease.jobId, { result: 'ok' });
    await log.append({ type: 'published', sha, paths: [specPath], ignored: [], specPresent: true });
    await expect(page.getByTestId('thread-write-marker')).toContainText(sha.slice(0, 7), { timeout: 20_000 });

    // End the session, then Plan: the card follows the PLAN job to Completed.
    await closeSession(page, writeRunner, lease, log);
    await expect(page.getByTestId('thread-action-plan')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('thread-action-plan').click();
    await page.getByTestId('thread-handoff-submit').click();
    const planJobId = await waitForJobId(token, threadId, (d) => d.handoff.plan?.jobId ?? null);
    const planLease = await writeRunner.acceptAssign(planJobId);
    await writeRunner.report(planLease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    await finishJob(writeRunner, planLease, 'COMPLETED');
    const planCard = page.locator('[data-testid="thread-job-card"][data-command="PLAN"]');
    await expect(planCard).toContainText('Completed', { timeout: 20_000 });

    // Run: the bundle's workflow result lands as the Draft outcome on the RUN card.
    await expect(page.getByTestId('thread-action-run')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('thread-action-run').click();
    await page.getByTestId('thread-handoff-submit').click();
    const runJobId = await waitForJobId(token, threadId, (d) => d.handoff.run?.jobId ?? null);
    const runLease = await writeRunner.acceptAssign(runJobId);
    await writeRunner.report(runLease, [{ type: 'state', payload: { to: 'RUNNING' } }, { type: 'state', payload: { to: 'UPLOADING' } }]);
    await writeRunner.uploadTarBundle(runLease, {
      'nax-out/status.json': JSON.stringify({ run: { id: 'run-e2e', status: 'completed' } }),
      'workflow/result.json': WORKFLOW_RESULT,
    });
    await writeRunner.report(runLease, [{ type: 'state', payload: { to: 'ESCALATED', reason: 'workflow draft' } }]);
    // The upload's ingest kick ran before the job was terminal; kick again rather than wait for the sweeper.
    await call('POST', `/fleet/ingest/jobs/${runJobId}/rerun`, token);
    const runCard = page.locator('[data-testid="thread-job-card"][data-command="RUN"]');
    await expect(runCard.getByTestId('thread-job-card-outcome')).toHaveText('Draft', { timeout: 45_000 });
  });

  test('stale: Discard waits for the session to end, then clears the banner', async ({ page }) => {
    test.setTimeout(180_000);
    const tipSha = 'cd34ef56'.repeat(5);
    const { runner: staleRunner, model } = await enrollThreadRunner(token, 'stale', true);
    const threadId = await createThread(page, repoId, `e2e-stale-${suffix}`, model);
    const { lease, log } = await startSession(page, token, threadId, staleRunner, { complete: true, stale: true });

    const banner = page.getByTestId('thread-stale-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('thread-stale-discard')).toBeDisabled();
    await expect(banner).toContainText('A thread job is active');

    await closeSession(page, staleRunner, lease, log);
    await expect(page.getByTestId('thread-stale-discard')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('thread-stale-discard').click();
    await page.getByTestId('thread-discard-confirm').click();
    const discardJobId = await waitForJobId(token, threadId, (d) => d.activeJob?.id ?? null);
    const discardLease = await staleRunner.acceptAssign(discardJobId);
    await staleRunner.report(discardLease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    await new ThreadLog(staleRunner, discardLease).append({ type: 'discarded', tipSha });
    await finishJob(staleRunner, discardLease, 'COMPLETED');

    await expect(banner).toHaveCount(0, { timeout: 20_000 });
  });
});
