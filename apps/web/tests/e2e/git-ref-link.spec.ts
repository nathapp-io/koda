import { test, expect } from '@playwright/test';
import { login, createProject, createTicket, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

function randomUppercase(length: number): string {
  return Array.from({ length }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
}

/**
 * Story 3 — Git Provider Links
 * Current API contract does not accept gitRef* fields in ticket create/update payloads,
 * so ticket detail should not render source reference UI for standard created tickets.
 */
test.describe('Git Ref Links (Story 3)', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

    const suffix = Date.now().toString().slice(-6);

    const proj = await createProject(token, {
      name: 'E2E Git Ref Project',
      slug: `e2e-gitref-${suffix}`,
      key: randomUppercase(6),
    });
    projectSlug = proj.slug;

    // Set gitRemoteUrl on the project
    const patchRes = await fetch(`${API_URL}/api/projects/${proj.slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ gitRemoteUrl: 'https://github.com/nathapp-io/koda' }),
    });

    if (!patchRes.ok) {
      throw new Error(`Patch project gitRemoteUrl failed: ${patchRes.status} ${await patchRes.text()}`);
    }
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('ticket detail does not show Source Reference for standard tickets', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Git Ref Section',
      type: 'BUG',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText('Source Reference')).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('a[href*="github.com"]')).not.toBeVisible();
  });

  test('setting project gitRemoteUrl alone does not render a GitHub source link', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Git Ref Link',
      type: 'BUG',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.locator('a[href*="github.com"]')).not.toBeVisible({ timeout: 3000 });
  });

  test('ticket without gitRefFile shows no Source Reference section', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E No Git Ref',
      type: 'ENHANCEMENT',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText('Source Reference')).not.toBeVisible({ timeout: 2000 });
    await expect(page.locator('a[href*="github.com"]')).not.toBeVisible();
  });
});
