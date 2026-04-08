import { test, expect } from '@playwright/test';
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers';

const PROJECT_SAVE_REGEX = /Save Project|保存项目/i;
const VCS_TAB_REGEX = /VCS|集成/i;
const VCS_SYNC_PR_REGEX = /Sync PR Status|同步 PR 状态/i;

test.describe('Settings Project + VCS Sync PR', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const proj = await createProject(token, {
      name: 'E2E Settings Project VCS Sync PR',
      slug: `e2e-settings-${Date.now()}`,
      key: generateUniqueProjectKey('SP'),
      description: 'E2E settings coverage',
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test.beforeEach(async ({ page }) => {
    await webLogin(page);
  });

  test('settings save sends PATCH /projects/:slug', async ({ page }) => {
    await page.goto(`/${projectSlug}/settings`);
    const projectForm = page.locator('form').first();
    const nameInput = projectForm.locator('input').first();
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('E2E Settings Project VCS Sync PR');
    await nameInput.fill(`E2E Updated ${Date.now()}`);

    const patchRequest = page.waitForRequest(request =>
      request.method() === 'PATCH' && request.url().includes(`/api/projects/${projectSlug}`)
    );

    await page.getByRole('button', { name: PROJECT_SAVE_REGEX }).click();
    await expect(patchRequest).resolves.toBeTruthy();
  });

  test('settings VCS Sync PR sends POST /projects/:slug/vcs/sync-pr', async ({ page }) => {
    await page.route('**/api/projects/*/vcs/sync-pr', route =>
      route.fulfill({ status: 200, body: JSON.stringify({ ret: 0, data: { updated: 1 } }) })
    );

    await page.goto(`/${projectSlug}/settings`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: VCS_TAB_REGEX }).click();

    // Wait for VCS tab content to render
    const vcsTabContent = page.locator('div[role="tabpanel"]', { hasText: /Sync PR Status|同步 PR 状态/i });
    await expect(vcsTabContent).toBeVisible({ timeout: 10000 });

    const syncPrRequest = page.waitForRequest(request =>
      request.method() === 'POST' && request.url().includes(`/api/projects/${projectSlug}/vcs/sync-pr`)
    );

    await page.getByRole('button', { name: VCS_SYNC_PR_REGEX }).click();
    await expect(syncPrRequest).resolves.toBeTruthy();
  });
});
