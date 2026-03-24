import { test, expect } from '@playwright/test';
import { login, createProject, createTicket, deleteProject, E2E_ADMIN } from './fixtures/api-client';

/**
 * Story 3 regression test — Git Provider Links
 * Verifies that tickets with gitRefFile + gitRefVersion show a clickable link
 * in the ticket detail page.
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
      description: 'https://github.com/nathapp-io/koda',
    });
    projectSlug = proj.slug;

    // Set gitRemoteUrl on the project (via PATCH)
    await fetch(`${process.env['E2E_API_URL'] ?? 'http://localhost:3100'}/api/projects/${proj.slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ gitRemoteUrl: 'https://github.com/nathapp-io/koda' }),
    });
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('ticket with gitRefFile shows git ref section', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Git Ref Ticket',
      type: 'BUG',
      gitRefFile: 'apps/api/src/auth/auth.service.ts',
      gitRefLine: 42,
      gitRefVersion: 'main',
    });

    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();

    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Git ref section should appear
    await expect(page.getByText(/apps\/api\/src\/auth\/auth\.service\.ts/)).toBeVisible({ timeout: 3000 });
    await expect(page.getByText(/:42/)).toBeVisible();
  });

  test('ticket with gitRemoteUrl + gitRefFile shows clickable link', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Git Ref Link Ticket',
      type: 'BUG',
      gitRefFile: 'apps/api/src/tickets/tickets.service.ts',
      gitRefLine: 87,
      gitRefVersion: 'v1.0',
    });

    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();

    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Should render as <a> with href pointing to GitHub blob URL
    const gitLink = page.locator('a[href*="github.com"][href*="tickets.service.ts"]');
    await expect(gitLink).toBeVisible({ timeout: 3000 });

    const href = await gitLink.getAttribute('href');
    expect(href).toContain('nathapp-io/koda');
    expect(href).toContain('tickets.service.ts');
    expect(href).toContain('v1.0');
    expect(href).toContain('#L87');

    // Link opens in new tab
    await expect(gitLink).toHaveAttribute('target', '_blank');
  });

  test('ticket without gitRefFile shows no git ref section', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E No Git Ref Ticket',
      type: 'ENHANCEMENT',
    });

    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();

    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // No git ref link should appear
    await expect(page.locator('a[href*="github.com"]')).not.toBeVisible({ timeout: 2000 });
  });
});
