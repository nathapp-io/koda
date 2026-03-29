import { test, expect } from '@playwright/test';
import {
  login,
  createProject,
  createTicket,
  deleteProject,
  transitionTicket,
  E2E_ADMIN,
} from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers';

/**
 * Ticket lifecycle: CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
 *
 * Transition map (from TicketActionPanel.vue):
 *   CREATED    → "Verify" (opens dialog) or "Reject"
 *   VERIFIED   → "Start" (no dialog)
 *   IN_PROGRESS → "Submit Fix" (opens dialog) or "Reject"
 *   VERIFY_FIX  → "Approve Fix" (opens dialog) or "Fail Fix"
 */
test.describe('Ticket Lifecycle', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

    const suffix = Date.now().toString().slice(-6);

    const proj = await createProject(token, {
      name: 'E2E Ticket Lifecycle',
      slug: `e2etl${suffix}`,
      key: generateUniqueProjectKey('TL'),
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('board shows New Ticket action', async ({ page }) => {
    await webLogin(page);
    await page.goto(`/${projectSlug}`);

    await expect(page.getByRole('button', { name: 'New Ticket' })).toBeVisible();
  });

  test('ticket starts in CREATED status', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Status Check',
      type: 'BUG',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Verify the CREATED action buttons are present (Verify + Reject)
    await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  });

  test('CREATED → VERIFIED: UI shows Start after verify transition', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Verify Transition',
      type: 'BUG',
    });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'Verified in E2E' });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText(/^VERIFIED$/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 5000 });
  });

  test('VERIFIED → IN_PROGRESS: UI shows Submit Fix after start transition', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, { title: 'E2E Start', type: 'BUG' });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'Verified in E2E' });
    await transitionTicket(token, projectSlug, ticket.ref, 'start');

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText(/^IN_PROGRESS$/)).toBeVisible({ timeout: 4000 });
    await expect(page.getByRole('button', { name: 'Submit Fix' })).toBeVisible({ timeout: 4000 });
  });

  test('full lifecycle: CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Full Lifecycle Ticket',
      type: 'BUG',
      priority: 'HIGH',
    });

    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'Verified in E2E' });
    await transitionTicket(token, projectSlug, ticket.ref, 'start');
    await transitionTicket(token, projectSlug, ticket.ref, 'fix', { body: 'Fix submitted in E2E' });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify-fix', { body: 'Approved in E2E' }, { approve: true });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText(/^CLOSED$/)).toBeVisible({ timeout: 4000 });
    await expect(page.getByRole('button', { name: 'Approve Fix' })).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Verify' })).not.toBeVisible({ timeout: 3000 });
  });
});
