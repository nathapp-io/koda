import { test, expect } from '@playwright/test';
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client';

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
    // Login
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page).toHaveURL('/');

    // Dashboard renders
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('can create a new project via dialog', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page).toHaveURL('/');

    // Open create project dialog
    await page.getByRole('button', { name: /new project|create project/i }).click();

    // Fill form
    const projectName = `E2E Project ${Date.now()}`;
    const projectSlug = `e2e-proj-${Date.now()}`;
    const projectKey = 'E2EP';

    await page.getByLabel(/name/i).fill(projectName);
    // Slug may auto-fill — override it
    const slugInput = page.locator('input[name="slug"]');
    await slugInput.clear();
    await slugInput.fill(projectSlug);

    const keyInput = page.locator('input[name="key"]');
    await keyInput.clear();
    await keyInput.fill(projectKey);

    await page.getByRole('button', { name: /create|submit/i }).last().click();

    // Dialog closes and project appears in list
    createdSlug = projectSlug;
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 5000 });
  });

  test('clicking project navigates to project board', async ({ page }) => {
    // Create a project via API for this test
    const proj = await createProject(token, {
      name: 'E2E Nav Project',
      slug: `e2e-nav-${Date.now()}`,
      key: 'NAVP',
    });

    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page).toHaveURL('/');

    await page.getByRole('button', { name: /view board/i }).first().click();

    await expect(page).toHaveURL(new RegExp(proj.slug), { timeout: 5000 });

    await deleteProject(token, proj.slug);
  });
});
