import { test, expect } from '@playwright/test';
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
    await addProjectMember(token, SLUG, viewerEmail, 'VIEWER');
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
});
