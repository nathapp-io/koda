import { test, expect } from '@playwright/test';
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const EDIT_REGEX = /Edit|编辑/i;
const SAVE_REGEX = /Save|保存/i;

async function createLabel(token: string, projectSlug: string, name: string) {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, color: '#22C55E' }),
  });
  if (!res.ok) throw new Error(`Create label failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { data?: { id?: string; name?: string } };
  return { id: body.data?.id ?? '', name: body.data?.name ?? name };
}

test.describe('Labels Inline Update', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const proj = await createProject(token, {
      name: 'E2E Labels Inline Update',
      slug: `e2e-labels-${Date.now()}`,
      key: generateUniqueProjectKey('LB'),
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test.beforeEach(async ({ page }) => {
    await webLogin(page);
  });

  test('inline edit sends PATCH /projects/:slug/labels/:id', async ({ page }) => {
    const label = await createLabel(token, projectSlug, `e2e-label-${Date.now()}`);
    await page.goto(`/${projectSlug}/labels`);
    await page.waitForLoadState('networkidle');

    const row = page.locator('tr', { hasText: label.name }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.getByRole('button', { name: EDIT_REGEX }).click();

    // Wait for edit mode to render (Save button and input fields)
    const editRow = page.locator('tr').filter({ has: page.getByRole('button', { name: SAVE_REGEX }) }).first();
    await expect(editRow).toBeVisible({ timeout: 5000 });
    const nameInput = editRow.locator('input').first();
    await expect(nameInput).toBeVisible();
    await nameInput.fill(`${label.name}-updated`);

    const patchRequest = page.waitForRequest(request =>
      request.method() === 'PATCH' &&
      request.url().includes(`/api/projects/${projectSlug}/labels/${label.id}`)
    );

    await editRow.getByRole('button', { name: SAVE_REGEX }).click();
    await expect(patchRequest).resolves.toBeTruthy();
  });
});
