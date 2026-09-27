import { test, expect } from '@playwright/test';
import {
  login, createUser, addProjectMember, createProject, createTicket, transitionTicket, E2E_ADMIN,
} from './fixtures/api-client';
import { webLogin, confirmTransitionDialog, generateUniqueProjectKey, waitForHydration } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const PASSWORD = 'E2ePassword1!';
const PADMIN = { email: 'roles-padmin@koda-e2e.test', name: 'Roles Project Admin', password: PASSWORD };
const DEV = { email: 'roles-dev@koda-e2e.test', name: 'Roles Developer', password: PASSWORD };
const VIEWER = { email: 'roles-viewer@koda-e2e.test', name: 'Roles Viewer', password: PASSWORD };

test.describe('Ticket actions follow the project role (#144, M25)', () => {
  let token: string;
  let slug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    slug = (await createProject(token, { name: 'E2E Roles', slug: `e2erl${suffix}`, key: generateUniqueProjectKey('RL') })).slug;
    for (const u of [PADMIN, DEV, VIEWER]) await createUser(token, u);
    await addProjectMember(token, slug, PADMIN.email, 'ADMIN');
    await addProjectMember(token, slug, DEV.email, 'DEVELOPER');
    await addProjectMember(token, slug, VIEWER.email, 'VIEWER');
  });

  test('a DEVELOPER moves a ticket through the flow and never sees Close or Delete', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Dev flow', type: 'BUG' });
    await webLogin(page, DEV.email, DEV.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Verify' }).click();
    await confirmTransitionDialog(page, 'verified by dev');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: 'Submit Fix' }).click();
    await confirmTransitionDialog(page, 'fixed by dev');
    await expect(page.getByRole('button', { name: 'Approve Fix' })).toBeVisible({ timeout: 5000 });

    await expect(page.getByRole('button', { name: /^Close$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Delete Ticket/i })).toHaveCount(0);
  });

  test('a VIEWER sees no action buttons', async ({ page }) => {
    // createTicket() returns only { id, ref, status }; assert on the literal title.
    const title = 'Viewer view';
    const ticket = await createTicket(token, slug, { title, type: 'BUG' });
    await webLogin(page, VIEWER.email, VIEWER.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
    for (const name of ['Verify', 'Start', 'Reject', 'Close']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${name}$`) })).toHaveCount(0);
    }
  });

  test('a project ADMIN sees Close; it prompts for a reason and records it', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Admin close', type: 'BUG' });
    await transitionTicket(token, slug, ticket.ref, 'verify', { body: 'v' });
    await webLogin(page, PADMIN.email, PADMIN.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: /^Close$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Reason for closing')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await confirmTransitionDialog(page, 'closing as duplicate');
    await expect(page.getByText(/^CLOSED$/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('closing as duplicate')).toBeVisible();
  });

  test('the assignee name renders', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Assignee render', type: 'BUG' });
    const devSession = await login(DEV.email, DEV.password);
    const res = await fetch(`${API_URL}/api/projects/${slug}/tickets/${ticket.ref}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: devSession.userId }),
    });
    expect(res.ok).toBe(true);
    await webLogin(page, DEV.email, DEV.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    await expect(page.getByText(DEV.name).first()).toBeVisible({ timeout: 5000 });
  });

  test('user markdown cannot restyle the page with class; code keeps language-*', async ({ page }) => {
    const description = '<div class="fixed inset-0" data-testid="overlay">boom</div>\n\n```ts\nconst a = 1\n```';
    const ticket = await createTicket(token, slug, { title: 'Sanitizer', type: 'BUG', description });
    await webLogin(page, DEV.email, DEV.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    const overlay = page.locator('div', { hasText: /^boom$/ });
    await expect(overlay).toHaveCount(1, { timeout: 5000 });
    await expect(overlay).not.toHaveAttribute('class', /fixed/);
    await expect(page.locator('code.language-ts')).toHaveCount(1);
  });
});
