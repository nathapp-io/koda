import { test, expect, type Page } from '@playwright/test';
import { addProjectMember, createUser, login, E2E_ADMIN } from './fixtures/api-client';
import { fleetE2eRepoId, seedNaxFiles } from './fixtures/fleet-config-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * S3 §8 E2E: browse + edit + save -> job page; conflict -> Reopen edits; drift -> regenerate; VIEWER read-only.
 * Files come from the API's test-only fake reader (plan C11); the runner is scripted over the real sync protocol.
 */
const SLUG = 'fleet-e2e';
const FILES = {
  '.nax/context.md': '# App\n\nOriginal context.\n',
  '.nax/config.json': '{\n  "name": "e2e-app"\n}\n',
  '.nax/rules/style.md': '# Style\n\nUse tabs.\n',
};

async function expectState(page: Page, state: string): Promise<void> {
  await expect(page.getByTestId('fleet-job-state').first()).toHaveAttribute('data-state', state, { timeout: 10_000 });
}

/** RUNNING -> final snapshot -> UPLOADING -> terminal, the config-job sequence of S3 §3 / D476. */
async function finish(runner: ScriptedRunner, lease: Lease, snapshot: Record<string, unknown>, to: 'COMPLETED' | 'FAILED', reason: string): Promise<void> {
  await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
  await runner.report(lease, [
    { type: 'snapshot', payload: { heartbeatAt: new Date().toISOString(), ...snapshot } },
    { type: 'state', payload: { to: 'UPLOADING' } },
    { type: 'state', payload: { to, reason } },
  ]);
}

async function openConfig(page: Page, repoId: string): Promise<void> {
  await page.goto(`/${SLUG}/fleet/repos/${repoId}/config`);
  await waitForHydration(page);
  await expect(page.getByTestId('nax-file-tree')).toBeVisible();
}

async function editContext(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="nax-file"][data-path=".nax/context.md"]').click();
  const editor = page.getByRole('textbox', { name: '.nax/context.md' });
  await editor.fill(text);
  await expect(page.locator('[data-testid="nax-file"][data-path=".nax/context.md"]')).toHaveAttribute('data-status', 'modified');
}

async function submitPr(page: Page, title: string): Promise<string> {
  await page.getByTestId('config-save').click();
  await page.getByTestId('config-pr-title').fill(title);
  await page.getByTestId('config-pr-submit').click();
  await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
  await waitForHydration(page);
  return page.url().split('/').pop() ?? '';
}

test.describe('Fleet repo config (S3)', () => {
  let runner: ScriptedRunner;
  let token: string;
  let repoId: string;
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    runner = await ScriptedRunner.enroll(token, `e2e-config-runner-${suffix}`, { configJobs: true });
    repoId = await fleetE2eRepoId(token);
  });

  test.beforeEach(async () => {
    await seedNaxFiles(token, repoId, FILES);
    await runner.heartbeat();
  });

  test('browse from the Repos card, edit, review the diff, save -> CONFIG_EDIT job -> PR opened', async ({ page }) => {
    test.setTimeout(90_000);
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    await page.getByTestId('fleet-repo-config-link').first().click();
    await waitForHydration(page);
    await expect(page.locator('[data-testid="nax-file-group"]')).toHaveCount(3);

    await editContext(page, '# App\n\nEdited context.\n');
    await expect(page.locator('[data-testid="nax-diff-line"][data-kind="add"]')).toContainText('Edited context.');
    const jobId = await submitPr(page, `Edit context ${suffix}`);

    const lease = await runner.acceptAssign(jobId);
    const edit = await runner.getConfigEdit(lease);
    expect(edit.edits).toEqual([expect.objectContaining({ path: '.nax/context.md', op: 'put', content: '# App\n\nEdited context.\n' })]);
    await finish(runner, lease, {
      resultBranch: `nax-config/${jobId}`, resultSha: 'abcdef1234567', resultPrUrl: 'https://github.com/acme/e2e-app/pull/41',
      configResult: { outcome: 'ok', files: ['.nax/context.md', 'AGENTS.md'] },
    }, 'COMPLETED', 'ok');

    await expectState(page, 'COMPLETED');
    await expect(page.getByTestId('config-panel-outcome')).toHaveAttribute('data-outcome', 'ok');
    await expect(page.getByTestId('config-panel-pr')).toHaveAttribute('href', 'https://github.com/acme/e2e-app/pull/41');
    await expect(page.getByTestId('fleet-job-bundle')).toHaveCount(0);
  });

  test('conflict -> Reopen edits shows both versions and blocks save until resolved', async ({ page }) => {
    test.setTimeout(90_000);
    await webLogin(page);
    await openConfig(page, repoId);
    await editContext(page, '# App\n\nMy edit.\n');
    const jobId = await submitPr(page, `Conflicting edit ${suffix}`);

    // Upstream moves on, then the runner finds the base changed.
    await seedNaxFiles(token, repoId, { ...FILES, '.nax/context.md': '# App\n\nSomeone else changed this.\n' });
    const lease = await runner.acceptAssign(jobId);
    await finish(runner, lease, { configResult: { outcome: 'conflict', files: ['.nax/context.md'] } }, 'FAILED', 'conflict');
    await expectState(page, 'FAILED');
    await expect(page.getByTestId('config-panel-outcome')).toHaveAttribute('data-outcome', 'conflict');

    await page.getByTestId('config-panel-reopen').click();
    await page.waitForURL(new RegExp(`/repos/${repoId}/config\\?reopen=${jobId}`));
    await waitForHydration(page);
    await expect(page.getByTestId('nax-change-conflict')).toBeVisible();
    await expect(page.locator('[data-testid="nax-diff-line"][data-kind="del"]')).toContainText('Someone else changed this.');
    await expect(page.locator('[data-testid="nax-diff-line"][data-kind="add"]')).toContainText('My edit.');
    await expect(page.getByTestId('config-save')).toBeDisabled();
    await page.getByTestId('nax-change-resolve').click();
    await expect(page.getByTestId('config-save')).toBeEnabled();
    await page.getByTestId('nax-changes-discard-all').click(); // leave nothing behind for the next test
  });

  test('drift check -> drifted files -> Open regenerate PR queues a regenerate job', async ({ page }) => {
    test.setTimeout(90_000);
    await webLogin(page);
    await openConfig(page, repoId);
    await page.getByTestId('config-drift').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
    await waitForHydration(page);
    const driftJobId = page.url().split('/').pop() ?? '';

    const lease = await runner.acceptAssign(driftJobId);
    await finish(runner, lease, { configResult: { outcome: 'drift', files: ['AGENTS.md', 'CLAUDE.md'] } }, 'COMPLETED', 'drift');
    await expectState(page, 'COMPLETED');
    await expect(page.getByTestId('config-panel-result-file')).toHaveCount(2);

    await page.getByTestId('config-panel-regenerate').click();
    await page.getByTestId('config-pr-title').fill(`Regenerate agent files ${suffix}`);
    await page.getByTestId('config-pr-submit').click();
    await page.waitForURL((url) => /\/fleet\/jobs\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(`/${driftJobId}`));
    await waitForHydration(page);
    const regenJobId = page.url().split('/').pop() ?? '';
    await expect(page.getByTestId('fleet-config-panel')).toContainText('Regenerate agent files');

    // End the regenerate job so no config job stays active for the repo (D465).
    const regenLease = await runner.acceptAssign(regenJobId);
    const regenEdit = await runner.getConfigEdit(regenLease);
    expect(regenEdit.mode).toBe('regenerate');
    expect(regenEdit.edits).toEqual([]);
    await finish(runner, regenLease, { configResult: { outcome: 'no_changes' } }, 'COMPLETED', 'no_changes');
    await expectState(page, 'COMPLETED');
  });

  test('a project VIEWER can read the files but gets no edit, save or drift controls', async ({ page }) => {
    const viewer = { email: `config-viewer-${suffix}@koda-e2e.test`, name: 'Config Viewer', password: 'Passw0rd!e2e' };
    await createUser(token, viewer);
    await addProjectMember(token, SLUG, viewer.email, 'VIEWER');
    await webLogin(page, viewer.email, viewer.password);
    await openConfig(page, repoId);
    await expect(page.getByTestId('config-readonly-notice')).toBeVisible();
    await expect(page.getByTestId('config-save')).toHaveCount(0);
    await expect(page.getByTestId('config-drift')).toHaveCount(0);
    await expect(page.getByTestId('config-new-file')).toHaveCount(0);
    await page.locator('[data-testid="nax-file"][data-path=".nax/rules/style.md"]').click();
    await expect(page.getByTestId('nax-editor-readonly')).toContainText('Use tabs.');
  });
});
