import { test, expect } from '@playwright/test';
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin } from './fixtures/page-helpers';

test.describe('Projects', () => {
  let token: string;
  let createdSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
  });

  test.afterAll(async () => {
    if (createdSlug) await deleteProject(token, createdSlug);
  });

  test('dashboard shows project list', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');
    // Dashboard renders a heading
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('can create a new project via dialog', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');

    // Open create project dialog
    await page.getByRole('button', { name: 'New Project' }).click();

    const projectName = `E2E Project ${Date.now()}`;
    const projectSlug = `e2e-proj-${Date.now()}`;

    await page.locator('input[name="name"]').fill(projectName);
    await page.locator('input[name="slug"]').clear();
    await page.locator('input[name="slug"]').fill(projectSlug);
    await page.locator('input[name="key"]').clear();
    await page.locator('input[name="key"]').fill('E2EP');

    await page.getByRole('button', { name: 'Create Project' }).click();

    createdSlug = projectSlug;
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 5000 });
  });

  test('clicking View Board navigates to project board', async ({ page }) => {
    const proj = await createProject(token, {
      name: 'E2E Nav Project',
      slug: `e2e-nav-${Date.now()}`,
      key: 'NAVP',
    });

    await webLogin(page);
    await expect(page).toHaveURL('/');

    // Click the first "View Board" button
    await page.getByRole('button', { name: 'View Board' }).first().click();
    await expect(page).toHaveURL(new RegExp(proj.slug), { timeout: 5000 });

    await deleteProject(token, proj.slug);
  });
});
