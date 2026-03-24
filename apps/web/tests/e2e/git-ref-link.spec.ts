import { test, expect } from '@playwright/test';
import { login, createProject, createTicket, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3100';

/**
 * Story 3 — Git Provider Links
 * Verifies that tickets with gitRefFile show the source reference section,
 * and that when gitRemoteUrl is configured, the reference renders as a clickable link.
 */
test.describe('Git Ref Links (Story 3)', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

    const proj = await createProject(token, {
      name: 'E2E Git Ref Project',
      slug: `e2e-gitref-${Date.now()}`,
      key: 'EGIT',
    });
    projectSlug = proj.slug;

    // Set gitRemoteUrl on the project
    await fetch(`${API_URL}/api/projects/${proj.slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ gitRemoteUrl: 'https://github.com/nathapp-io/koda' }),
    });
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('ticket with gitRefFile shows Source Reference section', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Git Ref Section',
      type: 'BUG',
      gitRefFile: 'apps/api/src/auth/auth.service.ts',
      gitRefLine: 42,
      gitRefVersion: 'main',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Source Reference label
    await expect(page.getByText('Source Reference')).toBeVisible({ timeout: 3000 });
    // File path shown
    await expect(page.getByText(/apps\/api\/src\/auth\/auth\.service\.ts/)).toBeVisible();
    // Line number shown
    await expect(page.getByText(/:42/)).toBeVisible();
  });

  test('ticket with gitRemoteUrl + gitRefFile shows clickable GitHub link', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Git Ref Link',
      type: 'BUG',
      gitRefFile: 'apps/api/src/tickets/tickets.service.ts',
      gitRefLine: 87,
      gitRefVersion: 'v1.0',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Link should point to GitHub blob URL
    const gitLink = page.locator('a[href*="github.com"]').first();
    await expect(gitLink).toBeVisible({ timeout: 3000 });

    const href = await gitLink.getAttribute('href');
    expect(href).toContain('nathapp-io/koda');
    expect(href).toContain('tickets.service.ts');
    expect(href).toContain('v1.0');
    expect(href).toContain('#L87');

    await expect(gitLink).toHaveAttribute('target', '_blank');
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
